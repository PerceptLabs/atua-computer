/**
 * engine-main-worker.js — Runs the Blink engine on a Worker thread.
 * The main thread handles DOM/terminal. This Worker runs WASM and can
 * use Atomics.wait() to block without freezing the UI.
 *
 * Communication:
 *   Main → Worker: { type: 'boot', engineWasm, rootfsTar, args, env, files }
 *   Worker → Main: { type: 'stdout', data }
 *   Worker → Main: { type: 'exit', code }
 *   Worker → Main: { type: 'fork', state, pid, files }
 *   Main → Worker: (via SAB for stdin)
 */

import { VirtualFS } from './filesystem.js';

let memory = null;
let instance = null;
let vfs = null;
let outputFn = null;
let nextPid = 2;
const children = new Map();

// Pipe table: pipe_id → { sab, control, data }
const pipes = new Map();
let nextPipeId = 0;
const PIPE_BUF_SIZE = 64 * 1024;

// Socket table: sockId → { sab, control, data, isDns }
const sockets = new Map();
let nextSockId = 0;
const SOCK_BUF_SIZE = 128 * 1024;
// SAB layout: Int32Array control[8] at offset 0, Uint8Array data[SOCK_BUF_SIZE] at offset 32
// control: [0]=writePos [1]=readPos [2]=closed [3]=connectDone [4]=errorCode [5..7]=reserved

function socketRecvToArray(sockId, buf, len) {
  const sock = sockets.get(sockId);
  if (!sock) return -1;
  const { control, data } = sock;
  const cap = data.length;
  let bytesRead = 0;
  while (bytesRead < len) {
    const wp = Atomics.load(control, 0);
    const rp = Atomics.load(control, 1);
    if (rp === wp) {
      if (Atomics.load(control, 2) === 1) break;
      if (bytesRead > 0) break;
      Atomics.wait(control, 1, rp, 5000);
      continue;
    }
    buf[bytesRead] = data[rp % cap];
    Atomics.store(control, 1, rp + 1);
    bytesRead++;
  }
  return bytesRead;
}

/* socketRecv is unused now — socketRecvToArray handles all socket recv */

function createPipe() {
  const id = nextPipeId++;
  const sab = new SharedArrayBuffer(PIPE_BUF_SIZE + 16);
  // control: [0]=writePos, [1]=readPos, [2]=writeClosed, [3]=readClosed
  const control = new Int32Array(sab, 0, 4);
  const data = new Uint8Array(sab, 16, PIPE_BUF_SIZE);
  pipes.set(id, { sab, control, data });
  return id;
}

function pipeWrite(pipeId, buf, len) {
  const pipe = pipes.get(pipeId);
  if (!pipe) return -1;
  const { control, data } = pipe;
  const cap = data.length;
  let written = 0;
  for (let i = 0; i < len; i++) {
    const wp = Atomics.load(control, 0);
    const next = (wp + 1) % cap;
    if (next === Atomics.load(control, 1)) break; // full
    data[wp] = buf[i];
    Atomics.store(control, 0, next);
    written++;
  }
  Atomics.notify(control, 1); // wake reader
  return written;
}

function pipeRead(pipeId, buf, len) {
  const pipe = pipes.get(pipeId);
  if (!pipe) return -1;
  const { control, data } = pipe;
  const cap = data.length;
  let bytesRead = 0;
  while (bytesRead < len) {
    const wp = Atomics.load(control, 0);
    const rp = Atomics.load(control, 1);
    if (rp === wp) {
      if (Atomics.load(control, 2) === 1) break; // write end closed = EOF
      if (bytesRead > 0) break;
      // Block until data arrives (on Worker, Atomics.wait is allowed)
      Atomics.wait(control, 1, rp, 5000); // 5s timeout
      continue;
    }
    buf[bytesRead] = data[rp];
    Atomics.store(control, 1, (rp + 1) % cap);
    bytesRead++;
  }
  return bytesRead;
}

function pipeClose(pipeId, end) {
  const pipe = pipes.get(pipeId);
  if (!pipe) return;
  if (end === 1) { // write end
    Atomics.store(pipe.control, 2, 1);
    Atomics.notify(pipe.control, 1); // wake blocked reader
  } else { // read end
    Atomics.store(pipe.control, 3, 1);
  }
}

// Pending wait: { pid, resolve }
let pendingWaits = new Map();



self.onmessage = async (e) => {
  if (e.data.type === 'boot') {
    await bootEngine(e.data);
  } else if (e.data.type === 'child-exit') {
    // Child Worker exited
    const { pid, code } = e.data;
    const waiter = pendingWaits.get(pid);
    if (waiter) {
      // Signal the SAB so Atomics.wait unblocks
      Atomics.store(waiter.flag, 0, 1);
      Atomics.notify(waiter.flag, 0);
      waiter.exitCode = code;
    }
  } else if (e.data.type === 'child-stdout') {
    // Forward child stdout to main thread
    self.postMessage({ type: 'stdout', data: e.data.data });
  }
};

let stdinSab = null;

async function bootEngine(opts) {
  stdinSab = opts.stdinSab || null;
  vfs = new VirtualFS();

  if (opts.rootfsTar) {
    await vfs.loadTar(opts.rootfsTar);
  }
  if (opts.files) {
    for (const [path, content] of Object.entries(opts.files)) {
      vfs.addFile(path, new Uint8Array(content));
    }
  }

  const args = opts.args || ['engine'];
  const env = opts.env || {};
  let cwd = '/';

  const { instance: inst } = await WebAssembly.instantiate(opts.engineWasm, {
    atua: createImports(args, env, () => cwd, (p) => { cwd = p; }),
  });

  instance = inst;
  memory = instance.exports.memory;

  try {
    instance.exports._start();
  } catch (err) {
    if (!(err instanceof WebAssembly.RuntimeError && err.message.includes('unreachable'))) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }

  self.postMessage({ type: 'exit', code: 0 });
}

function createImports(args, env, getCwd, setCwd) {
  function readCString(ptr) {
    const mem = new Uint8Array(memory.buffer);
    let end = ptr;
    while (end < mem.length && mem[end]) end++;
    return new TextDecoder().decode(mem.subarray(ptr, end));
  }

  return {
    term_write(bufPtr, len) {
      const bytes = new Uint8Array(memory.buffer, bufPtr, len);
      self.postMessage({ type: 'stdout', data: new Uint8Array(bytes) });
    },

    term_read(bufPtr, len) {
      if (!stdinSab) return 0;
      const flag = new Int32Array(stdinSab, 0, 4);
      const data = new Uint8Array(stdinSab, 16, 4096);
      const avail = Atomics.load(flag, 2);

      // First, wait for data if none available
      if (avail === 0) {
        let waited = 0;
        while (flag[2] === 0) {
          Atomics.wait(flag, 2, 0, 1000);
          waited++;
          if (waited >= 30) break;
        }
        if (flag[2] === 0) return 0; // timeout → EOF
      }

      // AFTER Atomics.wait, create dest view with CURRENT memory.buffer
      // (memory.buffer may change during Atomics.wait if memory.grow happened)
      let bytesRead = 0;
      while (bytesRead < len) {
        if (flag[2] === 0) break;
        const rp = flag[1];
        // Create a fresh view each byte to handle potential buffer changes
        new Uint8Array(memory.buffer)[bufPtr + bytesRead] = data[rp % 4096];
        flag[1] = rp + 1;
        flag[2] = flag[2] - 1;
        bytesRead++;
      }

      return bytesRead;
    },

    fs_open(pathPtr, flags, mode) {
      const path = readCString(pathPtr);
      return vfs.open(path, flags, mode);
    },

    fs_read(handle, bufPtr, len, offset) {
      const o = typeof offset === 'bigint' ? Number(offset) : (offset || 0);
      const dest = new Uint8Array(memory.buffer, bufPtr, len);
      return vfs.read(handle, dest, o);
    },

    fs_write(handle, bufPtr, len, offset) {
      const o = typeof offset === 'bigint' ? Number(offset) : (offset || 0);
      const src = new Uint8Array(memory.buffer, bufPtr, len);
      return vfs.write(handle, src, o);
    },

    fs_close(handle) {
      vfs.close(handle);
    },

    fs_fstat(handle) {
      const file = vfs.openFiles.get(handle);
      return file ? BigInt(file.content.length) : BigInt(-1);
    },

    fs_stat(pathPtr, bufPtr, bufLen) {
      const path = readCString(pathPtr);
      const info = vfs.stat(path);
      if (!info) return -1;
      if (bufPtr && bufLen >= 64) {
        const view = new DataView(memory.buffer);
        view.setUint8(bufPtr + 16, info.type === 'dir' ? 3 : 4);
        view.setBigUint64(bufPtr + 24, 1n, true);
        view.setBigUint64(bufPtr + 32, BigInt(info.size), true);
      }
      return 0;
    },

    fs_readdir() { return 0; },

    clock_gettime() {
      return BigInt(Math.floor(Date.now() * 1000000));
    },

    args_sizes_get(argcPtr, bufSizePtr) {
      const view = new DataView(memory.buffer);
      view.setUint32(argcPtr, args.length, true);
      let size = 0;
      for (const a of args) size += new TextEncoder().encode(a).length + 1;
      view.setUint32(bufSizePtr, size, true);
      return 0;
    },

    args_get(argvPtr, argvBufPtr) {
      const view = new DataView(memory.buffer);
      let off = argvBufPtr;
      for (let i = 0; i < args.length; i++) {
        view.setUint32(argvPtr + i * 4, off, true);
        const bytes = new TextEncoder().encode(args[i]);
        new Uint8Array(memory.buffer, off, bytes.length + 1).set([...bytes, 0]);
        off += bytes.length + 1;
      }
      return 0;
    },

    environ_sizes_get(countPtr, bufSizePtr) {
      const view = new DataView(memory.buffer);
      const entries = Object.entries(env);
      view.setUint32(countPtr, entries.length, true);
      let size = 0;
      for (const [k, v] of entries) size += new TextEncoder().encode(`${k}=${v}`).length + 1;
      view.setUint32(bufSizePtr, size, true);
      return 0;
    },

    environ_get(environPtr, environBufPtr) {
      const view = new DataView(memory.buffer);
      const entries = Object.entries(env);
      let off = environBufPtr;
      for (let i = 0; i < entries.length; i++) {
        view.setUint32(environPtr + i * 4, off, true);
        const bytes = new TextEncoder().encode(`${entries[i][0]}=${entries[i][1]}`);
        new Uint8Array(memory.buffer, off, bytes.length + 1).set([...bytes, 0]);
        off += bytes.length + 1;
      }
      return 0;
    },

    getcwd(bufPtr, len) {
      const c = getCwd();
      const bytes = new TextEncoder().encode(c);
      if (bytes.length + 1 > len) return 0;
      new Uint8Array(memory.buffer, bufPtr, bytes.length + 1).set([...bytes, 0]);
      return bufPtr;
    },

    chdir(pathPtr) {
      const path = readCString(pathPtr);
      setCwd(path.startsWith('/') ? path : getCwd().replace(/\/$/, '') + '/' + path);
      return 0;
    },

    pipe_create() {
      return createPipe();
    },

    pipe_read(pipeId, bufPtr, len) {
      const buf = new Uint8Array(memory.buffer, bufPtr, len);
      return pipeRead(pipeId, buf, len);
    },

    pipe_write(pipeId, bufPtr, len) {
      const buf = new Uint8Array(memory.buffer, bufPtr, len);
      return pipeWrite(pipeId, buf, len);
    },

    pipe_close(pipeId, end) {
      pipeClose(pipeId, end);
    },

    /* Socket imports — Phase F networking */
    socket_open(domain, type, protocol) {
      const sockId = nextSockId++;
      const sab = new SharedArrayBuffer(SOCK_BUF_SIZE + 32);
      const control = new Int32Array(sab, 0, 8);
      const data = new Uint8Array(sab, 32, SOCK_BUF_SIZE);
      const isDns = (type === 2); // SOCK_DGRAM = 2 = likely DNS
      sockets.set(sockId, { sab, control, data, isDns, peerPort: 0 });
      self.postMessage({ type: 'socket-open', sockId, sab });
      return 300 + sockId;
    },

    socket_connect(sockId, addrPtr, addrLen) {
      // addrPtr points to sockaddr_in in WASM memory:
      //   [0-1] = sin_family (AF_INET=2)
      //   [2-3] = sin_port (network byte order = big-endian)
      //   [4-7] = sin_addr (4 bytes)
      const id = sockId - 300;
      const sock = sockets.get(id);
      if (!sock) return -1;
      const addrBuf = new Uint8Array(memory.buffer, addrPtr, addrLen);
      const port = (addrBuf[2] << 8) | addrBuf[3]; // big-endian
      const ip = `${addrBuf[4]}.${addrBuf[5]}.${addrBuf[6]}.${addrBuf[7]}`;
      sock.peerPort = port;
      if (port === 53) {
        sock.isDns = true;
        // DNS sockets don't go through the relay — DoH handles resolution
        // when sendto() is called. Just return success.
        return 0;
      }
      if (ip === '127.0.0.1' || ip === '0.0.0.0') {
        // Loopback connect — used by musl's AI_ADDRCONFIG check.
        // Return success so getaddrinfo doesn't fail with EAI_SYSTEM.
        return 0;
      }
      self.postMessage({ type: 'socket-connect', sockId: id, ip, port });
      // Block until main thread signals connect result
      while (Atomics.load(sock.control, 3) === 0) {
        Atomics.wait(sock.control, 3, 0, 30000);
      }
      const result = Atomics.load(sock.control, 3);
      return result === 1 ? 0 : -1;
    },

    socket_send(sockId, bufPtr, len) {
      const id = sockId - 300;
      const sock = sockets.get(id);
      if (!sock) return -1;
      const data = new Uint8Array(memory.buffer, bufPtr, len).slice();
      if (sock.isDns) {
        // UDP/DNS socket — route to main thread DoH resolver
        self.postMessage({ type: 'dns-query', sockId: id, data: data.buffer }, [data.buffer]);
      } else {
        self.postMessage({ type: 'socket-send', sockId: id, data: data.buffer }, [data.buffer]);
      }
      return len;
    },

    socket_recv(sockId, bufPtr, len) {
      const id = sockId - 300;
      const sock = sockets.get(id);
      if (!sock) return -1;
      // C passes a small WASM stack buffer (≤4096, always single page).
      // Write directly via Uint8Array view — no page-spanning risk.
      const buf = new Uint8Array(memory.buffer, bufPtr, len);
      return socketRecvToArray(id, buf, len);
    },

    socket_close(sockId) {
      const id = sockId - 300;
      self.postMessage({ type: 'socket-close', sockId: id });
      sockets.delete(id);
    },

    socket_poll(sockId) {
      const id = sockId - 300;
      const sock = sockets.get(id);
      if (!sock) return 0;
      const { control } = sock;
      let result = 2; // always writable
      const wp = Atomics.load(control, 0);
      const rp = Atomics.load(control, 1);
      if (wp !== rp) result |= 1; // readable (data available)
      if (Atomics.load(control, 2) === 1) result |= 5; // closed: readable (EOF) + hup
      return result;
    },

    fork_spawn(statePtr, stateLen) {
      // Serialize the state and VFS, send to a new child Worker
      const state = new Uint8Array(memory.buffer, statePtr, stateLen).slice();
      const pid = nextPid++;

      // Serialize VFS files for the child
      const files = {};
      for (const [path, content] of vfs.files) {
        files[path] = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
      }

      // Create a SharedArrayBuffer flag for wait synchronization
      const waitFlag = new SharedArrayBuffer(8); // [0]=done flag, [1]=exit code
      const waitFlagView = new Int32Array(waitFlag);

      // Serialize pipe SABs for the child
      const pipeSabs = {};
      for (const [id, pipe] of pipes) {
        pipeSabs[id] = pipe.sab;
      }

      // Tell main thread to spawn a child Worker
      self.postMessage({
        type: 'fork',
        state: state.buffer,
        pid,
        files,
        waitFlag,
        pipeSabs,
      }, [state.buffer]);

      // Store the wait flag so proc_wait can block on it
      pendingWaits.set(pid, { flag: waitFlagView, exitCode: 0 });

      return pid;
    },

    proc_wait(pid, statusPtr) {
      const waiter = pendingWaits.get(pid);
      if (!waiter) return -1;

      // Block until child sets the flag
      if (Atomics.load(waiter.flag, 0) === 0) {
        Atomics.wait(waiter.flag, 0, 0, 30000); // 30s timeout
      }

      // Read exit code from SAB (set by main thread before notify)
      if (statusPtr) {
        const exitCode = Atomics.load(waiter.flag, 1);
        new DataView(memory.buffer).setInt32(statusPtr, exitCode, true);
      }

      pendingWaits.delete(pid);
      return pid;
    },
  };
}
