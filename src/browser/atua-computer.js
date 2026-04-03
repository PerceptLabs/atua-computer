/**
 * atua-computer browser host layer — kernel architecture.
 *
 * Main thread orchestrates:
 *   - Kernel Worker (kernel-worker.js, module) — handles syscalls via SABs
 *   - Execution Workers (execution-worker.js, classic) — run Blink WASM engine
 *
 * Each execution worker gets a controlSab (256 bytes), dataSab (1MB),
 * and a shared wakeChannel (4 bytes). The kernel worker receives all SABs
 * and processes syscalls for every execution worker.
 *
 * Wisp relay stays on main thread — kernel sends socket data requests
 * via postMessage to main thread.
 */

export class AtuaComputer {
  constructor() {
    this.outputCallback = null;
    this._kernelWorker = null;
    this._executionWorkers = new Map(); // pid -> execution Worker
    this._exitResolve = null;
    this._engineWasm = null;
    this._engineModule = null;
    this._files = null;
    this._wisp = null;
    this._socketSabs = new Map(); // sockId -> { sab, control, data, streamId }
    this._dnsProxyUrl = null;
    this._dnsCache = new Map(); // ip -> hostname (reverse map from DNS resolution)
    // Worker pool — pre-spawned execution workers for fork children
    this._workerPool = [];
    // Shared wake channel for Atomics.notify between kernel and execution workers
    this._wakeChannel = new SharedArrayBuffer(4);
    // Create stdin SharedArrayBuffer eagerly so writeStdin can be called before boot completes
    this._stdinSab = new SharedArrayBuffer(4096 + 16);
    this._stdinControl = new Int32Array(this._stdinSab, 0, 4);
    this._stdinData = new Uint8Array(this._stdinSab, 16, 4096);
  }

  async boot(opts) {
    this.outputCallback = opts.onOutput || ((bytes) => {
      console.log(new TextDecoder().decode(bytes));
    });

    // Load engine WASM and pre-compile module (shared across all execution workers)
    const engineBytes = typeof opts.engineUrl === 'string'
      ? await fetch(opts.engineUrl).then(r => r.arrayBuffer())
      : (opts.engineUrl instanceof ArrayBuffer ? opts.engineUrl : opts.engineUrl.buffer.slice(opts.engineUrl.byteOffset, opts.engineUrl.byteOffset + opts.engineUrl.byteLength));
    this._engineWasm = engineBytes;
    this._engineModule = await WebAssembly.compile(engineBytes);

    // Load rootfs tar
    let rootfsTar = null;
    if (opts.rootfsUrl) {
      console.log('Fetching rootfs:', opts.rootfsUrl);
      rootfsTar = typeof opts.rootfsUrl === 'string'
        ? await fetch(opts.rootfsUrl).then(r => r.arrayBuffer())
        : (opts.rootfsUrl instanceof ArrayBuffer ? opts.rootfsUrl : opts.rootfsUrl.buffer.slice(opts.rootfsUrl.byteOffset, opts.rootfsUrl.byteOffset + opts.rootfsUrl.byteLength));
      console.log('Rootfs loaded:', rootfsTar.byteLength, 'bytes');
    }

    // Prepare individual files
    const files = {};
    if (opts.files) {
      for (const [path, content] of Object.entries(opts.files)) {
        const u8 = content instanceof Uint8Array ? content : new Uint8Array(content);
        files[path] = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      }
    }
    this._files = files;

    // Initialize Wisp relay if URL provided
    if (opts.wispRelayUrl) {
      console.log('Connecting to Wisp relay:', opts.wispRelayUrl);
      const { WispClient } = await import('./wisp-client.js');
      this._wisp = new WispClient(opts.wispRelayUrl);
      await this._wisp.connect();
      console.log('Wisp relay connected');
    }
    this._dnsProxyUrl = opts.dnsProxyUrl || null;

    // Boot Wasmer WASIX bridge — provides fork, pipes, threading, signals, sockets
    let bridgeSab = null;
    if (opts.bridgeUrl !== false) { // Skip bridge only if explicitly disabled
      try {
        const { init: initWasmer, runWasix } = await import('/node_modules/@wasmer/sdk/dist/index.mjs');
        await initWasmer();
        const bridgeBytes = await fetch(opts.bridgeUrl || '/wasix-bridge.wasm').then(r => r.arrayBuffer());
        this._bridgeInstance = await runWasix(new Uint8Array(bridgeBytes), { program: 'wasix-bridge' });
        const mem = this._bridgeInstance.memory;
        if (mem && mem.buffer instanceof SharedArrayBuffer) {
          bridgeSab = mem.buffer;
          this._bridgeSab = bridgeSab;
          console.log('[atua] Bridge started, SAB=' + bridgeSab.byteLength + ' bytes');
        } else {
          console.warn('[atua] Bridge memory not SharedArrayBuffer — bridge disabled');
        }
      } catch (e) {
        console.warn('[atua] Bridge boot failed:', e.message, '— continuing without bridge');
      }
    }

    // Create Kernel Worker (module worker — handles syscalls)
    this._kernelWorker = new Worker('/kernel-worker.js', { type: 'module' });
    this._kernelWorker.onmessage = (e) => this._handleKernelMessage(e);
    this._kernelWorker.onerror = (e) => {
      console.error('Kernel worker error:', e.message);
    };

    // Pre-spawn 4 execution workers into the pool for fork children (in parallel with init)
    for (let i = 0; i < 4; i++) {
      this._workerPool.push(new Worker('/execution-worker.js'));
    }

    // Send init message to kernel with rootfs, files, and bridge SAB
    await new Promise((resolve, reject) => {
      const origHandler = this._kernelWorker.onmessage;
      this._kernelWorker.onmessage = (e) => {
        if (e.data.type === 'init-done') {
          this._kernelWorker.onmessage = origHandler;
          resolve();
        } else {
          origHandler(e);
        }
      };
      this._kernelWorker.postMessage({
        type: 'init',
        rootfsTar,
        files,
        stdinSab: this._stdinSab,
        bridgeSab,
      });
    });

    // Allocate SABs for PID 1
    const pid1ControlSab = new SharedArrayBuffer(256);
    const pid1DataSab = new SharedArrayBuffer(1024 * 1024); // 1MB

    // Create execution worker for PID 1
    const pid1Worker = this._workerPool.length > 0
      ? this._workerPool.pop()
      : new Worker('/execution-worker.js');
    this._executionWorkers.set(1, pid1Worker);

    // Build args — inject strace/statistics flags if requested
    let args = opts.args || ['engine'];
    if (opts.syscallTrace) {
      const level = typeof opts.syscallTrace === 'number' ? opts.syscallTrace : 1;
      const sFlag = '-' + 's'.repeat(Math.min(level, 4));
      args = [args[0], sFlag, ...args.slice(1)];
    }
    if (opts.statistics) {
      args = [args[0], '-Z', ...args.slice(1)];
    }

    return new Promise((resolve, reject) => {
      this._exitResolve = resolve;

      pid1Worker.onmessage = (e) => this._handleExecutionWorkerMessage(e, 1, resolve);
      pid1Worker.onerror = (e) => reject(new Error('PID 1 worker error: ' + e.message));

      // Register PID 1's SABs with kernel
      this._kernelWorker.postMessage({
        type: 'register-worker',
        pid: 1,
        controlSab: pid1ControlSab,
        dataSab: pid1DataSab,
      });

      // Boot PID 1 execution worker
      pid1Worker.postMessage({
        type: 'boot',
        controlSab: pid1ControlSab,
        dataSab: pid1DataSab,
        wakeChannel: this._wakeChannel,
        pid: 1,
        engineModule: this._engineModule,
        args,
        env: opts.env || {},
        stdinSab: this._stdinSab,
        bridgeSab,
      });
    });
  }

  /** Handle messages from an execution worker */
  _handleExecutionWorkerMessage(e, pid, resolve) {
    const msg = e.data;
    if (msg.type === 'stdout') {
      this.outputCallback(msg.data);
    } else if (msg.type === 'exit') {
      if (pid === 1 && resolve) {
        resolve(msg.code);
      }
      // Notify kernel of worker exit
      this._kernelWorker.postMessage({ type: 'worker-exit', pid, code: msg.code });
      this._executionWorkers.delete(pid);
      // Recycle non-PID-1 workers back to pool
      if (pid !== 1) {
        const worker = this._executionWorkers.get(pid) || e.target;
        this._recycleWorker(worker);
      }
    } else if (msg.type === 'memory-ready') {
      this._kernelWorker.postMessage({
        type: 'register-memory',
        pid: msg.pid,
        wasmMemoryBuffer: msg.wasmMemoryBuffer,
      });
    } else if (msg.type === 'pipe-sab') {
      this._kernelWorker.postMessage(msg);
    } else if (msg.type === 'error') {
      console.error('Execution worker error (pid ' + pid + '):', msg.message);
    } else if (msg.type === 'debug') {
      console.log('[Worker pid=' + pid + ']', msg.message);
    } else if (msg.type === 'reset-ack') {
      // Worker confirmed reset — already back in pool
    }
  }

  /** Handle messages from the kernel worker */
  _handleKernelMessage(e) {
    const msg = e.data;
    if (msg.type === 'fork-request') {
      this._spawnChildWorker(msg);
    } else if (msg.type === 'socket-open') {
      this._handleSocketOpen(msg);
    } else if (msg.type === 'socket-connect') {
      this._handleSocketConnect(msg);
    } else if (msg.type === 'socket-send') {
      this._handleSocketSend(msg);
    } else if (msg.type === 'socket-close') {
      this._handleSocketClose(msg);
    } else if (msg.type === 'dns-query') {
      this._handleDnsQuery(msg);
    } else if (msg.type === 'http-fetch') {
      this._handleHttpFetch(msg);
    } else if (msg.type === 'pipe-fd-cache') {
      // Relay pipe SABs from kernel to the correct execution worker
      const worker = this._executionWorkers.get(msg.pid);
      if (worker) worker.postMessage(msg);
    } else if (msg.type === 'stdout') {
      this.outputCallback(msg.data);
    } else if (msg.type === 'debug') {
      console.log('[Kernel]', msg.message);
    } else if (msg.type === 'error') {
      console.error('Kernel error:', msg.message);
    } else if (msg.type === 'init-done') {
      // Kernel VFS initialized
    } else if (msg.type === 'worker-registered') {
      // Worker registered with kernel
    }
  }

  /** Write input bytes to the engine's stdin */
  writeStdin(data) {
    if (!this._stdinSab) return;
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    for (let i = 0; i < bytes.length; i++) {
      const wp = Atomics.load(this._stdinControl, 0);
      this._stdinData[wp % 4096] = bytes[i];
      Atomics.store(this._stdinControl, 0, wp + 1);
      Atomics.add(this._stdinControl, 2, 1);
    }
    Atomics.notify(this._stdinControl, 2); // wake worker's Atomics.wait
  }

  /** Spawn a child execution worker in response to a fork-request from kernel */
  _spawnChildWorker(msg) {
    const { pid: parentPid, childPid, forkType, forkState, forkStateLen,
            guestPagesSab, parentWasmMemory, parentBrk, vfsState, hostOpenFiles, waitFlag,
            pipeSabs, pipeFds, path, argv, env } = msg;
    const pid = childPid || (parentPid + 1);

    // Grab a worker from the pool, or create one if pool is empty
    const child = this._workerPool.length > 0
      ? this._workerPool.pop()
      : new Worker('/execution-worker.js');
    this._executionWorkers.set(pid, child);

    // Allocate SABs for child
    const childControlSab = new SharedArrayBuffer(256);
    const childDataSab = new SharedArrayBuffer(1024 * 1024); // 1MB

    child.onmessage = (ce) => {
      if (ce.data.type === 'stdout') {
        this.outputCallback(ce.data.data);
      } else if (ce.data.type === 'exit') {
        // Notify kernel that child exited
        this._kernelWorker.postMessage({
          type: 'worker-exit',
          pid: ce.data.pid,
          code: ce.data.code,
        });
        // Signal parent via waitFlag SAB if provided
        if (waitFlag) {
          const view = new Int32Array(waitFlag);
          Atomics.store(view, 1, ce.data.code || 0); // exit code at index 1
          Atomics.store(view, 0, 1); // done flag at index 0
          Atomics.notify(view, 0);
        }
        this._executionWorkers.delete(pid);
        this._recycleWorker(child);
      } else if (ce.data.type === 'reset-ack') {
        // Worker confirmed reset — already back in pool
      } else if (ce.data.type === 'memory-ready') {
        // Relay shared WASM memory buffer to kernel so it can access child's memory
        this._kernelWorker.postMessage({
          type: 'register-memory',
          pid: ce.data.pid,
          wasmMemoryBuffer: ce.data.wasmMemoryBuffer,
        });
      } else if (ce.data.type === 'debug') {
        console.log('[Worker pid=' + pid + ']', ce.data.message);
      }
    };

    child.onerror = (err) => {
      console.error('Child execution worker error (pid ' + pid + '):', err.message);
    };

    // Register child's SABs with kernel
    this._kernelWorker.postMessage({
      type: 'register-worker',
      pid,
      controlSab: childControlSab,
      dataSab: childDataSab,
    });

    // Send appropriate boot message to child based on fork type
    if (forkType === 'fork-exec') {
      child.postMessage({
        type: 'fork-exec',
        pid,
        path,
        argv,
        env,
        controlSab: childControlSab,
        dataSab: childDataSab,
        wakeChannel: this._wakeChannel,
        engineModule: this._engineModule,
        pipeFds: pipeFds || [],
        bridgeSab: this._bridgeSab || null,
      });
    } else {
      // restore-fork (full fork with page copy)
      child.postMessage({
        type: 'restore-fork',
        guestPagesSab: parentWasmMemory || guestPagesSab,
        forkState,
        forkStateLen,
        parentBrk,
        pid,
        controlSab: childControlSab,
        dataSab: childDataSab,
        pipeFds: pipeFds || [],
        bridgeSab: this._bridgeSab || null,
        wakeChannel: this._wakeChannel,
        engineModule: this._engineModule,
        vfsState: vfsState || {},
        hostOpenFiles: hostOpenFiles || {},
        pipeSabs: pipeSabs || {},
      });
    }
  }

  /** Send reset message to worker and return it to the pool */
  _recycleWorker(worker) {
    worker.postMessage({ type: 'reset' });
    this._workerPool.push(worker);
  }

  /* --- HTTP Fetch Bypass (Phase 5) --- */

  async _handleHttpFetch(msg) {
    const { sockId, url, method, headers } = msg;
    const sabInfo = this._socketSabs.get(sockId);
    if (!sabInfo) return;
    try {
      const response = await fetch(url, { method, headers });
      // Synthesize HTTP response headers
      const statusLine = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
      const respHeaders = [];
      response.headers.forEach((v, k) => { respHeaders.push(`${k}: ${v}`); });
      const headerStr = statusLine + respHeaders.join('\r\n') + '\r\n\r\n';
      const headerBytes = new TextEncoder().encode(headerStr);
      // Stream: write headers + body into socket SAB
      const body = await response.arrayBuffer();
      const bodyBytes = new Uint8Array(body);
      const fullResponse = new Uint8Array(headerBytes.length + bodyBytes.length);
      fullResponse.set(headerBytes);
      fullResponse.set(bodyBytes, headerBytes.length);
      // Write to socket SAB in chunks
      const data = new Uint8Array(sabInfo.sab, 32, sabInfo.sab.byteLength - 32);
      const control = new Int32Array(sabInfo.sab, 0, 8);
      let written = 0;
      while (written < fullResponse.length) {
        const wp = Atomics.load(control, 0);
        const rp = Atomics.load(control, 1);
        const bufSize = data.length;
        const available = bufSize - ((wp - rp + bufSize) % bufSize) - 1;
        if (available <= 0) {
          await new Promise(r => setTimeout(r, 1));
          continue;
        }
        const chunk = Math.min(available, fullResponse.length - written);
        for (let i = 0; i < chunk; i++) {
          data[(wp + i) % bufSize] = fullResponse[written + i];
        }
        Atomics.store(control, 0, wp + chunk);
        Atomics.notify(control, 1);
        written += chunk;
      }
    } catch (err) {
      console.error('HTTP fetch bypass error:', err.message, 'url:', url);
      // Fall through — socket read will return 0 (EOF)
    }
  }

  /* --- Socket message handlers --- */

  _handleSocketOpen(msg) {
    const { sockId, sab } = msg;
    const control = new Int32Array(sab, 0, 8);
    const data = new Uint8Array(sab, 32, 128 * 1024);
    this._socketSabs.set(sockId, { sab, control, data, streamId: null });
  }

  _handleSocketConnect(msg) {
    const { sockId, ip, port } = msg;
    const entry = this._socketSabs.get(sockId);
    if (!entry) return;

    if (!this._wisp || !this._wisp.connected) {
      // No relay — signal connect failure
      Atomics.store(entry.control, 3, -1);
      Atomics.notify(entry.control, 3);
      return;
    }

    // Use hostname from DNS cache if available (relay resolves hostname,
    // avoiding raw-IP routing issues with proxies/VPNs)
    const host = this._dnsCache.get(ip) || ip;
    const streamId = this._wisp.createStream(host, port, {
      onConnect: () => {
        Atomics.store(entry.control, 3, 1); // connected
        Atomics.notify(entry.control, 3);
      },
      onData: (payload) => {
        // Write incoming TCP data to socket SAB ring buffer
        const cap = entry.data.length;
        for (let i = 0; i < payload.length; i++) {
          const wp = Atomics.load(entry.control, 0);
          entry.data[wp % cap] = payload[i];
          Atomics.store(entry.control, 0, wp + 1);
        }
        Atomics.notify(entry.control, 1); // wake blocked recv
      },
      onClose: (reason) => {
        Atomics.store(entry.control, 2, 1); // closed
        Atomics.notify(entry.control, 1); // wake blocked recv
      },
    });

    entry.streamId = streamId;
  }

  _handleSocketSend(msg) {
    const { sockId, data } = msg;
    const entry = this._socketSabs.get(sockId);
    if (!entry || !entry.streamId || !this._wisp) return;
    this._wisp.send(entry.streamId, new Uint8Array(data));
  }

  _handleSocketClose(msg) {
    const { sockId } = msg;
    const entry = this._socketSabs.get(sockId);
    if (entry && entry.streamId && this._wisp) {
      this._wisp.close(entry.streamId);
    }
    this._socketSabs.delete(sockId);
  }

  async _handleDnsQuery(msg) {
    const { sockId, data } = msg;
    const entry = this._socketSabs.get(sockId);
    if (!entry) return;

    const queryBuf = new Uint8Array(data);

    // Parse hostname and QTYPE from DNS wire format query
    const parsed = this._parseDnsQuery(queryBuf);
    if (!parsed) {
      Atomics.store(entry.control, 2, 1); // signal closed/error
      Atomics.notify(entry.control, 1);
      return;
    }
    const { hostname, qtype } = parsed;

    // Only resolve A records (type 1). For AAAA (28) and others, return NODATA.
    if (qtype !== 1) {
      const response = this._buildDnsResponse(queryBuf, null, false); // NODATA, not NXDOMAIN
      this._writeToSocketSab(entry, response);
      return;
    }

    try {
      // Resolve via DoH — fetch on MAIN THREAD (Worker is blocked on Atomics.wait)
      let ip = null;
      if (this._dnsProxyUrl) {
        const resp = await fetch(`${this._dnsProxyUrl}?name=${hostname}&type=A`);
        const json = await resp.json();
        ip = json.Answer?.[0]?.data || json.ip || null;
      } else {
        const resp = await fetch(`https://dns.google/resolve?name=${hostname}&type=A`);
        const json = await resp.json();
        ip = json.Answer?.[0]?.data || null;
      }

      if (!ip) {
        const response = this._buildDnsResponse(queryBuf, null, true); // NXDOMAIN
        this._writeToSocketSab(entry, response);
      } else {
        this._dnsCache.set(ip, hostname);
        const response = this._buildDnsResponse(queryBuf, ip, false);
        this._writeToSocketSab(entry, response);
      }
    } catch (err) {
      console.error('DNS resolution failed:', err);
      Atomics.store(entry.control, 2, 1);
      Atomics.notify(entry.control, 1);
    }
  }

  _writeToSocketSab(entry, data) {
    const cap = entry.data.length;
    for (let i = 0; i < data.length; i++) {
      const wp = Atomics.load(entry.control, 0);
      entry.data[wp % cap] = data[i];
      Atomics.store(entry.control, 0, wp + 1);
    }
    Atomics.notify(entry.control, 1);
  }

  /** Parse hostname and QTYPE from DNS wire format query */
  _parseDnsQuery(buf) {
    if (buf.length < 17) return null;
    let offset = 12; // skip DNS header
    const labels = [];
    while (offset < buf.length) {
      const len = buf[offset];
      if (len === 0) break;
      if (len > 63) return null;
      offset++;
      if (offset + len > buf.length) return null;
      labels.push(new TextDecoder().decode(buf.subarray(offset, offset + len)));
      offset += len;
    }
    offset++; // skip null terminator
    const qtype = (offset + 1 < buf.length) ? (buf[offset] << 8) | buf[offset + 1] : 1;
    return { hostname: labels.join('.'), qtype };
  }

  /** Build a DNS wire format response with optional A record answer */
  _buildDnsResponse(queryBuf, ip, nxdomain) {
    const header = new Uint8Array(queryBuf.subarray(0, 12));
    header[2] = 0x81; // QR=1, RD=1
    // RCODE: 0=NOERROR (NODATA or success), 3=NXDOMAIN
    header[3] = nxdomain ? 0x83 : 0x80;
    header[6] = 0; header[7] = ip ? 1 : 0; // ANCOUNT

    // Find end of question section
    let qEnd = 12;
    while (qEnd < queryBuf.length && queryBuf[qEnd] !== 0) {
      qEnd += queryBuf[qEnd] + 1;
    }
    qEnd += 5; // null terminator + QTYPE(2) + QCLASS(2)
    const question = queryBuf.subarray(12, qEnd);

    if (!ip) {
      const resp = new Uint8Array(12 + question.length);
      resp.set(header);
      resp.set(question, 12);
      return resp;
    }

    // A record answer RR
    const answer = new Uint8Array(16);
    const av = new DataView(answer.buffer);
    answer[0] = 0xC0; answer[1] = 0x0C; // pointer to name at offset 12
    av.setUint16(2, 1, false);  // TYPE = A
    av.setUint16(4, 1, false);  // CLASS = IN
    av.setUint32(6, 300, false); // TTL = 300s
    av.setUint16(10, 4, false); // RDLENGTH = 4
    const ipParts = ip.split('.').map(Number);
    answer[12] = ipParts[0]; answer[13] = ipParts[1];
    answer[14] = ipParts[2]; answer[15] = ipParts[3];

    const resp = new Uint8Array(12 + question.length + answer.length);
    resp.set(header);
    resp.set(question, 12);
    resp.set(answer, 12 + question.length);
    return resp;
  }
}
