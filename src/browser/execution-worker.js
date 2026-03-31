/**
 * execution-worker.js — Unified execution worker for atua-computer kernel architecture.
 *
 * Replaces BOTH engine-main-worker.js and engine-worker.js. Every process
 * (parent PID 1 and forked children) runs this IDENTICAL code.
 *
 * Architecture:
 *   - Runs engine.wasm (Blink x86-64 emulator)
 *   - ALL I/O syscalls trap to a Kernel Worker via SharedArrayBuffer + Atomics
 *   - Local-only WASM imports: term_write, term_read, term_get_size,
 *     random_get, clock_gettime, sleep_ms, args/environ
 *   - Everything else traps to kernel via trapToKernel()
 *
 * SAB Protocol (per worker):
 *   controlSab: SharedArrayBuffer(256) — Int32Array view
 *     [0]=trap_flag, [1]=syscall_number, [2-7]=args a-f, [8]=return_value
 *   wakeChannel: SharedArrayBuffer(4) — shared by ALL workers, notifies kernel
 *   WASM memory: SharedArrayBuffer — kernel reads/writes guest memory directly
 *
 * Message types from orchestrator:
 *   { type: 'boot', controlSab, wakeChannel, pid, engineModule, args, env, stdinSab }
 *   { type: 'restore-fork', controlSab, wakeChannel, pid, engineModule, forkState, forkStateLen, guestPagesSab }
 *   { type: 'fork-exec', controlSab, wakeChannel, pid, engineModule, path, argv, env }
 *   { type: 'reset' }
 *
 * Messages TO orchestrator:
 *   { type: 'memory-ready', pid, wasmMemoryBuffer } — sent after instantiation so kernel can access shared memory
 */

/* ─── Module-level state ──────────────────────────────────────────────────── */

let memory = null;
let instance = null;
let sharedMemory = null;

// Local pipe fd cache — workers do direct pipe I/O via SAB (CheerpX pattern)
// Pipe data flows worker-to-worker, kernel only manages metadata.
const localPipeFds = new Map(); // fd → { pipeId, sab, control: Int32Array, data: Uint8Array, end: 0|1 }

/* ─── Custom syscall numbers for Blink-specific imports ───────────────────── */

const SYS_FS_OPEN         = 1000;
const SYS_FS_READ         = 1001;
const SYS_FS_WRITE        = 1002;
const SYS_FS_CLOSE        = 1003;
const SYS_FS_FSTAT        = 1004;
const SYS_FS_STAT         = 1005;
const SYS_FS_READDIR      = 1006;
const SYS_PAGE_POOL_FAULT = 1007;
const SYS_REGISTER_FILEMAP = 1008;
const SYS_FORK_SPAWN      = 1009;
const SYS_FORK_EXEC_SPAWN = 1010;
const SYS_PROC_WAIT       = 1011;
const SYS_PIPE_CREATE     = 1012;
const SYS_PIPE_READ       = 1013;
const SYS_PIPE_WRITE      = 1014;
const SYS_PIPE_CLOSE      = 1015;
const SYS_SOCKET_OPEN     = 1016;
const SYS_SOCKET_CONNECT  = 1017;
const SYS_SOCKET_SEND     = 1018;
const SYS_SOCKET_RECV     = 1019;
const SYS_SOCKET_CLOSE    = 1020;
const SYS_SOCKET_POLL     = 1021;
const SYS_GETCWD          = 1022;
const SYS_CHDIR           = 1023;
const SYS_HOST_SYSCALL    = 1024;

/* ─── SAB trap to kernel ──────────────────────────────────────────────────── */

/**
 * Trap to the kernel worker via SharedArrayBuffer + Atomics.
 * This is the core IPC mechanism — 10 lines that replace thousands of lines
 * of duplicated I/O logic.
 *
 * Protocol:
 *   1. Write syscall number and args into controlSab
 *   2. Set request_flag = 1
 *   3. Notify kernel via wakeChannel
 *   4. Atomics.wait on response_flag until kernel sets it to 1
 *   5. Read return value from controlSab[9]
 */
/* ─── Local pipe I/O (CheerpX pattern) ────────────────────────────────────── */
/* Workers read/write pipes directly via SharedArrayBuffer. The kernel never
   touches pipe data — only manages the fd table. Workers use Atomics.wait()
   to block on empty pipes without blocking the kernel or other workers. */

const PIPE_BUF_SIZE = 64 * 1024;

function localPipeRead(fd, bufPtr, count) {
  const pipe = localPipeFds.get(fd);
  if (!pipe || pipe.end !== 0) return -9; // EBADF — not a read end
  const { control, data } = pipe;
  const cap = data.length;
  const maxCount = Math.min(count >>> 0, cap);
  let bytesRead = 0;

  while (bytesRead < maxCount) {
    const wp = Atomics.load(control, 0);
    const rp = Atomics.load(control, 1);
    if (rp === wp) {
      if (Atomics.load(control, 2) === 1) break; // write end closed = EOF
      if (bytesRead > 0) break;
      // Block until writer notifies — only blocks THIS worker
      Atomics.wait(control, 0, wp, 5000);
      continue;
    }
    new Uint8Array(memory.buffer)[(bufPtr >>> 0) + bytesRead] = data[rp];
    Atomics.store(control, 1, (rp + 1) % cap);
    bytesRead++;
  }
  return bytesRead;
}

function localPipeWrite(fd, bufPtr, count) {
  const pipe = localPipeFds.get(fd);
  if (!pipe || pipe.end !== 1) return -9; // EBADF — not a write end
  const { control, data } = pipe;
  const cap = data.length;
  const len = count >>> 0;
  let written = 0;

  for (let i = 0; i < len; i++) {
    const wp = Atomics.load(control, 0);
    const next = (wp + 1) % cap;
    if (next === Atomics.load(control, 1)) break; // pipe full
    data[wp] = new Uint8Array(memory.buffer)[(bufPtr >>> 0) + i];
    Atomics.store(control, 0, next);
    written++;
  }
  Atomics.notify(control, 0); // wake any blocked reader
  return written;
}

function localPipeReadv(fd, iovPtr, iovcnt) {
  const pipe = localPipeFds.get(fd);
  if (!pipe || pipe.end !== 0) return -9;
  const dv = new DataView(memory.buffer);
  let totalRead = 0;

  for (let i = 0; i < iovcnt; i++) {
    const base = dv.getUint32(iovPtr + i * 8, true);
    const len = dv.getUint32(iovPtr + i * 8 + 4, true);
    const { control, data } = pipe;
    const cap = data.length;
    let bytesRead = 0;

    while (bytesRead < len) {
      const wp = Atomics.load(control, 0);
      const rp = Atomics.load(control, 1);
      if (rp === wp) {
        if (Atomics.load(control, 2) === 1) break;
        if (totalRead + bytesRead > 0) break;
        Atomics.wait(control, 0, wp, 5000);
        continue;
      }
      new Uint8Array(memory.buffer)[base + bytesRead] = data[rp];
      Atomics.store(control, 1, (rp + 1) % cap);
      bytesRead++;
    }
    totalRead += bytesRead;
    if (bytesRead < len) break;
  }
  return totalRead;
}

function localPipeWritev(fd, iovPtr, iovcnt) {
  const pipe = localPipeFds.get(fd);
  if (!pipe || pipe.end !== 1) return -9;
  const dv = new DataView(memory.buffer);
  const { control, data } = pipe;
  const cap = data.length;
  let totalWritten = 0;

  for (let i = 0; i < iovcnt; i++) {
    const base = dv.getUint32(iovPtr + i * 8, true);
    const len = dv.getUint32(iovPtr + i * 8 + 4, true);
    for (let j = 0; j < len; j++) {
      const wp = Atomics.load(control, 0);
      const next = (wp + 1) % cap;
      if (next === Atomics.load(control, 1)) {
        Atomics.notify(control, 0);
        return totalWritten;
      }
      data[wp] = new Uint8Array(memory.buffer)[base + j];
      Atomics.store(control, 0, next);
      totalWritten++;
    }
  }
  Atomics.notify(control, 0);
  return totalWritten;
}

/* ─── SAB trap to kernel ──────────────────────────────────────────────────── */

function trapToKernel(n, a, b, c, d, e, f) {
  const ctl = new Int32Array(self._controlSab);
  // Kernel layout: [0]=trap_flag, [1]=syscall_number, [2-7]=args a-f, [8]=return_value
  Atomics.store(ctl, 1, n);   // syscall number
  Atomics.store(ctl, 2, a);   // arg a
  Atomics.store(ctl, 3, b);   // arg b
  Atomics.store(ctl, 4, c);   // arg c
  Atomics.store(ctl, 5, d);   // arg d
  Atomics.store(ctl, 6, e);   // arg e
  Atomics.store(ctl, 7, f);   // arg f
  Atomics.store(ctl, 0, 1);   // set trap flag = 1 (MUST be last — kernel checks this)
  Atomics.notify(ctl, 0);     // wake kernel (kernel waits on ctl[0])
  Atomics.wait(ctl, 0, 1);    // block until kernel resets trap to 0
  return Atomics.load(ctl, 8); // return value at [8]
}

/* ─── WASM import functions ───────────────────────────────────────────────── */

/**
 * Create the complete atua import object for WebAssembly.instantiate().
 *
 * Local imports (stay in-worker, no kernel trap):
 *   term_write, term_read, term_get_size, random_get, clock_gettime,
 *   sleep_ms, args_sizes_get, args_get, environ_sizes_get, environ_get
 *
 * Kernel-trapped imports (all I/O, process, pipe, socket, fs):
 *   fs_open, fs_read, fs_write, fs_close, fs_fstat, fs_stat, fs_readdir,
 *   host_syscall, page_pool_fault, register_filemap,
 *   fork_spawn, fork_exec_spawn, proc_wait,
 *   pipe_create, pipe_read, pipe_write, pipe_close,
 *   socket_open, socket_connect, socket_send, socket_recv, socket_close, socket_poll,
 *   getcwd, chdir
 *
 * WASI P1 stubs (Blink's HOST libc requires these even though guest uses host_syscall):
 *   fd_read (PLACEHOLDER_fd_read), fd_write, fd_pread, fd_pwrite,
 *   fd_close, fd_seek, fd_tell, fd_fdstat_get, fd_fdstat_set_flags, fd_fdstat_set_rights,
 *   fd_filestat_get, fd_filestat_set_size, fd_filestat_set_times,
 *   fd_prestat_get, fd_prestat_dir_name, fd_advise, fd_allocate, fd_datasync,
 *   fd_sync, fd_renumber, fd_readdir,
 *   path_open, path_filestat_get, path_filestat_set_times,
 *   path_create_directory, path_link, path_readlink,
 *   path_remove_directory, path_rename, path_symlink, path_unlink_file,
 *   clock_res_get, clock_time_get,
 *   proc_exit, poll_oneoff, sched_yield,
 *   sock_accept, sock_recv, sock_send, sock_shutdown, thread-spawn
 */
function createImports(args, env, stdinSab) {
  const envEntries = Array.isArray(env) ? env : Object.entries(env || {});

  return {
    /* ── Terminal I/O (local — no kernel trap) ────────────────────────── */

    term_write(bufPtr, len) {
      // Copy to regular ArrayBuffer for postMessage (SAB views can't be transferred)
      const copy = new Uint8Array(len);
      copy.set(new Uint8Array(memory.buffer, bufPtr, len));
      self.postMessage({ type: 'stdout', data: copy });
    },

    term_read(bufPtr, len) {
      if (!stdinSab) return 0;
      const flag = new Int32Array(stdinSab, 0, 4);
      const data = new Uint8Array(stdinSab, 16, 4096);

      // Wait for data if none available
      if (Atomics.load(flag, 2) === 0) {
        let waited = 0;
        while (flag[2] === 0) {
          Atomics.wait(flag, 2, 0, 1000);
          waited++;
          if (waited >= 30) break;
        }
        if (flag[2] === 0) return 0; // timeout
      }

      // Read available bytes — create fresh view each byte (buffer may grow)
      let bytesRead = 0;
      while (bytesRead < len) {
        if (flag[2] === 0) break;
        const rp = flag[1];
        new Uint8Array(memory.buffer)[bufPtr + bytesRead] = data[rp % 4096];
        flag[1] = rp + 1;
        flag[2] = flag[2] - 1;
        bytesRead++;
      }
      return bytesRead;
    },

    term_get_size(rowsPtr, colsPtr) {
      const view = new DataView(memory.buffer);
      view.setInt32(rowsPtr, 24, true);
      view.setInt32(colsPtr, 80, true);
    },

    /* ── Random / Time / Sleep (local — no kernel trap) ───────────────── */

    random_get(bufPtr, len) {
      // crypto.getRandomValues doesn't accept SharedArrayBuffer views — copy via temp
      const tmp = new Uint8Array(len);
      crypto.getRandomValues(tmp);
      new Uint8Array(memory.buffer, bufPtr, len).set(tmp);
    },

    clock_gettime() {
      return BigInt(Math.floor(Date.now() * 1000000));
    },

    sleep_ms(ms) {
      if (!self._sleepSab) self._sleepSab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(self._sleepSab, 0, 0, ms > 0 ? ms : 1);
    },

    /* ── Args / Environ (local — no kernel trap) ─────────────────────── */

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
      view.setUint32(countPtr, envEntries.length, true);
      let size = 0;
      for (const [k, v] of envEntries) size += new TextEncoder().encode(`${k}=${v}`).length + 1;
      view.setUint32(bufSizePtr, size, true);
      return 0;
    },

    environ_get(environPtr, environBufPtr) {
      const view = new DataView(memory.buffer);
      let off = environBufPtr;
      for (let i = 0; i < envEntries.length; i++) {
        view.setUint32(environPtr + i * 4, off, true);
        const bytes = new TextEncoder().encode(`${envEntries[i][0]}=${envEntries[i][1]}`);
        new Uint8Array(memory.buffer, off, bytes.length + 1).set([...bytes, 0]);
        off += bytes.length + 1;
      }
      return 0;
    },

    /* ── Filesystem (trap to kernel) ──────────────────────────────────── */

    fs_open(pathPtr, flags, mode) {
      return trapToKernel(SYS_FS_OPEN, pathPtr, flags, mode, 0, 0, 0);
    },

    fs_read(handle, bufPtr, len, offset) {
      return trapToKernel(SYS_FS_READ, handle, bufPtr, len, Number(offset), 0, 0);
    },

    fs_write(handle, bufPtr, len, offset) {
      return trapToKernel(SYS_FS_WRITE, handle, bufPtr, len, Number(offset), 0, 0);
    },

    fs_close(handle) {
      trapToKernel(SYS_FS_CLOSE, handle, 0, 0, 0, 0, 0);
    },

    fs_fstat(handle) {
      // Returns a BigInt, no memory access by kernel — keep as-is
      const lo = trapToKernel(SYS_FS_FSTAT, handle, 0, 0, 0, 0, 0);
      const hi = Atomics.load(new Int32Array(self._controlSab), 9);
      return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
    },

    fs_stat(pathPtr, bufPtr, bufLen) {
      return trapToKernel(SYS_FS_STAT, pathPtr, bufPtr, bufLen, 0, 0, 0);
    },

    fs_readdir(handle, bufPtr, len) {
      return trapToKernel(SYS_FS_READDIR, handle, bufPtr, len, 0, 0, 0);
    },

    /* ── host_syscall: musl libc's single entry point into JS ─────────── */
    /* Upstream musl routes ALL libc I/O through __syscall(SYS_*, ...).
       syscall_arch.h maps this to atua.host_syscall. Linux x86-64 numbers.
       In the kernel architecture, this traps to the kernel for handling. */

    host_syscall(n, a, b, c, d, e, f) {
      // Exit syscalls terminate locally
      if (n === 60 || n === 231 || n === 62 || n === 200 || n === 234)
        throw new WebAssembly.RuntimeError('unreachable');
      // Memory management stays local (operates on worker's WASM memory)
      if (n === 12) { // brk
        if (!self._brk) self._brk = memory.buffer.byteLength;
        if (a === 0) return self._brk;
        // Log grows for debugging
        const _cP = memory.buffer.byteLength / 65536;
        const _nP = Math.ceil((a >>> 0) / 65536);
        if (_nP > _cP) console.log('[brk-grow] ' + _cP + ' → ' + _nP + ' pages');
        const target = a >>> 0;
        const currentPages = memory.buffer.byteLength / 65536;
        const neededPages = Math.ceil(target / 65536);
        if (neededPages > currentPages) {
          try {
            sharedMemory.grow(neededPages - currentPages);
            // grow() creates new SAB — update kernel's reference
            self.postMessage({ type: 'memory-ready', pid: new Int32Array(self._controlSab)[10], wasmMemoryBuffer: sharedMemory.buffer });
            // Synchronous wait for kernel to acknowledge (process the postMessage)
            // Use a short Atomics.wait on a dummy to yield, allowing message delivery
            if (!self._growSab) self._growSab = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(self._growSab, 0, 0, 5); // yield 50ms for message delivery
          } catch { return self._brk; }
        }
        self._brk = target;
        return self._brk;
      }
      if (n === 9) { // mmap — LOCAL
        const len = b >>> 0;
        const flags = d;
        const MAP_ANONYMOUS = 0x20;
        const pages = Math.ceil(len / 65536);
        const oldPages = memory.buffer.byteLength / 65536;
        try {
          sharedMemory.grow(pages);
          self.postMessage({ type: 'memory-ready', pid: new Int32Array(self._controlSab)[10], wasmMemoryBuffer: sharedMemory.buffer });
          if (!self._growSab) self._growSab = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(self._growSab, 0, 0, 5);
        } catch { return -12; }
        const ptr = oldPages * 65536;
        new Uint8Array(memory.buffer, ptr, len).fill(0);
        return ptr;
      }
      if (n === 10) return 0; // mprotect — LOCAL no-op
      if (n === 11) return 0; // munmap — LOCAL no-op
      if (n === 25) return -38; // mremap — ENOSYS
      // Pipe I/O — direct worker-to-worker via SAB, no kernel in data path
      if (n === 0 && localPipeFds.has(a)) { console.log('[pipe] read fd='+a); return localPipeRead(a, b, c); }
      if (n === 1 && localPipeFds.has(a)) { console.log('[pipe] write fd='+a+' count='+c); return localPipeWrite(a, b, c); }
      if (n === 19 && localPipeFds.has(a)) return localPipeReadv(a, b, c);
      if (n === 20 && localPipeFds.has(a)) return localPipeWritev(a, b, c);
      // dup2/dup3/close — update local pipe cache synchronously
      if ((n === 33 || n === 292) && localPipeFds.has(a)) {
        // dup2(oldfd=a, newfd=b): copy pipe cache entry locally
        localPipeFds.set(b, { ...localPipeFds.get(a) });
      }
      if (n === 3 && localPipeFds.has(a)) {
        // close(fd=a): remove from local pipe cache
        localPipeFds.delete(a);
      }
      // Everything else traps to kernel. Kernel reads/writes WASM memory directly.
      return trapToKernel(n, a, b, c, d, e, f);
    },

    /* ── SoftMMU (trap to kernel) ─────────────────────────────────────── */

    page_pool_fault(pageIndex, destPtr) {
      if (!self._ppfLog) { self._ppfLog = 0; }
      if (self._ppfLog < 5) { console.log('[ppf] idx=' + pageIndex + ' dest=' + destPtr + ' hasSab=' + !!self._guestPagesSab + ' hasAddrs=' + !!self._parentPageAddrs + ' addrCount=' + (self._parentPageAddrs?.length||0)); self._ppfLog++; }
      if (self._guestPagesSab && self._parentPageAddrs) {
        const parentAddr = self._parentPageAddrs[pageIndex];
        if (parentAddr !== undefined && parentAddr > 0) {
          const parentView = new Uint8Array(self._guestPagesSab);
          const src = parentView.subarray(parentAddr, parentAddr + 4096);
          new Uint8Array(memory.buffer, destPtr, 4096).set(src);
          return;
        }
      }
      // Fallback: trap to kernel (page stays zero-filled if kernel has no data)
      trapToKernel(SYS_PAGE_POOL_FAULT, pageIndex, destPtr, 0, 0, 0, 0);
    },

    register_filemap(virt_lo, virt_hi, size_lo, size_hi, offset_lo, offset_hi, pathPtr, pathLen) {
      // Pass pathPtr directly — kernel reads from shared memory
      trapToKernel(SYS_REGISTER_FILEMAP, virt_lo, virt_hi, size_lo, size_hi, pathPtr, pathLen);
    },

    /* ── Process management (trap to kernel) ──────────────────────────── */

    fork_spawn(statePtr, stateLen) {
      // Kernel reads state from shared memory directly
      return trapToKernel(SYS_FORK_SPAWN, statePtr, stateLen, 0, 0, 0, 0);
    },

    fork_exec_spawn(pid, pathPtr, argvPackedPtr, argvLen, envpPackedPtr, envpLen) {
      // Kernel reads all pointers from shared memory directly
      return trapToKernel(SYS_FORK_EXEC_SPAWN, pid, pathPtr, argvPackedPtr, argvLen, envpPackedPtr, envpLen);
    },

    proc_wait(pid, statusPtr) {
      // Kernel writes exit status directly into shared WASM memory at statusPtr
      return trapToKernel(SYS_PROC_WAIT, pid, statusPtr, 0, 0, 0, 0);
    },

    /* ── Pipes (trap to kernel) ───────────────────────────────────────── */

    pipe_create() {
      // Create pipe SAB locally so both worker and kernel share the same buffer.
      // CheerpX pattern: worker does direct I/O, kernel manages metadata.
      const pipeSab = new SharedArrayBuffer(PIPE_BUF_SIZE + 16);
      // Send SAB to kernel BEFORE trapping (it'll be queued for processing)
      const myPid = new Int32Array(self._controlSab)[10];
      self.postMessage({ type: 'pipe-sab', pid: myPid, sab: pipeSab });
      // Brief yield to let the message reach the kernel
      if (!self._growSab) self._growSab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(self._growSab, 0, 0, 5);
      const pipeId = trapToKernel(SYS_PIPE_CREATE, 0, 0, 0, 0, 0, 0);
      console.log('[pipe_create] pipeId=' + pipeId + ' readFd=' + (200+pipeId*2) + ' writeFd=' + (201+pipeId*2));
      // Register pipe fds locally (matching kernel's 200+pipeId*2 scheme)
      const readFd = 200 + pipeId * 2;
      const writeFd = 200 + pipeId * 2 + 1;
      localPipeFds.set(readFd, {
        pipeId, sab: pipeSab,
        control: new Int32Array(pipeSab, 0, 4),
        data: new Uint8Array(pipeSab, 16, PIPE_BUF_SIZE),
        end: 0,
      });
      localPipeFds.set(writeFd, {
        pipeId, sab: pipeSab,
        control: new Int32Array(pipeSab, 0, 4),
        data: new Uint8Array(pipeSab, 16, PIPE_BUF_SIZE),
        end: 1,
      });
      return pipeId;
    },

    pipe_read(pipeId, bufPtr, len) {
      const readFd = 200 + pipeId * 2;
      if (localPipeFds.has(readFd)) {
        const pipe = localPipeFds.get(readFd);
        console.log('[pipe_read] pipeId='+pipeId+' fd='+readFd+' len='+len+' wp='+Atomics.load(pipe.control,0)+' rp='+Atomics.load(pipe.control,1)+' closed='+Atomics.load(pipe.control,2));
        return localPipeRead(readFd, bufPtr, len);
      }
      // Fallback to kernel (shouldn't happen if pipe cache is populated)
      return trapToKernel(SYS_PIPE_READ, pipeId, bufPtr, len, 0, 0, 0);
    },

    pipe_write(pipeId, bufPtr, len) {
      const writeFd = 200 + pipeId * 2 + 1; // write end
      if (localPipeFds.has(writeFd)) {
        const r = localPipeWrite(writeFd, bufPtr, len);
        console.log('[pipe_write] pipeId='+pipeId+' fd='+writeFd+' len='+len+' wrote='+r);
        return r;
      }
      return trapToKernel(SYS_PIPE_WRITE, pipeId, bufPtr, len, 0, 0, 0);
    },

    pipe_close(pipeId, end) {
      trapToKernel(SYS_PIPE_CLOSE, pipeId, end, 0, 0, 0, 0);
    },

    /* ── Sockets (trap to kernel) ─────────────────────────────────────── */

    socket_open(domain, type, protocol) {
      return trapToKernel(SYS_SOCKET_OPEN, domain, type, protocol, 0, 0, 0);
    },

    socket_connect(sockId, addrPtr, addrLen) {
      // Kernel reads sockaddr from shared memory at addrPtr
      return trapToKernel(SYS_SOCKET_CONNECT, sockId, addrPtr, addrLen, 0, 0, 0);
    },

    socket_send(sockId, bufPtr, len) {
      return trapToKernel(SYS_SOCKET_SEND, sockId, bufPtr, len, 0, 0, 0);
    },

    socket_recv(sockId, bufPtr, len) {
      return trapToKernel(SYS_SOCKET_RECV, sockId, bufPtr, len, 0, 0, 0);
    },

    socket_close(sockId) {
      trapToKernel(SYS_SOCKET_CLOSE, sockId, 0, 0, 0, 0, 0);
    },

    socket_poll(sockId) {
      return trapToKernel(SYS_SOCKET_POLL, sockId, 0, 0, 0, 0, 0);
    },

    /* ── CWD (trap to kernel) ─────────────────────────────────────────── */

    getcwd(bufPtr, len) {
      return trapToKernel(SYS_GETCWD, bufPtr, len, 0, 0, 0, 0);
    },

    chdir(pathPtr) {
      return trapToKernel(SYS_CHDIR, pathPtr, 0, 0, 0, 0, 0);
    },

    /* ── WASI P1 imports ─────────────────────────────────────────────── */
    /* Blink's HOST libc (compiled with wasi-sdk) requires these WASI P1
       imports. In the kernel architecture, most of these route through
       host_syscall on the guest side. The HOST libc uses them for its own
       bootstrapping (fd_prestat_get, args/environ, etc.) and for any
       direct HOST I/O. We implement them as kernel traps or local stubs. */

    PLACEHOLDER_fd_read(fd, iovs_ptr, iovs_len, nread_ptr) {
      // HOST libc fd_read — route through kernel trap
      // For stdin (fd 0-2), return 0 (EOF). For VFS fds, trap to kernel.
      const view = new DataView(memory.buffer);
      let totalRead = 0;
      for (let i = 0; i < iovs_len; i++) {
        const bufPtr = view.getUint32(iovs_ptr + i * 8, true);
        const bufLen = view.getUint32(iovs_ptr + i * 8 + 4, true);
        if (fd <= 2) break;
        // Read via kernel: kernel writes directly to bufPtr in shared memory
        const result = trapToKernel(SYS_FS_READ, fd, bufPtr, bufLen, 0, 0, 0);
        if (result > 0) totalRead += result;
        if (result < bufLen) break;
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
          // Copy to regular ArrayBuffer for postMessage (SAB views can't be transferred)
          const copy = new Uint8Array(bufLen);
          copy.set(new Uint8Array(memory.buffer, bufPtr, bufLen));
          self.postMessage({ type: 'stdout', data: copy });
        } else {
          // Kernel reads directly from bufPtr in shared memory
          trapToKernel(SYS_FS_WRITE, fd, bufPtr, bufLen, 0, 0, 0);
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
        // Kernel reads/writes directly from/to shared memory at bufPtr
        const result = trapToKernel(SYS_FS_READ, fd, bufPtr, bufLen, off + totalRead, 0, 0);
        if (result > 0) totalRead += result;
        if (result < bufLen) break;
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
        // Kernel reads directly from bufPtr in shared memory
        trapToKernel(SYS_FS_WRITE, fd, bufPtr, bufLen, off + totalWritten, 0, 0);
        totalWritten += bufLen;
      }
      view.setUint32(nwritten_ptr, totalWritten, true);
      return 0;
    },

    path_open(dirfd, dirflags, path_ptr, path_len, oflags, rights_base, rights_inh, fdflags, fd_ptr) {
      // Kernel reads path directly from shared memory at path_ptr
      const fd = trapToKernel(SYS_FS_OPEN, path_ptr, oflags | fdflags, 0o666, 0, 0, 0);
      if (fd < 0) return 44; // ENOENT
      new DataView(memory.buffer).setUint32(fd_ptr, fd, true);
      return 0;
    },

    fd_close(fd) {
      trapToKernel(SYS_FS_CLOSE, fd, 0, 0, 0, 0, 0);
      return 0;
    },

    fd_seek(fd, offset, whence, newoffset_ptr) {
      // Route through host_syscall SYS_lseek (8)
      const off = Number(offset);
      const result = trapToKernel(SYS_HOST_SYSCALL, 8, fd, off, whence, 0, 0);
      if (result < 0) return 8; // EBADF
      new DataView(memory.buffer).setBigUint64(newoffset_ptr, BigInt(result), true);
      return 0;
    },

    fd_tell(fd, offset_ptr) {
      // lseek(fd, 0, SEEK_CUR=1)
      const result = trapToKernel(SYS_HOST_SYSCALL, 8, fd, 0, 1, 0, 0);
      if (result < 0) return 8;
      new DataView(memory.buffer).setBigUint64(offset_ptr, BigInt(result), true);
      return 0;
    },

    fd_fdstat_get(fd, stat_ptr) {
      const view = new DataView(memory.buffer);
      view.setUint8(stat_ptr, fd <= 2 ? 2 : 4); // CHAR_DEVICE or REGULAR_FILE
      view.setUint16(stat_ptr + 2, 0, true);
      view.setBigUint64(stat_ptr + 8, 0xFFFFFFFFFFFFFFFFn, true); // all rights
      view.setBigUint64(stat_ptr + 16, 0xFFFFFFFFFFFFFFFFn, true);
      return 0;
    },

    fd_fdstat_set_flags(fd, flags) { return 0; },
    fd_fdstat_set_rights(fd, base, inh) { return 0; },

    fd_filestat_get(fd, stat_ptr) {
      // Get file size via fstat kernel trap
      const lo = trapToKernel(SYS_FS_FSTAT, fd, 0, 0, 0, 0, 0);
      const hi = Atomics.load(new Int32Array(self._controlSab), 9);
      const packed = (BigInt(hi) << 32n) | BigInt(lo >>> 0);
      const size = packed >> 16n;
      const view = new DataView(memory.buffer);
      view.setBigUint64(stat_ptr, 1n, true);        // dev
      view.setBigUint64(stat_ptr + 8, BigInt(fd + 1000), true); // ino
      view.setUint8(stat_ptr + 16, fd <= 2 ? 2 : 4); // filetype
      view.setBigUint64(stat_ptr + 24, 1n, true);   // nlink
      view.setBigUint64(stat_ptr + 32, size >= 0n ? size : 0n, true); // size
      return 0;
    },

    fd_filestat_set_size(fd, size) { return 0; },
    fd_filestat_set_times(fd, atim, mtim, flags) { return 0; },

    fd_prestat_get(fd, prestat_ptr) {
      if (fd === 3) {
        const view = new DataView(memory.buffer);
        view.setUint32(prestat_ptr, 0, true);     // tag = DIR
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
      // Kernel reads path from shared memory at path_ptr, writes stat to stat_ptr
      const result = trapToKernel(SYS_FS_STAT, path_ptr, stat_ptr, 64, 0, 0, 0);
      if (result !== 0) return 44; // ENOENT
      // Kernel wrote stat data directly into shared memory at stat_ptr
      // Re-format as WASI filestat
      const view = new DataView(memory.buffer);
      const size = view.getInt32(stat_ptr, true);
      const isDir = view.getInt32(stat_ptr + 4, true);
      view.setBigUint64(stat_ptr, 1n, true);             // dev
      view.setBigUint64(stat_ptr + 8, BigInt(path_len), true); // ino
      view.setUint8(stat_ptr + 16, isDir ? 3 : 4);       // filetype
      view.setBigUint64(stat_ptr + 24, 1n, true);         // nlink
      view.setBigUint64(stat_ptr + 32, BigInt(size), true); // size
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
      const view = new DataView(memory.buffer);
      let sleepMs = 0;
      // subscription_t is 48 bytes: userdata(8) + tag(1) + pad(7) + union(32)
      for (let i = 0; i < nsubscriptions; i++) {
        const base = in_ptr + i * 48;
        const tag = view.getUint8(base + 8);
        if (tag === 0) { // EVENTTYPE_CLOCK
          const timeoutNs = view.getBigUint64(base + 24, true);
          const ms = Number(timeoutNs / 1000000n);
          if (ms > sleepMs) sleepMs = ms;
        }
      }
      if (sleepMs > 0) {
        if (!self._sleepSab) self._sleepSab = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(self._sleepSab, 0, 0, sleepMs);
      }
      // Write events: event_t is 32 bytes
      let count = 0;
      for (let i = 0; i < nsubscriptions; i++) {
        const subBase = in_ptr + i * 48;
        const evtBase = out_ptr + count * 32;
        const userdata = view.getBigUint64(subBase, true);
        view.setBigUint64(evtBase, userdata, true);
        view.setUint16(evtBase + 8, 0, true);   // error = 0
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
  };
}

/* ─── Boot paths ──────────────────────────────────────────────────────────── */

/**
 * Boot PID 1 (or any fresh process): instantiate engine.wasm, call _start().
 */
async function bootEngine(opts) {
  const {
    controlSab, dataSab, wakeChannel, pid,
    engineModule, args, env, stdinSab,
  } = opts;

  // Store SABs on self for trapToKernel
  self._controlSab = controlSab;
  self._wakeChannel = wakeChannel;

  // Write our PID into control[10]
  const ctl = new Int32Array(controlSab);
  Atomics.store(ctl, 10, pid);

  // Create shared memory that the WASM module imports
  sharedMemory = new WebAssembly.Memory({ initial: 4096, maximum: 16384, shared: true });
  memory = sharedMemory;

  const engineArgs = args || ['engine'];
  const envObj = env || {};
  const imports = createImports(engineArgs, envObj, stdinSab);

  let inst;
  try {
    const result = await WebAssembly.instantiate(engineModule, { atua: imports, env: { memory: sharedMemory } });
    inst = result.instance || result;
  } catch (err) {
    self.postMessage({ type: 'error', message: 'WASM instantiate failed: ' + err.message });
    return;
  }

  instance = inst;
  // memory is already set to sharedMemory above

  // Send shared memory buffer to kernel so it can read/write guest memory directly
  self.postMessage({ type: 'memory-ready', pid, wasmMemoryBuffer: sharedMemory.buffer });

  self.postMessage({ type: 'debug', message: 'PID ' + pid + ': calling _start' });
  try {
    instance.exports._start();
  } catch (err) {
    self.postMessage({ type: 'debug', message: 'PID ' + pid + ': engine exit: ' + err.message });
    if (!(err instanceof WebAssembly.RuntimeError && err.message.includes('unreachable'))) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }

  let exitCode = 0;
  try {
    if (instance.exports.get_exit_code) exitCode = instance.exports.get_exit_code();
  } catch (e) {}
  self.postMessage({ type: 'exit', pid, code: exitCode });
}

/**
 * Parse parent host page addresses from the serialized fork state blob.
 * The fork state layout (SerializeForkState in syscall.c) on wasm32:
 *   128  bytes: m->beg (general registers)
 *   256  bytes: m->xmm (16 * 16)
 *     8  bytes: m->ip (i64)
 *     8  bytes: m->flags (u64)
 *   128  bytes: m->seg (8 * DescriptorCache{u16 sel + 6pad + u64 base} = 8 * 16)
 *    16  bytes: m->fs (DescriptorCache, redundant with seg[4])
 *    16  bytes: m->gs (DescriptorCache, redundant with seg[5])
 *     8  bytes: m->sigmask (u64)
 *     8  bytes: m->ctid (i64)
 *     4  bytes: m->tid (int on wasm32)
 *  2048  bytes: m->system->hands (64 * sigaction_linux{handler[8]+flags[8]+restorer[8]+mask[8]} = 64 * 32)
 *     8  bytes: m->system->brk (i64)
 *     8  bytes: m->system->automap (i64)
 *     8  bytes: m->system->cr3 (u64)
 *     4  bytes: m->system->pid (int on wasm32)
 *   256  bytes: m->system->rlim (16 * rlimit_linux{cur[8]+max[8]} = 16 * 16)
 *     8  bytes: m->system->blinksigs (u64)
 * --- host pages section ---
 *     4  bytes: g_hostpages.n (size_t = 4 on wasm32)
 *   n*4  bytes: page addresses (unsigned = 4 each on wasm32)
 *     4  bytes: pool_base
 *     4  bytes: pool_next
 *     4  bytes: pool_cap
 * --- fd table section (not parsed here) ---
 */
function parseParentPageAddrs(forkState) {
  const view = new DataView(forkState.buffer, forkState.byteOffset, forkState.byteLength);
  // Compute offset to the host pages section
  const HOST_PAGES_OFFSET =
    128  +  // m->beg (general registers)
    256  +  // m->xmm (16 * 16)
    8    +  // m->ip (i64)
    8    +  // m->flags (u64)
    128  +  // m->seg (8 * DescriptorCache(16))
    16   +  // m->fs (DescriptorCache, redundant)
    16   +  // m->gs (DescriptorCache, redundant)
    8    +  // m->sigmask (u64)
    8    +  // m->ctid (i64)
    4    +  // m->tid (int = 4 on wasm32)
    2048 +  // m->system->hands (64 * 32)
    8    +  // m->system->brk (i64)
    8    +  // m->system->automap (i64)
    8    +  // m->system->cr3 (u64)
    4    +  // m->system->pid (int = 4 on wasm32)
    256  +  // m->system->rlim (16 * 16)
    8;      // m->system->blinksigs (u64)
  // = 2920

  // Scan for the host pages count. It should be a plausible value (10-10000)
  // followed by that many 4-byte addresses that look like WASM pointers.
  // This is more robust than hardcoding the exact struct offset.
  let off = -1;
  for (let probe = Math.max(0, HOST_PAGES_OFFSET - 200); probe <= Math.min(forkState.byteLength - 4, HOST_PAGES_OFFSET + 200); probe += 4) {
    const pn = view.getUint32(probe, true);
    if (pn >= 10 && pn < 50000 && probe + 4 + pn * 4 + 12 <= forkState.byteLength) {
      // Check if the addresses look like WASM pool addresses (aligned, within memory)
      const firstAddr = view.getUint32(probe + 4, true);
      if (firstAddr > 0 && firstAddr < 0x20000000 && (firstAddr & 0xFFF) === 0) {
        off = probe;
        break;
      }
    }
  }
  if (off < 0) return new Uint32Array(0);

  const n = view.getUint32(off, true); off += 4;
  if (off + n * 4 > forkState.byteLength) return new Uint32Array(0);

  const addrs = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    addrs[i] = view.getUint32(off, true);
    off += 4;
  }
  return addrs;
}

/**
 * Restore a fork child: instantiate engine.wasm, call init_for_fork(),
 * write fork state into WASM memory, call restore_fork().
 */
async function restoreFork(opts) {
  const {
    controlSab, dataSab, wakeChannel, pid,
    engineModule, forkState, forkStateLen, guestPagesSab,
    pipeFds,
  } = opts;

  // Populate local pipe cache BEFORE execution starts (can't receive postMessage during Atomics.wait)
  if (pipeFds && pipeFds.length > 0) {
    for (const u of pipeFds) {
      localPipeFds.set(u.fd, {
        pipeId: u.pipeId, sab: u.sab,
        control: new Int32Array(u.sab, 0, 4),
        data: new Uint8Array(u.sab, 16, PIPE_BUF_SIZE),
        end: u.end,
      });
    }
  }

  // Store SABs on self for trapToKernel
  self._controlSab = controlSab;
  self._wakeChannel = wakeChannel;
  self._guestPagesSab = guestPagesSab;

  // Write our PID into control[10]
  const ctl = new Int32Array(controlSab);
  Atomics.store(ctl, 10, pid);

  // Create shared memory that the WASM module imports
  sharedMemory = new WebAssembly.Memory({ initial: 4096, maximum: 16384, shared: true });
  memory = sharedMemory;

  // For fork children, args/env are not used (restore_fork bypasses main)
  const imports = createImports([], {}, null);

  let inst;
  try {
    const result = await WebAssembly.instantiate(engineModule, { atua: imports, env: { memory: sharedMemory } });
    inst = result.instance || result;
  } catch (err) {
    self.postMessage({ type: 'error', message: 'WASM instantiate failed (fork): ' + err.message });
    return;
  }

  instance = inst;
  self.postMessage({ type: 'memory-ready', pid, wasmMemoryBuffer: sharedMemory.buffer });
  // Wait for kernel to register our memory AND control SAB (both go worker→main→kernel)
  // 100ms gives reliable delivery across 2 postMessage hops
  await new Promise(r => setTimeout(r, 100));

  // 1. init_for_fork() — initializes musl (malloc, brk, TLS) without main()
  instance.exports.init_for_fork();

  // 2. Write fork state blob into WASM memory
  const forkStateBytes = new Uint8Array(forkState);
  const statePtr = instance.exports.malloc(forkStateBytes.length);
  new Uint8Array(memory.buffer, statePtr, forkStateBytes.length).set(forkStateBytes);

  // 2b. Parse parent page addresses from fork state BEFORE restore_fork runs,
  // so page_pool_fault can read pages from the parent's WASM memory.
  self._parentPageAddrs = parseParentPageAddrs(forkStateBytes);
  self.postMessage({ type: 'debug', message: 'PID ' + pid + ': restoring fork, state=' + forkStateBytes.length + ', parentPages=' + self._parentPageAddrs.length });

  // 3. restore_fork() — NewMachine/NewSystem on child heap, restore CPU state
  try {
    instance.exports.restore_fork(statePtr, forkStateLen);
    self.postMessage({ type: 'debug', message: 'PID ' + pid + ': restore_fork returned' });
  } catch (err) {
    self.postMessage({ type: 'debug', message: 'PID ' + pid + ': ' + err.message });
    if (!(err instanceof WebAssembly.RuntimeError && err.message.includes('unreachable'))) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }

  let exitCode = 0;
  try {
    if (instance.exports.get_exit_code) exitCode = instance.exports.get_exit_code();
  } catch (e) {}
  self.postMessage({ type: 'exit', pid, code: exitCode });
}

/**
 * Fork-exec fast path: instantiate engine.wasm with target program args,
 * call _start(). No fork state restoration, no SAB page copy.
 */
async function forkExec(opts) {
  const {
    controlSab, dataSab, wakeChannel, pid,
    engineModule, path, argv, env, pipeFds,
  } = opts;

  // Populate local pipe cache BEFORE execution starts
  if (pipeFds && pipeFds.length > 0) {
    for (const u of pipeFds) {
      localPipeFds.set(u.fd, {
        pipeId: u.pipeId, sab: u.sab,
        control: new Int32Array(u.sab, 0, 4),
        data: new Uint8Array(u.sab, 16, PIPE_BUF_SIZE),
        end: u.end,
      });
    }
  }

  // Store SABs on self for trapToKernel
  self._controlSab = controlSab;
  self._wakeChannel = wakeChannel;

  // Write our PID into control[10]
  const ctl = new Int32Array(controlSab);
  Atomics.store(ctl, 10, pid);

  // Create shared memory that the WASM module imports
  sharedMemory = new WebAssembly.Memory({ initial: 4096, maximum: 16384, shared: true });
  memory = sharedMemory;

  // Build Blink args: ['blink', path, ...argv_rest]
  const engineArgs = ['blink', path, ...(argv || []).slice(1)];
  const envObj = env || {};
  const imports = createImports(engineArgs, envObj, null);

  let inst;
  try {
    const result = await WebAssembly.instantiate(engineModule, { atua: imports, env: { memory: sharedMemory } });
    inst = result.instance || result;
  } catch (err) {
    self.postMessage({ type: 'error', message: 'WASM instantiate failed (fork-exec): ' + err.message });
    return;
  }

  instance = inst;
  self.postMessage({ type: 'memory-ready', pid, wasmMemoryBuffer: sharedMemory.buffer });

  self.postMessage({ type: 'debug', message: 'PID ' + pid + ': fork-exec ' + path });

  try {
    instance.exports._start();
  } catch (err) {
    if (!(err instanceof WebAssembly.RuntimeError && err.message.includes('unreachable'))) {
      self.postMessage({ type: 'error', message: 'fork-exec error: ' + err.message });
    }
  }

  let exitCode = 0;
  try {
    if (instance.exports.get_exit_code) exitCode = instance.exports.get_exit_code();
  } catch (e) {}
  self.postMessage({ type: 'exit', pid, code: exitCode });
}

/* ─── Worker reset for pool reuse ─────────────────────────────────────────── */

function resetWorkerState() {
  memory = null;
  instance = null;
  sharedMemory = null;
  self._controlSab = null;
  self._wakeChannel = null;
  self._guestPagesSab = null;
  self._sleepSab = null;
}

/* ─── Message handler ─────────────────────────────────────────────────────── */

self.onmessage = async (e) => {
  const msg = e.data;

  switch (msg.type) {
    case 'boot':
      await bootEngine(msg);
      break;

    case 'restore-fork':
      await restoreFork(msg);
      break;

    case 'fork-exec':
      await forkExec(msg);
      break;

    case 'reset':
      resetWorkerState();
      localPipeFds.clear();
      self.postMessage({ type: 'reset-ack' });
      break;

    case 'pipe-fd-cache':
      // Kernel pushes pipe SABs so worker can do direct I/O
      if (msg.updates) {
        for (const u of msg.updates) {
          localPipeFds.set(u.fd, {
            pipeId: u.pipeId,
            sab: u.sab,
            control: new Int32Array(u.sab, 0, 4),
            data: new Uint8Array(u.sab, 16, PIPE_BUF_SIZE),
            end: u.end,
          });
        }
      }
      if (msg.removes) {
        for (const fd of msg.removes) localPipeFds.delete(fd);
      }
      break;

    default:
      self.postMessage({ type: 'error', message: 'Unknown message type: ' + msg.type });
      break;
  }
};
