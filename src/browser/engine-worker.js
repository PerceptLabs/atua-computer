/**
 * engine-worker.js — Web Worker that runs a fork child.
 * Loads engine.wasm, writes fork state into WASM memory, calls restore_fork.
 * stdout/stderr routed to parent via postMessage.
 */

let memory = null;
let instance = null;

// Pipe table for this child — populated from parent's SABs
const childPipes = new Map();
const PIPE_BUF_SIZE = 64 * 1024;

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
  if (e.data.type === 'restore-fork') {
    const { state, pid, engineUrl, files, symlinks, pipeSabs } = e.data;

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
    const engineBytes = await fetch(engineUrl).then(r => r.arrayBuffer());

    // Build VFS from files + symlinks
    const vfs = new Map();
    if (files) {
      for (const [path, content] of Object.entries(files)) {
        vfs.set(path, new Uint8Array(content));
      }
    }
    const symlinkMap = new Map();
    if (symlinks) {
      for (const [path, target] of Object.entries(symlinks)) {
        symlinkMap.set(path, target);
      }
    }
    function normPath(p) {
      const parts = p.split('/');
      const r = [];
      for (const s of parts) { if (s === '' || s === '.') continue; if (s === '..') { r.pop(); continue; } r.push(s); }
      return '/' + r.join('/');
    }
    function resolveSymlinks(path, depth) {
      if (!symlinkMap.size || (depth || 0) > 10) return path;
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
    const openFiles = new Map();
    let nextFd = 4;
    let childBrk = 0;
    const childMmapFree = [];
    let childMmapTop = 0;

    // Create imports — similar to parent but stdout goes to postMessage
    const result = await WebAssembly.instantiate(engineBytes, {
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
          path = resolveSymlinks(path);
          const content = vfs.get(path);
          if (!content) return -1;
          const fd = nextFd++;
          openFiles.set(fd, { content, position: 0, path });
          return fd;
        },
        fs_close(fd) {},
        fs_fstat(h) {
          const file = openFiles.get(h);
          return file ? BigInt(file.content.length) : BigInt(-1);
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
                if (file) { const off = Number(f) || 0; const av = Math.min(len, file.content.length - off); if (av > 0) new Uint8Array(memory.buffer, ptr, av).set(file.content.subarray(off, off + av)); }
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
              let i2 = ptr; while (new Uint8Array(memory.buffer)[i2]) i2++;
              let path = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, i2 - ptr));
              if (!path.startsWith('/')) path = '/' + path;
              path = resolveSymlinks(path);
              const content = vfs.get(path);
              if (!content) return -2;
              const fd = nextFd++;
              openFiles.set(fd, { content: new Uint8Array(content), position: 0, path });
              return fd;
            }
            case 3: openFiles.delete(a); return 0;
            case 5: { const file = openFiles.get(a); new Uint8Array(memory.buffer, b >>> 0, 128).fill(0); const view = new DataView(memory.buffer); view.setUint32(b + 16, 0o100755, true); view.setBigInt64(b + 48, BigInt(file ? file.content.length : 0), true); return file || a <= 2 ? 0 : -9; }
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
            case 77: return 0; // SYS_ftruncate
            case 72: { if (b===3||b===1||b===2||b===4) return 0; if (b===0||b===1030) return a; return 0; }
            case 79: { new Uint8Array(memory.buffer, a>>>0, 2).set([47, 0]); return a; }
            case 16: return -25; case 51: case 55: return 0; case 95: return 0o22;
            case 4: case 6: {
              let i3=a;while(new Uint8Array(memory.buffer)[i3])i3++;
              let p2=new TextDecoder().decode(new Uint8Array(memory.buffer,a,i3-a));
              if(!p2.startsWith('/'))p2='/'+p2; p2=resolveSymlinks(p2);
              const f2=vfs.get(p2); if(!f2)return-2;
              new Uint8Array(memory.buffer,b>>>0,128).fill(0);
              new DataView(memory.buffer).setUint32(b+16,0o100755,true);
              new DataView(memory.buffer).setBigInt64(b+48,BigInt(f2.length),true);
              return 0;
            }
            case 262: {
              let i3=b;while(new Uint8Array(memory.buffer)[i3])i3++;
              let p2=new TextDecoder().decode(new Uint8Array(memory.buffer,b,i3-b));
              if(!p2.startsWith('/'))p2='/'+p2; p2=resolveSymlinks(p2);
              const f2=vfs.get(p2); if(!f2)return-2;
              new Uint8Array(memory.buffer,c>>>0,128).fill(0);
              new DataView(memory.buffer).setUint32(c+16,0o100755,true);
              new DataView(memory.buffer).setBigInt64(c+48,BigInt(f2.length),true);
              return 0;
            }
            case 269: {
              let i3=b;while(new Uint8Array(memory.buffer)[i3])i3++;
              let p2=new TextDecoder().decode(new Uint8Array(memory.buffer,b,i3-b));
              if(!p2.startsWith('/'))p2='/'+p2; p2=resolveSymlinks(p2);
              return vfs.has(p2)?0:-2;
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
            case 32: return a; case 33: return b; case 41: return -97; case 51: case 52: case 54: case 55: return 0;
            case 56: case 57: case 59: return -38; case 61: return -10;
            case 74: case 75: case 76: case 80: case 90: case 91: case 92: case 93: case 94: return 0;
            case 95: return 0o22; case 96: { if(a){const now=Date.now();const v=new DataView(memory.buffer);v.setBigInt64(a>>>0,BigInt(Math.floor(now/1000)),true);v.setBigInt64((a>>>0)+8,BigInt((now%1000)*1000),true);}return 0; }
            case 97: case 98: case 100: return 0; case 105: case 106: case 109: case 111: return 0;
            case 112: return 1; case 113: case 114: case 117: case 119: case 124: return 0;
            case 118: case 120: { if(a)new DataView(memory.buffer).setUint32(a>>>0,0,true);if(b)new DataView(memory.buffer).setUint32(b>>>0,0,true);if(c)new DataView(memory.buffer).setUint32(c>>>0,0,true);return 0; }
            case 15: case 157: case 158: case 160: case 161: case 162: return 0;
            case 60: case 231: case 62: case 200: case 234: throw new WebAssembly.RuntimeError('unreachable');
            default:
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
      },
    });

    instance = result.instance;
    memory = instance.exports.memory;

    // Write fork state into WASM memory
    self.postMessage({ type: 'stdout', data: new TextEncoder().encode('CHILD: malloc state ' + state.byteLength + '\n') });
    const stateBytes = new Uint8Array(state);
    const statePtr = instance.exports.malloc(stateBytes.length);
    self.postMessage({ type: 'stdout', data: new TextEncoder().encode('CHILD: malloc returned ' + statePtr + '\n') });
    new Uint8Array(memory.buffer, statePtr, stateBytes.length).set(stateBytes);

    // Call restore_fork
    self.postMessage({ type: 'stdout', data: new TextEncoder().encode('CHILD: calling restore_fork\n') });
    try {
      instance.exports.restore_fork(statePtr, stateBytes.length);
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
