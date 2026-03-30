/**
 * kernel-worker.js — Centralized kernel for atua-computer.
 *
 * Runs on a dedicated Worker thread. Owns the VirtualFS, process table,
 * pipe table, and fd tables. Execution workers (running Blink WASM) trap
 * into here via SharedArrayBuffer for every syscall.
 *
 * SAB protocol per execution worker:
 *   controlSab (256 bytes) — Int32Array[64]:
 *     [0] = trap flag (worker stores 1, kernel resets to 0 after handling)
 *     [1] = syscall number
 *     [2..7] = args a..f
 *     [8] = return value
 *     [9] = data direction: 0=none, 1=worker→kernel (write), 2=kernel→worker (read)
 *     [10] = data length (bytes in dataSab)
 *   dataSab (1 MB) — Uint8Array bulk data transfer region
 *
 * The execution worker:
 *   1. Copies any outbound data (write, pwrite64, writev buffers) into dataSab
 *   2. Fills controlSab args, sets trap=1
 *   3. Atomics.wait(controlSab, 0, 1) — blocks until kernel sets trap=0
 *   4. Reads return value from controlSab[8]
 *   5. Copies any inbound data (read, pread64, readv, stat, getdents64, readlink) from dataSab
 *
 * Message types:
 *   'init'            — load rootfs tar, boot files, config
 *   'register-worker' — register a new execution worker's SABs
 *   'socket-*'        — relay to main thread (Wisp stays on main)
 */

import { VirtualFS } from './filesystem.js';

// ─── Global state ────────────────────────────────────────────────────────────

const vfs = new VirtualFS();

// Process table: pid → { controlSab, dataSab, control, data, fdTable, cwd, brk, mmapFreelist }
const processTable = new Map();
let nextPid = 1;

// Pipe table: pipeId → { sab, control, data }
const pipes = new Map();
let nextPipeId = 0;
const PIPE_BUF_SIZE = 64 * 1024;

// Socket table: sockId → { sab, control, data, isUdp }
const sockets = new Map();
let nextSockId = 0;
const SOCK_BUF_SIZE = 128 * 1024;

// ─── Pipe helpers ────────────────────────────────────────────────────────────

function createPipe() {
  const id = nextPipeId++;
  const sab = new SharedArrayBuffer(PIPE_BUF_SIZE + 16);
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
      Atomics.wait(control, 1, rp, 5000);
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
    Atomics.notify(pipe.control, 1);
  } else { // read end
    Atomics.store(pipe.control, 3, 1);
  }
}

// ─── Socket recv helper ──────────────────────────────────────────────────────

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
      if (sock.isUdp) return -1;
      Atomics.wait(control, 1, rp, 5000);
      continue;
    }
    buf[bytesRead] = data[rp % cap];
    Atomics.store(control, 1, rp + 1);
    bytesRead++;
  }
  return bytesRead;
}

// ─── Per-process fd table helpers ────────────────────────────────────────────
// Each process gets its own fd table that maps fd numbers to VFS fd numbers
// or to pipe/socket descriptors. For now the kernel VFS owns the open file
// descriptors globally (VirtualFS.openFiles) and the per-process table just
// mirrors the mapping. This keeps the move faithful to the original.

function getProcessFdTable(pid) {
  const proc = processTable.get(pid);
  return proc ? proc.fdTable : null;
}

// ─── Read C string from dataSab ──────────────────────────────────────────────
// The execution worker copies the C string into dataSab before trapping.
// The offset in dataSab where the string starts is communicated via controlSab.

function readCStringFromData(data, offset) {
  let end = offset;
  while (end < data.length && data[end]) end++;
  return new TextDecoder().decode(data.subarray(offset, end));
}

// ─── Write bytes into dataSab for return to worker ───────────────────────────

function writeDataToSab(data, bytes, offset) {
  data.set(bytes, offset);
}

// ─── Stat helper: write 112-byte kstat struct into dataSab ───────────────────

function writeStatBuf(data, offset, info, meta, fdOrPath, isDir, isSpecial, specialType) {
  const buf = new Uint8Array(112);
  buf.fill(0);
  const view = new DataView(buf.buffer);
  const size = info ? info.size : 0;
  let typeBits;
  let nlink = 1;
  if (isDir || (info && info.type === 'dir')) { typeBits = 0o40000; nlink = 2; }
  else if (info && info.type === 'symlink') { typeBits = 0o120000; }
  else if (info && info.type === 'chardev') { typeBits = 0o20000; }
  else if (isSpecial) { typeBits = 0o20000; }
  else { typeBits = 0o100000; }
  const permBits = (meta && meta.mode !== undefined) ? (meta.mode & 0o7777)
                 : (typeBits === 0o20000 ? 0o666 : 0o755);
  let ino = 0;
  if (typeof fdOrPath === 'string') {
    for (let i = 0; i < fdOrPath.length; i++) ino = ((ino << 5) - ino + fdOrPath.charCodeAt(i)) >>> 0;
  } else {
    ino = (fdOrPath || 0) + 1000;
  }
  const now = vfs.bootTime;
  view.setBigUint64(0, 1n, true);                        // st_dev
  view.setBigUint64(8, BigInt(ino || 1), true);           // st_ino
  view.setUint32(16, nlink, true);                        // st_nlink
  view.setUint32(20, typeBits | permBits, true);          // st_mode
  view.setUint32(24, (meta && meta.uid) || 0, true);      // st_uid
  view.setUint32(28, (meta && meta.gid) || 0, true);      // st_gid
  view.setBigInt64(48, BigInt(size), true);                // st_size
  view.setInt32(56, 4096, true);                          // st_blksize
  view.setBigInt64(64, BigInt(Math.ceil(size / 512)), true); // st_blocks
  view.setInt32(72, (meta && meta.atime) || now, true);    // st_atime_sec
  view.setInt32(80, (meta && meta.mtime) || now, true);    // st_mtime_sec
  view.setInt32(88, (meta && meta.mtime) || now, true);    // st_ctime_sec
  view.setBigInt64(104, BigInt((meta && meta.mtime) || now), true); // st_ctime
  data.set(buf, offset);
  return 112;
}

// ─── Statfs helper: write 120 bytes into dataSab ─────────────────────────────

function writeStatfsBuf(data, offset) {
  const buf = new Uint8Array(120);
  buf.fill(0);
  const v = new DataView(buf.buffer);
  v.setBigInt64(0, 0xEF53n, true);    // f_type = EXT4
  v.setBigInt64(8, 4096n, true);       // f_bsize
  v.setBigInt64(16, 1000000n, true);   // f_blocks
  v.setBigInt64(24, 500000n, true);    // f_bfree
  v.setBigInt64(32, 500000n, true);    // f_bavail
  v.setBigInt64(40, 100000n, true);    // f_files
  v.setBigInt64(48, 50000n, true);     // f_ffree
  v.setBigInt64(64, 255n, true);       // f_namelen
  v.setBigInt64(72, 4096n, true);      // f_frsize
  data.set(buf, offset);
  return 120;
}

// ─── Syscall dispatch ────────────────────────────────────────────────────────
// This is the EXACT same logic as engine-main-worker.js host_syscall,
// adapted so that bulk data transfers go through dataSab instead of
// memory.buffer. The execution worker pre-copies write data into dataSab
// and post-copies read data from dataSab.
//
// controlSab layout (Int32Array):
//   [0] trap flag: 1=pending, 0=done
//   [1] syscall number (n)
//   [2] arg a
//   [3] arg b
//   [4] arg c
//   [5] arg d
//   [6] arg e
//   [7] arg f
//   [8] return value
//   [9] data direction: 0=none, 1=worker→kernel (write), 2=kernel→worker (read)
//   [10] data length
//   [11] secondary data offset (for iovec-style multi-buffer syscalls)
//   [12] extra info (e.g. iov count for writev)

function handleSyscall(pid, control, data) {
  const n = control[1];
  const a = control[2];
  const b = control[3];
  const c = control[4];
  const d = control[5];
  const e = control[6];
  const f = control[7];

  if (!self._syscallCount) self._syscallCount = 0;
  if (self._syscallCount++ < 50) console.log('[kernel] syscall pid=' + pid + ' n=' + n + ' a=' + a);

  const proc = processTable.get(pid);
  if (!proc) { control[8] = -1; return; }

  // Helper to read a C string from dataSab at a given offset
  // For syscalls that pass a path pointer, the execution worker copies
  // the string into dataSab at offset 0 (or at a specified offset).
  function readCString(offset) {
    return readCStringFromData(data, offset);
  }

  // Helper to read secondary C string (for rename, symlink, etc.)
  function readCString2(offset) {
    return readCStringFromData(data, offset);
  }

  let result;

  switch (n) {
    /* ── Memory — must work before anything else (malloc depends on these) ── */
    case 12: { // SYS_brk
      // brk is handled entirely in the execution worker (it owns WASM memory).
      // The worker does memory.grow() itself. We just return the value it passes.
      if (!proc.brk) proc.brk = a || 0;
      if (a === 0) { result = proc.brk; break; }
      proc.brk = a >>> 0;
      result = proc.brk;
      break;
    }
    case 9: { // SYS_mmap — handled in execution worker (needs memory.grow)
      // mmap for anonymous mappings is handled in the execution worker.
      // For file-backed mappings, the worker traps here to get file content
      // copied into dataSab, then copies it into WASM memory itself.
      const len = b >>> 0;
      const flags = d;
      const MAP_ANONYMOUS = 0x20;
      if (!(flags & MAP_ANONYMOUS)) {
        // File-backed mmap: read file content into dataSab
        const file = vfs.openFiles.get(e);
        if (file && file.content) {
          const off = Number(f) || 0;
          const avail = Math.min(len, file.content.length - off);
          if (avail > 0) {
            data.set(file.content.subarray(off, off + avail), 0);
            control[10] = avail;
            control[9] = 2; // kernel→worker
          }
        }
      }
      // The actual ptr allocation is done by the worker (it owns memory.grow).
      // Return 0 to signal success; the worker uses its own ptr.
      result = 0;
      break;
    }
    case 10: result = 0; break;  // SYS_mprotect — no-op
    case 11: result = 0; break;  // SYS_munmap — handled in execution worker

    /* ── I/O ── */
    case 0: { // SYS_read(fd, buf, count)
      // buf/count refer to dataSab (kernel writes read data into dataSab)
      if (a <= 2) { result = 0; break; } // stdin: HOST reads return EOF
      const file = vfs.openFiles.get(a);
      if (!file) { result = -9; break; } // EBADF
      const count = c >>> 0;
      const dest = new Uint8Array(count);
      const n2 = vfs.read(a, dest, file.position);
      file.position += n2;
      if (n2 > 0) {
        data.set(dest.subarray(0, n2), 0);
        control[10] = n2;
        control[9] = 2; // kernel→worker
      }
      result = n2;
      break;
    }
    case 1: { // SYS_write(fd, buf, count) [1a] O_APPEND aware
      // The execution worker copied the write data into dataSab before trapping.
      const count = c >>> 0;
      const buf = data.slice(0, count);
      const file = vfs.openFiles.get(a);
      if (a === 1 || a === 2 || file?.special === 'stdout' || file?.special === 'stderr') {
        self.postMessage({ type: 'stdout', data: new Uint8Array(buf) });
        result = count;
        break;
      }
      if (!file) { result = -9; break; }
      if (file.special === 'null') { result = count; break; }
      if (file.append) file.position = file.content.length; // [1a]
      vfs.write(a, buf, file.position);
      file.position += count;
      result = count;
      break;
    }
    case 2: { // SYS_open(path, flags, mode)
      const path = readCString(0);
      const fd = vfs.open(path, b, c);
      if (fd >= 0) {
        const file = vfs.openFiles.get(fd);
        if (file && file.content && file.content.length > 4) {
          if (path.includes('bash') || path.includes('.so'))
            console.log(`[open] ${path} fd=${fd} len=${file.content.length}`);
        }
      }
      result = fd;
      break;
    }
    case 3: { // SYS_close(fd)
      vfs.close(a);
      result = 0;
      break;
    }
    case 5: { // SYS_fstat(fd, statbuf)
      const file = vfs.openFiles.get(a);
      const size = file ? (file.content?.length || 0) : 0;
      const meta = file?.path ? (vfs.metadata.get(file.path) || {}) : {};
      const isDir = file?.isDir || false;
      const isSpecial = (file?.special === 'null' || file?.special === 'urandom' ||
                         file?.special === 'stdout' || file?.special === 'stderr' || file?.special === 'stdin');
      writeStatBuf(data, 0, { size, type: isDir ? 'dir' : (isSpecial ? 'chardev' : 'file') },
                   meta, a, isDir, isSpecial, file?.special);
      control[10] = 112;
      control[9] = 2; // kernel→worker
      result = (a <= 2 || file) ? 0 : -9;
      break;
    }
    case 8: { // SYS_lseek(fd, offset, whence)
      const file = vfs.openFiles.get(a);
      if (!file) { result = -9; break; }
      if (c === 0) file.position = b;          // SEEK_SET
      else if (c === 1) file.position += b;    // SEEK_CUR
      else if (c === 2) file.position = (file.content?.length || 0) + b; // SEEK_END
      result = file.position;
      break;
    }
    case 17: { // SYS_pread64(fd, buf, count, offset_lo, offset_hi)
      const file = vfs.openFiles.get(a);
      if (!file) { result = -9; break; }
      const count = c >>> 0;
      const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
      const dest = new Uint8Array(count);
      const n2 = vfs.read(a, dest, offset);
      if (n2 > 0) {
        data.set(dest.subarray(0, n2), 0);
        control[10] = n2;
        control[9] = 2;
      }
      result = n2;
      break;
    }
    case 295: { // SYS_preadv(fd, iov, iovcnt, offset_lo, offset_hi)
      // For preadv, the execution worker passes iov metadata in dataSab:
      //   iov entries as pairs of (bufLen:u32) starting at offset 0
      //   iovcnt = c
      // Kernel reads file data into dataSab starting after the iov metadata.
      const file = vfs.openFiles.get(a);
      if (!file) { result = -9; break; }
      const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
      const iovcnt = c;
      // Read iov lengths from dataSab (worker wrote them)
      const iovView = new DataView(data.buffer, data.byteOffset);
      let total = 0;
      let dataOffset = iovcnt * 4; // start writing data after iov lengths
      for (let i = 0; i < iovcnt; i++) {
        const bufLen = iovView.getUint32(i * 4, true);
        const dest = new Uint8Array(bufLen);
        const n2 = vfs.read(a, dest, offset + total);
        data.set(dest.subarray(0, n2), dataOffset);
        dataOffset += n2;
        total += n2;
        if (n2 < bufLen) break;
      }
      control[10] = dataOffset;
      control[9] = 2;
      result = total;
      break;
    }
    case 19: { // SYS_readv(fd, iov, iovcnt)
      // Same as preadv but uses file.position
      const iovcnt = c;
      const iovView = new DataView(data.buffer, data.byteOffset);
      let total = 0;
      let dataOffset = iovcnt * 4;
      for (let i = 0; i < iovcnt; i++) {
        const bufLen = iovView.getUint32(i * 4, true);
        if (a === 1 || a === 2) continue; // stdout/stderr: skip reads
        const file = vfs.openFiles.get(a);
        if (!file) { result = total > 0 ? total : -9; control[10] = dataOffset; control[9] = 2; return; }
        const dest = new Uint8Array(bufLen);
        const n2 = vfs.read(a, dest, file.position);
        file.position += n2;
        data.set(dest.subarray(0, n2), dataOffset);
        dataOffset += n2;
        total += n2;
        if (n2 < bufLen) break;
      }
      control[10] = dataOffset;
      control[9] = 2;
      result = total;
      break;
    }
    case 20: { // SYS_writev(fd, iov, iovcnt)
      // The execution worker writes all iov data contiguously into dataSab,
      // preceded by iov lengths (u32 each).
      const iovcnt = c;
      const iovView = new DataView(data.buffer, data.byteOffset);
      let dataOffset = iovcnt * 4; // data starts after iov lengths
      let total = 0;
      for (let i = 0; i < iovcnt; i++) {
        const bufLen = iovView.getUint32(i * 4, true);
        const buf = data.slice(dataOffset, dataOffset + bufLen);
        if (a === 1 || a === 2) {
          self.postMessage({ type: 'stdout', data: new Uint8Array(buf) });
        } else {
          const file = vfs.openFiles.get(a);
          if (file) { vfs.write(a, buf, file.position); file.position += bufLen; }
        }
        dataOffset += bufLen;
        total += bufLen;
      }
      result = total;
      break;
    }
    case 257: { // SYS_openat(dirfd, path, flags, mode)
      const path = readCString(0);
      const fd = vfs.open(path, c, d);
      if (path.includes('bash') || path.includes('ld-linux'))
        self.postMessage({ type: 'debug', message: `openat ${path} → ${fd}` });
      result = fd;
      break;
    }

    /* ── Stat ── */
    case 4: case 6: case 262: { // SYS_stat/lstat/fstatat
      // For stat/lstat: path is at dataSab offset 0
      // For fstatat: path is at dataSab offset 0, flags = d
      const flags = n === 262 ? (d >>> 0) : 0;
      let path = readCString(0);
      if (!path.startsWith('/')) path = '/' + path;
      const followSymlinks = (n !== 6) && !(flags & 0x100);
      const info = vfs.stat(path, followSymlinks);
      if (!info) { result = -2; break; } // ENOENT
      const meta = vfs.metadata.get(followSymlinks ? vfs.resolvePath(path) : path) || {};
      writeStatBuf(data, 0, info, meta, path, info.type === 'dir', info.type === 'chardev', null);
      control[10] = 112;
      control[9] = 2;
      result = 0;
      break;
    }

    /* ── Process ── */
    case 39: result = 1; break;   // SYS_getpid
    case 110: result = 0; break;  // SYS_getppid
    case 102: result = 0; break;  // SYS_getuid
    case 104: result = 0; break;  // SYS_getgid
    case 107: result = 0; break;  // SYS_geteuid
    case 108: result = 0; break;  // SYS_getegid
    case 186: result = 1; break;  // SYS_gettid
    case 218: result = 1; break;  // SYS_set_tid_address
    case 273: result = 0; break;  // SYS_set_robust_list
    case 205: result = 0; break;  // SYS_set_thread_area — no-op (single-threaded)

    /* ── Signals — no-op on wasm32 ── */
    case 13: result = 0; break;   // SYS_rt_sigaction
    case 14: result = 0; break;   // SYS_rt_sigprocmask
    case 127: result = 0; break;  // SYS_rt_sigpending
    case 131: result = 0; break;  // SYS_sigaltstack

    /* ── Time ── */
    case 228: { // SYS_clock_gettime(clockid, timespec_ptr)
      // Write timespec into dataSab at offset 0 (16 bytes)
      const ns = BigInt(Math.floor(Date.now() * 1e6));
      const view = new DataView(data.buffer, data.byteOffset);
      view.setBigInt64(0, ns / 1000000000n, true);      // tv_sec
      view.setBigInt64(8, ns % 1000000000n, true);       // tv_nsec
      control[10] = 16;
      control[9] = 2;
      result = 0;
      break;
    }
    case 229: { // SYS_clock_getres
      const view = new DataView(data.buffer, data.byteOffset);
      view.setBigInt64(0, 0n, true);
      view.setBigInt64(8, 1000000n, true); // 1ms
      control[10] = 16;
      control[9] = 2;
      result = 0;
      break;
    }
    case 35: { // SYS_nanosleep(req, rem)
      // Worker sends timespec in dataSab at offset 0
      const view = new DataView(data.buffer, data.byteOffset);
      const sec = Number(view.getBigInt64(0, true));
      const nsec = Number(view.getBigInt64(8, true));
      const ms = sec * 1000 + Math.floor(nsec / 1000000);
      if (ms > 0) {
        if (!self._sleepSab) self._sleepSab = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(self._sleepSab, 0, 0, ms);
      }
      result = 0;
      break;
    }

    /* ── Random ── */
    case 318: { // SYS_getrandom(buf, len, flags)
      const len = b >>> 0;
      const buf = new Uint8Array(len);
      crypto.getRandomValues(buf);
      data.set(buf, 0);
      control[10] = len;
      control[9] = 2;
      result = len;
      break;
    }

    /* ── Filesystem metadata ── */
    case 16: result = -25; break;  // SYS_ioctl → ENOTTY
    case 72: { // SYS_fcntl(fd=a, cmd=b, arg=c) [1e] real dup
      const file = vfs.openFiles.get(a);
      if (!file) { result = -9; break; }
      if (b === 0 || b === 1030) { // F_DUPFD / F_DUPFD_CLOEXEC
        const newFd = vfs.nextFd++;
        vfs.openFiles.set(newFd, {
          content: file.content, position: file.position, path: file.path,
          isDir: file.isDir, dirPath: file.dirPath, special: file.special,
          append: file.append, cloexec: (b === 1030),
        });
        result = newFd;
        break;
      }
      if (b === 1) { result = file.cloexec ? 1 : 0; break; } // F_GETFD
      if (b === 2) { file.cloexec = !!(c & 1); result = 0; break; } // F_SETFD
      if (b === 3) { let fl = 0; if (file.append) fl |= 0x400; result = fl; break; } // F_GETFL
      if (b === 4) { result = 0; break; } // F_SETFL
      result = 0;
      break;
    }
    case 32: { // SYS_dup(oldfd)
      const file = vfs.openFiles.get(a);
      if (!file) { result = -9; break; }
      const newFd = vfs.nextFd++;
      vfs.openFiles.set(newFd, { ...file, cloexec: false });
      result = newFd;
      break;
    }
    case 33: { // SYS_dup2(oldfd, newfd)
      if (a === b) { result = b; break; }
      const file = vfs.openFiles.get(a);
      if (!file) { result = -9; break; }
      vfs.openFiles.delete(b);
      vfs.openFiles.set(b, { ...file, cloexec: false });
      if (b >= vfs.nextFd) vfs.nextFd = b + 1;
      result = b;
      break;
    }
    case 292: { // SYS_dup3(oldfd, newfd, flags)
      if (a === b) { result = -22; break; } // EINVAL
      const file = vfs.openFiles.get(a);
      if (!file) { result = -9; break; }
      vfs.openFiles.delete(b);
      vfs.openFiles.set(b, { ...file, cloexec: !!(c & 0x80000) });
      if (b >= vfs.nextFd) vfs.nextFd = b + 1;
      result = b;
      break;
    }
    case 79: { // SYS_getcwd(buf, size)
      const cwd = proc.cwd || '/';
      const bytes = new TextEncoder().encode(cwd);
      if (bytes.length + 1 > b) { result = -34; break; } // ERANGE
      data.set([...bytes, 0], 0);
      control[10] = bytes.length + 1;
      control[9] = 2;
      result = a; // returns the buf pointer (worker-side)
      break;
    }
    case 63: { // SYS_uname(buf)
      // struct utsname: 5 fields of 65 bytes each = 325 bytes
      const buf = new Uint8Array(325);
      buf.fill(0);
      const fields = ['Linux', 'atua', '6.1.0', '#1', 'x86_64'];
      for (let i = 0; i < 5; i++) {
        const bytes = new TextEncoder().encode(fields[i]);
        buf.set(bytes, i * 65);
      }
      data.set(buf, 0);
      control[10] = 325;
      control[9] = 2;
      result = 0;
      break;
    }
    case 269: { // SYS_faccessat(dirfd, path, mode, flags)
      const path = readCString(0);
      const info = vfs.stat(path);
      result = info ? 0 : -2; // ENOENT
      break;
    }
    case 121: result = 0; break; // SYS_getpgid → return 0
    case 332: { // SYS_statx(dirfd, path, flags, mask, statx_buf)
      const path = readCString(0);
      const info = vfs.stat(path);
      if (!info) { result = -2; break; }
      // statx struct: 256 bytes into dataSab
      const buf = new Uint8Array(256);
      buf.fill(0);
      const view = new DataView(buf.buffer);
      view.setUint32(0, 0xFFF, true); // stx_mask = all fields valid
      view.setUint32(16, info.type === 'dir' ? 0o40755 : 0o100755, true); // stx_mode
      view.setUint32(20, 1, true); // stx_nlink
      view.setBigUint64(40, BigInt(info.size), true); // stx_size
      data.set(buf, 0);
      control[10] = 256;
      control[9] = 2;
      result = 0;
      break;
    }
    case 302: { // SYS_prlimit64(pid, resource, new, old)
      // If old pointer is non-zero, write defaults into dataSab
      if (d) {
        const view = new DataView(data.buffer, data.byteOffset);
        view.setBigUint64(0, 1024n, true);       // rlim_cur
        view.setBigUint64(8, 1024n, true);        // rlim_max
        control[10] = 16;
        control[9] = 2;
      }
      result = 0;
      break;
    }

    /* ── Exit / abort ── */
    case 60:  // SYS_exit
    case 231: // SYS_exit_group
    case 62:  // SYS_kill
    case 200: // SYS_tkill
    case 234: // SYS_tgkill
      // Signal the execution worker to throw RuntimeError('unreachable')
      result = -255; // special sentinel: worker interprets this as exit
      break;

    /* ── I/O: pipe, directory, link, truncate ── */
    case 22: result = -38; break;  // SYS_pipe → ENOSYS (Blink handles guest pipes)
    case 293: result = -38; break; // SYS_pipe2 → ENOSYS (Blink handles guest pipes)
    case 18: { // SYS_pwrite64(fd, buf, count, offset_lo, offset_hi)
      const file = vfs.openFiles.get(a);
      if (!file) { result = -9; break; } // EBADF
      const count = c >>> 0;
      const src = data.slice(0, count);
      const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
      vfs.write(a, src, offset);
      result = count;
      break;
    }
    case 77: { // SYS_ftruncate(fd=a, length=b)
      const file = vfs.openFiles.get(a);
      if (!file || file.isDir) { result = -9; break; }
      if (file.special) { result = 0; break; }
      const len = b >>> 0;
      if (len < file.content.length) {
        file.content = file.content.slice(0, len);
      } else if (len > file.content.length) {
        const grown = new Uint8Array(len);
        grown.set(file.content);
        file.content = grown;
      }
      if (file.path) vfs.files.set(file.path, file.content);
      result = 0;
      break;
    }
    case 83: case 258: { // SYS_mkdir(path,mode) / SYS_mkdirat(dirfd,path,mode)
      let path = readCString(0);
      const mode = (n === 83 ? b : c) >>> 0;
      if (!path.startsWith('/')) { if (n === 258 && (a|0) !== -100) { result = -95; break; } path = '/' + path; }
      path = vfs.resolvePath(path);
      vfs.mkdir(path);
      if (mode) vfs.metadata.set(path, { ...(vfs.metadata.get(path)||{}), mode: mode & 0o7777 });
      result = 0;
      break;
    }
    case 87: case 263: { // SYS_unlink(path) / SYS_unlinkat(dirfd,path,flags)
      let path = readCString(0);
      if (!path.startsWith('/')) { if (n === 263 && (a|0) !== -100) { result = -95; break; } path = '/' + path; }
      path = vfs.resolvePath(path);
      const flags = n === 263 ? (c >>> 0) : 0;
      if (flags & 0x200) { vfs.rmdir(path); } else { vfs.unlink(path); }
      result = 0;
      break;
    }
    case 82: case 264: case 316: { // SYS_rename / SYS_renameat / SYS_renameat2
      // Worker puts old path at offset 0, new path at a secondary offset
      let oldPath = readCString(0);
      const secondaryOffset = control[11] || 512; // secondary string offset in dataSab
      let newPath = readCString(secondaryOffset);
      if (!oldPath.startsWith('/')) { if (n !== 82 && (a|0) !== -100) { result = -95; break; } oldPath = '/' + oldPath; }
      if (!newPath.startsWith('/')) { if (n !== 82 && (c|0) !== -100) { result = -95; break; } newPath = '/' + newPath; }
      vfs.rename(vfs.resolvePath(oldPath), vfs.resolvePath(newPath));
      result = 0;
      break;
    }
    case 89: { // SYS_readlink(path=a, buf=b, bufsiz=c)
      let path = readCString(0);
      if (!path.startsWith('/')) path = '/' + path;
      if (path === '/proc/self/exe') {
        const t = new TextEncoder().encode('/bin/bash');
        const n2 = Math.min(t.length, c >>> 0);
        data.set(t.subarray(0, n2), 0);
        control[10] = n2;
        control[9] = 2;
        result = n2;
        break;
      }
      const target = vfs.symlinks.get(path) || vfs.symlinks.get(vfs.normalizePath(path));
      if (!target) { result = -22; break; } // EINVAL
      const enc = new TextEncoder().encode(target);
      const n2 = Math.min(enc.length, c >>> 0);
      data.set(enc.subarray(0, n2), 0);
      control[10] = n2;
      control[9] = 2;
      result = n2;
      break;
    }
    case 267: { // SYS_readlinkat(dirfd=a, path=b, buf=c, bufsiz=d)
      let path = readCString(0);
      if (!path.startsWith('/')) { if ((a|0) !== -100) { result = -38; break; } path = '/' + path; }
      if (path === '/proc/self/exe') {
        const t = new TextEncoder().encode('/bin/bash');
        const n2 = Math.min(t.length, d >>> 0);
        data.set(t.subarray(0, n2), 0);
        control[10] = n2;
        control[9] = 2;
        result = n2;
        break;
      }
      // /proc/self/fd/N → return path of open fd N
      const fdMatch = path.match(/^\/proc\/self\/fd\/(\d+)$/);
      if (fdMatch) {
        const fdFile = vfs.openFiles.get(parseInt(fdMatch[1]));
        const t = new TextEncoder().encode(fdFile?.path || '/');
        const n2 = Math.min(t.length, d >>> 0);
        data.set(t.subarray(0, n2), 0);
        control[10] = n2;
        control[9] = 2;
        result = n2;
        break;
      }
      const target = vfs.symlinks.get(path) || vfs.symlinks.get(vfs.normalizePath(path));
      if (!target) { result = -22; break; } // EINVAL
      const enc = new TextEncoder().encode(target);
      const n2 = Math.min(enc.length, d >>> 0);
      data.set(enc.subarray(0, n2), 0);
      control[10] = n2;
      control[9] = 2;
      result = n2;
      break;
    }
    case 217: { // SYS_getdents64(fd=a, dirp=b, count=c)
      const file = vfs.openFiles.get(a);
      if (!file || !file.isDir) { result = -9; break; } // EBADF
      if (!file._dirEntries) {
        file._dirEntries = vfs.readdir(file.dirPath);
        file._dirOffset = 0;
      }
      const bufSize = c >>> 0;
      // Build getdents64 entries in a temp buffer, then copy to dataSab
      const tmpBuf = new Uint8Array(bufSize);
      const tmpView = new DataView(tmpBuf.buffer);
      let written = 0;
      while (file._dirOffset < file._dirEntries.length) {
        const entry = file._dirEntries[file._dirOffset];
        const nameBytes = new TextEncoder().encode(entry.name);
        const reclen = ((19 + nameBytes.length + 1 + 7) >> 3) << 3;
        if (written + reclen > bufSize) break;
        const off = written;
        tmpView.setBigUint64(off, BigInt(file._dirOffset + 1), true);     // d_ino
        tmpView.setBigUint64(off + 8, BigInt(file._dirOffset + 2), true); // d_off
        tmpView.setUint16(off + 16, reclen, true);                        // d_reclen
        const dtype = entry.type === 'dir' ? 4 : entry.type === 'symlink' ? 10 : 8;
        tmpBuf[off + 18] = dtype;                                          // d_type
        tmpBuf.set(nameBytes, off + 19);
        tmpBuf[off + 19 + nameBytes.length] = 0;
        written += reclen;
        file._dirOffset++;
      }
      if (written > 0) {
        data.set(tmpBuf.subarray(0, written), 0);
        control[10] = written;
        control[9] = 2;
      }
      result = written;
      break;
    }
    case 73: result = 0; break; // SYS_flock — no contention
    case 285: result = 0; break; // SYS_fallocate — no-op

    /* ── Process/signal (single-process defaults) ── */
    case 21: result = -2; break;   // SYS_access → ENOENT
    case 24: result = 0; break;    // SYS_sched_yield
    case 25: result = -38; break;  // SYS_mremap → ENOSYS
    case 28: result = 0; break;    // SYS_madvise → no-op
    case 56: result = -38; break;  // SYS_clone → ENOSYS (Blink handles)
    case 57: result = -38; break;  // SYS_fork → ENOSYS (Blink handles)
    case 59: result = -38; break;  // SYS_execve → ENOSYS (Blink handles)
    case 61: result = -10; break;  // SYS_wait4 → ECHILD (no HOST children)
    case 95: result = 0o22; break; // SYS_umask → return old mask
    case 96: { // SYS_gettimeofday(tv, tz)
      // Write timeval into dataSab (16 bytes)
      if (a) {
        const now = Date.now();
        const view = new DataView(data.buffer, data.byteOffset);
        view.setBigInt64(0, BigInt(Math.floor(now / 1000)), true);       // tv_sec
        view.setBigInt64(8, BigInt((now % 1000) * 1000), true);          // tv_usec
        control[10] = 16;
        control[9] = 2;
      }
      result = 0;
      break;
    }
    case 97: result = 0; break;    // SYS_getrlimit
    case 98: { // SYS_getrusage
      // Write 144 bytes of zeros into dataSab
      data.fill(0, 0, 144);
      control[10] = 144;
      control[9] = 2;
      result = 0;
      break;
    }
    case 100: { // SYS_times(buf)
      if (a) {
        data.fill(0, 0, 32);
        control[10] = 32;
        control[9] = 2;
      }
      result = 0;
      break;
    }
    case 105: result = 0; break;   // SYS_setuid
    case 106: result = 0; break;   // SYS_setgid
    case 109: result = 0; break;   // SYS_setpgid
    case 111: result = 0; break;   // SYS_getpgrp
    case 112: result = 1; break;   // SYS_setsid
    case 113: result = 0; break;   // SYS_setreuid
    case 114: result = 0; break;   // SYS_setregid
    case 117: result = 0; break;   // SYS_setresuid
    case 118: { // SYS_getresuid(ruid, euid, suid)
      // Write three u32 zeros into dataSab
      const view = new DataView(data.buffer, data.byteOffset);
      view.setUint32(0, 0, true);  // ruid
      view.setUint32(4, 0, true);  // euid
      view.setUint32(8, 0, true);  // suid
      control[10] = 12;
      control[9] = 2;
      result = 0;
      break;
    }
    case 119: result = 0; break;   // SYS_setresgid
    case 120: { // SYS_getresgid(rgid, egid, sgid)
      const view = new DataView(data.buffer, data.byteOffset);
      view.setUint32(0, 0, true);
      view.setUint32(4, 0, true);
      view.setUint32(8, 0, true);
      control[10] = 12;
      control[9] = 2;
      result = 0;
      break;
    }
    case 124: result = 0; break;   // SYS_getsid
    case 15: result = 0; break;    // SYS_rt_sigreturn
    case 157: result = 0; break;   // SYS_prctl
    case 158: result = 0; break;   // SYS_arch_prctl
    case 160: result = 0; break;   // SYS_setrlimit
    case 247: result = -38; break; // SYS_waitid → ENOSYS

    /* ── Filesystem metadata — store in vfs.metadata for stat readback ── */
    case 90: { // SYS_chmod(path=a, mode=b)
      let path = readCString(0);
      if (!path.startsWith('/')) path = '/' + path;
      path = vfs.resolvePath(path);
      vfs.metadata.set(path, { ...(vfs.metadata.get(path)||{}), mode: b >>> 0 });
      result = 0;
      break;
    }
    case 91: { // SYS_fchmod(fd=a, mode=b)
      const file = vfs.openFiles.get(a);
      if (file?.path) vfs.metadata.set(file.path, { ...(vfs.metadata.get(file.path)||{}), mode: b >>> 0 });
      result = 0;
      break;
    }
    case 92: { // SYS_chown(path=a, uid=b, gid=c)
      let path = readCString(0);
      if (!path.startsWith('/')) path = '/' + path;
      path = vfs.resolvePath(path);
      vfs.metadata.set(path, { ...(vfs.metadata.get(path)||{}), uid: b, gid: c });
      result = 0;
      break;
    }
    case 93: { // SYS_fchown(fd=a, uid=b, gid=c)
      const file = vfs.openFiles.get(a);
      if (file?.path) vfs.metadata.set(file.path, { ...(vfs.metadata.get(file.path)||{}), uid: b, gid: c });
      result = 0;
      break;
    }
    case 94: result = 0; break;    // SYS_lchown — store metadata on symlink path
    case 132: result = 0; break;   // SYS_utime
    case 268: { // SYS_fchmodat(dirfd=a, path=b, mode=c)
      let path = readCString(0);
      if (!path.startsWith('/')) { if ((a|0) !== -100) { result = -95; break; } path = '/' + path; }
      path = vfs.resolvePath(path);
      vfs.metadata.set(path, { ...(vfs.metadata.get(path)||{}), mode: c >>> 0 });
      result = 0;
      break;
    }
    case 260: { // SYS_fchownat(dirfd=a, path=b, uid=c, gid=d)
      let path = readCString(0);
      if (!path.startsWith('/')) { if ((a|0) !== -100) { result = -95; break; } path = '/' + path; }
      path = vfs.resolvePath(path);
      vfs.metadata.set(path, { ...(vfs.metadata.get(path)||{}), uid: c, gid: d });
      result = 0;
      break;
    }
    case 280: { // SYS_utimensat(dirfd=a, path=b, times=c, flags=d)
      // If path is non-null, worker puts it at dataSab offset 0.
      // If times is non-null, worker puts the 32-byte timespec pair at dataSab offset 512.
      if (b) {
        let path = readCString(0);
        if (!path.startsWith('/')) { if ((a|0) !== -100) { result = -95; break; } path = '/' + path; }
        path = vfs.resolvePath(path);
        if (c) {
          const v = new DataView(data.buffer, data.byteOffset);
          const timesOffset = 512; // worker puts timespec at offset 512
          const atime_sec = Number(v.getBigInt64(timesOffset, true));
          const atime_nsec = Number(v.getBigInt64(timesOffset + 8, true));
          const mtime_sec = Number(v.getBigInt64(timesOffset + 16, true));
          const mtime_nsec = Number(v.getBigInt64(timesOffset + 24, true));
          const now = Math.floor(Date.now() / 1000);
          const UTIME_NOW = 0x3FFFFFFF, UTIME_OMIT = 0x3FFFFFFE;
          const existing = vfs.metadata.get(path) || {};
          const atime = (atime_nsec === UTIME_OMIT) ? existing.atime
                       : (atime_nsec === UTIME_NOW) ? now : atime_sec;
          const mtime = (mtime_nsec === UTIME_OMIT) ? existing.mtime
                       : (mtime_nsec === UTIME_NOW) ? now : mtime_sec;
          vfs.metadata.set(path, { ...existing, atime, mtime });
        }
      }
      result = 0;
      break;
    }
    case 133: result = -38; break; // SYS_mknod → ENOSYS
    case 137: { // SYS_statfs(path=a, buf=b)
      writeStatfsBuf(data, 0);
      control[10] = 120;
      control[9] = 2;
      result = 0;
      break;
    }
    case 138: { // SYS_fstatfs(fd=a, buf=b)
      writeStatfsBuf(data, 0);
      control[10] = 120;
      control[9] = 2;
      result = 0;
      break;
    }
    case 266: { // SYS_symlinkat(target=a, newdirfd=b, linkpath=c)
      // Worker puts target at offset 0, linkpath at offset 512
      const target = readCString(0);
      const secondaryOffset = control[11] || 512;
      let linkpath = readCString(secondaryOffset);
      if (!linkpath.startsWith('/')) { if ((b|0) !== -100) { result = -95; break; } linkpath = '/' + linkpath; }
      vfs.createSymlink(target, linkpath);
      result = 0;
      break;
    }
    case 265: { // SYS_linkat(olddirfd=a, oldpath=b, newdirfd=c, newpath=d, flags=e)
      // Worker puts oldpath at offset 0, newpath at offset 512
      let oldpath = readCString(0);
      const secondaryOffset = control[11] || 512;
      let newpath = readCString(secondaryOffset);
      if (!oldpath.startsWith('/')) { if ((a|0) !== -100) { result = -95; break; } oldpath = '/' + oldpath; }
      if (!newpath.startsWith('/')) { if ((c|0) !== -100) { result = -95; break; } newpath = '/' + newpath; }
      const content = vfs.files.get(vfs.resolvePath(oldpath));
      if (!content) { result = -2; break; }
      vfs.addFile(vfs.resolvePath(newpath), new Uint8Array(content));
      result = 0;
      break;
    }
    case 40: { // SYS_sendfile(out_fd=a, in_fd=b, offset_ptr=c, count=d)
      const outFile = vfs.openFiles.get(a);
      const inFile = vfs.openFiles.get(b);
      if (!outFile || !inFile) { result = -9; break; }
      const count = d >>> 0;
      // If offset_ptr (c) is non-zero, worker passes offset value in dataSab at offset 0
      let offset;
      if (c) {
        const v = new DataView(data.buffer, data.byteOffset);
        offset = Number(v.getBigInt64(0, true));
      } else {
        offset = inFile.position || 0;
      }
      const avail = Math.min(count, (inFile.content?.length || 0) - offset);
      if (avail <= 0) { result = 0; break; }
      vfs.write(a, inFile.content.subarray(offset, offset + avail), outFile.position || 0);
      outFile.position = (outFile.position || 0) + avail;
      if (c) {
        // Write updated offset back into dataSab for worker to copy to offset_ptr
        const v = new DataView(data.buffer, data.byteOffset);
        v.setBigInt64(0, BigInt(offset + avail), true);
        control[10] = 8;
        control[9] = 2;
      } else {
        inFile.position = offset + avail;
      }
      result = avail;
      break;
    }
    case 191: result = 0; break;   // SYS_getxattr → 0 (no attrs)
    case 192: result = 0; break;   // SYS_lgetxattr
    case 193: result = 0; break;   // SYS_fgetxattr
    case 197: result = -61; break; // SYS_removexattr → ENODATA
    case 198: result = -61; break; // SYS_lremovexattr
    case 199: result = -61; break; // SYS_fremovexattr
    case 74: result = 0; break;    // SYS_fsync
    case 75: result = 0; break;    // SYS_fdatasync
    case 76: result = 0; break;    // SYS_truncate
    case 80: result = 0; break;    // SYS_chdir (HOST) — Blink handles guest chdir
    case 161: result = 0; break;   // SYS_chroot → no-op
    case 162: result = 0; break;   // SYS_sync

    /* ── Network stubs (HOST doesn't use sockets — guest sockets go through Blink) ── */
    case 41: result = -97; break;  // SYS_socket → EAFNOSUPPORT
    case 42: result = -38; break;  // SYS_connect
    case 43: result = -38; break;  // SYS_accept
    case 44: result = -38; break;  // SYS_sendto
    case 45: result = -38; break;  // SYS_recvfrom
    case 46: result = -38; break;  // SYS_sendmsg
    case 47: result = -38; break;  // SYS_recvmsg
    case 48: result = -38; break;  // SYS_shutdown
    case 49: result = -38; break;  // SYS_bind
    case 50: result = -38; break;  // SYS_listen
    case 51: result = 0; break;    // SYS_getsockname → success (musl probes this)
    case 52: result = 0; break;    // SYS_getpeername
    case 53: result = -38; break;  // SYS_socketpair
    case 54: result = 0; break;    // SYS_setsockopt
    case 55: result = 0; break;    // SYS_getsockopt
    case 7: result = 0; break;     // SYS_poll → 0 events ready
    case 23: result = 0; break;    // SYS_select → 0 ready

    /* ── Impossible in browser ── */
    case 101: result = -38; break; // SYS_ptrace
    case 165: result = -38; break; // SYS_mount
    case 166: result = -38; break; // SYS_umount2
    case 169: result = -38; break; // SYS_reboot

    /* ── Blink-specific imports (custom numbers 1000+) ─────────────────── */
    case 1000: { // SYS_FS_OPEN — path in dataSab[0..a], flags=b, mode=c
      const path = readCString(0);
      const fd = vfs.open(path, b, c);
      // Register in process fd table
      if (fd >= 0) {
        const fds = getFdTable(pid);
        if (fds) fds.set(fd, { type: 'file', fd });
      }
      result = fd;
      break;
    }
    case 1001: { // SYS_FS_READ — handle=a, len=b, offset_lo=c, offset_hi=d
      const offset = (c >>> 0) + ((d >>> 0) * 0x100000000);
      const dest = new Uint8Array(b);
      const n2 = vfs.read(a, dest, offset);
      if (n2 > 0) {
        data.set(dest.subarray(0, n2), 0); // write to dataSab for worker to copy
        control[9] = 2;  // direction: kernel→worker
        control[10] = n2; // data length
      }
      result = n2;
      break;
    }
    case 1002: { // SYS_FS_WRITE — handle=a, len=b, offset_lo=c, offset_hi=d
      const offset = (c >>> 0) + ((d >>> 0) * 0x100000000);
      const src = new Uint8Array(data.buffer, data.byteOffset, b);
      result = vfs.write(a, src, offset);
      break;
    }
    case 1003: { // SYS_FS_CLOSE
      vfs.close(a);
      const fds = getFdTable(pid);
      if (fds) fds.delete(a);
      result = 0;
      break;
    }
    case 1004: { // SYS_FS_FSTAT — returns (size << 16) | mode as BigInt via control[8]
      const file = vfs.openFiles.get(a);
      if (!file && a > 2) { result = -1; break; }
      if (!file) { result = 0; break; }
      const size = file.content?.length || 0;
      let mode = 0o100755;
      if (file.isDir) mode = 0o40755;
      if (file.special === 'null' || file.special === 'urandom') mode = 0o20666;
      if (file.special === 'stdout' || file.special === 'stderr' || file.special === 'stdin') mode = 0o20666;
      // Encode: low 16 bits = mode, upper bits = size << 16
      result = (size << 16) | mode;
      break;
    }
    case 1005: // SYS_FS_STAT — stub
      result = 0;
      break;
    case 1006: // SYS_FS_READDIR — stub
      result = 0;
      break;
    case 1007: // SYS_PAGE_POOL_FAULT — stub (page faulting)
      result = 0;
      break;
    case 1008: // SYS_REGISTER_FILEMAP — stub
      result = 0;
      break;
    case 1009: // SYS_FORK_SPAWN
      // Tell main thread to spawn a fork child
      self.postMessage({ type: 'fork-request', pid, forkType: 'restore-fork' });
      result = pid + 1; // child PID
      break;
    case 1010: // SYS_FORK_EXEC_SPAWN — stub
      result = -38;
      break;
    case 1011: // SYS_PROC_WAIT — stub
      result = -10; // ECHILD
      break;
    case 1012: // SYS_PIPE_CREATE — stub
      result = -38;
      break;
    case 1013: // SYS_PIPE_READ — stub
      result = 0;
      break;
    case 1014: // SYS_PIPE_WRITE — stub
      result = 0;
      break;
    case 1015: // SYS_PIPE_CLOSE — stub
      result = 0;
      break;
    case 1016: // SYS_SOCKET_OPEN — stub
      result = -97;
      break;
    case 1017: // SYS_SOCKET_CONNECT — stub
      result = -38;
      break;
    case 1018: // SYS_SOCKET_SEND — stub
      result = -38;
      break;
    case 1019: // SYS_SOCKET_RECV — stub
      result = -38;
      break;
    case 1020: // SYS_SOCKET_CLOSE — stub
      result = 0;
      break;
    case 1021: // SYS_SOCKET_POLL — stub
      result = 0;
      break;
    case 1022: { // SYS_GETCWD — write cwd to dataSab
      const proc2 = processTable.get(pid);
      const cwd = proc2 ? proc2.cwd : '/';
      const cwdBytes = new TextEncoder().encode(cwd);
      data.set([...cwdBytes, 0], 0);
      control[9] = 2;
      control[10] = cwdBytes.length + 1;
      result = cwdBytes.length;
      break;
    }
    case 1023: { // SYS_CHDIR — path in dataSab[0..a]
      const path = readCString(0);
      const proc2 = processTable.get(pid);
      if (proc2) proc2.cwd = path;
      result = 0;
      break;
    }
    case 1024: { // SYS_HOST_SYSCALL — musl's __syscall() passthrough
      // control[2]=real_syscall_number, control[3-7]=real args a-e
      // Shift args: put real n at [1], real a-e at [2-6], f=0 at [7]
      const realN = control[2];
      control[1] = realN;
      control[2] = control[3];
      control[3] = control[4];
      control[4] = control[5];
      control[5] = control[6];
      control[6] = control[7];
      control[7] = 0;
      handleSyscall(pid, control, data);
      return; // handleSyscall already set control[8]
    }

    default: {
      const NAMES = {0:'read',1:'write',2:'open',3:'close',4:'stat',5:'fstat',6:'lstat',7:'poll',8:'lseek',9:'mmap',10:'mprotect',11:'munmap',12:'brk',13:'rt_sigaction',14:'rt_sigprocmask',15:'rt_sigreturn',16:'ioctl',17:'pread64',18:'pwrite64',19:'readv',20:'writev',21:'access',22:'pipe',23:'select',24:'sched_yield',25:'mremap',28:'madvise',32:'dup',33:'dup2',35:'nanosleep',39:'getpid',41:'socket',42:'connect',43:'accept',44:'sendto',45:'recvfrom',46:'sendmsg',47:'recvmsg',48:'shutdown',49:'bind',50:'listen',51:'getsockname',52:'getpeername',53:'socketpair',54:'setsockopt',55:'getsockopt',56:'clone',57:'fork',59:'execve',60:'exit',61:'wait4',62:'kill',63:'uname',72:'fcntl',77:'ftruncate',78:'getdents',79:'getcwd',80:'chdir',82:'rename',83:'mkdir',87:'unlink',89:'readlink',90:'chmod',95:'umask',96:'gettimeofday',97:'getrlimit',98:'getrusage',100:'times',102:'getuid',104:'getgid',105:'setuid',106:'setgid',107:'geteuid',108:'getegid',109:'setpgid',110:'getppid',112:'setsid',113:'setreuid',114:'setregid',117:'setresuid',118:'getresuid',119:'setresgid',120:'getresgid',121:'getpgid',124:'getsid',131:'sigaltstack',157:'prctl',158:'arch_prctl',160:'setrlimit',186:'gettid',200:'tkill',205:'set_thread_area',217:'getdents64',218:'set_tid_address',228:'clock_gettime',229:'clock_getres',231:'exit_group',234:'tgkill',257:'openat',262:'newfstatat',263:'unlinkat',267:'readlinkat',269:'faccessat',273:'set_robust_list',293:'pipe2',295:'preadv',302:'prlimit64',316:'renameat2',318:'getrandom',332:'statx'};
      console.warn('[kernel] unhandled syscall:', n, NAMES[n] || 'unknown');
      result = -38; // ENOSYS
    }
  }

  control[8] = result;
}

// ─── Kernel loop: poll each registered worker's controlSab ───────────────────

let running = false;

async function kernelLoop() {
  running = true;
  while (running) {
    let handled = false;
    for (const [pid, proc] of processTable) {
      const control = proc.control;
      const trap = Atomics.load(control, 0);
      if (trap === 1) {
        handled = true;
        control[9] = 0;
        control[10] = 0;
        control[11] = 0;

        handleSyscall(pid, control, proc.data);

        Atomics.store(control, 0, 0);
        Atomics.notify(control, 0);
      }
    }

    if (!handled) {
      if (processTable.size === 0) {
        await new Promise(resolve => setTimeout(resolve, 1));
        continue;
      }

      // Simple yield — let message loop process, then re-check
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

// ─── Message handler ─────────────────────────────────────────────────────────

self.onmessage = async (e) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      // Load rootfs tar into VFS
      if (msg.rootfsTar) {
        await vfs.loadTar(msg.rootfsTar);
        console.log(`[kernel] VFS loaded: ${vfs.files.size} files`);
        self.postMessage({ type: 'debug', message: `VFS loaded: ${vfs.files.size} files` });
      }
      // Add boot files
      if (msg.files) {
        for (const [path, content] of Object.entries(msg.files)) {
          vfs.addFile(path, content instanceof Uint8Array ? content : new Uint8Array(content));
        }
      }
      // Store config
      if (msg.config) {
        // Future: store environment, rootfs URL, etc.
      }
      self.postMessage({ type: 'init-done' });

      // Start the kernel loop
      kernelLoop();
      break;
    }

    case 'register-worker': {
      // Register a new execution worker's SABs
      const pid = msg.pid || nextPid++;
      const controlSab = msg.controlSab; // SharedArrayBuffer(256)
      const dataSab = msg.dataSab;       // SharedArrayBuffer(1MB)
      const control = new Int32Array(controlSab);
      const data = new Uint8Array(dataSab);

      processTable.set(pid, {
        controlSab,
        dataSab,
        control,
        data,
        fdTable: new Map(), // per-process fd mapping
        cwd: msg.cwd || '/',
        brk: 0,
        mmapFreelist: [],
      });

      console.log(`[kernel] registered worker pid=${pid}`);
      self.postMessage({ type: 'worker-registered', pid });
      break;
    }

    case 'unregister-worker': {
      const pid = msg.pid;
      processTable.delete(pid);
      console.log(`[kernel] unregistered worker pid=${pid}`);
      break;
    }

    // Relay socket messages to main thread (Wisp stays on main thread)
    case 'socket-open':
    case 'socket-send':
    case 'socket-close':
    case 'socket-connect': {
      // Forward to main thread
      self.postMessage(msg);
      break;
    }

    case 'stop': {
      running = false;
      self.postMessage({ type: 'stopped' });
      break;
    }

    default:
      console.warn('[kernel] unknown message type:', msg.type);
  }
};
