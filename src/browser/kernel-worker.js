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
 *     [2..7] = args a..f (pointer args are offsets into shared WASM memory)
 *     [8] = return value
 *   Shared WASM memory — the kernel reads/writes guest memory directly via
 *   proc.wasmView (Uint8Array) and wasmDV (DataView) using pointer args.
 *
 * The execution worker:
 *   1. Fills controlSab args (pointers are WASM memory offsets), sets trap=1
 *   2. Atomics.wait(controlSab, 0, 1) — blocks until kernel sets trap=0
 *   3. Reads return value from controlSab[8]
 *
 * Message types:
 *   'init'            — load rootfs tar, boot files, config
 *   'register-worker' — register a new execution worker's SABs
 *   'socket-*'        — relay to main thread (Wisp stays on main)
 */

import { VirtualFS } from './filesystem.js';

// ─── Global state ────────────────────────────────────────────────────────────

const vfs = new VirtualFS();

// Process table: pid → { controlSab, control, fdTable, cwd, brk, mmapFreelist, wasmView, wasmMemory }
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
  // Use worker-provided SAB if available (worker created it for direct I/O)
  const sab = (self._pendingPipeSabs && self._pendingPipeSabs.length > 0)
    ? self._pendingPipeSabs.shift()
    : new SharedArrayBuffer(PIPE_BUF_SIZE + 16);
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
  // Non-blocking: read what's available, return immediately
  // The kernel is single-threaded — blocking here deadlocks all processes
  while (bytesRead < len) {
    const wp = Atomics.load(control, 0);
    const rp = Atomics.load(control, 1);
    if (rp === wp) {
      if (Atomics.load(control, 2) === 1) break; // write end closed = EOF
      break; // no data available — return what we have
    }
    buf[bytesRead] = data[rp];
    Atomics.store(control, 1, (rp + 1) % cap);
    bytesRead++;
  }
  // If no data read and write end still open, return EAGAIN
  if (bytesRead === 0 && Atomics.load(control, 2) !== 1) return -11; // EAGAIN
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

// ─── Read C string from shared WASM memory ──────────────────────────────────
// With shared WASM memory, the kernel reads strings directly from the guest's
// linear memory using the pointer value from the syscall args.

function readCStringFromWasm(wasmView, ptr) {
  let end = ptr;
  while (end < wasmView.length && wasmView[end]) end++;
  const copy = new Uint8Array(end - ptr);
  copy.set(wasmView.subarray(ptr, end));
  return new TextDecoder().decode(copy);
}

// ─── Write bytes into shared WASM memory ────────────────────────────────────

function writeToWasm(wasmView, bytes, offset) {
  wasmView.set(bytes, offset);
}

// ─── Stat helper: write 112-byte kstat struct into buffer ───────────────────

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

// ─── Statfs helper: write 120 bytes into buffer ─────────────────────────────

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
// The kernel reads/writes guest memory directly via shared WASM memory.
// Syscall pointer args are offsets into proc.wasmView.
//
// controlSab layout (Int32Array):
//   [0] trap flag: 1=pending, 0=done
//   [1] syscall number (n)
//   [2] arg a  (pointer args are WASM memory offsets)
//   [3] arg b
//   [4] arg c
//   [5] arg d
//   [6] arg e
//   [7] arg f
//   [8] return value

function handleSyscall(pid, control, data) {
  const n = control[1];
  const a = control[2];
  const b = control[3];
  const c = control[4];
  const d = control[5];
  const e = control[6];
  const f = control[7];

  try {

  const proc = processTable.get(pid);
  if (!proc) { control[8] = -1; return; }

  // With shared WASM memory, the kernel reads/writes guest memory directly.
  // Create fresh views each syscall — memory.grow() increases SAB byteLength.
  const wasm = proc.wasmMemory ? new Uint8Array(proc.wasmMemory) : null;
  const wasmDV = proc.wasmMemory ? new DataView(proc.wasmMemory) : null;

  // Helper to read a C string from guest memory at pointer p
  function readCString(p) {
    if (!wasm) return '';
    return readCStringFromWasm(wasm, p >>> 0);
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
      // For file-backed mappings, the kernel writes file content directly
      // into the guest's WASM memory at the address the worker allocated.
      const len = b >>> 0;
      const flags = d;
      const MAP_ANONYMOUS = 0x20;
      if (!(flags & MAP_ANONYMOUS)) {
        // File-backed mmap: read file content into guest memory
        // a = addr hint (the worker allocated space and passes it here)
        const file = vfs.openFiles.get(e);
        if (file && file.content && wasm && a) {
          const off = Number(f) || 0;
          const avail = Math.min(len, file.content.length - off);
          if (avail > 0) {
            wasm.set(file.content.subarray(off, off + avail), a >>> 0);
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
      // b=buf pointer in WASM memory, c=count
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      const count = Math.min(c >>> 0, 1048576);
      if (entry.type === 'special') {
        if (entry.name === 'stdin') { result = 0; break; } // EOF
        if (entry.name === 'urandom') {
          const rbuf = new Uint8Array(count);
          crypto.getRandomValues(rbuf);
          wasm.set(rbuf, b >>> 0);
          result = count;
          break;
        }
        result = 0; break;
      }
      if (entry.type === 'pipe') {
        const dest = new Uint8Array(count);
        const n2 = pipeRead(entry.pipeId, dest, count);
        if (n2 === -11) {
          // EAGAIN — no data yet, pipe still open. Store pending read.
          // The kernel loop will retry on next iteration.
          if (!self._pendingPipeReads) self._pendingPipeReads = [];
          self._pendingPipeReads.push({ pid, control, wasm, wasmDV, fd: a, entry, bufPtr: b >>> 0, count });
          return; // DON'T set control[8] or notify — worker stays blocked
        }
        if (n2 > 0 && wasm) wasm.set(dest.subarray(0, n2), b >>> 0);
        result = n2;
        break;
      }
      if (entry.type === 'file' || entry.type === 'dir') {
        const file = vfs.openFiles.get(entry.vfsFd);
        if (!file) { result = -9; break; }
        const dest = new Uint8Array(count);
        const n2 = vfs.read(entry.vfsFd, dest, file.position);
        file.position += n2;
        if (n2 > 0) wasm.set(dest.subarray(0, n2), b >>> 0);
        result = n2;
        break;
      }
      if (entry.type === 'socket') { result = -9; break; } // TODO
      result = -9;
      break;
    }
    case 1: { // SYS_write(fd, buf, count)
      // b=buf pointer in WASM memory, c=count
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      const count = c >>> 0;
      const buf = wasm.slice(b >>> 0, (b >>> 0) + count);
      if (entry.type === 'special') {
        if (entry.name === 'stdout' || entry.name === 'stderr') {
          self.postMessage({ type: 'stdout', data: new Uint8Array(buf) });
          result = count;
          break;
        }
        if (entry.name === 'null') { result = count; break; }
        result = count;
        break;
      }
      if (entry.type === 'pipe') {
        result = pipeWrite(entry.pipeId, buf, count);
        break;
      }
      if (entry.type === 'file') {
        const file = vfs.openFiles.get(entry.vfsFd);
        if (!file) { result = -9; break; }
        if (file.append) file.position = file.content.length;
        vfs.write(entry.vfsFd, buf, file.position);
        file.position += count;
        result = count;
        break;
      }
      result = -9;
      break;
    }
    case 2: { // SYS_open(path, flags, mode)
      const path = readCString(a);
      const vfsFd = vfs.open(path, b, c);
      if (vfsFd >= 0) {
        const isDir = vfs.openFiles.get(vfsFd)?.isDir;
        proc.fdTable.set(vfsFd, { type: isDir ? 'dir' : 'file', vfsFd });
        if (vfsFd >= proc.nextFd) proc.nextFd = vfsFd + 1;
      }
      result = vfsFd;
      break;
    }
    case 3: { // SYS_close(fd)
      const entry3 = proc.fdTable.get(a);
      if (!entry3) { result = 0; break; } // closing unknown fd is OK
      if (entry3.type === 'file' || entry3.type === 'dir') {
        vfs.close(entry3.vfsFd);
      } else if (entry3.type === 'pipe') {
        pipeClose(entry3.pipeId, entry3.end);
        // Notify worker to remove from local pipe cache
        self.postMessage({ type: 'pipe-fd-cache', pid, removes: [a] });
      }
      proc.fdTable.delete(a);
      result = 0;
      break;
    }
    case 5: { // SYS_fstat(fd, statbuf)
      // b=statbuf pointer in WASM memory
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      if (entry.type === 'special') {
        writeStatBuf(wasm, b >>> 0, { size: 0, type: 'chardev' }, {}, a, false, true, entry.name);
        result = 0;
        break;
      }
      if (entry.type === 'pipe') {
        // S_IFIFO | rw-owner
        const pipeBuf = new Uint8Array(112);
        pipeBuf.fill(0);
        const pipeView = new DataView(pipeBuf.buffer);
        pipeView.setUint32(20, 0o10600, true); // st_mode = S_IFIFO | 0600
        pipeView.setUint32(16, 1, true);        // st_nlink
        pipeView.setInt32(56, 4096, true);      // st_blksize
        wasm.set(pipeBuf, b >>> 0);
        result = 0;
        break;
      }
      if (entry.type === 'file' || entry.type === 'dir') {
        const file = vfs.openFiles.get(entry.vfsFd);
        if (!file) { result = -9; break; }
        const size = file.content?.length || 0;
        const meta = file.path ? (vfs.metadata.get(file.path) || {}) : {};
        const isDir = file.isDir || false;
        const isSpecial = (file.special === 'null' || file.special === 'urandom' ||
                           file.special === 'stdout' || file.special === 'stderr' || file.special === 'stdin');
        writeStatBuf(wasm, b >>> 0, { size, type: isDir ? 'dir' : (isSpecial ? 'chardev' : 'file') },
                     meta, a, isDir, isSpecial, file.special);
        result = 0;
        break;
      }
      result = -9;
      break;
    }
    case 8: { // SYS_lseek(fd, offset, whence)
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      if (entry.type === 'pipe') { result = -29; break; } // ESPIPE
      if (entry.type === 'special') { result = -29; break; } // ESPIPE
      if (entry.type !== 'file' && entry.type !== 'dir') { result = -9; break; }
      const file = vfs.openFiles.get(entry.vfsFd);
      if (!file) { result = -9; break; }
      if (c === 0) file.position = b;          // SEEK_SET
      else if (c === 1) file.position += b;    // SEEK_CUR
      else if (c === 2) file.position = (file.content?.length || 0) + b; // SEEK_END
      result = file.position;
      break;
    }
    case 17: { // SYS_pread64(fd, buf, count, offset_lo, offset_hi)
      // b=buf pointer in WASM memory, c=count
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      if (entry.type !== 'file' && entry.type !== 'dir') { result = -29; break; } // ESPIPE for non-files
      const file = vfs.openFiles.get(entry.vfsFd);
      if (!file) { result = -9; break; }
      const count = c >>> 0;
      const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
      const dest = new Uint8Array(count);
      const n2 = vfs.read(entry.vfsFd, dest, offset);
      if (n2 > 0) {
        wasm.set(dest.subarray(0, n2), b >>> 0);
      }
      result = n2;
      break;
    }
    case 295: { // SYS_preadv(fd, iov, iovcnt, offset_lo, offset_hi)
      const entry = proc.fdTable.get(a);
      if (!entry || (entry.type !== 'file' && entry.type !== 'dir')) { result = -9; break; }
      const file = vfs.openFiles.get(entry.vfsFd);
      if (!file) { result = -9; break; }
      const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
      const iovcnt = c;
      let total = 0;
      for (let i = 0; i < iovcnt; i++) {
        const iovBase = wasmDV.getUint32((b >>> 0) + i * 8, true);
        const iovLen = wasmDV.getUint32((b >>> 0) + i * 8 + 4, true);
        const dest = new Uint8Array(iovLen);
        const n2 = vfs.read(entry.vfsFd, dest, offset + total);
        if (n2 > 0) wasm.set(dest.subarray(0, n2), iovBase);
        total += n2;
        if (n2 < iovLen) break;
      }
      result = total;
      break;
    }
    case 19: { // SYS_readv(fd, iov, iovcnt)
      // b=iov pointer in WASM memory, c=iovcnt
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      const iovcnt = c;
      let total = 0;
      if (entry.type === 'special') {
        if (entry.name === 'stdin') { result = 0; break; } // EOF
        if (entry.name === 'urandom') {
          for (let i = 0; i < iovcnt; i++) {
            const iovBase = wasmDV.getUint32((b >>> 0) + i * 8, true);
            const iovLen = wasmDV.getUint32((b >>> 0) + i * 8 + 4, true);
            const rbuf = new Uint8Array(iovLen);
            crypto.getRandomValues(rbuf);
            wasm.set(rbuf, iovBase);
            total += iovLen;
          }
          result = total;
          break;
        }
        result = 0; break;
      }
      if (entry.type === 'pipe') {
        // First iov — try non-blocking read
        const iov0Base = wasmDV.getUint32((b >>> 0), true);
        const iov0Len = wasmDV.getUint32((b >>> 0) + 4, true);
        const dest0 = new Uint8Array(iov0Len);
        const n0 = pipeRead(entry.pipeId, dest0, iov0Len);
        if (n0 === -11) {
          // EAGAIN — store pending readv, retry later
          if (!self._pendingPipeReads) self._pendingPipeReads = [];
          self._pendingPipeReads.push({ pid, control, wasm, wasmDV, fd: a, entry, bufPtr: iov0Base, count: iov0Len, isReadv: true, iovPtr: b >>> 0, iovcnt });
          return;
        }
        if (n0 > 0) wasm.set(dest0.subarray(0, n0), iov0Base);
        total += Math.max(n0, 0);
        // Read remaining iovecs if first was fully satisfied
        if (n0 >= iov0Len) {
          for (let i = 1; i < iovcnt; i++) {
            const iovBase = wasmDV.getUint32((b >>> 0) + i * 8, true);
            const iovLen = wasmDV.getUint32((b >>> 0) + i * 8 + 4, true);
            const dest = new Uint8Array(iovLen);
            const n2 = pipeRead(entry.pipeId, dest, iovLen);
            if (n2 <= 0) break;
            wasm.set(dest.subarray(0, n2), iovBase);
            total += n2;
            if (n2 < iovLen) break;
          }
        }
        result = total;
        break;
      }
      if (entry.type === 'file' || entry.type === 'dir') {
        const file = vfs.openFiles.get(entry.vfsFd);
        if (!file) { result = -9; break; }
        for (let i = 0; i < iovcnt; i++) {
          const iovBase = wasmDV.getUint32((b >>> 0) + i * 8, true);
          const iovLen = wasmDV.getUint32((b >>> 0) + i * 8 + 4, true);
          const dest = new Uint8Array(iovLen);
          const n2 = vfs.read(entry.vfsFd, dest, file.position);
          file.position += n2;
          if (n2 > 0) wasm.set(dest.subarray(0, n2), iovBase);
          total += n2;
          if (n2 < iovLen) break;
        }
        result = total;
        break;
      }
      result = -9;
      break;
    }
    case 20: { // SYS_writev(fd, iov, iovcnt)
      // b=iov pointer in WASM memory, c=iovcnt
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      const iovcnt = c;
      let total = 0;
      if (entry.type === 'special') {
        if (entry.name === 'stdout' || entry.name === 'stderr') {
          // Gather all iov buffers and send as one message
          let totalLen = 0;
          for (let i = 0; i < iovcnt; i++) {
            totalLen += wasmDV.getUint32((b >>> 0) + i * 8 + 4, true);
          }
          const gathered = new Uint8Array(totalLen);
          let off = 0;
          for (let i = 0; i < iovcnt; i++) {
            const iovBase = wasmDV.getUint32((b >>> 0) + i * 8, true);
            const iovLen = wasmDV.getUint32((b >>> 0) + i * 8 + 4, true);
            gathered.set(wasm.subarray(iovBase, iovBase + iovLen), off);
            off += iovLen;
          }
          self.postMessage({ type: 'stdout', data: gathered });
          result = totalLen;
          break;
        }
        if (entry.name === 'null') {
          for (let i = 0; i < iovcnt; i++) total += wasmDV.getUint32((b >>> 0) + i * 8 + 4, true);
          result = total;
          break;
        }
        result = 0; break;
      }
      if (entry.type === 'pipe') {
        for (let i = 0; i < iovcnt; i++) {
          const iovBase = wasmDV.getUint32((b >>> 0) + i * 8, true);
          const iovLen = wasmDV.getUint32((b >>> 0) + i * 8 + 4, true);
          const buf = wasm.slice(iovBase, iovBase + iovLen);
          total += pipeWrite(entry.pipeId, buf, iovLen);
        }
        result = total;
        break;
      }
      if (entry.type === 'file') {
        const file = vfs.openFiles.get(entry.vfsFd);
        if (!file) { result = -9; break; }
        for (let i = 0; i < iovcnt; i++) {
          const iovBase = wasmDV.getUint32((b >>> 0) + i * 8, true);
          const iovLen = wasmDV.getUint32((b >>> 0) + i * 8 + 4, true);
          const buf = wasm.slice(iovBase, iovBase + iovLen);
          if (file.append) file.position = file.content.length;
          vfs.write(entry.vfsFd, buf, file.position);
          file.position += iovLen;
          total += iovLen;
        }
        result = total;
        break;
      }
      result = -9;
      break;
    }
    case 257: { // SYS_openat(dirfd, path, flags, mode)
      const path = readCString(b);
      const vfsFd = vfs.open(path, c, d);
      if (vfsFd < 0) { result = vfsFd; break; }
      const isDir = vfs.openFiles.get(vfsFd)?.isDir;
      proc.fdTable.set(vfsFd, { type: isDir ? 'dir' : 'file', vfsFd });
      if (vfsFd >= proc.nextFd) proc.nextFd = vfsFd + 1;
      result = vfsFd;
      break;
    }

    /* ── Stat ── */
    case 4: case 6: case 262: { // SYS_stat/lstat/fstatat
      // stat: a=path, b=statbuf; lstat: a=path, b=statbuf; fstatat: a=dirfd, b=path, c=statbuf, d=flags
      const flags = n === 262 ? (d >>> 0) : 0;
      let path = n === 262 ? readCString(b) : readCString(a);
      if (!path.startsWith('/')) path = '/' + path;
      const followSymlinks = (n !== 6) && !(flags & 0x100);
      const info = vfs.stat(path, followSymlinks);
      if (!info) { result = -2; break; } // ENOENT
      const meta = vfs.metadata.get(followSymlinks ? vfs.resolvePath(path) : path) || {};
      const statBufPtr = n === 262 ? (c >>> 0) : (b >>> 0);
      writeStatBuf(wasm, statBufPtr, info, meta, path, info.type === 'dir', info.type === 'chardev', null);
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
      // b=timespec pointer in WASM memory
      const ns = BigInt(Math.floor(Date.now() * 1e6));
      wasmDV.setBigInt64(b >>> 0, ns / 1000000000n, true);      // tv_sec
      wasmDV.setBigInt64((b >>> 0) + 8, ns % 1000000000n, true); // tv_nsec
      result = 0;
      break;
    }
    case 229: { // SYS_clock_getres(clockid, res)
      // b=timespec pointer in WASM memory
      if (b) {
        wasmDV.setBigInt64(b >>> 0, 0n, true);
        wasmDV.setBigInt64((b >>> 0) + 8, 1000000n, true); // 1ms
      }
      result = 0;
      break;
    }
    case 35: { // SYS_nanosleep(req, rem)
      // a=req pointer in WASM memory
      const sec = Number(wasmDV.getBigInt64(a >>> 0, true));
      const nsec = Number(wasmDV.getBigInt64((a >>> 0) + 8, true));
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
      // a=buf pointer in WASM memory, b=len
      const len = b >>> 0;
      const buf = new Uint8Array(len);
      crypto.getRandomValues(buf);
      wasm.set(buf, a >>> 0);
      result = len;
      break;
    }

    /* ── Filesystem metadata ── */
    case 16: result = -25; break;  // SYS_ioctl → ENOTTY
    case 72: { // SYS_fcntl(fd=a, cmd=b, arg=c)
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      if (b === 0 || b === 1030) { // F_DUPFD / F_DUPFD_CLOEXEC
        // Find lowest available fd >= arg (c)
        let newFd = c >>> 0;
        while (proc.fdTable.has(newFd)) newFd++;
        proc.fdTable.set(newFd, { ...entry, cloexec: (b === 1030) });
        if (newFd >= proc.nextFd) proc.nextFd = newFd + 1;
        result = newFd;
        break;
      }
      if (b === 1) { result = entry.cloexec ? 1 : 0; break; } // F_GETFD
      if (b === 2) { entry.cloexec = !!(c & 1); result = 0; break; } // F_SETFD
      if (b === 3) { // F_GETFL
        let fl = 0;
        if (entry.type === 'file') {
          const file = vfs.openFiles.get(entry.vfsFd);
          if (file?.append) fl |= 0x400;
        }
        result = fl;
        break;
      }
      if (b === 4) { result = 0; break; } // F_SETFL — no-op
      result = 0;
      break;
    }
    case 32: { // SYS_dup(oldfd)
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      const newFd = proc.nextFd++;
      proc.fdTable.set(newFd, { ...entry, cloexec: false });
      result = newFd;
      break;
    }
    case 33: { // SYS_dup2(oldfd, newfd)
      if (a === b) { result = b; break; }
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      // Close existing newfd entry if present
      const existing33 = proc.fdTable.get(b);
      if (existing33) {
        if (existing33.type === 'file' || existing33.type === 'dir') vfs.close(existing33.vfsFd);
        // Don't close pipe on dup2 target — the pipe itself stays open, just the fd moves
        proc.fdTable.delete(b);
      }
      proc.fdTable.set(b, { ...entry, cloexec: false });
      if (b >= proc.nextFd) proc.nextFd = b + 1;
      // If pipe fd was duplicated, push cache update to worker
      if (entry.type === 'pipe') {
        const pipe = pipes.get(entry.pipeId);
        if (pipe) {
          self.postMessage({
            type: 'pipe-fd-cache', pid,
            updates: [{ fd: b, pipeId: entry.pipeId, end: entry.end, sab: pipe.sab }]
          });
        }
      }
      result = b;
      break;
    }
    case 292: { // SYS_dup3(oldfd, newfd, flags)
      if (a === b) { result = -22; break; } // EINVAL
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      // Close existing newfd entry if present
      const existing = proc.fdTable.get(b);
      if (existing) {
        if (existing.type === 'file' || existing.type === 'dir') vfs.close(existing.vfsFd);
        else if (existing.type === 'pipe') pipeClose(existing.pipeId, existing.end);
        proc.fdTable.delete(b);
      }
      proc.fdTable.set(b, { ...entry, cloexec: !!(c & 0x80000) });
      if (b >= proc.nextFd) proc.nextFd = b + 1;
      result = b;
      break;
    }
    case 79: { // SYS_getcwd(buf, size)
      // a=buf pointer in WASM memory, b=size
      const cwd = proc.cwd || '/';
      const bytes = new TextEncoder().encode(cwd);
      if (bytes.length + 1 > b) { result = -34; break; } // ERANGE
      wasm.set(bytes, a >>> 0);
      wasm[(a >>> 0) + bytes.length] = 0; // null terminate
      result = a; // returns the buf pointer
      break;
    }
    case 63: { // SYS_uname(buf)
      // a=utsname struct pointer in WASM memory
      // struct utsname: 5 fields of 65 bytes each = 325 bytes
      const fields = ['Linux', 'atua', '6.1.0-atua', '#1 SMP', 'x86_64'];
      let off = a >>> 0;
      for (const f of fields) {
        const bytes = new TextEncoder().encode(f);
        wasm.set(bytes, off);
        wasm[off + bytes.length] = 0;
        off += 65;
      }
      result = 0;
      break;
    }
    case 269: { // SYS_faccessat(dirfd, path, mode, flags)
      const path = readCString(b);
      const info = vfs.stat(path);
      result = info ? 0 : -2; // ENOENT
      break;
    }
    case 121: result = 0; break; // SYS_getpgid → return 0
    case 332: { // SYS_statx(dirfd=a, path=b, flags=c, mask=d, statx_buf=e)
      const path = readCString(b);
      const info = vfs.stat(path);
      if (!info) { result = -2; break; }
      // Write statx struct directly to guest memory at e
      const statxPtr = e >>> 0;
      const buf = new Uint8Array(256);
      buf.fill(0);
      const view = new DataView(buf.buffer);
      const mode = info.type === 'dir' ? 0o40755 : info.type === 'symlink' ? 0o120755 : 0o100755;
      view.setUint32(0, 0xFFF, true);          // stx_mask
      view.setUint32(4, 4096, true);            // stx_blksize
      view.setUint32(16, info.type === 'dir' ? 2 : 1, true); // stx_nlink
      view.setUint16(28, mode, true);           // stx_mode (u16 at offset 28!)
      view.setBigUint64(40, BigInt(info.size || 0), true); // stx_size
      wasm.set(buf, statxPtr);
      result = 0;
      break;
    }
    case 302: { // SYS_prlimit64(pid, resource, new, old)
      // d=old_rlim pointer in WASM memory
      if (d) {
        wasmDV.setBigUint64(d >>> 0, 1024n, true);       // rlim_cur
        wasmDV.setBigUint64((d >>> 0) + 8, 1024n, true); // rlim_max
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
      // b=buf pointer in WASM memory, c=count
      const entry = proc.fdTable.get(a);
      if (!entry) { result = -9; break; } // EBADF
      if (entry.type !== 'file') { result = -29; break; } // ESPIPE for non-files
      const file = vfs.openFiles.get(entry.vfsFd);
      if (!file) { result = -9; break; }
      const count = c >>> 0;
      const src = wasm.slice(b >>> 0, (b >>> 0) + count);
      const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
      vfs.write(entry.vfsFd, src, offset);
      result = count;
      break;
    }
    case 77: { // SYS_ftruncate(fd=a, length=b)
      const entry77 = proc.fdTable.get(a);
      if (!entry77 || entry77.type !== 'file') { result = -9; break; }
      const file = vfs.openFiles.get(entry77.vfsFd);
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
      let path = n === 83 ? readCString(a) : readCString(b);
      const mode = (n === 83 ? b : c) >>> 0;
      if (!path.startsWith('/')) { if (n === 258 && (a|0) !== -100) { result = -95; break; } path = '/' + path; }
      path = vfs.resolvePath(path);
      vfs.mkdir(path);
      if (mode) vfs.metadata.set(path, { ...(vfs.metadata.get(path)||{}), mode: mode & 0o7777 });
      result = 0;
      break;
    }
    case 87: case 263: { // SYS_unlink(path) / SYS_unlinkat(dirfd,path,flags)
      let path = n === 87 ? readCString(a) : readCString(b);
      if (!path.startsWith('/')) { if (n === 263 && (a|0) !== -100) { result = -95; break; } path = '/' + path; }
      path = vfs.resolvePath(path);
      const flags = n === 263 ? (c >>> 0) : 0;
      if (flags & 0x200) { vfs.rmdir(path); } else { vfs.unlink(path); }
      result = 0;
      break;
    }
    case 82: case 264: case 316: { // SYS_rename / SYS_renameat / SYS_renameat2
      // rename: a=oldpath, b=newpath
      // renameat: a=olddirfd, b=oldpath, c=newdirfd, d=newpath
      // renameat2: a=olddirfd, b=oldpath, c=newdirfd, d=newpath, e=flags
      let oldPath, newPath;
      if (n === 82) { oldPath = readCString(a); newPath = readCString(b); }
      else { oldPath = readCString(b); newPath = readCString(d); }
      if (!oldPath.startsWith('/')) { if (n !== 82 && (a|0) !== -100) { result = -95; break; } oldPath = '/' + oldPath; }
      if (!newPath.startsWith('/')) { if (n !== 82 && (c|0) !== -100) { result = -95; break; } newPath = '/' + newPath; }
      vfs.rename(vfs.resolvePath(oldPath), vfs.resolvePath(newPath));
      result = 0;
      break;
    }
    case 89: { // SYS_readlink(path=a, buf=b, bufsiz=c)
      let path = readCString(a);
      if (!path.startsWith('/')) path = '/' + path;
      if (path === '/proc/self/exe') {
        const t = new TextEncoder().encode('/bin/bash');
        const n2 = Math.min(t.length, c >>> 0);
        wasm.set(t.subarray(0, n2), b >>> 0);
        result = n2;
        break;
      }
      const target = vfs.symlinks.get(path) || vfs.symlinks.get(vfs.normalizePath(path));
      if (!target) { result = -22; break; } // EINVAL
      const enc = new TextEncoder().encode(target);
      const n2 = Math.min(enc.length, c >>> 0);
      wasm.set(enc.subarray(0, n2), b >>> 0);
      result = n2;
      break;
    }
    case 267: { // SYS_readlinkat(dirfd=a, path=b, buf=c, bufsiz=d)
      let path = readCString(b);
      if (!path.startsWith('/')) { if ((a|0) !== -100) { result = -38; break; } path = '/' + path; }
      if (path === '/proc/self/exe') {
        const t = new TextEncoder().encode('/bin/bash');
        const n2 = Math.min(t.length, d >>> 0);
        wasm.set(t.subarray(0, n2), c >>> 0);
        result = n2;
        break;
      }
      // /proc/self/fd/N → return path of open fd N
      const fdMatch = path.match(/^\/proc\/self\/fd\/(\d+)$/);
      if (fdMatch) {
        const fdFile = vfs.openFiles.get(parseInt(fdMatch[1]));
        const t = new TextEncoder().encode(fdFile?.path || '/');
        const n2 = Math.min(t.length, d >>> 0);
        wasm.set(t.subarray(0, n2), c >>> 0);
        result = n2;
        break;
      }
      const target = vfs.symlinks.get(path) || vfs.symlinks.get(vfs.normalizePath(path));
      if (!target) { result = -22; break; } // EINVAL
      const enc = new TextEncoder().encode(target);
      const n2 = Math.min(enc.length, d >>> 0);
      wasm.set(enc.subarray(0, n2), c >>> 0);
      result = n2;
      break;
    }
    case 217: { // SYS_getdents64(fd=a, dirp=b, count=c)
      const entry217 = proc.fdTable.get(a);
      if (!entry217) { result = -9; break; }
      const file = (entry217.type === 'file' || entry217.type === 'dir') ? vfs.openFiles.get(entry217.vfsFd) : null;
      if (!file || !file.isDir) { result = -9; break; } // EBADF
      if (!file._dirEntries) {
        file._dirEntries = vfs.readdir(file.dirPath);
        file._dirOffset = 0;
      }
      const bufSize = c >>> 0;
      const dirpBase = b >>> 0;
      // Build getdents64 entries in a temp buffer, then copy to guest memory
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
        wasm.set(tmpBuf.subarray(0, written), dirpBase);
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
      // a=timeval pointer in WASM memory
      if (a) {
        const now = Date.now();
        wasmDV.setBigInt64(a >>> 0, BigInt(Math.floor(now / 1000)), true);       // tv_sec
        wasmDV.setBigInt64((a >>> 0) + 8, BigInt((now % 1000) * 1000), true);    // tv_usec
      }
      result = 0;
      break;
    }
    case 97: result = 0; break;    // SYS_getrlimit
    case 98: { // SYS_getrusage(who=a, usage=b)
      // b=rusage pointer in WASM memory, write 144 bytes of zeros
      wasm.fill(0, b >>> 0, (b >>> 0) + 144);
      result = 0;
      break;
    }
    case 100: { // SYS_times(buf)
      // a=tms struct pointer in WASM memory
      if (a) {
        wasm.fill(0, a >>> 0, (a >>> 0) + 32);
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
      // a=ruid ptr, b=euid ptr, c=suid ptr in WASM memory
      wasmDV.setUint32(a >>> 0, 0, true);  // ruid
      wasmDV.setUint32(b >>> 0, 0, true);  // euid
      wasmDV.setUint32(c >>> 0, 0, true);  // suid
      result = 0;
      break;
    }
    case 119: result = 0; break;   // SYS_setresgid
    case 120: { // SYS_getresgid(rgid, egid, sgid)
      // a=rgid ptr, b=egid ptr, c=sgid ptr in WASM memory
      wasmDV.setUint32(a >>> 0, 0, true);  // rgid
      wasmDV.setUint32(b >>> 0, 0, true);  // egid
      wasmDV.setUint32(c >>> 0, 0, true);  // sgid
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
      let path = readCString(a);
      if (!path.startsWith('/')) path = '/' + path;
      path = vfs.resolvePath(path);
      vfs.metadata.set(path, { ...(vfs.metadata.get(path)||{}), mode: b >>> 0 });
      result = 0;
      break;
    }
    case 91: { // SYS_fchmod(fd=a, mode=b)
      const entry91 = proc.fdTable.get(a);
      const file = (entry91 && (entry91.type === 'file' || entry91.type === 'dir')) ? vfs.openFiles.get(entry91.vfsFd) : null;
      if (file?.path) vfs.metadata.set(file.path, { ...(vfs.metadata.get(file.path)||{}), mode: b >>> 0 });
      result = 0;
      break;
    }
    case 92: { // SYS_chown(path=a, uid=b, gid=c)
      let path = readCString(a);
      if (!path.startsWith('/')) path = '/' + path;
      path = vfs.resolvePath(path);
      vfs.metadata.set(path, { ...(vfs.metadata.get(path)||{}), uid: b, gid: c });
      result = 0;
      break;
    }
    case 93: { // SYS_fchown(fd=a, uid=b, gid=c)
      const entry93 = proc.fdTable.get(a);
      const file = (entry93 && (entry93.type === 'file' || entry93.type === 'dir')) ? vfs.openFiles.get(entry93.vfsFd) : null;
      if (file?.path) vfs.metadata.set(file.path, { ...(vfs.metadata.get(file.path)||{}), uid: b, gid: c });
      result = 0;
      break;
    }
    case 94: result = 0; break;    // SYS_lchown — store metadata on symlink path
    case 132: result = 0; break;   // SYS_utime
    case 268: { // SYS_fchmodat(dirfd=a, path=b, mode=c)
      let path = readCString(b);
      if (!path.startsWith('/')) { if ((a|0) !== -100) { result = -95; break; } path = '/' + path; }
      path = vfs.resolvePath(path);
      vfs.metadata.set(path, { ...(vfs.metadata.get(path)||{}), mode: c >>> 0 });
      result = 0;
      break;
    }
    case 260: { // SYS_fchownat(dirfd=a, path=b, uid=c, gid=d)
      let path = readCString(b);
      if (!path.startsWith('/')) { if ((a|0) !== -100) { result = -95; break; } path = '/' + path; }
      path = vfs.resolvePath(path);
      vfs.metadata.set(path, { ...(vfs.metadata.get(path)||{}), uid: c, gid: d });
      result = 0;
      break;
    }
    case 280: { // SYS_utimensat(dirfd=a, path=b, times=c, flags=d)
      // b=path pointer in WASM memory, c=times pointer in WASM memory
      if (b) {
        let path = readCString(b);
        if (!path.startsWith('/')) { if ((a|0) !== -100) { result = -95; break; } path = '/' + path; }
        path = vfs.resolvePath(path);
        if (c) {
          const timesPtr = c >>> 0;
          const atime_sec = Number(wasmDV.getBigInt64(timesPtr, true));
          const atime_nsec = Number(wasmDV.getBigInt64(timesPtr + 8, true));
          const mtime_sec = Number(wasmDV.getBigInt64(timesPtr + 16, true));
          const mtime_nsec = Number(wasmDV.getBigInt64(timesPtr + 24, true));
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
      writeStatfsBuf(wasm, b >>> 0);
      result = 0;
      break;
    }
    case 138: { // SYS_fstatfs(fd=a, buf=b)
      writeStatfsBuf(wasm, b >>> 0);
      result = 0;
      break;
    }
    case 266: { // SYS_symlinkat(target=a, newdirfd=b, linkpath=c)
      // a=target pointer, c=linkpath pointer in WASM memory
      const target = readCString(a);
      let linkpath = readCString(c);
      if (!linkpath.startsWith('/')) { if ((b|0) !== -100) { result = -95; break; } linkpath = '/' + linkpath; }
      vfs.createSymlink(target, linkpath);
      result = 0;
      break;
    }
    case 265: { // SYS_linkat(olddirfd=a, oldpath=b, newdirfd=c, newpath=d, flags=e)
      // b=oldpath pointer, d=newpath pointer in WASM memory
      let oldpath = readCString(b);
      let newpath = readCString(d);
      if (!oldpath.startsWith('/')) { if ((a|0) !== -100) { result = -95; break; } oldpath = '/' + oldpath; }
      if (!newpath.startsWith('/')) { if ((c|0) !== -100) { result = -95; break; } newpath = '/' + newpath; }
      const content = vfs.files.get(vfs.resolvePath(oldpath));
      if (!content) { result = -2; break; }
      vfs.addFile(vfs.resolvePath(newpath), new Uint8Array(content));
      result = 0;
      break;
    }
    case 40: { // SYS_sendfile(out_fd=a, in_fd=b, offset_ptr=c, count=d)
      const entryOut = proc.fdTable.get(a);
      const entryIn = proc.fdTable.get(b);
      if (!entryOut || !entryIn) { result = -9; break; }
      const outFile = (entryOut.type === 'file') ? vfs.openFiles.get(entryOut.vfsFd) : null;
      const inFile = (entryIn.type === 'file') ? vfs.openFiles.get(entryIn.vfsFd) : null;
      if (!outFile || !inFile) { result = -9; break; }
      const count = d >>> 0;
      let offset;
      if (c) {
        offset = Number(wasmDV.getBigInt64(c >>> 0, true));
      } else {
        offset = inFile.position || 0;
      }
      const avail = Math.min(count, (inFile.content?.length || 0) - offset);
      if (avail <= 0) { result = 0; break; }
      vfs.write(a, inFile.content.subarray(offset, offset + avail), outFile.position || 0);
      outFile.position = (outFile.position || 0) + avail;
      if (c) {
        // Write updated offset back to guest memory
        wasmDV.setBigInt64(c >>> 0, BigInt(offset + avail), true);
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
    case 1000: { // SYS_FS_OPEN — a=pathPtr, flags=b, mode=c
      const path = readCString(a);
      const vfsFd = vfs.open(path, b, c);
      if (vfsFd >= 0) {
        const isDir = vfs.openFiles.get(vfsFd)?.isDir;
        proc.fdTable.set(vfsFd, { type: isDir ? 'dir' : 'file', vfsFd });
        if (vfsFd >= proc.nextFd) proc.nextFd = vfsFd + 1;
      }
      result = vfsFd;
      break;
    }
    case 1001: { // SYS_FS_READ — handle=a, bufPtr=b, len=c, offset_lo=d, offset_hi=e
      const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
      const readLen = c >>> 0;
      const dest = new Uint8Array(readLen);
      const n2 = vfs.read(a, dest, offset);
      if (n2 > 0) {
        wasm.set(dest.subarray(0, n2), b >>> 0);
      }
      result = n2;
      break;
    }
    case 1002: { // SYS_FS_WRITE — handle=a, bufPtr=b, len=c, offset_lo=d, offset_hi=e
      const offset = (d >>> 0) + ((e >>> 0) * 0x100000000);
      const src = wasm.slice(b >>> 0, (b >>> 0) + (c >>> 0));
      result = vfs.write(a, src, offset);
      break;
    }
    case 1003: { // SYS_FS_CLOSE
      vfs.close(a);
      const fds = getProcessFdTable(pid);
      if (fds) fds.delete(a);
      result = 0;
      break;
    }
    case 1004: { // SYS_FS_FSTAT — returns (size << 16) | mode as i64
      // Returns packed value: lo32 in control[8], hi32 in control[9]
      const file = vfs.openFiles.get(a);
      if (!file && a > 2) { result = -1; break; }
      if (!file) { result = 0; break; }
      const size = file.content?.length || 0;
      let mode = 0o100755;
      if (file.isDir) mode = 0o40755;
      if (file.special === 'null' || file.special === 'urandom') mode = 0o20666;
      if (file.special === 'stdout' || file.special === 'stderr' || file.special === 'stdin') mode = 0o20666;
      const packed = (size * 65536) + mode;
      const lo = packed & 0xFFFFFFFF;
      const hi = Math.floor(packed / 0x100000000) & 0xFFFFFFFF;
      control[9] = hi; // hi32 in control[9] — execution worker reads Atomics.load(ctl, 9)
      result = lo | 0;
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
    case 1009: { // SYS_FORK_SPAWN (full fork with state restoration)
      // a=statePtr in WASM memory, b=stateLen
      const childPid = nextPid++;
      // Duplicate parent's fd table for child
      const parentFds = proc.fdTable;
      const childFds = new Map(parentFds);
      // Read fork state from guest memory
      const statePtr = a >>> 0;
      const stateLen = b >>> 0;
      const forkState = wasm.slice(statePtr, statePtr + stateLen);
      // Store child process info with duplicated fd table (same pattern as fork-exec)
      processTable.set(childPid, {
        controlSab: null, control: null, wasmMemory: null, wasmView: null,
        fdTable: childFds, nextFd: proc.nextFd, cwd: proc.cwd, brk: 0, mmapFreelist: [],
      });
      // Tell main thread to spawn a fork child, passing parent's wasmMemory
      // so the child can read parent pages during page_pool_fault
      // Collect pipe fds to include in the fork-request (child needs them BEFORE execution)
      const pipeFds1009 = [];
      for (const [fd, fentry] of childFds) {
        if (fentry.type === 'pipe') {
          const pipe = pipes.get(fentry.pipeId);
          if (pipe) pipeFds1009.push({ fd, pipeId: fentry.pipeId, end: fentry.end, sab: pipe.sab });
        }
      }
      self.postMessage({
        type: 'fork-request', pid, childPid, forkType: 'restore-fork',
        forkState, forkStateLen: stateLen,
        parentWasmMemory: proc.wasmMemory,
        pipeFds: pipeFds1009,
      });
      result = childPid;
      break;
    }
    case 1010: { // SYS_FORK_EXEC_SPAWN (fork+exec fast path)
      // a=childPid, b=pathPtr, c=argvPackedPtr, d=argvLen, e=envpPackedPtr, f=envpLen
      const childPid = a;
      if (childPid >= nextPid) nextPid = childPid + 1;
      const path = readCString(b);
      // Read packed argv from guest memory (null-separated strings)
      const argvPtr = c >>> 0;
      const argvLen = d >>> 0;
      const argvBytes = wasm.slice(argvPtr, argvPtr + argvLen);
      const argv = [];
      { let s = 0;
        for (let i = 0; i < argvLen; i++) {
          if (argvBytes[i] === 0) { argv.push(new TextDecoder().decode(argvBytes.subarray(s, i))); s = i + 1; }
        }
      }
      // Read packed envp from guest memory
      const envpPtr = e >>> 0;
      const envpLen = f >>> 0;
      const envpBytes = wasm.slice(envpPtr, envpPtr + envpLen);
      const envEntries = [];
      { let s = 0;
        for (let i = 0; i < envpLen; i++) {
          if (envpBytes[i] === 0) {
            const entry = new TextDecoder().decode(envpBytes.subarray(s, i));
            const eq = entry.indexOf('=');
            if (eq >= 0) envEntries.push([entry.substring(0, eq), entry.substring(eq + 1)]);
            s = i + 1;
          }
        }
      }
      // Duplicate parent's fd table for child
      const parentFds = proc.fdTable;
      const childFds = new Map(parentFds);
      // Store child process info (will be registered when main thread sends register-worker)
      processTable.set(childPid, {
        controlSab: null, control: null, wasmMemory: null, wasmView: null,
        fdTable: childFds, nextFd: proc.nextFd, cwd: proc.cwd, brk: 0, mmapFreelist: [],
        pendingBoot: { path, argv, env: Object.fromEntries(envEntries) },
      });
      // Collect pipe fds to include in fork-request
      const pipeFds1010 = [];
      for (const [fd1010, entry1010] of childFds) {
        if (entry1010.type === 'pipe') {
          const pipe1010 = pipes.get(entry1010.pipeId);
          if (pipe1010) pipeFds1010.push({ fd: fd1010, pipeId: entry1010.pipeId, end: entry1010.end, sab: pipe1010.sab });
        }
      }
      self.postMessage({
        type: 'fork-request', pid, childPid, forkType: 'fork-exec',
        path, argv, env: Object.fromEntries(envEntries),
        pipeFds: pipeFds1010,
      });
      result = childPid;
      break;
    }
    case 1011: { // SYS_PROC_WAIT (wait for child to exit)
      // a = child pid to wait for (0 = any child)
      const waitPid = a;
      // Check if child already exited
      if (!self._exitCodes) self._exitCodes = new Map();
      if (waitPid > 0 && self._exitCodes.has(waitPid)) {
        const code = self._exitCodes.get(waitPid);
        self._exitCodes.delete(waitPid);
        // Write wait status to guest memory (b=status pointer if provided)
        if (b && wasmDV) {
          wasmDV.setInt32(b >>> 0, (code & 0xFF) << 8, true);
        }
        result = waitPid;
        break;
      }
      // Child hasn't exited yet — store pending wait, will be resolved later
      if (!self._pendingWaits) self._pendingWaits = new Map();
      self._pendingWaits.set(waitPid || pid, { pid, control, wasm, wasmDV, statusPtr: b });
      // DON'T set control[8] or notify — leave parent blocked until child exits
      return; // skip the control[8] = result at the end
    }
    case 1012: { // SYS_PIPE_CREATE — returns pipe id
      const pipeId = createPipe();
      const pipe = pipes.get(pipeId);
      // TEMPORARY: Blink assigns pipe fds as 200+pipeId*2 (read) and 200+pipeId*2+1 (write)
      // TODO: Replace with SYS_REGISTER_PIPE_FD from C side for proper fd registration
      const readFd = 200 + pipeId * 2;
      const writeFd = 200 + pipeId * 2 + 1;
      proc.fdTable.set(readFd, { type: 'pipe', pipeId, end: 0 });
      proc.fdTable.set(writeFd, { type: 'pipe', pipeId, end: 1 });
      // Push pipe SABs to worker for direct I/O (CheerpX pattern — no kernel in data path)
      if (pipe) {
        self.postMessage({
          type: 'pipe-fd-cache', pid,
          updates: [
            { fd: readFd, pipeId, end: 0, sab: pipe.sab },
            { fd: writeFd, pipeId, end: 1, sab: pipe.sab },
          ]
        });
      }
      result = pipeId;
      break;
    }
    case 1013: { // SYS_PIPE_READ(pipeId=a, bufPtr=b, len=c)
      const len = Math.min(c >>> 0, 65536);
      const buf = new Uint8Array(len);
      const n2 = pipeRead(a, buf, len);
      if (n2 > 0 && wasm) wasm.set(buf.subarray(0, n2), b >>> 0);
      result = n2;
      break;
    }
    case 1014: { // SYS_PIPE_WRITE(pipeId=a, bufPtr=b, len=c)
      const len = c >>> 0;
      const src = wasm ? wasm.slice(b >>> 0, (b >>> 0) + len) : new Uint8Array(0);
      result = pipeWrite(a, src, len);
      break;
    }
    case 1015: { // SYS_PIPE_CLOSE(pipeId=a, end=b)
      pipeClose(a, b);
      result = 0;
      break;
    }
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
    case 1022: { // SYS_GETCWD — a=bufPtr in WASM memory
      const proc2 = processTable.get(pid);
      const cwd = proc2 ? proc2.cwd : '/';
      const cwdBytes = new TextEncoder().encode(cwd);
      wasm.set(cwdBytes, a >>> 0);
      wasm[(a >>> 0) + cwdBytes.length] = 0; // null terminate
      result = cwdBytes.length;
      break;
    }
    case 1023: { // SYS_CHDIR — a=pathPtr in WASM memory
      const path = readCString(a);
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
      handleSyscall(pid, control, null);
      return; // handleSyscall already set control[8]
    }

    default: {
      const NAMES = {0:'read',1:'write',2:'open',3:'close',4:'stat',5:'fstat',6:'lstat',7:'poll',8:'lseek',9:'mmap',10:'mprotect',11:'munmap',12:'brk',13:'rt_sigaction',14:'rt_sigprocmask',15:'rt_sigreturn',16:'ioctl',17:'pread64',18:'pwrite64',19:'readv',20:'writev',21:'access',22:'pipe',23:'select',24:'sched_yield',25:'mremap',28:'madvise',32:'dup',33:'dup2',35:'nanosleep',39:'getpid',41:'socket',42:'connect',43:'accept',44:'sendto',45:'recvfrom',46:'sendmsg',47:'recvmsg',48:'shutdown',49:'bind',50:'listen',51:'getsockname',52:'getpeername',53:'socketpair',54:'setsockopt',55:'getsockopt',56:'clone',57:'fork',59:'execve',60:'exit',61:'wait4',62:'kill',63:'uname',72:'fcntl',77:'ftruncate',78:'getdents',79:'getcwd',80:'chdir',82:'rename',83:'mkdir',87:'unlink',89:'readlink',90:'chmod',95:'umask',96:'gettimeofday',97:'getrlimit',98:'getrusage',100:'times',102:'getuid',104:'getgid',105:'setuid',106:'setgid',107:'geteuid',108:'getegid',109:'setpgid',110:'getppid',112:'setsid',113:'setreuid',114:'setregid',117:'setresuid',118:'getresuid',119:'setresgid',120:'getresgid',121:'getpgid',124:'getsid',131:'sigaltstack',157:'prctl',158:'arch_prctl',160:'setrlimit',186:'gettid',200:'tkill',205:'set_thread_area',217:'getdents64',218:'set_tid_address',228:'clock_gettime',229:'clock_getres',231:'exit_group',234:'tgkill',257:'openat',262:'newfstatat',263:'unlinkat',267:'readlinkat',269:'faccessat',273:'set_robust_list',293:'pipe2',295:'preadv',302:'prlimit64',316:'renameat2',318:'getrandom',332:'statx'};
      console.warn('[kernel] unhandled syscall:', n, NAMES[n] || 'unknown');
      result = -38; // ENOSYS
    }
  }

  control[8] = result;

  } catch (err) {
    console.error('[kernel] handleSyscall CRASH: n=' + n + ' a=' + a + ' b=' + b + ' pid=' + pid + ': ' + err.message);
    control[8] = -1;
  }
}

// ─── Kernel loop: poll each registered worker's controlSab ───────────────────

let running = false;

async function kernelLoop() {
  running = true;
  while (running) {
    let handled = false;
    for (const [pid, proc] of processTable) {
      if (!proc.control) continue;
      const control = proc.control;
      const trap = Atomics.load(control, 0);
      if (trap === 1) {
        // Process has a pending trap. Wait for wasmMemory to be registered.
        if (!proc.wasmMemory) {
          await new Promise(resolve => setTimeout(resolve, 10));
          if (!proc.wasmMemory) {
            if (!proc._wmWarnCount) proc._wmWarnCount = 0;
            if (proc._wmWarnCount++ < 3) self.postMessage({ type: 'debug', message: `pid ${pid}: trap pending but no wasmMemory yet (attempt ${proc._wmWarnCount})` });
            continue;
          }
        }
        handled = true;
        // Debug logging removed

        // Yield to process pending messages (pipe-fd-cache, memory-ready, etc.)
        await new Promise(resolve => setTimeout(resolve, 1));

        handleSyscall(pid, control, null);

        Atomics.store(control, 0, 0);
        Atomics.notify(control, 0);
      }
    }

    // Retry pending pipe reads — check if pipe has data now
    if (self._pendingPipeReads && self._pendingPipeReads.length > 0) {
      const pending = self._pendingPipeReads;
      self._pendingPipeReads = [];
      for (const pr of pending) {
        const dest = new Uint8Array(pr.count);
        const n2 = pipeRead(pr.entry.pipeId, dest, pr.count);
        if (n2 === -11) {
          // Still no data — re-queue
          if (!self._pendingPipeReads) self._pendingPipeReads = [];
          self._pendingPipeReads.push(pr);
        } else {
          // Got data (or EOF) — complete the syscall
          if (n2 > 0 && pr.wasm) {
            // Refresh wasm view in case memory grew
            const proc = processTable.get(pr.pid);
            const freshWasm = proc?.wasmMemory ? new Uint8Array(proc.wasmMemory) : pr.wasm;
            freshWasm.set(dest.subarray(0, n2), pr.bufPtr);
          }
          pr.control[8] = n2;
          Atomics.store(pr.control, 0, 0);
          Atomics.notify(pr.control, 0);
          handled = true;
        }
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
      const controlSab = msg.controlSab;
      const control = new Int32Array(controlSab);

      // Keep nextPid above all registered PIDs
      if (pid >= nextPid) nextPid = pid + 1;
      // Preserve existing process state (fd table from fork-exec) if it exists
      const existing = processTable.get(pid);
      processTable.set(pid, {
        controlSab,
        control,
        fdTable: existing?.fdTable || new Map([
          [0, { type: 'special', name: 'stdin' }],
          [1, { type: 'special', name: 'stdout' }],
          [2, { type: 'special', name: 'stderr' }],
        ]),
        nextFd: existing?.nextFd || 3,
        cwd: existing?.cwd || msg.cwd || '/',
        brk: 0,
        mmapFreelist: [],
        wasmMemory: existing?.wasmMemory || null,
        wasmView: existing?.wasmView || null,
      });

      self.postMessage({ type: 'worker-registered', pid });
      break;
    }

    case 'register-memory': {
      const pid = msg.pid;
      const proc = processTable.get(pid);
      if (proc) {
        proc.wasmMemory = msg.wasmMemoryBuffer;
        proc.wasmView = new Uint8Array(msg.wasmMemoryBuffer);
      }
      break;
    }

    case 'pipe-sab': {
      if (!self._pendingPipeSabs) self._pendingPipeSabs = [];
      self._pendingPipeSabs.push(msg.sab);
      console.log('[kernel] received pipe-sab, pending=' + self._pendingPipeSabs.length);
      break;
    }

    case 'unregister-worker': {
      const pid = msg.pid;
      processTable.delete(pid);
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

    case 'worker-exit': {
      const exitPid = msg.pid;
      const exitCode = msg.code || 0;
      processTable.delete(exitPid);
      // Store exit code for future waitpid
      if (!self._exitCodes) self._exitCodes = new Map();
      self._exitCodes.set(exitPid, exitCode);
      // Wake any parent waiting on this child
      if (self._pendingWaits) {
        // Check for exact pid wait or any-child wait
        const waiter = self._pendingWaits.get(exitPid) || self._pendingWaits.get(1); // PID 1 = parent
        if (waiter) {
          self._pendingWaits.delete(exitPid);
          self._pendingWaits.delete(1);
          // Write wait status to guest memory
          if (waiter.statusPtr && waiter.wasmDV) {
            waiter.wasmDV.setInt32(waiter.statusPtr >>> 0, (exitCode & 0xFF) << 8, true);
          }
          waiter.control[8] = exitPid; // return child pid
          Atomics.store(waiter.control, 0, 0); // clear trap
          Atomics.notify(waiter.control, 0); // wake parent
        }
      }
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
