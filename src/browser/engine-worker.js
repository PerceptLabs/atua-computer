/**
 * engine-worker.js — Web Worker that runs a fork child.
 * Loads engine.wasm, writes fork state into WASM memory, calls restore_fork.
 * stdout/stderr routed to parent via postMessage.
 */

let memory = null;
let instance = null;

// Pipe table for this child — populated from parent's SABs
let childPipes = new Map();
const PIPE_BUF_SIZE = 64 * 1024;

/** Reset worker state for reuse from worker pool (Phase 2e) */
function resetWorkerState() {
  memory = null;
  instance = null;
  childPipes = new Map();
}

function childPipeRead(pipeId, buf, len) {
  const pipe = childPipes.get(pipeId);
  if (!pipe) return -1;
  const { control, data } = pipe;
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
    buf[bytesRead] = data[rp];
    Atomics.store(control, 1, (rp + 1) % cap);
    bytesRead++;
  }
  return bytesRead;
}

function childPipeWrite(pipeId, buf, len) {
  const pipe = childPipes.get(pipeId);
  if (!pipe) return -1;
  const { control, data } = pipe;
  const cap = data.length;
  let written = 0;
  for (let i = 0; i < len; i++) {
    const wp = Atomics.load(control, 0);
    const next = (wp + 1) % cap;
    if (next === Atomics.load(control, 1)) break;
    data[wp] = buf[i];
    Atomics.store(control, 0, next);
    written++;
  }
  Atomics.notify(control, 1);
  return written;
}

function childPipeClose(pipeId, end) {
  const pipe = childPipes.get(pipeId);
  if (!pipe) return;
  if (end === 1) {
    Atomics.store(pipe.control, 2, 1);
    Atomics.notify(pipe.control, 1);
  } else {
    Atomics.store(pipe.control, 3, 1);
  }
}

self.onmessage = async (e) => {
  if (e.data.type === 'reset') {
    // Phase 2e: Worker pool reuse — clear all per-fork state so this
    // Worker can accept another 'restore-fork' message.
    resetWorkerState();
    self.postMessage({ type: 'reset-ack' });
    return;
  }
  if (e.data.type === 'fork-exec') {
    /* Phase 2c: fork+exec fast path.
     * No fork state restoration, no SAB page copy. Just instantiate the
     * engine WASM and run the target program via _start(). The engine's
     * main() parses ['blink', path] and calls LoadProgram() directly. */
    const { pid, path, argv, env, engineModule, engineUrl, vfsState, pipeSabs } = e.data;

    // Reconstruct pipe table
    if (pipeSabs) {
      for (const [idStr, sab] of Object.entries(pipeSabs)) {
        const id = parseInt(idStr);
        childPipes.set(id, {
          sab,
          control: new Int32Array(sab, 0, 4),
          data: new Uint8Array(sab, 16, PIPE_BUF_SIZE),
        });
      }
    }

    const engineBytesOrModule = engineModule || await fetch(engineUrl).then(r => r.arrayBuffer());

    // Reconstruct VFS from serialized parent state
    const vs = vfsState || {};
    const vfs = new Map();
    const dirs = new Set();
    const symlinkMap = new Map();
    const whiteouts = new Set();
    const metadata = new Map();
    const children = new Map();
    const bootTime = vs.bootTime || Math.floor(Date.now() / 1000);

    if (vs.files) for (const [p, buf] of Object.entries(vs.files)) vfs.set(p, new Uint8Array(buf));
    if (vs.dirs) for (const d of vs.dirs) dirs.add(d);
    if (vs.symlinks) for (const [p, t] of Object.entries(vs.symlinks)) symlinkMap.set(p, t);
    if (vs.whiteouts) for (const w of vs.whiteouts) whiteouts.add(w);
    if (vs.metadata) for (const [p, m] of Object.entries(vs.metadata)) metadata.set(p, m);
    if (vs.children) for (const [p, ch] of Object.entries(vs.children)) children.set(p, new Set(ch));

    function normPath(p) {
      const parts = p.split('/');
      const r = [];
      for (const s of parts) { if (s === '' || s === '.') continue; if (s === '..') { r.pop(); continue; } r.push(s); }
      return '/' + r.join('/');
    }
    function resolveSymlinks(path, depth) {
      if (!symlinkMap.size || (depth || 0) > 40) return path;
      path = normPath(path);
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        const target = symlinkMap.get(prefix);
        if (target) {
          const rest = parts.slice(i).join('/');
          return resolveSymlinks(rest ? target + '/' + rest : target, (depth || 0) + 1);
        }
      }
      return path;
    }
    function vfsExists(path) {
      if (whiteouts.has(path)) return false;
      return vfs.has(path) || dirs.has(path) || symlinkMap.has(path);
    }
    function vfsStat(path, followSymlinks) {
      if (!path.startsWith('/')) path = '/' + path;
      if (path === '/dev/null' || path === '/dev/urandom' || path === '/dev/random') return { size: 0, type: 'chardev' };
      if (followSymlinks === false && symlinkMap.has(path)) return { size: symlinkMap.get(path).length, type: 'symlink' };
      const resolved = resolveSymlinks(path);
      if (whiteouts.has(resolved)) return null;
      const content = vfs.get(resolved);
      if (content) return { size: content.length, type: 'file', ...(metadata.get(resolved) || {}) };
      if (dirs.has(resolved) || dirs.has(path)) return { size: 0, type: 'dir', ...(metadata.get(resolved) || {}) };
      return null;
    }
    function vfsReaddir(path) {
      const resolved = resolveSymlinks(path);
      const ch = children.get(resolved) || children.get(path);
      if (ch) {
        const entries = ['.', '..'];
        for (const name of ch) {
          const fullPath = resolved === '/' ? '/' + name : resolved + '/' + name;
          if (!whiteouts.has(fullPath)) entries.push(name);
        }
        return entries;
      }
      return null;
    }

    // Build Blink args: engine path + program path
    // The engine's main() parses these and calls LoadProgram
    const engineArgs = ['blink', path, ...argv.slice(1)];

    // Convert env object to KEY=VALUE entries for environ
    const envEntries = Object.entries(env || {});

    // Open files table for VFS
    const openFiles = new Map();
    openFiles.set(0, { special: 'stdin', position: 0, path: '/dev/stdin' });
    openFiles.set(1, { special: 'stdout', position: 0, path: '/dev/stdout' });
    openFiles.set(2, { special: 'stderr', position: 0, path: '/dev/stderr' });
    let nextFd = 3;

    const result = await WebAssembly.instantiate(engineBytesOrModule, {
      atua: {
        // args/environ for _start() → main(argc, argv)
        args_sizes_get(argcPtr, bufSizePtr) {
          const view = new DataView(memory.buffer);
          view.setUint32(argcPtr, engineArgs.length, true);
          let size = 0;
          for (const a of engineArgs) size += new TextEncoder().encode(a).length + 1;
          view.setUint32(bufSizePtr, size, true);
          return 0;
        },
        args_get(argvPtr, argvBufPtr) {
          const view = new DataView(memory.buffer);
          let off = argvBufPtr;
          for (let i = 0; i < engineArgs.length; i++) {
            view.setUint32(argvPtr + i * 4, off, true);
            const bytes = new TextEncoder().encode(engineArgs[i]);
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
        term_write(bufPtr, len) {
          const bytes = new Uint8Array(memory.buffer, bufPtr, len);
          self.postMessage({ type: 'stdout', data: new Uint8Array(bytes) });
        },
        term_read(bufPtr, len) { return 0; },
        term_get_size(rowsPtr, colsPtr) {
          const view = new DataView(memory.buffer);
          view.setInt32(rowsPtr, 24, true);
          view.setInt32(colsPtr, 80, true);
        },
        fs_open(pathPtr, flags, mode) {
          const mem = new Uint8Array(memory.buffer);
          let end = pathPtr;
          while (end < mem.length && mem[end]) end++;
          let p = new TextDecoder().decode(mem.subarray(pathPtr, end));
          if (!p.startsWith('/')) p = '/' + p;
          const resolved = resolveSymlinks(p);
          // O_CREAT handling
          if ((flags & 0x40) && !vfs.has(resolved) && !dirs.has(resolved)) {
            vfs.set(resolved, new Uint8Array(0));
            // Add to parent's children
            const parentDir = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
            const name = resolved.substring(resolved.lastIndexOf('/') + 1);
            if (!children.has(parentDir)) children.set(parentDir, new Set());
            children.get(parentDir).add(name);
          }
          const content = vfs.get(resolved);
          if (!content && !dirs.has(resolved) && !dirs.has(p)) {
            if (p === '/dev/null' || p === '/dev/urandom' || p === '/dev/random') {
              const fd = nextFd++;
              openFiles.set(fd, { path: p, special: true, position: 0 });
              return fd;
            }
            return -2; // ENOENT
          }
          const fd = nextFd++;
          openFiles.set(fd, {
            path: resolved,
            content: content || null,
            isDir: dirs.has(resolved) || dirs.has(p),
            position: 0,
          });
          return fd;
        },
        fs_read(handle, bufPtr, len, offset) {
          const file = openFiles.get(handle);
          if (!file || !file.content) return 0;
          const start = offset >= 0 ? offset : file.position;
          const end = Math.min(start + len, file.content.length);
          const slice = file.content.subarray(start, end);
          new Uint8Array(memory.buffer, bufPtr, slice.length).set(slice);
          file.position = end;
          return slice.length;
        },
        fs_write(handle, bufPtr, len, offset) {
          const file = openFiles.get(handle);
          if (!file) return -1;
          if (file.special && file.path === '/dev/null') return len;
          const data = new Uint8Array(memory.buffer, bufPtr, len).slice();
          const pos = offset >= 0 ? offset : file.position;
          if (!file.content || pos + len > file.content.length) {
            const newBuf = new Uint8Array(pos + len);
            if (file.content) newBuf.set(file.content);
            file.content = newBuf;
            vfs.set(file.path, newBuf);
          } else {
            file.content.set(data, pos);
          }
          file.position = pos + len;
          return len;
        },
        fs_close(handle) { openFiles.delete(handle); },
        fs_fstat(handle) {
          const file = openFiles.get(handle);
          if (!file && handle > 2) return BigInt(-1);
          if (!file) return BigInt(0);
          const size = BigInt(file.content?.length || 0);
          let mode = 0o100755;
          if (file.isDir) mode = 0o40755;
          if (file.special) mode = 0o20666;
          return (size << 16n) | BigInt(mode);
        },
        fs_stat(pathPtr, statBufPtr, statLen) {
          const mem = new Uint8Array(memory.buffer);
          let end = pathPtr;
          while (end < mem.length && mem[end]) end++;
          let p = new TextDecoder().decode(mem.subarray(pathPtr, end));
          if (!p.startsWith('/')) p = '/' + p;
          const stat = vfsStat(p, true);
          if (!stat) return -2;
          if (statLen >= 8) {
            const view = new DataView(memory.buffer);
            view.setInt32(statBufPtr, stat.size, true);
            view.setInt32(statBufPtr + 4, stat.type === 'dir' ? 1 : 0, true);
          }
          return 0;
        },
        fs_readdir(handle, bufPtr, len) {
          const file = openFiles.get(handle);
          if (!file || !file.isDir) return 0;
          const entries = vfsReaddir(file.path);
          if (!entries) return 0;
          const str = entries.join('\n') + '\n';
          const bytes = new TextEncoder().encode(str);
          const n = Math.min(bytes.length, len);
          new Uint8Array(memory.buffer, bufPtr, n).set(bytes.subarray(0, n));
          return n;
        },
        pipe_create() { return -1; },
        pipe_read(pipeId, bufPtr, len) {
          const pipe = childPipes.get(pipeId);
          if (!pipe) return -1;
          const buf = new Uint8Array(memory.buffer, bufPtr, len);
          const { control, data } = pipe;
          const cap = data.length;
          let bytesRead = 0;
          while (bytesRead < len) {
            const wp = Atomics.load(control, 0);
            const rp = Atomics.load(control, 1);
            if (rp === wp) {
              if (Atomics.load(control, 2) === 1) break;
              if (bytesRead > 0) break;
              Atomics.wait(control, 1, rp, 100);
              continue;
            }
            buf[bytesRead] = data[rp % cap];
            Atomics.store(control, 1, rp + 1);
            bytesRead++;
          }
          return bytesRead;
        },
        pipe_write(pipeId, bufPtr, len) {
          const pipe = childPipes.get(pipeId);
          if (!pipe) return -1;
          const buf = new Uint8Array(memory.buffer, bufPtr, len);
          const { control, data } = pipe;
          const cap = data.length;
          let written = 0;
          for (let i = 0; i < len; i++) {
            const wp = Atomics.load(control, 0);
            const next = (wp + 1) % cap;
            if (next === Atomics.load(control, 1)) break;
            data[wp] = buf[i];
            Atomics.store(control, 0, next);
            written++;
          }
          Atomics.notify(control, 1);
          return written;
        },
        pipe_close(pipeId, end) {
          const pipe = childPipes.get(pipeId);
          if (pipe) {
            if (end === 1) { Atomics.store(pipe.control, 2, 1); Atomics.notify(pipe.control, 1); }
            else { Atomics.store(pipe.control, 3, 1); }
          }
        },
        socket_open() { return -1; },
        socket_connect() { return -1; },
        socket_send() { return -1; },
        socket_recv() { return -1; },
        socket_close() {},
        socket_poll() { return 0; },
        fork_spawn() { return -1; },
        fork_exec_spawn() { return -1; },
        proc_wait() { return -1; },
        clock_gettime() { return BigInt(Math.floor(Date.now() * 1000000)); },
        sleep_ms(ms) {
          if (!self._sleepSab) self._sleepSab = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(self._sleepSab, 0, 0, ms > 0 ? ms : 1);
        },
        random_get(bufPtr, len) {
          const buf = new Uint8Array(memory.buffer, bufPtr, len);
          crypto.getRandomValues(buf);
        },
        getcwd(bufPtr, len) {
          const bytes = new TextEncoder().encode('/');
          new Uint8Array(memory.buffer, bufPtr, 2).set([...bytes, 0]);
          return bufPtr;
        },
        chdir() { return 0; },
        page_pool_fault() {},
        register_filemap() {},
        /* host_syscall for fork-exec child — FULL implementation matching restore-fork */
        host_syscall(n, a, b, c, d, e, f) {
          switch (n) {
            case 12: { // brk
              if (!self._feBrk) self._feBrk = memory.buffer.byteLength;
              if (a === 0) return self._feBrk;
              const t = a >>> 0, cp = memory.buffer.byteLength / 65536, np = Math.ceil(t / 65536);
              if (np > cp) { try { memory.grow(np - cp); } catch { return self._feBrk; } }
              self._feBrk = t;
              return t;
            }
            case 9: { // mmap
              const len = b >>> 0;
              const pages = Math.ceil(len / 65536);
              const oldPages = memory.buffer.byteLength / 65536;
              try { memory.grow(pages); } catch { return -12; }
              const ptr = oldPages * 65536;
              new Uint8Array(memory.buffer, ptr, len).fill(0);
              if (!(d & 0x20)) { // not MAP_ANONYMOUS — read file data
                const file = openFiles.get(e);
                if (file && file.content) {
                  const off = Number(f) || 0;
                  const av = Math.min(len, file.content.length - off);
                  if (av > 0) new Uint8Array(memory.buffer, ptr, av).set(file.content.subarray(off, off + av));
                }
              }
              return ptr;
            }
            case 10: return 0; // mprotect
            case 11: return 0; // munmap
            case 25: return -38; // mremap
            case 0: { // read
              const file = openFiles.get(a);
              if (!file) return a <= 2 ? 0 : -9;
              if (!file.content) return 0;
              const dest = new Uint8Array(memory.buffer, b >>> 0, c >>> 0);
              const avail = Math.min(c, file.content.length - (file.position || 0));
              if (avail <= 0) return 0;
              dest.set(file.content.subarray(file.position || 0, (file.position || 0) + avail));
              file.position = (file.position || 0) + avail;
              return avail;
            }
            case 1: { // write
              const buf = new Uint8Array(memory.buffer, b >>> 0, c >>> 0);
              if (a === 1 || a === 2) { self.postMessage({ type: 'stdout', data: new Uint8Array(buf) }); return c; }
              return c;
            }
            case 20: { // writev
              const view = new DataView(memory.buffer);
              let total = 0;
              for (let i = 0; i < c; i++) {
                const bp = view.getUint32(b + i * 8, true), bl = view.getUint32(b + i * 8 + 4, true);
                if (a === 1 || a === 2) self.postMessage({ type: 'stdout', data: new Uint8Array(memory.buffer, bp, bl) });
                total += bl;
              }
              return total;
            }
            case 17: { // pread64
              const file = openFiles.get(a);
              if (!file || !file.content) return -9;
              const dest = new Uint8Array(memory.buffer, b >>> 0, c >>> 0);
              const off = (d >>> 0) + ((e >>> 0) * 0x100000000);
              const av = Math.min(c >>> 0, file.content.length - off);
              if (av <= 0) return 0;
              dest.set(file.content.subarray(off, off + av));
              return av;
            }
            case 295: { // preadv
              const file = openFiles.get(a);
              if (!file || !file.content) return -9;
              const view = new DataView(memory.buffer);
              const off = (d >>> 0);
              let total = 0;
              for (let i = 0; i < c; i++) {
                const bp = view.getUint32(b + i * 8, true), bl = view.getUint32(b + i * 8 + 4, true);
                const av = Math.min(bl, file.content.length - off - total);
                if (av <= 0) break;
                new Uint8Array(memory.buffer, bp, av).set(file.content.subarray(off + total, off + total + av));
                total += av;
              }
              return total;
            }
            case 19: { // readv
              const view = new DataView(memory.buffer);
              let total = 0;
              for (let i = 0; i < c; i++) {
                const bp = view.getUint32(b + i * 8, true), bl = view.getUint32(b + i * 8 + 4, true);
                const file = openFiles.get(a);
                if (!file || !file.content) return total > 0 ? total : (a <= 2 ? 0 : -9);
                const av = Math.min(bl, file.content.length - (file.position || 0));
                if (av <= 0) break;
                new Uint8Array(memory.buffer, bp, av).set(file.content.subarray(file.position || 0, (file.position || 0) + av));
                file.position = (file.position || 0) + av;
                total += av;
              }
              return total;
            }
            case 2: case 257: { // open/openat
              const ptr = n === 2 ? a : b;
              let i = ptr; while (new Uint8Array(memory.buffer)[i]) i++;
              let p = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, i - ptr));
              if (!p.startsWith('/')) p = '/' + p;
              p = resolveSymlinks(p);
              const content = vfs.get(p);
              if (!content) { return dirs.has(p) ? (openFiles.set(nextFd, {isDir:true,dirPath:p,path:p}), nextFd++) : -2; }
              const fd = nextFd++;
              openFiles.set(fd, { content: new Uint8Array(content), position: 0, path: p });
              return fd;
            }
            case 3: openFiles.delete(a); return 0; // close
            case 5: { // fstat — kstat layout
              const file = openFiles.get(a);
              const buf = b >>> 0;
              new Uint8Array(memory.buffer, buf, 112).fill(0);
              const v = new DataView(memory.buffer);
              let mode = 0o100755;
              if (file?.isDir) mode = 0o40755;
              if (file?.special) mode = 0o20666;
              v.setBigUint64(buf, 1n, true);
              v.setBigUint64(buf + 8, BigInt(a + 1000), true);
              v.setUint32(buf + 16, file?.isDir ? 2 : 1, true);
              v.setUint32(buf + 20, mode, true);
              v.setBigInt64(buf + 48, BigInt(file?.content?.length || 0), true);
              v.setInt32(buf + 56, 4096, true);
              return file || a <= 2 ? 0 : -9;
            }
            case 4: case 6: case 262: { // stat/lstat/fstatat
              const pArg = n === 262 ? b : a;
              let i = pArg; while (new Uint8Array(memory.buffer)[i]) i++;
              let p = new TextDecoder().decode(new Uint8Array(memory.buffer, pArg, i - pArg));
              if (!p.startsWith('/')) p = '/' + p;
              p = normPath(p);
              const info = vfsStat(p, n !== 6);
              if (!info) return -2;
              const buf = (n === 262 ? c : b) >>> 0;
              new Uint8Array(memory.buffer, buf, 112).fill(0);
              const v = new DataView(memory.buffer);
              let tb = info.type === 'dir' ? 0o40000 : info.type === 'symlink' ? 0o120000 : 0o100000;
              v.setUint32(buf + 16, info.type === 'dir' ? 2 : 1, true);
              v.setUint32(buf + 20, tb | 0o755, true);
              v.setBigInt64(buf + 48, BigInt(info.size), true);
              v.setInt32(buf + 56, 4096, true);
              return 0;
            }
            case 8: { // lseek
              const file = openFiles.get(a);
              if (!file) return -9;
              if (c === 0) file.position = b;
              else if (c === 1) file.position = (file.position || 0) + b;
              else file.position = (file.content?.length || 0) + b;
              return file.position;
            }
            case 72: { // fcntl
              const file = openFiles.get(a);
              if (!file) return -9;
              if (b === 0 || b === 1030) { const nf = nextFd++; openFiles.set(nf, {...file}); return nf; }
              if (b === 1) return 0; if (b === 2) return 0;
              if (b === 3) return 0; if (b === 4) return 0;
              return 0;
            }
            case 32: { const file = openFiles.get(a); if (!file) return -9; const nf = nextFd++; openFiles.set(nf, {...file}); return nf; } // dup
            case 33: { if (a===b) return b; const file = openFiles.get(a); if (!file) return -9; openFiles.delete(b); openFiles.set(b, {...file}); if (b>=nextFd) nextFd=b+1; return b; } // dup2
            case 269: { // faccessat
              let i = b; while (new Uint8Array(memory.buffer)[i]) i++;
              let p = new TextDecoder().decode(new Uint8Array(memory.buffer, b, i - b));
              if (!p.startsWith('/')) p = '/' + p;
              return vfsExists(resolveSymlinks(normPath(p))) ? 0 : -2;
            }
            case 79: { new Uint8Array(memory.buffer, a>>>0, 2).set([47, 0]); return a; } // getcwd
            case 63: { const buf = new Uint8Array(memory.buffer, a>>>0, 325); buf.fill(0); const fields = ["Linux","atua","6.1.0","#1","x86_64"]; for (let i=0;i<5;i++){const b2=new TextEncoder().encode(fields[i]);buf.set(b2,i*65);} return 0; } // uname
            case 39: return 1; case 110: return 0; case 102: return 0; case 104: return 0;
            case 95: return 0o22; case 186: return 1; case 218: return 1; case 273: return 0;
            case 228: { const v = new DataView(memory.buffer); const ns = BigInt(Math.floor(Date.now()*1e6)); v.setBigInt64(b>>>0,ns/1000000000n,true); v.setBigInt64((b>>>0)+8,ns%1000000000n,true); return 0; } // clock_gettime
            case 318: { crypto.getRandomValues(new Uint8Array(memory.buffer, a>>>0, b>>>0)); return b; } // getrandom
            case 35: { const v = new DataView(memory.buffer); const sec = Number(v.getBigInt64(a>>>0,true)); const nsec = Number(v.getBigInt64((a>>>0)+8,true)); const ms = sec*1000+Math.floor(nsec/1e6); if (ms>0){if(!self._sleepSab)self._sleepSab=new Int32Array(new SharedArrayBuffer(4));Atomics.wait(self._sleepSab,0,0,ms);}return 0; } // nanosleep
            case 302: return 0; case 334: return -38; case 435: return -38;
            case 137: case 138: { const buf=(n===137?b:b)>>>0;new Uint8Array(memory.buffer,buf,120).fill(0);const v=new DataView(memory.buffer);v.setBigInt64(buf,0xEF53n,true);v.setBigInt64(buf+8,4096n,true);v.setBigInt64(buf+16,1000000n,true);v.setBigInt64(buf+24,500000n,true);v.setBigInt64(buf+32,500000n,true);v.setBigInt64(buf+40,100000n,true);v.setBigInt64(buf+48,50000n,true);v.setBigInt64(buf+64,255n,true);v.setBigInt64(buf+72,4096n,true);return 0; }
            case 13: case 14: case 15: case 16: return 0;
            case 21: return -2; case 24: return 0; case 28: return 0;
            case 38: return 0; case 56: return -38; case 57: return -38;
            case 59: return -38; case 61: return -10;
            case 73: return 0; case 74: return 0; case 75: return 0; case 76: return 0;
            case 77: return 0; case 80: return 0; case 90: return 0; case 91: return 0;
            case 92: return 0; case 93: return 0; case 94: return 0; case 96: return 0;
            case 97: return 0; case 100: return 0; case 105: return 0; case 106: return 0;
            case 107: return 0; case 108: return 0; case 109: return 0; case 111: return 0;
            case 112: return 1; case 113: return 0; case 114: return 0; case 117: return 0;
            case 119: return 0; case 121: return 0; case 124: return 0; case 131: return 0;
            case 132: return 0; case 157: return 0; case 158: return 0; case 160: return 0;
            case 161: return 0; case 162: return 0; case 191: return 0; case 192: return 0;
            case 193: return 0; case 205: return 0; case 247: return -38; case 280: return 0;
            case 285: return 0;
            case 60: case 231: throw new WebAssembly.RuntimeError('unreachable');
            default: return -38;
          }
        },
      },
    });

    instance = result.instance || result;
    memory = instance.exports.memory;

    self.postMessage({ type: 'stdout', data: new TextEncoder().encode('CHILD-EXEC: ' + path + ' argv=[' + argv.join(',') + ']\n') });

    try {
      instance.exports._start();
    } catch (err) {
      if (!(err instanceof WebAssembly.RuntimeError && err.message.includes('unreachable'))) {
        self.postMessage({ type: 'stdout', data: new TextEncoder().encode('CHILD-EXEC-ERR: ' + err.message + '\n') });
      }
    }

    let exitCode = 0;
    try {
      if (instance.exports.get_exit_code) exitCode = instance.exports.get_exit_code();
    } catch(e) {}
    self.postMessage({ type: 'exit', pid, code: exitCode });
    return;
  }
  if (e.data.type === 'restore-fork') {
    const { guestPagesSab, forkState, forkStateLen, parentBrk, pid, engineModule, engineUrl, vfsState, hostOpenFiles, pipeSabs } = e.data;
    const guestPagesView = new Uint8Array(guestPagesSab);

    // Reconstruct pipe table from parent's SharedArrayBuffers
    if (pipeSabs) {
      for (const [idStr, sab] of Object.entries(pipeSabs)) {
        const id = parseInt(idStr);
        childPipes.set(id, {
          sab,
          control: new Int32Array(sab, 0, 4),
          data: new Uint8Array(sab, 16, PIPE_BUF_SIZE),
        });
      }
    }

    // Fetch engine WASM
    // Use pre-compiled module if available (2d: worker module caching)
    const engineBytesOrModule = engineModule || await fetch(engineUrl).then(r => r.arrayBuffer());

    // [1h] Reconstruct full VFS from serialized parent state
    const vs = vfsState || {};
    const vfs = new Map();        // path → Uint8Array
    const dirs = new Set();
    const symlinkMap = new Map();
    const whiteouts = new Set();
    const metadata = new Map();
    const children = new Map();
    const bootTime = vs.bootTime || Math.floor(Date.now() / 1000);

    if (vs.files) for (const [p, buf] of Object.entries(vs.files)) vfs.set(p, new Uint8Array(buf));
    if (vs.dirs) for (const d of vs.dirs) dirs.add(d);
    if (vs.symlinks) for (const [p, t] of Object.entries(vs.symlinks)) symlinkMap.set(p, t);
    if (vs.whiteouts) for (const w of vs.whiteouts) whiteouts.add(w);
    if (vs.metadata) for (const [p, m] of Object.entries(vs.metadata)) metadata.set(p, m);
    if (vs.children) for (const [p, ch] of Object.entries(vs.children)) children.set(p, new Set(ch));

    function normPath(p) {
      const parts = p.split('/');
      const r = [];
      for (const s of parts) { if (s === '' || s === '.') continue; if (s === '..') { r.pop(); continue; } r.push(s); }
      return '/' + r.join('/');
    }
    // [1g] symlink depth 40
    function resolveSymlinks(path, depth) {
      if (!symlinkMap.size || (depth || 0) > 40) return path;
      path = normPath(path);
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        const target = symlinkMap.get(prefix);
        if (target) {
          const rest = parts.slice(i).join('/');
          return resolveSymlinks(rest ? target + '/' + rest : target, (depth || 0) + 1);
        }
      }
      return path;
    }
    function vfsExists(path) {
      if (whiteouts.has(path)) return false;
      return vfs.has(path) || dirs.has(path) || symlinkMap.has(path);
    }
    function vfsStat(path, followSymlinks) {
      if (!path.startsWith('/')) path = '/' + path;
      if (path === '/dev/null' || path === '/dev/urandom' || path === '/dev/random') return { size: 0, type: 'chardev' };
      if (followSymlinks === false && symlinkMap.has(path)) return { size: symlinkMap.get(path).length, type: 'symlink' };
      const resolved = resolveSymlinks(path);
      if (whiteouts.has(resolved)) return null;
      const content = vfs.get(resolved);
      if (content) return { size: content.length, type: 'file', ...(metadata.get(resolved) || {}) };
      if (dirs.has(resolved) || dirs.has(path)) return { size: 0, type: 'dir', ...(metadata.get(resolved) || {}) };
      return null;
    }
    // [1c] readdir with . and ..
    function vfsReaddir(dirPath) {
      dirPath = normPath(dirPath);
      const entries = [{ name: '.', type: 'dir' }, { name: '..', type: 'dir' }];
      const seen = new Set(['.', '..']);
      const ch = children.get(dirPath);
      if (ch) {
        for (const name of ch) {
          const childPath = dirPath === '/' ? '/' + name : dirPath + '/' + name;
          if (whiteouts.has(childPath)) continue;
          if (seen.has(name)) continue;
          seen.add(name);
          let type = 'file';
          if (dirs.has(childPath)) type = 'dir';
          if (symlinkMap.has(childPath)) type = 'symlink';
          entries.push({ name, type });
        }
      }
      return entries;
    }
    function vfsMkdir(path) {
      path = normPath(path);
      dirs.add(path);
      if (!children.has(path)) children.set(path, new Set());
      whiteouts.delete(path);
      // register parents
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/') || '/';
        dirs.add(d);
        if (!children.has(d)) children.set(d, new Set());
      }
      // add to parent's children
      const ls = path.lastIndexOf('/');
      const parent = ls <= 0 ? '/' : path.substring(0, ls);
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(path.substring(ls + 1));
    }
    function vfsUnlink(path) {
      path = normPath(path);
      vfs.delete(path);
      symlinkMap.delete(path);
      metadata.delete(path);
      whiteouts.add(path);
    }
    function vfsRename(from, to) {
      from = normPath(from); to = normPath(to);
      if (vfs.has(from)) { vfs.set(to, vfs.get(from)); vfs.delete(from); }
      if (symlinkMap.has(from)) { symlinkMap.set(to, symlinkMap.get(from)); symlinkMap.delete(from); }
      if (metadata.has(from)) { metadata.set(to, metadata.get(from)); metadata.delete(from); }
      whiteouts.add(from);
      whiteouts.delete(to);
    }
    // Second openFiles Map for host_syscall handlers (separate from WASM imports Map)
    // This Map handles HOST-level fd operations (dup2, close, stat, read, write)
    // fs_open also registers entries here via self._hostOpenFiles so HOST mmap works
    const openFiles = new Map();
    openFiles.set(0, { special: 'stdin', position: 0, path: '/dev/stdin' });
    openFiles.set(1, { special: 'stdout', position: 0, path: '/dev/stdout' });
    openFiles.set(2, { special: 'stderr', position: 0, path: '/dev/stderr' });
    self._hostOpenFiles = openFiles; // bridge for fs_open → host_syscall
    let nextFd = 4;

    // Restore parent's HOST open file descriptors — Blink demand-pages library
    // sections via preadv on these fds. Without them, page faults → SIGSEGV.
    if (hostOpenFiles) {
      for (const [fdStr, file] of Object.entries(hostOpenFiles)) {
        const fd = parseInt(fdStr);
        openFiles.set(fd, {
          content: new Uint8Array(file.content),
          position: file.position || 0,
          path: file.path,
        });
        if (fd >= nextFd) nextFd = fd + 1;
      }
    }

    let childBrk = 0;
    const childMmapFree = [];

    // Create imports — similar to parent but stdout goes to postMessage
    const result = await WebAssembly.instantiate(engineBytesOrModule, {
      atua: {
        term_write(bufPtr, len) {
          const bytes = new Uint8Array(memory.buffer, bufPtr, len);
          self.postMessage({ type: 'stdout', data: new Uint8Array(bytes) });
        },
        fs_write(h, p, l) { return l; },
        term_read() { return 0; },
        fs_read(h, p, l, offset) {
          const o = typeof offset === 'bigint' ? Number(offset) : (offset || 0);
          const file = openFiles.get(h);
          if (!file) return -1;
          const avail = file.content.length - o;
          if (avail <= 0) return 0;
          const n = Math.min(l, avail);
          new Uint8Array(memory.buffer, p, n).set(file.content.subarray(o, o + n));
          return n;
        },
        fs_open(pathPtr) {
          const mem = new Uint8Array(memory.buffer);
          let e2 = pathPtr;
          while (e2 < mem.length && mem[e2]) e2++;
          let path = new TextDecoder().decode(mem.subarray(pathPtr, e2));
          if (!path.startsWith('/')) path = '/' + path;
          // Special files
          if (path === '/dev/null') { const fd = nextFd++; openFiles.set(fd, { content: new Uint8Array(0), position: 0, path, special: 'null' }); return fd; }
          if (path === '/dev/urandom' || path === '/dev/random') { const fd = nextFd++; openFiles.set(fd, { content: new Uint8Array(0), position: 0, path, special: 'urandom' }); return fd; }
          path = resolveSymlinks(path);
          if (whiteouts.has(path)) return -1;
          const content = vfs.get(path);
          if (content) {
            const fd = nextFd++;
            openFiles.set(fd, { content, position: 0, path });
            // Also register in host_syscall's openFiles so HOST mmap can find it
            if (self._hostOpenFiles) self._hostOpenFiles.set(fd, { content, position: 0, path });
            return fd;
          }
          // Check dirs using the dirs Set (not prefix scan)
          if (dirs.has(path) || dirs.has(normPath(path))) {
            const fd = nextFd++;
            const entry = { isDir: true, dirPath: path, position: 0, path };
            openFiles.set(fd, entry);
            if (self._hostOpenFiles) self._hostOpenFiles.set(fd, entry);
            return fd;
          }
          return -1;
        },
        fs_close(fd) {},
        fs_fstat(h) {
          const file = openFiles.get(h);
          if (!file && h > 2) return BigInt(-1);
          if (!file) return BigInt(0);
          const size = BigInt(file.content?.length || 0);
          let mode = 0o100755;
          if (file.isDir) mode = 0o40755;
          else if (file.special === 'null' || file.special === 'urandom') mode = 0o20666;
          return (size << 16n) | BigInt(mode);
        },
        fs_stat() { return 0; },
        fs_readdir() { return 0; },
        clock_gettime() { return BigInt(Math.floor(Date.now() * 1000000)); },
        getcwd(bufPtr, len) {
          const bytes = new TextEncoder().encode('/');
          new Uint8Array(memory.buffer, bufPtr, 2).set([...bytes, 0]);
          return bufPtr;
        },
        chdir() { return 0; },
        fork_spawn() { return -1; },
        fork_exec_spawn() { return -1; },
        proc_wait() { return -1; },
        pipe_create() { return -1; },
        pipe_read(pipeId, bufPtr, len) {
          const buf = new Uint8Array(memory.buffer, bufPtr, len);
          return childPipeRead(pipeId, buf, len);
        },
        pipe_write(pipeId, bufPtr, len) {
          const buf = new Uint8Array(memory.buffer, bufPtr, len);
          return childPipeWrite(pipeId, buf, len);
        },
        pipe_close(pipeId, end) {
          childPipeClose(pipeId, end);
        },
        /* Socket stubs for child workers */
        socket_open() { return -1; },
        socket_connect() { return -1; },
        socket_send() { return -1; },
        socket_recv() { return -1; },
        socket_close() {},
        socket_poll() { return 0; },
        sleep_ms(ms) {
          if (!self._sleepSab) self._sleepSab = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(self._sleepSab, 0, 0, ms > 0 ? ms : 1);
        },
        random_get(bufPtr, len) {
          const buf = new Uint8Array(memory.buffer, bufPtr, len);
          crypto.getRandomValues(buf);
        },
        term_get_size(rowsPtr, colsPtr) {
          const view = new DataView(memory.buffer);
          view.setInt32(rowsPtr, 24, true);
          view.setInt32(colsPtr, 80, true);
        },
        /* host_syscall for child worker — musl libc syscall dispatch */
        host_syscall(n, a, b, c, d, e, f) {
          switch (n) {
            case 12: { // brk
              if (!childBrk) childBrk = memory.buffer.byteLength;
              if (a === 0) return childBrk;
              const t = a >>> 0, cp = memory.buffer.byteLength / 65536, np = Math.ceil(t / 65536);
              if (np > cp) { try { memory.grow(np - cp); } catch { return childBrk; } }
              childBrk = t;
              return t;
            }
            case 9: { // mmap with freelist
              const len = b >>> 0;
              let ptr;
              for (let i = 0; i < childMmapFree.length; i++) {
                if (childMmapFree[i].size >= len) { ptr = childMmapFree.splice(i, 1)[0].ptr; new Uint8Array(memory.buffer, ptr, len).fill(0); break; }
              }
              if (ptr === undefined) {
                const pages = Math.ceil(len / 65536);
                const oldPages = memory.buffer.byteLength / 65536;
                try { memory.grow(pages); } catch { return -12; }
                ptr = oldPages * 65536;
                new Uint8Array(memory.buffer, ptr, len).fill(0);
              }
              if (!(d & 0x20)) {
                const file = openFiles.get(e);
                if (file && file.content) { const off = Number(f) || 0; const av = Math.min(len, file.content.length - off); if (av > 0) new Uint8Array(memory.buffer, ptr, av).set(file.content.subarray(off, off + av)); }
              }
              return ptr;
            }
            case 10: return 0; // mprotect
            case 11: { const p = a >>> 0; const l = b >>> 0; if (p && l) childMmapFree.push({ptr: p, size: l}); return 0; } // munmap
            case 1: { // write
              const buf = new Uint8Array(memory.buffer, b >>> 0, c >>> 0);
              if (a === 1 || a === 2) { self.postMessage({ type: 'stdout', data: new Uint8Array(buf) }); return c; }
              return c;
            }
            case 20: { // writev
              const view = new DataView(memory.buffer);
              let total = 0;
              for (let i = 0; i < c; i++) {
                const bp = view.getUint32(b + i * 8, true), bl = view.getUint32(b + i * 8 + 4, true);
                if (a === 1 || a === 2) self.postMessage({ type: 'stdout', data: new Uint8Array(memory.buffer, bp, bl) });
                total += bl;
              }
              return total;
            }
            case 0: { // read
              const file = openFiles.get(a);
              if (!file) return a <= 2 ? 0 : -9;
              const dest = new Uint8Array(memory.buffer, b >>> 0, c >>> 0);
              const avail = Math.min(c, file.content.length - (file.position || 0));
              if (avail <= 0) return 0;
              dest.set(file.content.subarray(file.position || 0, (file.position || 0) + avail));
              file.position = (file.position || 0) + avail;
              return avail;
            }
            case 2: case 257: {
              const ptr = n === 2 ? a : b;
              const flags2 = n === 2 ? b : c;
              let i2 = ptr; while (new Uint8Array(memory.buffer)[i2]) i2++;
              let path = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, i2 - ptr));
              if (!path.startsWith('/')) path = '/' + path;
              // Special files
              if (path === '/dev/null') { const fd = nextFd++; openFiles.set(fd, { content: new Uint8Array(0), position: 0, path, special: 'null' }); return fd; }
              if (path === '/dev/urandom' || path === '/dev/random') { const fd = nextFd++; openFiles.set(fd, { content: new Uint8Array(0), position: 0, path, special: 'urandom' }); return fd; }
              path = resolveSymlinks(path);
              let content = vfs.get(path);
              // O_CREAT
              if (!content && (flags2 & 0x40)) { content = new Uint8Array(0); vfs.set(path, content); }
              // O_TRUNC
              if (content && (flags2 & 0x200)) { content = new Uint8Array(0); vfs.set(path, content); }
              if (content) {
                const fd = nextFd++;
                openFiles.set(fd, { content: new Uint8Array(content), position: 0, path });
                return fd;
              }
              // Check if it's a directory (child has limited dir knowledge)
              // Look for any file with this prefix
              const dirPrefix = path === '/' ? '/' : path + '/';
              let isDir = false;
              for (const [k] of vfs) { if (k.startsWith(dirPrefix)) { isDir = true; break; } }
              if (!isDir) for (const [k] of symlinkMap) { if (k.startsWith(dirPrefix)) { isDir = true; break; } }
              if (isDir) {
                const fd = nextFd++;
                openFiles.set(fd, { isDir: true, dirPath: path, position: 0, path });
                return fd;
              }
              return -2;
            }
            case 3: openFiles.delete(a); return 0;
            case 5: { // fstat — kstat layout: st_nlink at 16, st_mode at 20
              const file = openFiles.get(a);
              const buf2 = b >>> 0;
              new Uint8Array(memory.buffer, buf2, 112).fill(0);
              const v2 = new DataView(memory.buffer);
              let mode2 = 0o100755;
              if (file?.isDir) mode2 = 0o40755;
              if (file?.special === 'null' || file?.special === 'urandom') mode2 = 0o20666;
              v2.setBigUint64(buf2, 1n, true);
              v2.setBigUint64(buf2 + 8, BigInt(a + 1000), true);
              v2.setUint32(buf2 + 16, file?.isDir ? 2 : 1, true);  // st_nlink
              v2.setUint32(buf2 + 20, mode2, true);                 // st_mode
              v2.setBigInt64(buf2 + 48, BigInt(file?.content?.length || 0), true);
              v2.setInt32(buf2 + 56, 4096, true);
              return file || a <= 2 ? 0 : -9;
            }
            case 8: { const file = openFiles.get(a); if (!file) return -9; if (c === 0) file.position = b; else if (c === 1) file.position = (file.position||0) + b; else file.position = file.content.length + b; return file.position; }
            case 17: { const file = openFiles.get(a); if (!file) return -9; const dest = new Uint8Array(memory.buffer, b>>>0, c>>>0); const off2 = (d>>>0) + ((e>>>0) * 0x100000000); const av = Math.min(c>>>0, file.content.length - off2); if (av <= 0) return 0; dest.set(file.content.subarray(off2, off2+av)); return av; }
            case 295: { const file = openFiles.get(a); if (!file) return -9; const view = new DataView(memory.buffer); const off2 = (d>>>0); let total = 0; for (let i=0;i<c;i++){const bp=view.getUint32(b+i*8,true),bl=view.getUint32(b+i*8+4,true);const dest=new Uint8Array(memory.buffer,bp,bl);const av=Math.min(bl,file.content.length-off2-total);if(av<=0)break;dest.set(file.content.subarray(off2+total,off2+total+av));total+=av;if(av<bl)break;} return total; }
            case 19: { // SYS_readv
              const view = new DataView(memory.buffer);
              let total = 0;
              for (let i2 = 0; i2 < c; i2++) {
                const bp = view.getUint32(b + i2 * 8, true), bl = view.getUint32(b + i2 * 8 + 4, true);
                const file = openFiles.get(a);
                if (!file) return total > 0 ? total : (a <= 2 ? 0 : -9);
                const av = Math.min(bl, file.content.length - (file.position || 0));
                if (av <= 0) break;
                new Uint8Array(memory.buffer, bp, av).set(file.content.subarray(file.position || 0, (file.position || 0) + av));
                file.position = (file.position || 0) + av;
                total += av;
                if (av < bl) break;
              }
              return total;
            }
            case 38: return 0; // SYS_setitimer → no-op
            case 18: { // SYS_pwrite64
              const file = openFiles.get(a);
              if (!file) return -9;
              const src = new Uint8Array(memory.buffer, b>>>0, c>>>0);
              const off2 = (d>>>0);
              if (off2 + c > file.content.length) {
                const grown = new Uint8Array(off2 + c);
                grown.set(file.content);
                file.content = grown;
              }
              file.content.set(src, off2);
              return c;
            }
            case 77: { // SYS_ftruncate — real [6b]
              const ft = openFiles.get(a);
              if (!ft || ft.isDir || ft.special) return ft ? 0 : -9;
              const newLen = b >>> 0;
              if (newLen < ft.content.length) ft.content = ft.content.slice(0, newLen);
              else if (newLen > ft.content.length) { const g = new Uint8Array(newLen); g.set(ft.content); ft.content = g; }
              return 0;
            }
            case 72: { // fcntl — real dup [1e]
              const f72 = openFiles.get(a);
              if (!f72) return -9;
              if (b === 0 || b === 1030) { // F_DUPFD / F_DUPFD_CLOEXEC
                const nfd = nextFd++;
                openFiles.set(nfd, { ...f72, cloexec: b === 1030 });
                return nfd;
              }
              if (b === 1) return f72.cloexec ? 1 : 0;
              if (b === 2) { f72.cloexec = !!(c & 1); return 0; }
              if (b === 3) { let fl = 0; if (f72.append) fl |= 0x400; return fl; }
              if (b === 4) return 0;
              return 0;
            }
            case 79: { new Uint8Array(memory.buffer, a>>>0, 2).set([47, 0]); return a; }
            case 16: return -25; case 51: case 55: return 0; case 95: return 0o22;
            case 4: case 6: case 262: { // stat/lstat/fstatat — use vfsStat
              const pArg = n === 262 ? b : a;
              const bArg = n === 262 ? c : b;
              let i3 = pArg; while (new Uint8Array(memory.buffer)[i3]) i3++;
              let p2 = new TextDecoder().decode(new Uint8Array(memory.buffer, pArg, i3 - pArg));
              if (!p2.startsWith('/')) p2 = '/' + p2;
              p2 = normPath(p2);
              const followSym = (n !== 6); // lstat doesn't follow
              const info = vfsStat(p2, followSym);
              if (!info) return -2;
              const buf2 = bArg >>> 0;
              // kstat layout: st_nlink at 16, st_mode at 20
              new Uint8Array(memory.buffer, buf2, 112).fill(0);
              const v2 = new DataView(memory.buffer);
              let typeBits = 0o100000;
              let nlink = 1;
              if (info.type === 'dir') { typeBits = 0o40000; nlink = 2; }
              else if (info.type === 'symlink') typeBits = 0o120000;
              else if (info.type === 'chardev') typeBits = 0o20000;
              const permBits = (info.mode !== undefined) ? (info.mode & 0o7777) : (typeBits === 0o20000 ? 0o666 : 0o755);
              v2.setBigUint64(buf2, 1n, true); // st_dev
              v2.setUint32(buf2 + 16, nlink, true); // st_nlink
              v2.setUint32(buf2 + 20, typeBits | permBits, true); // st_mode
              v2.setUint32(buf2 + 24, info.uid || 0, true); // st_uid
              v2.setUint32(buf2 + 28, info.gid || 0, true); // st_gid
              v2.setBigInt64(buf2 + 48, BigInt(info.size), true); // st_size
              v2.setInt32(buf2 + 56, 4096, true); // st_blksize
              v2.setInt32(buf2 + 72, info.atime || bootTime, true); // st_atime_sec
              v2.setInt32(buf2 + 80, info.mtime || bootTime, true); // st_mtime_sec
              return 0;
            }
            case 269: { // faccessat — use vfsExists
              let i3 = b; while (new Uint8Array(memory.buffer)[i3]) i3++;
              let p2 = new TextDecoder().decode(new Uint8Array(memory.buffer, b, i3 - b));
              if (!p2.startsWith('/')) p2 = '/' + p2;
              p2 = normPath(p2);
              p2 = resolveSymlinks(p2);
              return vfsExists(p2) ? 0 : -2;
            }
            case 332: return -38; case 121: return 0;
            case 24: case 97: case 127: case 160: return 0;
            case 63: { const buf2 = new Uint8Array(memory.buffer, a>>>0, 325); buf2.fill(0); const fields = ["Linux","atua","6.1.0","#1","x86_64"]; for (let i=0;i<5;i++){const b2=new TextEncoder().encode(fields[i]);buf2.set(b2,i*65);} return 0; }
            case 302: { if (d) { const view = new DataView(memory.buffer); view.setBigUint64(d>>>0, 1024n, true); view.setBigUint64((d>>>0)+8, 1024n, true); } return 0; }
            case 228: { const view = new DataView(memory.buffer); const ns = BigInt(Math.floor(Date.now() * 1e6)); view.setBigInt64(b >>> 0, ns / 1000000000n, true); view.setBigInt64((b >>> 0) + 8, ns % 1000000000n, true); return 0; }
            case 318: { crypto.getRandomValues(new Uint8Array(memory.buffer, a >>> 0, b >>> 0)); return b; }
            case 35: { const view = new DataView(memory.buffer); const sec = Number(view.getBigInt64(a >>> 0, true)); const nsec = Number(view.getBigInt64((a >>> 0) + 8, true)); const ms = sec * 1000 + Math.floor(nsec / 1e6); if (ms > 0) { if (!self._sleepSab) self._sleepSab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(self._sleepSab, 0, 0, ms); } return 0; }
            case 39: return 1; case 110: return 0; case 102: return 0; case 104: return 0; case 107: return 0; case 108: return 0;
            case 186: return 1; case 205: return 0; case 218: return 1; case 273: return 0;
            case 13: return 0; case 14: return 0; case 131: return 0;
            case 60: case 231: throw new WebAssembly.RuntimeError('unreachable');
            /* Process/signal defaults */
            case 21: return -2; case 24: return 0; case 25: return -38; case 28: return 0;
            case 32: { // dup [6d]
              const fd32 = openFiles.get(a); if (!fd32) return -9;
              const nfd = nextFd++; openFiles.set(nfd, { ...fd32, cloexec: false }); return nfd;
            }
            case 33: { // dup2 [6d]
              if (a === b) return b;
              const fd33 = openFiles.get(a);
              if (!fd33) {
                self.postMessage({ type: 'stdout', data: new TextEncoder().encode('DUP2-EBADF: fd=' + a + ' openFiles.size=' + openFiles.size + ' keys=' + [...openFiles.keys()].join(',') + '\n') });
                return -9;
              }
              openFiles.delete(b); openFiles.set(b, { ...fd33, cloexec: false });
              if (b >= nextFd) nextFd = b + 1; return b;
            }
            case 292: { // dup3 [6d]
              if (a === b) return -22;
              const fd292 = openFiles.get(a); if (!fd292) return -9;
              openFiles.delete(b); openFiles.set(b, { ...fd292, cloexec: !!(c & 0x80000) });
              if (b >= nextFd) nextFd = b + 1; return b;
            }
            case 41: return -97; case 51: case 52: case 54: case 55: return 0;
            case 56: case 57: case 59: return -38; case 61: return -10;
            case 74: case 75: case 76: case 80: case 90: case 91: case 92: case 93: case 94: return 0;
            case 95: return 0o22; case 96: { if(a){const now=Date.now();const v=new DataView(memory.buffer);v.setBigInt64(a>>>0,BigInt(Math.floor(now/1000)),true);v.setBigInt64((a>>>0)+8,BigInt((now%1000)*1000),true);}return 0; }
            case 97: case 98: case 100: return 0; case 105: case 106: case 109: case 111: return 0;
            case 112: return 1; case 113: case 114: case 117: case 119: case 124: return 0;
            case 118: case 120: { if(a)new DataView(memory.buffer).setUint32(a>>>0,0,true);if(b)new DataView(memory.buffer).setUint32(b>>>0,0,true);if(c)new DataView(memory.buffer).setUint32(c>>>0,0,true);return 0; }
            case 15: case 157: case 158: case 160: case 161: case 162: return 0;
            case 73: return 0;  // flock
            case 285: return 0; // fallocate
            case 132: return 0; // utime
            case 133: return -38; // mknod
            case 280: return 0;  // utimensat
            case 268: return 0;  // fchmodat
            case 260: return 0;  // fchownat
            case 265: return 0;  // linkat (stub)
            case 266: return 0;  // symlinkat (stub)
            case 137: case 138: { // statfs/fstatfs
              const buf2 = (n === 137 ? b : b) >>> 0;
              new Uint8Array(memory.buffer, buf2, 120).fill(0);
              const v2 = new DataView(memory.buffer);
              v2.setBigInt64(buf2, 0xEF53n, true);
              v2.setBigInt64(buf2 + 8, 4096n, true);
              v2.setBigInt64(buf2 + 16, 1000000n, true);
              v2.setBigInt64(buf2 + 24, 500000n, true);
              v2.setBigInt64(buf2 + 32, 500000n, true);
              v2.setBigInt64(buf2 + 40, 100000n, true);
              v2.setBigInt64(buf2 + 48, 50000n, true);
              v2.setBigInt64(buf2 + 64, 255n, true);
              v2.setBigInt64(buf2 + 72, 4096n, true);
              return 0;
            }
            case 83: case 258: { // mkdir/mkdirat — real VFS op [1h]
              let p3 = n === 83 ? a : b;
              let i4 = p3; while (new Uint8Array(memory.buffer)[i4]) i4++;
              let path3 = new TextDecoder().decode(new Uint8Array(memory.buffer, p3, i4 - p3));
              if (!path3.startsWith('/')) path3 = '/' + path3;
              vfsMkdir(resolveSymlinks(path3));
              return 0;
            }
            case 87: case 263: { // unlink/unlinkat — real VFS op [1h]
              let pu = n === 87 ? a : b;
              let iu = pu; while (new Uint8Array(memory.buffer)[iu]) iu++;
              let pathU = new TextDecoder().decode(new Uint8Array(memory.buffer, pu, iu - pu));
              if (!pathU.startsWith('/')) pathU = '/' + pathU;
              vfsUnlink(resolveSymlinks(pathU));
              return 0;
            }
            case 82: case 264: case 316: { // rename — real VFS op [1h]
              let pFrom = n === 82 ? a : b;
              let pTo = n === 82 ? b : d;
              let iF = pFrom; while (new Uint8Array(memory.buffer)[iF]) iF++;
              let iT = pTo; while (new Uint8Array(memory.buffer)[iT]) iT++;
              let pathFrom = new TextDecoder().decode(new Uint8Array(memory.buffer, pFrom, iF - pFrom));
              let pathTo = new TextDecoder().decode(new Uint8Array(memory.buffer, pTo, iT - pTo));
              if (!pathFrom.startsWith('/')) pathFrom = '/' + pathFrom;
              if (!pathTo.startsWith('/')) pathTo = '/' + pathTo;
              vfsRename(resolveSymlinks(pathFrom), resolveSymlinks(pathTo));
              return 0;
            }
            case 89: { // readlink(path=a, buf=b, bufsiz=c)
              let i4 = a; while (new Uint8Array(memory.buffer)[i4]) i4++;
              let p3 = new TextDecoder().decode(new Uint8Array(memory.buffer, a, i4 - a));
              if (!p3.startsWith('/')) p3 = '/' + p3;
              const t3 = symlinkMap.get(p3) || symlinkMap.get(normPath(p3));
              if (!t3) return -22;
              const enc3 = new TextEncoder().encode(t3);
              const n3 = Math.min(enc3.length, c >>> 0);
              new Uint8Array(memory.buffer, b >>> 0, n3).set(enc3.subarray(0, n3));
              return n3;
            }
            case 267: { // readlinkat(dirfd=a, path=b, buf=c, bufsiz=d)
              let i4 = b; while (new Uint8Array(memory.buffer)[i4]) i4++;
              let p3 = new TextDecoder().decode(new Uint8Array(memory.buffer, b, i4 - b));
              if (!p3.startsWith('/')) { if ((a|0) !== -100) return -38; p3 = '/' + p3; }
              if (p3 === '/proc/self/exe') {
                const t3 = new TextEncoder().encode('/bin/bash');
                const n3 = Math.min(t3.length, d >>> 0);
                new Uint8Array(memory.buffer, c >>> 0, n3).set(t3.subarray(0, n3));
                return n3;
              }
              const t3 = symlinkMap.get(p3) || symlinkMap.get(normPath(p3));
              if (!t3) return -22;
              const enc3 = new TextEncoder().encode(t3);
              const n3 = Math.min(enc3.length, d >>> 0);
              new Uint8Array(memory.buffer, c >>> 0, n3).set(enc3.subarray(0, n3));
              return n3;
            }
            case 217: { // getdents64(fd=a, buf=b, count=c) — uses vfsReaddir [1h]
              const f3 = openFiles.get(a);
              if (!f3 || !f3.isDir) return -9;
              if (!f3._dirEntries) {
                f3._dirEntries = vfsReaddir(f3.dirPath);
                f3._dirOffset = 0;
              }
              const v3 = new DataView(memory.buffer);
              const buf3 = b >>> 0, bufSize3 = c >>> 0;
              let written3 = 0;
              while (f3._dirOffset < f3._dirEntries.length) {
                const ent = f3._dirEntries[f3._dirOffset];
                const nb = new TextEncoder().encode(ent.name);
                const rl = ((19 + nb.length + 1 + 7) >> 3) << 3;
                if (written3 + rl > bufSize3) break;
                const off3 = buf3 + written3;
                v3.setBigUint64(off3, BigInt(f3._dirOffset + 1), true);
                v3.setBigUint64(off3 + 8, BigInt(f3._dirOffset + 2), true);
                v3.setUint16(off3 + 16, rl, true);
                new Uint8Array(memory.buffer)[off3 + 18] = ent.type === 'dir' ? 4 : ent.type === 'symlink' ? 10 : 8;
                new Uint8Array(memory.buffer, off3 + 19, nb.length).set(nb);
                new Uint8Array(memory.buffer)[off3 + 19 + nb.length] = 0;
                written3 += rl;
                f3._dirOffset++;
              }
              return written3;
            }
            case 60: case 231: case 62: case 200: case 234: throw new WebAssembly.RuntimeError('unreachable');
            default:
              if (n !== 14 && n !== 13 && n !== 131) // skip sigprocmask, rt_sigaction, sigaltstack
                self.postMessage({ type: 'stdout', data: new TextEncoder().encode('CHILD-ENOSYS:' + n + '\n') });
              return -38;
          }
        },
        args_sizes_get(ac, bs) {
          const view = new DataView(memory.buffer);
          view.setUint32(ac, 0, true);
          view.setUint32(bs, 0, true);
          return 0;
        },
        args_get() { return 0; },
        environ_sizes_get(a, b) {
          const view = new DataView(memory.buffer);
          view.setUint32(a, 0, true);
          view.setUint32(b, 0, true);
          return 0;
        },
        environ_get() { return 0; },
        // SoftMMU: lazy page fault from SharedArrayBuffer
        page_pool_fault(pageIndex, destPtr) {
          // Page fault chain:
          // 1. Page in SAB? → copy from SAB (parent touched it)
          const srcOffset = pageIndex * 4096;
          if (srcOffset + 4096 <= guestPagesView.length) {
            // Check if SAB page has non-zero content (parent loaded it)
            let hasData = false;
            for (let i = srcOffset; i < srcOffset + 64; i++) {
              if (guestPagesView[i]) { hasData = true; break; }
            }
            if (hasData) {
              new Uint8Array(memory.buffer, destPtr, 4096).set(
                guestPagesView.subarray(srcOffset, srcOffset + 4096)
              );
              return;
            }
          }
          // 2. Page in filemap (file-backed mmap)? → read from VFS
          // The C code tracks guest vaddr → we need the guest vaddr for this page.
          // But page_pool_fault receives a host page INDEX, not a guest vaddr.
          // We can't resolve it here. Instead, zero-fill and let the C-side
          // filemap resolution handle it via a separate import.
          // For now: fill from SAB if available, else zeros (anonymous page).
          if (srcOffset + 4096 <= guestPagesView.length) {
            new Uint8Array(memory.buffer, destPtr, 4096).set(
              guestPagesView.subarray(srcOffset, srcOffset + 4096)
            );
          }
          // 3. Anonymous page → already zero-filled by AllocPoolPage
        },
        // Register a file-backed mmap region for demand-paging
        register_filemap(virt_lo, virt_hi, size_lo, size_hi, offset_lo, offset_hi, pathPtr, pathLen) {
          const path = new TextDecoder().decode(new Uint8Array(memory.buffer, pathPtr, pathLen));
          const virt = (BigInt(virt_hi) << 32n) | BigInt(virt_lo >>> 0);
          const size = (BigInt(size_hi) << 32n) | BigInt(size_lo >>> 0);
          const offset = (BigInt(offset_hi) << 32n) | BigInt(offset_lo >>> 0);
          if (!self._filemaps) self._filemaps = [];
          self._filemaps.push({ virt: Number(virt), size: Number(size), offset: Number(offset), path });
        },
      },
    });

    // WebAssembly.instantiate(Module) returns Instance; instantiate(bytes) returns {instance}
    instance = result.instance || result;
    memory = instance.exports.memory;

    // Option 2: Fresh WASM instance, own heap. No full memory copy.
    // 1. init_for_fork() — initializes musl (malloc, brk, TLS) without main()
    // 2. restore_fork() — NewMachine/NewSystem on child heap, restore CPU state
    // 3. Guest pages fault from SAB on demand via page_pool_fault
    instance.exports.init_for_fork();

    const forkStateBytes = new Uint8Array(forkState);
    const statePtr = instance.exports.malloc(forkStateBytes.length);
    new Uint8Array(memory.buffer, statePtr, forkStateBytes.length).set(forkStateBytes);

    childBrk = parentBrk || memory.buffer.byteLength;

    self.postMessage({ type: 'stdout', data: new TextEncoder().encode('CHILD: SAB fork, state=' + forkStateBytes.length + ' SAB=' + guestPagesView.length + '\n') });

    try {
      instance.exports.restore_fork(statePtr, forkStateLen);
      self.postMessage({ type: 'stdout', data: new TextEncoder().encode('CHILD: restore_fork returned\n') });
    } catch (err) {
      self.postMessage({ type: 'stdout', data: new TextEncoder().encode('CHILD: ' + err.message + ' at ' + (err.stack || '').split('\n').slice(0, 3).join(' | ') + '\n') });
    }

    // Read exit code from exported function (set by __wasi_proc_exit before trap)
    let exitCode = 0;
    try {
      if (instance.exports.get_exit_code) exitCode = instance.exports.get_exit_code();
    } catch(e) {}
    self.postMessage({ type: 'exit', pid, code: exitCode });
  }
};
