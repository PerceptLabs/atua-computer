/**
 * atua-computer browser host layer.
 * Runs the Blink engine on a Web Worker thread.
 * Main thread handles DOM/terminal. Worker runs WASM with Atomics.wait for blocking.
 */

export class AtuaComputer {
  constructor() {
    this.outputCallback = null;
    this._worker = null;
    this._children = new Map(); // pid → child Worker
    this._exitResolve = null;
    this._engineWasm = null;
    this._files = null;
    this._wisp = null;
    this._socketSabs = new Map(); // sockId → { sab, control, data, streamId }
    this._dnsProxyUrl = null;
    this._dnsCache = new Map(); // ip → hostname (reverse map from DNS resolution)
    // Create stdin SharedArrayBuffer eagerly so writeStdin can be called before boot completes
    this._stdinSab = new SharedArrayBuffer(4096 + 16);
    this._stdinControl = new Int32Array(this._stdinSab, 0, 4);
    this._stdinData = new Uint8Array(this._stdinSab, 16, 4096);
  }

  async boot(opts) {
    this.outputCallback = opts.onOutput || ((bytes) => {
      console.log(new TextDecoder().decode(bytes));
    });

    // Load engine WASM
    this._engineWasm = typeof opts.engineUrl === 'string'
      ? await fetch(opts.engineUrl).then(r => r.arrayBuffer())
      : (opts.engineUrl instanceof ArrayBuffer ? opts.engineUrl : opts.engineUrl.buffer.slice(opts.engineUrl.byteOffset, opts.engineUrl.byteOffset + opts.engineUrl.byteLength));

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

    // Create engine Worker
    this._worker = new Worker('/engine-main-worker.js', { type: 'module' });

    return new Promise((resolve, reject) => {
      this._exitResolve = resolve;

      this._worker.onmessage = (e) => this._handleWorkerMessage(e, resolve);
      this._worker.onerror = (e) => reject(new Error('Worker error: ' + e.message));

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

      // Boot the engine on the Worker
      this._worker.postMessage({
        type: 'boot',
        engineWasm: this._engineWasm,
        rootfsTar,
        args,
        env: opts.env || {},
        files,
        stdinSab: this._stdinSab,
      });
    });
  }

  _handleWorkerMessage(e, resolve) {
    const msg = e.data;
    if (msg.type === 'stdout') {
      this.outputCallback(msg.data);
    } else if (msg.type === 'exit') {
      if (resolve) resolve(msg.code);
    } else if (msg.type === 'error') {
      console.error('Engine error:', msg.message);
    } else if (msg.type === 'fork') {
      this._spawnChildWorker(msg);
    } else if (msg.type === 'debug') {
      console.log('[Worker]', msg.message);
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

  _spawnChildWorker(msg) {
    const { state, pid, files, symlinks, waitFlag, pipeSabs } = msg;

    const child = new Worker('/engine-worker.js');
    this._children.set(pid, child);

    child.onmessage = (ce) => {
      if (ce.data.type === 'stdout') {
        // Forward child stdout to our output
        this.outputCallback(ce.data.data);
      } else if (ce.data.type === 'exit') {
        // Signal parent Worker that child exited
        this._worker.postMessage({ type: 'child-exit', pid: ce.data.pid, code: ce.data.code });
        // Store exit code and set flag in SAB — parent reads from SAB directly
        if (waitFlag) {
          const view = new Int32Array(waitFlag);
          Atomics.store(view, 1, ce.data.code || 0); // exit code at index 1
          Atomics.store(view, 0, 1); // done flag at index 0
          Atomics.notify(view, 0);
        }
        this._children.delete(pid);
      }
    };

    child.onerror = (err) => {
      console.error('Child Worker error:', err.message);
    };

    child.postMessage({
      type: 'restore-fork',
      state,
      pid,
      engineUrl: '/engine.wasm',
      files,
      symlinks: symlinks || {},
      pipeSabs: pipeSabs || {},
    });
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
