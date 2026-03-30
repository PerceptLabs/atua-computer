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
 *   dataSab: SharedArrayBuffer(1MB) — bulk data for read/write/stat/getdents/path strings
 *   wakeChannel: SharedArrayBuffer(4) — shared by ALL workers, notifies kernel
 *
 * Message types from orchestrator:
 *   { type: 'boot', controlSab, dataSab, wakeChannel, pid, engineModule, args, env, stdinSab }
 *   { type: 'restore-fork', controlSab, dataSab, wakeChannel, pid, engineModule, forkState, forkStateLen, guestPagesSab }
 *   { type: 'fork-exec', controlSab, dataSab, wakeChannel, pid, engineModule, path, argv, env }
 *   { type: 'reset' }
 */

/* ─── Module-level state ──────────────────────────────────────────────────── */

let memory = null;
let instance = null;

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

/* ─── Data marshalling helpers ────────────────────────────────────────────── */

/**
 * Copy a null-terminated C string from WASM memory into dataSab.
 * Returns the byte length of the string (not including null terminator).
 */
function copyPathToDataSab(pathPtr) {
  const mem = new Uint8Array(memory.buffer);
  let end = pathPtr;
  while (end < mem.length && mem[end]) end++;
  const pathLen = end - pathPtr;
  const dataBuf = new Uint8Array(self._dataSab);
  dataBuf.set(mem.subarray(pathPtr, end), 0);
  dataBuf[pathLen] = 0;
  return pathLen;
}

/**
 * Copy len bytes from WASM memory at srcPtr into dataSab at offset dstOff.
 */
function copyToDataSab(srcPtr, len, dstOff) {
  const src = new Uint8Array(memory.buffer, srcPtr, len);
  new Uint8Array(self._dataSab, dstOff, len).set(src);
}

/**
 * Copy len bytes from dataSab at offset srcOff into WASM memory at dstPtr.
 */
function copyFromDataSab(dstPtr, len, srcOff) {
  const src = new Uint8Array(self._dataSab, srcOff || 0, len);
  new Uint8Array(memory.buffer, dstPtr, len).set(src);
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
      const bytes = new Uint8Array(memory.buffer, bufPtr, len);
      console.log('[exec-worker] term_write:', len, 'bytes');
      self.postMessage({ type: 'stdout', data: new Uint8Array(bytes) });
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
      crypto.getRandomValues(new Uint8Array(memory.buffer, bufPtr, len));
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
      const pathLen = copyPathToDataSab(pathPtr);
      const path = new TextDecoder().decode(new Uint8Array(self._dataSab, 0, pathLen));
      console.log('[exec-worker] fs_open:', path, 'trapping to kernel...');
      const result = trapToKernel(SYS_FS_OPEN, pathLen, flags, mode, 0, 0, 0);
      console.log('[exec-worker] fs_open:', path, '→', result);
      return result;
    },

    fs_read(handle, bufPtr, len, offset) {
      const o = typeof offset === 'bigint' ? Number(offset) : (offset || 0);
      const offsetLo = o & 0xFFFFFFFF;
      const offsetHi = Math.floor(o / 0x100000000) & 0xFFFFFFFF;
      const result = trapToKernel(SYS_FS_READ, handle, len, offsetLo, offsetHi, 0, 0);
      if (result > 0) {
        // Kernel wrote data into dataSab — copy to WASM memory
        copyFromDataSab(bufPtr, result, 0);
      }
      return result;
    },

    fs_write(handle, bufPtr, len, offset) {
      const o = typeof offset === 'bigint' ? Number(offset) : (offset || 0);
      const offsetLo = o & 0xFFFFFFFF;
      const offsetHi = Math.floor(o / 0x100000000) & 0xFFFFFFFF;
      // Copy data from WASM memory into dataSab for kernel to read
      copyToDataSab(bufPtr, len, 0);
      return trapToKernel(SYS_FS_WRITE, handle, len, offsetLo, offsetHi, 0, 0);
    },

    fs_close(handle) {
      trapToKernel(SYS_FS_CLOSE, handle, 0, 0, 0, 0, 0);
    },

    fs_fstat(handle) {
      // Returns packed BigInt: (size << 16n) | BigInt(mode)
      // Kernel stores result in dataSab as two i32: [0]=low32 of result, [4]=high32
      const lo = trapToKernel(SYS_FS_FSTAT, handle, 0, 0, 0, 0, 0);
      const dataBuf = new DataView(self._dataSab);
      const hi = dataBuf.getInt32(0, true);
      // Reconstruct BigInt from lo (return value) and hi (in dataSab)
      return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
    },

    fs_stat(pathPtr, bufPtr, bufLen) {
      const pathLen = copyPathToDataSab(pathPtr);
      const result = trapToKernel(SYS_FS_STAT, pathLen, bufLen, 0, 0, 0, 0);
      if (result === 0 && bufPtr && bufLen > 0) {
        // Kernel wrote stat data into dataSab — copy to WASM memory
        // Stat data starts after the path string in dataSab (at offset pathLen+1 rounded up, or just a fixed offset)
        // Use a fixed data region starting at offset 0 (kernel knows path was already consumed)
        copyFromDataSab(bufPtr, Math.min(bufLen, 64), 0);
      }
      return result;
    },

    fs_readdir(handle, bufPtr, len) {
      const result = trapToKernel(SYS_FS_READDIR, handle, len, 0, 0, 0, 0);
      if (result > 0) {
        copyFromDataSab(bufPtr, result, 0);
      }
      return result;
    },

    /* ── host_syscall: musl libc's single entry point into JS ─────────── */
    /* Upstream musl routes ALL libc I/O through __syscall(SYS_*, ...).
       syscall_arch.h maps this to atua.host_syscall. Linux x86-64 numbers.
       In the kernel architecture, this traps to the kernel for handling. */

    host_syscall(n, a, b, c, d, e, f) {
      // Memory management syscalls stay LOCAL (operate on worker's WASM memory)
      switch (n) {
        case 12: { // brk — LOCAL (memory.grow)
          if (!self._brk) self._brk = memory.buffer.byteLength;
          if (a === 0) return self._brk;
          const target = a >>> 0;
          const currentPages = memory.buffer.byteLength / 65536;
          const neededPages = Math.ceil(target / 65536);
          if (neededPages > currentPages) {
            try { memory.grow(neededPages - currentPages); } catch { return self._brk; }
          }
          self._brk = target;
          return self._brk;
        }
        case 9: { // mmap — LOCAL (memory.grow + file data from kernel)
          const len = b >>> 0;
          const flags = d;
          const MAP_ANONYMOUS = 0x20;
          const pages = Math.ceil(len / 65536);
          const oldPages = memory.buffer.byteLength / 65536;
          try { memory.grow(pages); } catch { return -12; }
          const ptr = oldPages * 65536;
          new Uint8Array(memory.buffer, ptr, len).fill(0);
          if (!(flags & MAP_ANONYMOUS) && e >= 0) {
            // File-backed mmap: ask kernel for file data
            const fileOff = f >>> 0;
            const ret = trapToKernel(17, e, 0, len, fileOff, 0, 0); // pread64
            if (ret > 0) copyFromDataSab(ptr, ret, 0);
          }
          return ptr;
        }
        case 10: return 0; // mprotect — LOCAL no-op
        case 11: return 0; // munmap — LOCAL no-op (can't shrink WASM memory)
        case 25: return -38; // mremap — ENOSYS
        case 1: { // write(fd, buf, count) — copy buf to dataSab
          const count = c >>> 0;
          if (count > 0 && b) copyToDataSab(b >>> 0, Math.min(count, 1048576), 0);
          const ret = trapToKernel(1, a, 0, count, 0, 0, 0);
          return ret;
        }
        case 0: { // read(fd, buf, count) — kernel writes to dataSab, we copy back
          const count = c >>> 0;
          const ret = trapToKernel(0, a, 0, count, 0, 0, 0);
          if (ret > 0) copyFromDataSab(b >>> 0, ret, 0);
          return ret;
        }
        case 20: { // writev(fd, iov, iovcnt) — copy iov buffers to dataSab
          const iovcnt = c >>> 0;
          const view = new DataView(memory.buffer);
          let total = 0;
          let dOff = 0;
          for (let i = 0; i < iovcnt; i++) {
            const bp = view.getUint32((b >>> 0) + i * 8, true);
            const bl = view.getUint32((b >>> 0) + i * 8 + 4, true);
            if (bl > 0) copyToDataSab(bp, Math.min(bl, 1048576 - dOff), dOff);
            dOff += bl;
            total += bl;
          }
          // Pack iov lengths into control args
          return trapToKernel(20, a, total, iovcnt, 0, 0, 0);
        }
        case 17: { // pread64(fd, buf, count, offset_lo, offset_hi)
          const count = c >>> 0;
          const ret = trapToKernel(17, a, 0, count, d, e, 0);
          if (ret > 0) copyFromDataSab(b >>> 0, ret, 0);
          return ret;
        }
        case 18: { // pwrite64(fd, buf, count, offset_lo, offset_hi)
          const count = c >>> 0;
          if (count > 0) copyToDataSab(b >>> 0, Math.min(count, 1048576), 0);
          return trapToKernel(18, a, 0, count, d, e, 0);
        }
        case 2: case 257: { // open/openat — copy path to dataSab
          const pathPtr = n === 2 ? a : b;
          const flags = n === 2 ? b : c;
          const mode = n === 2 ? c : d;
          const pathLen = copyPathToDataSab(pathPtr >>> 0);
          return trapToKernel(n, pathLen, flags, mode, 0, 0, 0);
        }
        case 4: case 6: { // stat/lstat — copy path to dataSab, get stat back
          const pathLen = copyPathToDataSab(a >>> 0);
          const ret = trapToKernel(n, pathLen, 0, 0, 0, 0, 0);
          if (ret === 0) copyFromDataSab(b >>> 0, 112, 0); // kstat is 112 bytes
          return ret;
        }
        case 5: { // fstat — no path, get stat back
          const ret = trapToKernel(5, a, 0, 0, 0, 0, 0);
          if (ret >= 0) copyFromDataSab(b >>> 0, 112, 0);
          return ret;
        }
        case 262: { // fstatat — copy path to dataSab
          const pathLen = copyPathToDataSab(b >>> 0);
          const ret = trapToKernel(262, a, pathLen, 0, d, 0, 0);
          if (ret === 0) copyFromDataSab(c >>> 0, 112, 0);
          return ret;
        }
        case 79: { // getcwd — kernel writes cwd to dataSab
          const ret = trapToKernel(79, c >>> 0, 0, 0, 0, 0, 0);
          if (ret >= 0) copyFromDataSab(a >>> 0, ret + 1, 0);
          return a;
        }
        case 63: { // uname — kernel writes struct to dataSab
          const ret = trapToKernel(63, 0, 0, 0, 0, 0, 0);
          if (ret === 0) copyFromDataSab(a >>> 0, 325, 0);
          return ret;
        }
        case 89: { // readlink — copy path, get link target back
          const pathLen = copyPathToDataSab(a >>> 0);
          const ret = trapToKernel(89, pathLen, c >>> 0, 0, 0, 0, 0);
          if (ret > 0) copyFromDataSab(b >>> 0, ret, 0);
          return ret;
        }
        case 267: { // readlinkat — copy path, get link target back
          const pathLen = copyPathToDataSab(b >>> 0);
          const ret = trapToKernel(267, a, pathLen, d >>> 0, 0, 0, 0);
          if (ret > 0) copyFromDataSab(c >>> 0, ret, 0);
          return ret;
        }
        case 217: { // getdents64 — kernel writes entries to dataSab
          const ret = trapToKernel(217, a, c >>> 0, 0, 0, 0, 0);
          if (ret > 0) copyFromDataSab(b >>> 0, ret, 0);
          return ret;
        }
        case 83: case 258: { // mkdir/mkdirat — copy path
          const pathPtr2 = n === 83 ? a : b;
          const mode2 = n === 83 ? b : c;
          const pathLen2 = copyPathToDataSab(pathPtr2 >>> 0);
          return trapToKernel(n, pathLen2, mode2, 0, 0, 0, 0);
        }
        case 87: case 263: { // unlink/unlinkat — copy path
          const pathPtr2 = n === 87 ? a : b;
          const pathLen2 = copyPathToDataSab(pathPtr2 >>> 0);
          return trapToKernel(n, pathLen2, n === 263 ? c : 0, 0, 0, 0, 0);
        }
        case 90: case 268: { // chmod/fchmodat — copy path
          const pathPtr2 = n === 90 ? a : b;
          const pathLen2 = copyPathToDataSab(pathPtr2 >>> 0);
          return trapToKernel(n, pathLen2, n === 90 ? b : c, 0, 0, 0, 0);
        }
        case 9: { // mmap — may need file data from kernel
          // mmap doesn't transfer bulk data through dataSab for memory.grow
          // The kernel returns a result; the execution worker handles memory.grow locally
          // For file-backed mmap, the kernel reads the file and writes to dataSab
          const len = b >>> 0;
          const ret = trapToKernel(9, a, b, c, d, e, f);
          if (ret > 0 && !(d & 0x20) && len > 0) {
            // File-backed mmap: kernel put file data in dataSab
            copyFromDataSab(ret, Math.min(len, 1048576), 0);
          }
          return ret;
        }
        default:
          // All other syscalls pass through without data transfer
          return trapToKernel(n, a, b, c, d, e, f);
      }
      // and the original a-e as args 2-6. The kernel receives:
      //   ctl[0]=SYS_HOST_SYSCALL, ctl[1]=n, ctl[2]=a, ctl[3]=b, ctl[4]=c, ctl[5]=d, ctl[6]=e
      // The f argument is dropped (Linux syscalls use at most 6 args, so n+a..e covers it).
      // The kernel must also be able to read/write WASM memory data through dataSab
      // for pointer-based syscalls (read/write/stat/etc).
    },

    /* ── SoftMMU (trap to kernel) ─────────────────────────────────────── */

    page_pool_fault(pageIndex, destPtr) {
      // Trap to kernel which will write the page data into dataSab
      const result = trapToKernel(SYS_PAGE_POOL_FAULT, pageIndex, 0, 0, 0, 0, 0);
      if (result >= 0) {
        // Kernel wrote 4096 bytes of page data into dataSab — copy to WASM memory
        copyFromDataSab(destPtr, 4096, 0);
      }
    },

    register_filemap(virt_lo, virt_hi, size_lo, size_hi, offset_lo, offset_hi, pathPtr, pathLen) {
      // Copy path to dataSab
      const pathBytes = new Uint8Array(memory.buffer, pathPtr, pathLen);
      new Uint8Array(self._dataSab, 0, pathLen).set(pathBytes);
      // Pack the 64-bit values into args: virt_lo, virt_hi, size_lo, size_hi go as args
      // offset_lo, offset_hi go into dataSab after the path
      const dataBuf = new DataView(self._dataSab);
      dataBuf.setInt32(pathLen + 1, offset_lo, true);
      dataBuf.setInt32(pathLen + 5, offset_hi, true);
      trapToKernel(SYS_REGISTER_FILEMAP, virt_lo, virt_hi, size_lo, size_hi, pathLen, 0);
    },

    /* ── Process management (trap to kernel) ──────────────────────────── */

    fork_spawn(statePtr, stateLen) {
      // Copy fork state blob from WASM memory into dataSab
      // For large states, the kernel may need to handle chunked transfer,
      // but dataSab is 1MB which should suffice for the state blob.
      const copyLen = Math.min(stateLen, self._dataSab.byteLength);
      copyToDataSab(statePtr, copyLen, 0);

      // Also need to send host page data — get page count and addrs from WASM exports
      const hpCount = instance.exports.get_hostpages_count
        ? instance.exports.get_hostpages_count() : 0;
      const hpAddrsPtr = instance.exports.get_hostpages_addrs
        ? instance.exports.get_hostpages_addrs() : 0;

      // The kernel needs the host pages. We store metadata in dataSab after the fork state:
      // At offset stateLen: hpCount (4 bytes)
      // The actual page data must be communicated separately since dataSab is only 1MB.
      // For now, the kernel will handle page data via a follow-up protocol or
      // the fork state blob already encodes page references.
      const dataBuf = new DataView(self._dataSab);
      dataBuf.setUint32(copyLen, hpCount, true);

      return trapToKernel(SYS_FORK_SPAWN, stateLen, hpCount, hpAddrsPtr, 0, 0, 0);
    },

    fork_exec_spawn(pid, pathPtr, argvPackedPtr, argvLen, envpPackedPtr, envpLen) {
      // Copy path to dataSab at offset 0
      const pathLen = copyPathToDataSab(pathPtr);

      // Copy packed argv after path
      const argvOff = pathLen + 1;
      copyToDataSab(argvPackedPtr, argvLen, argvOff);

      // Copy packed envp after argv
      const envpOff = argvOff + argvLen;
      copyToDataSab(envpPackedPtr, envpLen, envpOff);

      // Args: pid, pathLen, argvLen, envpLen, argvOff, envpOff
      return trapToKernel(SYS_FORK_EXEC_SPAWN, pid, pathLen, argvLen, envpLen, argvOff, envpOff);
    },

    proc_wait(pid, statusPtr) {
      const result = trapToKernel(SYS_PROC_WAIT, pid, 0, 0, 0, 0, 0);
      if (result > 0 && statusPtr) {
        // Kernel writes exit status into dataSab[0..3]
        const dataBuf = new DataView(self._dataSab);
        const exitCode = dataBuf.getInt32(0, true);
        new DataView(memory.buffer).setInt32(statusPtr, exitCode, true);
      }
      return result;
    },

    /* ── Pipes (trap to kernel) ───────────────────────────────────────── */

    pipe_create() {
      return trapToKernel(SYS_PIPE_CREATE, 0, 0, 0, 0, 0, 0);
    },

    pipe_read(pipeId, bufPtr, len) {
      const result = trapToKernel(SYS_PIPE_READ, pipeId, len, 0, 0, 0, 0);
      if (result > 0) {
        copyFromDataSab(bufPtr, result, 0);
      }
      return result;
    },

    pipe_write(pipeId, bufPtr, len) {
      copyToDataSab(bufPtr, len, 0);
      return trapToKernel(SYS_PIPE_WRITE, pipeId, len, 0, 0, 0, 0);
    },

    pipe_close(pipeId, end) {
      trapToKernel(SYS_PIPE_CLOSE, pipeId, end, 0, 0, 0, 0);
    },

    /* ── Sockets (trap to kernel) ─────────────────────────────────────── */

    socket_open(domain, type, protocol) {
      return trapToKernel(SYS_SOCKET_OPEN, domain, type, protocol, 0, 0, 0);
    },

    socket_connect(sockId, addrPtr, addrLen) {
      // Copy sockaddr from WASM memory into dataSab
      copyToDataSab(addrPtr, addrLen, 0);
      return trapToKernel(SYS_SOCKET_CONNECT, sockId, addrLen, 0, 0, 0, 0);
    },

    socket_send(sockId, bufPtr, len) {
      copyToDataSab(bufPtr, len, 0);
      return trapToKernel(SYS_SOCKET_SEND, sockId, len, 0, 0, 0, 0);
    },

    socket_recv(sockId, bufPtr, len) {
      const result = trapToKernel(SYS_SOCKET_RECV, sockId, len, 0, 0, 0, 0);
      if (result > 0) {
        copyFromDataSab(bufPtr, result, 0);
      }
      return result;
    },

    socket_close(sockId) {
      trapToKernel(SYS_SOCKET_CLOSE, sockId, 0, 0, 0, 0, 0);
    },

    socket_poll(sockId) {
      return trapToKernel(SYS_SOCKET_POLL, sockId, 0, 0, 0, 0, 0);
    },

    /* ── CWD (trap to kernel) ─────────────────────────────────────────── */

    getcwd(bufPtr, len) {
      const result = trapToKernel(SYS_GETCWD, len, 0, 0, 0, 0, 0);
      if (result > 0) {
        // Kernel wrote cwd string into dataSab — copy to WASM memory
        // Find null terminator in dataSab
        const dataBuf = new Uint8Array(self._dataSab);
        let cwdLen = 0;
        while (cwdLen < len && dataBuf[cwdLen]) cwdLen++;
        new Uint8Array(memory.buffer, bufPtr, cwdLen + 1).set(dataBuf.subarray(0, cwdLen + 1));
      }
      return result ? bufPtr : 0;
    },

    chdir(pathPtr) {
      const pathLen = copyPathToDataSab(pathPtr);
      return trapToKernel(SYS_CHDIR, pathLen, 0, 0, 0, 0, 0);
    },

    /* ── WASI P1 imports ─────────────────────────────────────────────── */
    /* Blink's HOST libc (compiled with wasi-sdk) requires these WASI P1
       imports. In the kernel architecture, most of these route through
       host_syscall on the guest side. The HOST libc uses them for its own
       bootstrapping (fd_prestat_get, args/environ, etc.) and for any
       direct HOST I/O. We implement them as kernel traps or local stubs. */

    PLACEHOLDER_fd_read(fd, iovs_ptr, iovs_len, nread_ptr) {
      // HOST libc fd_read — route through host_syscall-like kernel trap
      // For stdin (fd 0-2), return 0 (EOF). For VFS fds, trap to kernel.
      const view = new DataView(memory.buffer);
      let totalRead = 0;
      for (let i = 0; i < iovs_len; i++) {
        const bufPtr = view.getUint32(iovs_ptr + i * 8, true);
        const bufLen = view.getUint32(iovs_ptr + i * 8 + 4, true);
        if (fd <= 2) break;
        // Read via kernel: use fs_read path with the HOST fd
        const result = trapToKernel(SYS_FS_READ, fd, bufLen, 0, 0, 0, 0);
        if (result > 0) {
          copyFromDataSab(bufPtr, result, 0);
          totalRead += result;
        }
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
          const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
          self.postMessage({ type: 'stdout', data: new Uint8Array(bytes) });
        } else {
          copyToDataSab(bufPtr, bufLen, 0);
          trapToKernel(SYS_FS_WRITE, fd, bufLen, 0, 0, 0, 0);
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
        const offsetLo = (off + totalRead) & 0xFFFFFFFF;
        const offsetHi = Math.floor((off + totalRead) / 0x100000000) & 0xFFFFFFFF;
        const result = trapToKernel(SYS_FS_READ, fd, bufLen, offsetLo, offsetHi, 0, 0);
        if (result > 0) {
          copyFromDataSab(bufPtr, result, 0);
          totalRead += result;
        }
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
        copyToDataSab(bufPtr, bufLen, 0);
        const offsetLo = (off + totalWritten) & 0xFFFFFFFF;
        const offsetHi = Math.floor((off + totalWritten) / 0x100000000) & 0xFFFFFFFF;
        trapToKernel(SYS_FS_WRITE, fd, bufLen, offsetLo, offsetHi, 0, 0);
        totalWritten += bufLen;
      }
      view.setUint32(nwritten_ptr, totalWritten, true);
      return 0;
    },

    path_open(dirfd, dirflags, path_ptr, path_len, oflags, rights_base, rights_inh, fdflags, fd_ptr) {
      // Copy path to dataSab
      const pathBytes = new Uint8Array(memory.buffer, path_ptr, path_len);
      new Uint8Array(self._dataSab, 0, path_len).set(pathBytes);
      new Uint8Array(self._dataSab)[path_len] = 0;
      const fd = trapToKernel(SYS_FS_OPEN, path_len, oflags | fdflags, 0o666, 0, 0, 0);
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
      const result = trapToKernel(SYS_FS_FSTAT, fd, 0, 0, 0, 0, 0);
      const dataBuf = new DataView(self._dataSab);
      const hi = dataBuf.getInt32(0, true);
      const packed = (BigInt(hi) << 32n) | BigInt(result >>> 0);
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
      // Copy path to dataSab and trap to kernel for stat
      const pathBytes = new Uint8Array(memory.buffer, path_ptr, path_len);
      new Uint8Array(self._dataSab, 0, path_len).set(pathBytes);
      new Uint8Array(self._dataSab)[path_len] = 0;
      const result = trapToKernel(SYS_FS_STAT, path_len, 64, 0, 0, 0, 0);
      if (result !== 0) return 44; // ENOENT
      // Kernel wrote stat info into dataSab — extract and fill WASI filestat
      const dataBuf = new DataView(self._dataSab);
      const size = dataBuf.getInt32(0, true);
      const isDir = dataBuf.getInt32(4, true);
      const view = new DataView(memory.buffer);
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
  self._dataSab = dataSab;
  self._wakeChannel = wakeChannel;

  // Write our PID into control[10]
  const ctl = new Int32Array(controlSab);
  Atomics.store(ctl, 10, pid);

  const engineArgs = args || ['engine'];
  const envObj = env || {};
  const imports = createImports(engineArgs, envObj, stdinSab);

  let inst;
  try {
    const result = await WebAssembly.instantiate(engineModule, { atua: imports });
    inst = result.instance || result;
  } catch (err) {
    self.postMessage({ type: 'error', message: 'WASM instantiate failed: ' + err.message });
    return;
  }

  instance = inst;
  memory = instance.exports.memory;

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
 * Restore a fork child: instantiate engine.wasm, call init_for_fork(),
 * write fork state into WASM memory, call restore_fork().
 */
async function restoreFork(opts) {
  const {
    controlSab, dataSab, wakeChannel, pid,
    engineModule, forkState, forkStateLen, guestPagesSab,
  } = opts;

  // Store SABs on self for trapToKernel
  self._controlSab = controlSab;
  self._dataSab = dataSab;
  self._wakeChannel = wakeChannel;
  self._guestPagesSab = guestPagesSab;

  // Write our PID into control[10]
  const ctl = new Int32Array(controlSab);
  Atomics.store(ctl, 10, pid);

  // For fork children, args/env are not used (restore_fork bypasses main)
  const imports = createImports([], {}, null);

  let inst;
  try {
    const result = await WebAssembly.instantiate(engineModule, { atua: imports });
    inst = result.instance || result;
  } catch (err) {
    self.postMessage({ type: 'error', message: 'WASM instantiate failed (fork): ' + err.message });
    return;
  }

  instance = inst;
  memory = instance.exports.memory;

  // 1. init_for_fork() — initializes musl (malloc, brk, TLS) without main()
  instance.exports.init_for_fork();

  // 2. Write fork state blob into WASM memory
  const forkStateBytes = new Uint8Array(forkState);
  const statePtr = instance.exports.malloc(forkStateBytes.length);
  new Uint8Array(memory.buffer, statePtr, forkStateBytes.length).set(forkStateBytes);

  self.postMessage({ type: 'debug', message: 'PID ' + pid + ': restoring fork, state=' + forkStateBytes.length });

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
    engineModule, path, argv, env,
  } = opts;

  // Store SABs on self for trapToKernel
  self._controlSab = controlSab;
  self._dataSab = dataSab;
  self._wakeChannel = wakeChannel;

  // Write our PID into control[10]
  const ctl = new Int32Array(controlSab);
  Atomics.store(ctl, 10, pid);

  // Build Blink args: ['blink', path, ...argv_rest]
  const engineArgs = ['blink', path, ...(argv || []).slice(1)];
  const envObj = env || {};
  const imports = createImports(engineArgs, envObj, null);

  let inst;
  try {
    const result = await WebAssembly.instantiate(engineModule, { atua: imports });
    inst = result.instance || result;
  } catch (err) {
    self.postMessage({ type: 'error', message: 'WASM instantiate failed (fork-exec): ' + err.message });
    return;
  }

  instance = inst;
  memory = instance.exports.memory;

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
  self._controlSab = null;
  self._dataSab = null;
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
      self.postMessage({ type: 'reset-ack' });
      break;

    default:
      self.postMessage({ type: 'error', message: 'Unknown message type: ' + msg.type });
      break;
  }
};
