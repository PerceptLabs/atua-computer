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
      if (Atomics.load(control, 2) === 1) break; // closed = EOF
      if (bytesRead > 0) break; // partial read complete
      // UDP sockets are non-blocking (musl DNS resolver loops on recvfrom
      // expecting EAGAIN when no more datagrams are available).
      if (sock.isUdp) return -1;
      // TCP sockets block until data arrives (poll loop handles wait timing).
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
    // Debug: check if key files loaded
    const bashFile = vfs.files.get('/bin/bash');
    self.postMessage({ type: 'debug', message: `VFS loaded: ${vfs.files.size} files, /bin/bash = ${bashFile ? bashFile.length + ' bytes' : 'MISSING'}` });
    if (bashFile && bashFile.length >= 4) {
      self.postMessage({ type: 'debug', message: `bash magic: ${bashFile[0].toString(16)} ${bashFile[1].toString(16)} ${bashFile[2].toString(16)} ${bashFile[3].toString(16)}` });
    }
  }
  if (opts.files) {
    for (const [path, content] of Object.entries(opts.files)) {
      vfs.addFile(path, new Uint8Array(content));
    }
  }

  const args = opts.args || ['engine'];
  const env = opts.env || {};
  let cwd = '/';

  let inst;
  try {
    const result = await WebAssembly.instantiate(opts.engineWasm, {
      atua: createImports(args, env, () => cwd, (p) => { cwd = p; }),
    });
    inst = result.instance;
  } catch (err) {
    self.postMessage({ type: 'error', message: 'WASM instantiate failed: ' + err.message });
    return;
  }

  instance = inst;
  memory = instance.exports.memory;

  self.postMessage({ type: 'debug', message: 'calling _start' });
  try {
    instance.exports._start();
  } catch (err) {
    self.postMessage({ type: 'debug', message: 'engine exit: ' + err.message });
    if (!(err instanceof WebAssembly.RuntimeError && err.message.includes('unreachable'))) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }

  self.postMessage({ type: 'exit', code: 0 });
}

function createImports(args, env, getCwd, setCwd) {
  // Host syscall state (closure variables, not `this`)
  const hostState = { brk: 0 };
  const mmapFreelist = []; // {ptr, size} — reusable mmap regions

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

    term_get_size(rowsPtr, colsPtr) {
      /* Default 80x24. When xterm.js is integrated, read from the terminal. */
      const view = new DataView(memory.buffer);
      view.setInt32(rowsPtr, 24, true);
      view.setInt32(colsPtr, 80, true);
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
      const fd = vfs.open(path, flags, mode);
      if (fd >= 0 && (path.includes('bash') || path.includes('.so'))) {
        const file = vfs.openFiles.get(fd);
        if (file && file.content.length > 4) {
          const h = file.content;
          self.postMessage({ type: 'debug', message: `fs_open ${path} fd=${fd} len=${h.length} magic=${h[0].toString(16)} ${h[1].toString(16)} ${h[2].toString(16)} ${h[3].toString(16)}` });
        }
      }
      return fd;
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

    random_get(bufPtr, len) {
      const buf = new Uint8Array(memory.buffer, bufPtr, len);
      crypto.getRandomValues(buf);
    },

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

    /* ── host_syscall: musl libc's single entry point into JS ─────────── */
    /* Upstream musl routes ALL libc I/O through __syscall(SYS_*, ...).
       syscall_arch.h maps this to atua.host_syscall. Linux x86-64 numbers. */

    host_syscall(n, a, b, c, d, e, f) {
      // Log last HOST syscall for debugging hangs
      self._lastSyscall = n;
      switch (n) {
        /* Memory — must work before anything else (malloc depends on these) */
        case 12: { // SYS_brk
          if (!hostState.brk) {
            hostState.brk = memory.buffer.byteLength;
          }
          if (a === 0) return hostState.brk;
          const target = a >>> 0;
          const currentPages = memory.buffer.byteLength / 65536;
          const neededPages = Math.ceil(target / 65536);
          if (neededPages > currentPages) {
            try { memory.grow(neededPages - currentPages); } catch { return hostState.brk; }
          }
          hostState.brk = target;
          return hostState.brk;
        }
        case 9: { // SYS_mmap(addr, len, prot, flags, fd, offset)
          const len = b >>> 0;
          const flags = d;
          const MAP_ANONYMOUS = 0x20;
          let ptr;
          // Try freelist first (first-fit)
          for (let i = 0; i < mmapFreelist.length; i++) {
            if (mmapFreelist[i].size >= len) {
              ptr = mmapFreelist.splice(i, 1)[0].ptr;
              new Uint8Array(memory.buffer, ptr, len).fill(0);
              break;
            }
          }
          if (ptr === undefined) {
            // Freelist miss — grow memory
            const pages = Math.ceil(len / 65536);
            const oldPages = memory.buffer.byteLength / 65536;
            try { memory.grow(pages); } catch { return -12; /* ENOMEM */ }
            ptr = oldPages * 65536;
            new Uint8Array(memory.buffer, ptr, len).fill(0);
          }
          if (!(flags & MAP_ANONYMOUS)) {
            const file = vfs.openFiles.get(e);
            if (file) {
              const off = Number(f) || 0;
              const avail = Math.min(len, file.content.length - off);
              if (avail > 0) new Uint8Array(memory.buffer, ptr, avail).set(file.content.subarray(off, off + avail));
            }
          }
          return ptr;
        }
        case 10: return 0;  // SYS_mprotect — no-op
        case 11: { // SYS_munmap — return pages to freelist
          const ptr = a >>> 0;
          const len = b >>> 0;
          if (ptr && len) mmapFreelist.push({ ptr, size: len });
          return 0;
        }

        /* I/O */
        case 0: { // SYS_read(fd, buf, count)
          if (a <= 2) return 0; // stdin: HOST reads return EOF
          const file = vfs.openFiles.get(a);
          if (!file) return -9; // EBADF
          const dest = new Uint8Array(memory.buffer, b >>> 0, c >>> 0);
          const n2 = vfs.read(a, dest, file.position);
          file.position += n2;
          return n2;
        }
        case 1: { // SYS_write(fd, buf, count)
          const buf = new Uint8Array(memory.buffer, b >>> 0, c >>> 0);
          if (a === 1 || a === 2) {
            self.postMessage({ type: 'stdout', data: new Uint8Array(buf) });
            return c;
          }
          const file = vfs.openFiles.get(a);
          if (!file) return -9;
          vfs.write(a, buf, file.position);
          file.position += c;
          return c;
        }
        case 2: { // SYS_open(path, flags, mode)
          const path = readCString(a);
          const fd = vfs.open(path, b, c);
          if (fd >= 0) {
            const file = vfs.openFiles.get(fd);
            if (file && file.content.length > 4) {
              const h = file.content;
              if (path.includes('bash') || path.includes('.so'))
                console.log(`[open] ${path} fd=${fd} len=${h.length} magic=${h[0].toString(16)} ${h[1].toString(16)} ${h[2].toString(16)} ${h[3].toString(16)}`);
            }
          }
          return fd;
        }
        case 3: { // SYS_close(fd)
          vfs.close(a);
          return 0;
        }
        case 5: { // SYS_fstat(fd, statbuf)
          const file = vfs.openFiles.get(a);
          const size = file ? file.content.length : 0;
          const view = new DataView(memory.buffer);
          // wasm32 musl struct stat: 128 bytes
          // st_dev=0, st_ino=8, st_mode=16, st_nlink=20, st_size=48
          new Uint8Array(memory.buffer, b >>> 0, 128).fill(0);
          view.setBigUint64(b + 0, 1n, true);     // st_dev
          view.setBigUint64(b + 8, BigInt(a + 1000), true); // st_ino
          view.setUint32(b + 16, 0o100755, true);  // st_mode
          view.setUint32(b + 20, 1, true);         // st_nlink
          view.setBigInt64(b + 48, BigInt(size), true); // st_size
          view.setBigInt64(b + 56, 4096n, true);   // st_blksize
          return a <= 2 || file ? 0 : -9;
        }
        case 8: { // SYS_lseek(fd, offset, whence)
          const file = vfs.openFiles.get(a);
          if (!file) return -9;
          if (c === 0) file.position = b;          // SEEK_SET
          else if (c === 1) file.position += b;    // SEEK_CUR
          else if (c === 2) file.position = file.content.length + b; // SEEK_END
          return file.position;
        }
        case 17: { // SYS_pread64(fd, buf, count, offset_lo, offset_hi)
          const file = vfs.openFiles.get(a);
          if (!file) return -9;
          const dest = new Uint8Array(memory.buffer, b >>> 0, c >>> 0);
          const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
          return vfs.read(a, dest, offset);
        }
        case 295: { // SYS_preadv(fd, iov, iovcnt, offset_lo, offset_hi)
          const file = vfs.openFiles.get(a);
          if (!file) return -9;
          const view = new DataView(memory.buffer);
          const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
          let total = 0;
          for (let i = 0; i < c; i++) {
            const bufPtr = view.getUint32(b + i * 8, true);
            const bufLen = view.getUint32(b + i * 8 + 4, true);
            const dest = new Uint8Array(memory.buffer, bufPtr, bufLen);
            const n2 = vfs.read(a, dest, offset + total);
            total += n2;
            if (n2 < bufLen) break;
          }
          return total;
        }
        case 19: { // SYS_readv(fd, iov, iovcnt)
          const view = new DataView(memory.buffer);
          let total = 0;
          for (let i = 0; i < c; i++) {
            const bufPtr = view.getUint32(b + i * 8, true);
            const bufLen = view.getUint32(b + i * 8 + 4, true);
            if (a === 1 || a === 2) continue; // stdout/stderr: skip reads
            const file = vfs.openFiles.get(a);
            if (!file) return total > 0 ? total : -9;
            const dest = new Uint8Array(memory.buffer, bufPtr, bufLen);
            const n2 = vfs.read(a, dest, file.position);
            file.position += n2;
            total += n2;
            if (n2 < bufLen) break;
          }
          return total;
        }
        case 20: { // SYS_writev(fd, iov, iovcnt)
          const view = new DataView(memory.buffer);
          let total = 0;
          for (let i = 0; i < c; i++) {
            const bufPtr = view.getUint32(b + i * 8, true);
            const bufLen = view.getUint32(b + i * 8 + 4, true);
            const buf = new Uint8Array(memory.buffer, bufPtr, bufLen);
            if (a === 1 || a === 2) {
              self.postMessage({ type: 'stdout', data: new Uint8Array(buf) });
            } else {
              const file = vfs.openFiles.get(a);
              if (file) { vfs.write(a, buf, file.position); file.position += bufLen; }
            }
            total += bufLen;
          }
          return total;
        }
        case 257: { // SYS_openat(dirfd, path, flags, mode)
          const path = readCString(b);
          const fd = vfs.open(path, c, d);
          if (path.includes('bash') || path.includes('ld-linux'))
            self.postMessage({ type: 'debug', message: `openat ${path} → ${fd}` });
          return fd;
        }

        /* Stat */
        case 4: { // SYS_stat
          const path = readCString(a);
          const info = vfs.stat(path);
          if (!info) return -2;
          new Uint8Array(memory.buffer, b >>> 0, 128).fill(0);
          const view = new DataView(memory.buffer);
          view.setUint32(b + 16, info.type === 'dir' ? 0o40755 : 0o100755, true);
          view.setBigInt64(b + 48, BigInt(info.size), true);
          return 0;
        }
        case 6: { // SYS_lstat — same as stat (no symlinks in VFS)
          const path = readCString(a);
          const info = vfs.stat(path);
          if (!info) return -2;
          new Uint8Array(memory.buffer, b >>> 0, 128).fill(0);
          const view = new DataView(memory.buffer);
          view.setUint32(b + 16, info.type === 'dir' ? 0o40755 : 0o100755, true);
          view.setBigInt64(b + 48, BigInt(info.size), true);
          return 0;
        }
        case 262: { // SYS_fstatat/newfstatat(dirfd, path, statbuf, flags)
          const path = readCString(b);
          const info = vfs.stat(path);
          if (!info) return -2;
          new Uint8Array(memory.buffer, c >>> 0, 128).fill(0);
          const view = new DataView(memory.buffer);
          view.setUint32(c + 16, info.type === 'dir' ? 0o40755 : 0o100755, true);
          view.setBigInt64(c + 48, BigInt(info.size), true);
          return 0;
        }

        /* Process */
        case 39: return 1;   // SYS_getpid
        case 110: return 0;  // SYS_getppid
        case 102: return 0;  // SYS_getuid
        case 104: return 0;  // SYS_getgid
        case 107: return 0;  // SYS_geteuid
        case 108: return 0;  // SYS_getegid
        case 186: return 1;  // SYS_gettid
        case 218: return 1;  // SYS_set_tid_address
        case 273: return 0;  // SYS_set_robust_list
        case 205: return 0;  // SYS_set_thread_area — no-op (single-threaded)

        /* Signals — no-op on wasm32 */
        case 13: return 0;   // SYS_rt_sigaction
        case 14: return 0;   // SYS_rt_sigprocmask
        case 127: return 0;  // SYS_rt_sigpending
        case 131: return 0;  // SYS_sigaltstack

        /* Time */
        case 228: { // SYS_clock_gettime(clockid, timespec_ptr)
          const ns = BigInt(Math.floor(Date.now() * 1e6));
          const view = new DataView(memory.buffer);
          view.setBigInt64(b >>> 0, ns / 1000000000n, true);      // tv_sec
          view.setBigInt64((b >>> 0) + 8, ns % 1000000000n, true); // tv_nsec
          return 0;
        }
        case 229: { // SYS_clock_getres
          const view = new DataView(memory.buffer);
          view.setBigInt64(b >>> 0, 0n, true);
          view.setBigInt64((b >>> 0) + 8, 1000000n, true); // 1ms
          return 0;
        }
        case 35: { // SYS_nanosleep(req, rem)
          const view = new DataView(memory.buffer);
          const sec = Number(view.getBigInt64(a >>> 0, true));
          const nsec = Number(view.getBigInt64((a >>> 0) + 8, true));
          const ms = sec * 1000 + Math.floor(nsec / 1000000);
          if (ms > 0) {
            if (!self._sleepSab) self._sleepSab = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(self._sleepSab, 0, 0, ms);
          }
          return 0;
        }

        /* Random */
        case 318: { // SYS_getrandom(buf, len, flags)
          const buf = new Uint8Array(memory.buffer, a >>> 0, b >>> 0);
          crypto.getRandomValues(buf);
          return b;
        }

        /* Filesystem metadata */
        case 16: return -25;  // SYS_ioctl → ENOTTY (HOST ioctl, not guest)
        case 72: { // SYS_fcntl(fd, cmd, arg)
          const F_DUPFD = 0, F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4;
          const F_DUPFD_CLOEXEC = 1030;
          if (b === F_GETFD || b === F_SETFD) return 0;
          if (b === F_GETFL) return 0; // O_RDONLY
          if (b === F_SETFL) return 0;
          if (b === F_DUPFD || b === F_DUPFD_CLOEXEC) return a; // return same fd
          return 0;
        }
        case 79: { // SYS_getcwd(buf, size)
          const cwd = getCwd();
          const bytes = new TextEncoder().encode(cwd);
          if (bytes.length + 1 > b) return -34; // ERANGE
          new Uint8Array(memory.buffer, a >>> 0, bytes.length + 1).set([...bytes, 0]);
          return a;
        }
        case 63: { // SYS_uname(buf)
          // struct utsname: 5 fields of 65 bytes each
          const buf = new Uint8Array(memory.buffer, a >>> 0, 325);
          buf.fill(0);
          const fields = ['Linux', 'atua', '6.1.0', '#1', 'x86_64'];
          for (let i = 0; i < 5; i++) {
            const bytes = new TextEncoder().encode(fields[i]);
            buf.set(bytes, i * 65);
          }
          return 0;
        }
        case 269: { // SYS_faccessat(dirfd, path, mode, flags)
          const path = readCString(b);
          const info = vfs.stat(path);
          return info ? 0 : -2; // ENOENT
        }
        case 121: return 0; // SYS_getpgid → return 0
        case 332: { // SYS_statx(dirfd, path, flags, mask, statx_buf)
          const path = readCString(b);
          const info = vfs.stat(path);
          if (!info) return -2;
          // statx struct: flags(4) + pad(4) + ... mode at offset 16, size at offset 40
          new Uint8Array(memory.buffer, e >>> 0, 256).fill(0);
          const view = new DataView(memory.buffer);
          view.setUint32(e + 0, 0xFFF, true); // stx_mask = all fields valid
          view.setUint32(e + 16, info.type === 'dir' ? 0o40755 : 0o100755, true); // stx_mode
          view.setUint32(e + 20, 1, true); // stx_nlink
          view.setBigUint64(e + 40, BigInt(info.size), true); // stx_size
          return 0;
        }
        case 302: { // SYS_prlimit64(pid, resource, new, old)
          if (d) { // old pointer — return defaults
            const view = new DataView(memory.buffer);
            view.setBigUint64(d >>> 0, 1024n, true);               // rlim_cur
            view.setBigUint64((d >>> 0) + 8, 1024n, true);         // rlim_max
          }
          return 0;
        }

        /* Exit / abort */
        case 60:  // SYS_exit
        case 231: // SYS_exit_group
        case 62:  // SYS_kill (abort sends SIGABRT via kill)
        case 200: // SYS_tkill
        case 234: // SYS_tgkill
          throw new WebAssembly.RuntimeError('unreachable');

        /* I/O: dup, pipe, directory, link, truncate */
        case 32: return a;    // SYS_dup → return same fd
        case 33: return b;    // SYS_dup2 → return newfd
        case 292: return b;   // SYS_dup3 → return newfd
        case 22: return -38;  // SYS_pipe → ENOSYS (Blink handles guest pipes)
        case 293: return -38; // SYS_pipe2 → ENOSYS (Blink handles guest pipes)
        case 18: { // SYS_pwrite64(fd, buf, count, offset_lo, offset_hi)
          const file = vfs.openFiles.get(a);
          if (!file) return -9; // EBADF
          const src = new Uint8Array(memory.buffer, b >>> 0, c >>> 0);
          const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
          vfs.write(a, src, offset);
          return c;
        }
        case 77: { // SYS_ftruncate(fd, length)
          const file = vfs.openFiles.get(a);
          if (!file) return -9;
          const newLen = b >>> 0;
          const old = file.content;
          if (newLen < old.length) {
            file.content = old.subarray(0, newLen);
          } else if (newLen > old.length) {
            const expanded = new Uint8Array(newLen);
            expanded.set(old);
            file.content = expanded;
          }
          vfs.files.set(file.path, file.content);
          return 0;
        }
        case 83: case 258: { // SYS_mkdir / SYS_mkdirat
          const path = readCString(n === 83 ? a : b);
          vfs.dirs.add(path.startsWith('/') ? path : '/' + path);
          return 0;
        }
        case 87: case 263: { // SYS_unlink / SYS_unlinkat
          const path = readCString(n === 87 ? a : b);
          const norm = path.startsWith('/') ? path : '/' + path;
          vfs.files.delete(norm);
          return 0;
        }
        case 82: case 264: case 316: { // SYS_rename / SYS_renameat / SYS_renameat2
          const oldPath = readCString(n === 82 ? a : b);
          const newPath = readCString(n === 82 ? b : (n === 264 ? d : d));
          const normOld = oldPath.startsWith('/') ? oldPath : '/' + oldPath;
          const normNew = newPath.startsWith('/') ? newPath : '/' + newPath;
          const content = vfs.files.get(normOld);
          if (!content) return -2;
          vfs.files.set(normNew, content);
          vfs.files.delete(normOld);
          return 0;
        }
        case 89: case 267: return -2; // SYS_readlink(at) → ENOENT (no symlinks)
        case 217: { // SYS_getdents64(fd, dirp, count)
          // Minimal: return 0 (end of directory) — VFS doesn't track dir handles
          return 0;
        }

        /* Process/signal (single-process defaults) */
        case 21: return -2;   // SYS_access → ENOENT
        case 24: return 0;    // SYS_sched_yield
        case 25: return -38;  // SYS_mremap → ENOSYS
        case 28: return 0;    // SYS_madvise → no-op
        case 56: return -38;  // SYS_clone → ENOSYS (Blink handles)
        case 57: return -38;  // SYS_fork → ENOSYS (Blink handles)
        case 59: return -38;  // SYS_execve → ENOSYS (Blink handles)
        case 61: return -10;  // SYS_wait4 → ECHILD (no HOST children)
        case 95: return 0o22; // SYS_umask → return old mask
        case 96: { // SYS_gettimeofday(tv, tz)
          if (a) {
            const now = Date.now();
            const view = new DataView(memory.buffer);
            view.setBigInt64(a >>> 0, BigInt(Math.floor(now / 1000)), true);       // tv_sec
            view.setBigInt64((a >>> 0) + 8, BigInt((now % 1000) * 1000), true);    // tv_usec
          }
          return 0;
        }
        case 97: return 0;    // SYS_getrlimit
        case 98: { // SYS_getrusage
          new Uint8Array(memory.buffer, b >>> 0, 144).fill(0);
          return 0;
        }
        case 100: { // SYS_times(buf)
          if (a) new Uint8Array(memory.buffer, a >>> 0, 32).fill(0);
          return 0;
        }
        case 105: return 0;   // SYS_setuid
        case 106: return 0;   // SYS_setgid
        case 109: return 0;   // SYS_setpgid
        case 111: return 0;   // SYS_getpgrp
        case 112: return 1;   // SYS_setsid
        case 113: return 0;   // SYS_setreuid
        case 114: return 0;   // SYS_setregid
        case 117: return 0;   // SYS_setresuid
        case 118: { // SYS_getresuid(ruid, euid, suid)
          if (a) new DataView(memory.buffer).setUint32(a >>> 0, 0, true);
          if (b) new DataView(memory.buffer).setUint32(b >>> 0, 0, true);
          if (c) new DataView(memory.buffer).setUint32(c >>> 0, 0, true);
          return 0;
        }
        case 119: return 0;   // SYS_setresgid
        case 120: { // SYS_getresgid(rgid, egid, sgid)
          if (a) new DataView(memory.buffer).setUint32(a >>> 0, 0, true);
          if (b) new DataView(memory.buffer).setUint32(b >>> 0, 0, true);
          if (c) new DataView(memory.buffer).setUint32(c >>> 0, 0, true);
          return 0;
        }
        case 124: return 0;   // SYS_getsid
        case 15: return 0;    // SYS_rt_sigreturn
        case 157: return 0;   // SYS_prctl
        case 158: return 0;   // SYS_arch_prctl
        case 160: return 0;   // SYS_setrlimit
        case 247: return -38; // SYS_waitid → ENOSYS

        /* Filesystem metadata stubs */
        case 90: return 0;    // SYS_chmod
        case 91: return 0;    // SYS_fchmod
        case 92: return 0;    // SYS_chown
        case 93: return 0;    // SYS_fchown
        case 94: return 0;    // SYS_lchown
        case 132: return 0;   // SYS_utime
        case 280: return 0;   // SYS_utimensat
        case 133: return -38; // SYS_mknod → ENOSYS
        case 137: return 0;   // SYS_statfs → return ENOSYS? Let's try 0
        case 138: return 0;   // SYS_fstatfs
        case 191: return 0;   // SYS_getxattr → return 0 (no attrs)
        case 192: return 0;   // SYS_lgetxattr
        case 193: return 0;   // SYS_fgetxattr
        case 197: return -38; // SYS_removexattr
        case 198: return -38; // SYS_lremovexattr
        case 199: return -38; // SYS_fremovexattr
        case 74: return 0;    // SYS_fsync
        case 75: return 0;    // SYS_fdatasync
        case 76: return 0;    // SYS_truncate
        case 80: return 0;    // SYS_chdir (HOST) — Blink handles guest chdir
        case 161: return 0;   // SYS_chroot → no-op
        case 162: return 0;   // SYS_sync

        /* Network stubs (HOST doesn't use sockets — guest sockets go through Blink) */
        case 41: return -97;  // SYS_socket → EAFNOSUPPORT (HOST shouldn't create sockets)
        case 42: return -38;  // SYS_connect
        case 43: return -38;  // SYS_accept
        case 44: return -38;  // SYS_sendto
        case 45: return -38;  // SYS_recvfrom
        case 46: return -38;  // SYS_sendmsg
        case 47: return -38;  // SYS_recvmsg
        case 48: return -38;  // SYS_shutdown
        case 49: return -38;  // SYS_bind
        case 50: return -38;  // SYS_listen
        case 51: return 0;    // SYS_getsockname → success (musl probes this)
        case 52: return 0;    // SYS_getpeername
        case 53: return -38;  // SYS_socketpair
        case 54: return 0;    // SYS_setsockopt
        case 55: return 0;    // SYS_getsockopt
        case 7: return 0;     // SYS_poll → 0 events ready
        case 23: return 0;    // SYS_select → 0 ready

        /* Impossible in browser */
        case 101: return -38; // SYS_ptrace
        case 165: return -38; // SYS_mount
        case 166: return -38; // SYS_umount2
        case 169: return -38; // SYS_reboot

        default: {
          const NAMES = {0:'read',1:'write',2:'open',3:'close',4:'stat',5:'fstat',6:'lstat',7:'poll',8:'lseek',9:'mmap',10:'mprotect',11:'munmap',12:'brk',13:'rt_sigaction',14:'rt_sigprocmask',15:'rt_sigreturn',16:'ioctl',17:'pread64',18:'pwrite64',19:'readv',20:'writev',21:'access',22:'pipe',23:'select',24:'sched_yield',25:'mremap',28:'madvise',32:'dup',33:'dup2',35:'nanosleep',39:'getpid',41:'socket',42:'connect',43:'accept',44:'sendto',45:'recvfrom',46:'sendmsg',47:'recvmsg',48:'shutdown',49:'bind',50:'listen',51:'getsockname',52:'getpeername',53:'socketpair',54:'setsockopt',55:'getsockopt',56:'clone',57:'fork',59:'execve',60:'exit',61:'wait4',62:'kill',63:'uname',72:'fcntl',77:'ftruncate',78:'getdents',79:'getcwd',80:'chdir',82:'rename',83:'mkdir',87:'unlink',89:'readlink',90:'chmod',95:'umask',96:'gettimeofday',97:'getrlimit',98:'getrusage',100:'times',102:'getuid',104:'getgid',105:'setuid',106:'setgid',107:'geteuid',108:'getegid',109:'setpgid',110:'getppid',112:'setsid',113:'setreuid',114:'setregid',117:'setresuid',118:'getresuid',119:'setresgid',120:'getresgid',121:'getpgid',124:'getsid',131:'sigaltstack',157:'prctl',158:'arch_prctl',160:'setrlimit',186:'gettid',200:'tkill',205:'set_thread_area',217:'getdents64',218:'set_tid_address',228:'clock_gettime',229:'clock_getres',231:'exit_group',234:'tgkill',257:'openat',262:'newfstatat',263:'unlinkat',267:'readlinkat',269:'faccessat',273:'set_robust_list',293:'pipe2',295:'preadv',302:'prlimit64',316:'renameat2',318:'getrandom',332:'statx'};
          console.warn('[host_syscall] unhandled:', n, NAMES[n] || 'unknown');
          return -38; // ENOSYS
        }
      }
    },

    PLACEHOLDER_fd_read(fd, iovs_ptr, iovs_len, nread_ptr) {
      const view = new DataView(memory.buffer);
      let totalRead = 0;
      for (let i = 0; i < iovs_len; i++) {
        const bufPtr = view.getUint32(iovs_ptr + i * 8, true);
        const bufLen = view.getUint32(iovs_ptr + i * 8 + 4, true);
        if (fd <= 2) {
          // stdin: handled by term_read path (via Blink's SysRead)
          // For HOST libc reads on stdin, return 0 (EOF)
          break;
        }
        const file = vfs.openFiles.get(fd);
        if (!file) { view.setUint32(nread_ptr, 0, true); return 8; } // EBADF
        const dest = new Uint8Array(memory.buffer, bufPtr, bufLen);
        const n = vfs.read(fd, dest, file.position);
        file.position += n;
        totalRead += n;
        if (n < bufLen) break;
      }
      view.setUint32(nread_ptr, totalRead, true);
      return 0;
    },

    fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) {
      const view = new DataView(memory.buffer);
      let totalWritten = 0;
      for (let i = 0; i < iovs_len; i++) {
        const bufPtr = view.getUint32(iovs_ptr + i * 8, true);
        const bufLen = view.getUint32(iovs_ptr + i * 8 + 4, true);
        if (fd === 1 || fd === 2) {
          const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
          self.postMessage({ type: 'stdout', data: new Uint8Array(bytes) });
        } else {
          const file = vfs.openFiles.get(fd);
          if (file) {
            const src = new Uint8Array(memory.buffer, bufPtr, bufLen);
            vfs.write(fd, src, file.position);
            file.position += bufLen;
          }
        }
        totalWritten += bufLen;
      }
      view.setUint32(nwritten_ptr, totalWritten, true);
      return 0;
    },

    fd_pread(fd, iovs_ptr, iovs_len, offset, nread_ptr) {
      const view = new DataView(memory.buffer);
      let totalRead = 0;
      const off = Number(offset);
      for (let i = 0; i < iovs_len; i++) {
        const bufPtr = view.getUint32(iovs_ptr + i * 8, true);
        const bufLen = view.getUint32(iovs_ptr + i * 8 + 4, true);
        const dest = new Uint8Array(memory.buffer, bufPtr, bufLen);
        const n = vfs.read(fd, dest, off + totalRead);
        totalRead += n;
        if (n < bufLen) break;
      }
      view.setUint32(nread_ptr, totalRead, true);
      return 0;
    },

    fd_pwrite(fd, iovs_ptr, iovs_len, offset, nwritten_ptr) {
      const view = new DataView(memory.buffer);
      let totalWritten = 0;
      const off = Number(offset);
      for (let i = 0; i < iovs_len; i++) {
        const bufPtr = view.getUint32(iovs_ptr + i * 8, true);
        const bufLen = view.getUint32(iovs_ptr + i * 8 + 4, true);
        const src = new Uint8Array(memory.buffer, bufPtr, bufLen);
        vfs.write(fd, src, off + totalWritten);
        totalWritten += bufLen;
      }
      view.setUint32(nwritten_ptr, totalWritten, true);
      return 0;
    },

    path_open(dirfd, dirflags, path_ptr, path_len, oflags, rights_base, rights_inh, fdflags, fd_ptr) {
      const pathBytes = new Uint8Array(memory.buffer, path_ptr, path_len);
      let path = new TextDecoder().decode(pathBytes);
      if (!path.startsWith('/')) path = '/' + path;
      const handle = vfs.open(path, oflags | fdflags, 0o666);
      if (handle < 0) return 44; // ENOENT
      new DataView(memory.buffer).setUint32(fd_ptr, handle, true);
      return 0;
    },

    fd_close(fd) {
      vfs.close(fd);
      return 0;
    },

    fd_seek(fd, offset, whence, newoffset_ptr) {
      const file = vfs.openFiles.get(fd);
      if (!file) return 8; // EBADF
      const off = Number(offset);
      if (whence === 0) file.position = off;        // SEEK_SET
      else if (whence === 1) file.position += off;   // SEEK_CUR
      else if (whence === 2) file.position = file.content.length + off; // SEEK_END
      new DataView(memory.buffer).setBigUint64(newoffset_ptr, BigInt(file.position), true);
      return 0;
    },

    fd_tell(fd, offset_ptr) {
      const file = vfs.openFiles.get(fd);
      if (!file) return 8;
      new DataView(memory.buffer).setBigUint64(offset_ptr, BigInt(file.position), true);
      return 0;
    },

    fd_fdstat_get(fd, stat_ptr) {
      const view = new DataView(memory.buffer);
      // fs_filetype (u8), fs_flags (u16), padding, fs_rights_base (u64), fs_rights_inh (u64)
      view.setUint8(stat_ptr, fd <= 2 ? 2 : 4); // 2=CHAR_DEVICE, 4=REGULAR_FILE
      view.setUint16(stat_ptr + 2, 0, true); // flags
      // Use DataView to write 64-bit values
      view.setBigUint64(stat_ptr + 8, 0xFFFFFFFFFFFFFFFFn, true); // all rights
      view.setBigUint64(stat_ptr + 16, 0xFFFFFFFFFFFFFFFFn, true);
      return 0;
    },

    fd_fdstat_set_flags(fd, flags) { return 0; },
    fd_fdstat_set_rights(fd, base, inh) { return 0; },

    fd_filestat_get(fd, stat_ptr) {
      const file = vfs.openFiles.get(fd);
      const size = file ? file.content.length : 0;
      const view = new DataView(memory.buffer);
      // wasi_filestat: dev(8) ino(8) filetype(1) pad(7) nlink(8) size(8) atim(8) mtim(8) ctim(8)
      view.setBigUint64(stat_ptr, 1n, true); // dev
      view.setBigUint64(stat_ptr + 8, BigInt(fd + 1000), true); // ino
      view.setUint8(stat_ptr + 16, fd <= 2 ? 2 : 4); // filetype
      view.setBigUint64(stat_ptr + 24, 1n, true); // nlink
      view.setBigUint64(stat_ptr + 32, BigInt(size), true); // size
      return 0;
    },

    fd_filestat_set_size(fd, size) { return 0; },
    fd_filestat_set_times(fd, atim, mtim, flags) { return 0; },

    fd_prestat_get(fd, prestat_ptr) {
      if (fd === 3) {
        const view = new DataView(memory.buffer);
        view.setUint32(prestat_ptr, 0, true); // tag = DIR
        view.setUint32(prestat_ptr + 4, 1, true); // name_len = 1 ("/")
        return 0;
      }
      return 8; // EBADF
    },

    fd_prestat_dir_name(fd, path_ptr, path_len) {
      if (fd === 3 && path_len >= 1) {
        new Uint8Array(memory.buffer)[path_ptr] = 0x2F; // '/'
        return 0;
      }
      return 8;
    },

    fd_advise() { return 0; },
    fd_allocate() { return 0; },
    fd_datasync(fd) { return 0; },
    fd_sync(fd) { return 0; },
    fd_renumber(from, to) { return 0; },
    fd_readdir(fd, buf_ptr, buf_len, cookie, bufused_ptr) {
      new DataView(memory.buffer).setUint32(bufused_ptr, 0, true);
      return 0;
    },

    path_filestat_get(dirfd, flags, path_ptr, path_len, stat_ptr) {
      const pathBytes = new Uint8Array(memory.buffer, path_ptr, path_len);
      let path = new TextDecoder().decode(pathBytes);
      if (!path.startsWith('/')) path = '/' + path;
      const info = vfs.stat(path);
      if (!info) return 44; // ENOENT
      const view = new DataView(memory.buffer);
      view.setBigUint64(stat_ptr, 1n, true); // dev
      view.setBigUint64(stat_ptr + 8, BigInt(path.length), true); // ino
      view.setUint8(stat_ptr + 16, info.type === 'dir' ? 3 : 4); // filetype
      view.setBigUint64(stat_ptr + 24, 1n, true); // nlink
      view.setBigUint64(stat_ptr + 32, BigInt(info.size), true); // size
      return 0;
    },

    path_filestat_set_times() { return 0; },
    path_create_directory() { return 0; },
    path_link() { return 52; }, // ENOSYS
    path_readlink(dirfd, path_ptr, path_len, buf_ptr, buf_len, bufused_ptr) {
      new DataView(memory.buffer).setUint32(bufused_ptr, 0, true);
      return 52;
    },
    path_remove_directory() { return 52; },
    path_rename() { return 52; },
    path_symlink() { return 52; },
    path_unlink_file() { return 52; },

    clock_res_get(id, resolution_ptr) {
      new DataView(memory.buffer).setBigUint64(resolution_ptr, 1000n, true);
      return 0;
    },

    clock_time_get(id, precision, time_ptr) {
      const ns = BigInt(Math.floor(Date.now() * 1000000));
      new DataView(memory.buffer).setBigUint64(time_ptr, ns, true);
      return 0;
    },

    proc_exit(code) {
      throw new WebAssembly.RuntimeError('unreachable');
    },

    poll_oneoff(in_ptr, out_ptr, nsubscriptions, nevents_ptr) {
      /* Handle clock subscriptions (nanosleep). For clock events, yield
         via Atomics.wait. Report all events as ready. */
      const view = new DataView(memory.buffer);
      let sleepMs = 0;
      // subscription_t is 48 bytes: userdata(8) + tag(1) + pad(7) + union(32)
      for (let i = 0; i < nsubscriptions; i++) {
        const base = in_ptr + i * 48;
        const tag = view.getUint8(base + 8);
        if (tag === 0) { // EVENTTYPE_CLOCK
          // clock union: id(4) + pad(4) + timeout(8) + ...
          const timeoutNs = view.getBigUint64(base + 24, true);
          const ms = Number(timeoutNs / 1000000n);
          if (ms > sleepMs) sleepMs = ms;
        }
      }
      if (sleepMs > 0) {
        if (!self._sleepSab) self._sleepSab = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(self._sleepSab, 0, 0, sleepMs);
      }
      // Write events: event_t is 32 bytes: userdata(8) + error(2) + type(1) + pad(5) + fd_readwrite(16)
      let count = 0;
      for (let i = 0; i < nsubscriptions; i++) {
        const subBase = in_ptr + i * 48;
        const evtBase = out_ptr + count * 32;
        const userdata = view.getBigUint64(subBase, true);
        view.setBigUint64(evtBase, userdata, true);
        view.setUint16(evtBase + 8, 0, true); // error = 0
        view.setUint8(evtBase + 10, view.getUint8(subBase + 8)); // type
        count++;
      }
      view.setUint32(nevents_ptr, count, true);
      return 0;
    },

    sched_yield() { return 0; },
    sock_accept() { return 52; },
    sock_recv() { return 52; },
    sock_send() { return 52; },
    sock_shutdown() { return 52; },
    'thread-spawn'() { return 52; },

    /* ── End WASI P1 imports ──────────────────────────────────────────── */

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
      // type: 1=SOCK_STREAM (TCP), 2=SOCK_DGRAM (UDP)
      const isUdp = (type === 2);
      sockets.set(sockId, { sab, control, data, isDns: false, isUdp, peerPort: 0 });
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
        // DNS port 53 — DoH handles resolution, not the relay.
        return 0;
      }
      const isLoopback = ip === '127.0.0.1' || ip === '0.0.0.0' || ip.startsWith('127.');
      if (isLoopback && sock.isUdp) {
        // UDP loopback — musl's AI_ADDRCONFIG probe. No-op success.
        return 0;
      }
      self.postMessage({ type: 'socket-connect', sockId: id, ip, port });
      // Block until main thread signals connect result
      while (Atomics.load(sock.control, 3) === 0) {
        Atomics.wait(sock.control, 3, 0, 5000);
      }
      const result = Atomics.load(sock.control, 3);
      return result === 1 ? 0 : -1;
    },

    socket_send(sockId, bufPtr, len) {
      const id = sockId - 300;
      const sock = sockets.get(id);
      if (!sock) return -1;
      const data = new Uint8Array(memory.buffer, bufPtr, len).slice();
      if (sock.isDns || sock.isUdp) {
        // UDP sends are DNS queries — route to main thread DoH resolver.
        // musl's resolver may use sendto() without connect(), so isDns
        // might not be set. All UDP traffic in this runtime is DNS.
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
      const buf = new Uint8Array(memory.buffer, bufPtr, len);
      const n = socketRecvToArray(id, buf, len);
      return n;
    },

    socket_close(sockId) {
      const id = sockId - 300;
      self.postMessage({ type: 'socket-close', sockId: id });
      sockets.delete(id);
    },

    sleep_ms(ms) {
      // Use Atomics.wait on a dummy SAB to yield the thread for ms milliseconds.
      // This lets the main thread's event loop process socket messages.
      if (!self._sleepSab) self._sleepSab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(self._sleepSab, 0, 0, ms > 0 ? ms : 1);
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
      self.postMessage({ type: 'debug', message: 'fork_spawn called, stateLen=' + stateLen });
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
