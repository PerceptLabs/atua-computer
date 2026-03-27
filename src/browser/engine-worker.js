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
    const { state, pid, engineUrl, files, pipeSabs } = e.data;

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

    // Build VFS from files (passed as { path: ArrayBuffer })
    const vfs = new Map();
    if (files) {
      for (const [path, content] of Object.entries(files)) {
        vfs.set(path, new Uint8Array(content));
      }
    }
    const openFiles = new Map();
    let nextFd = 4;

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
          let e = pathPtr;
          while (e < mem.length && mem[e]) e++;
          const path = new TextDecoder().decode(mem.subarray(pathPtr, e));
          const content = vfs.get(path) || vfs.get(path.replace(/^\//, ''));
          if (!content) return -1;
          const fd = nextFd++;
          openFiles.set(fd, { content });
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
    const stateBytes = new Uint8Array(state);
    const statePtr = instance.exports.malloc(stateBytes.length);
    new Uint8Array(memory.buffer, statePtr, stateBytes.length).set(stateBytes);

    // Call restore_fork
    try {
      instance.exports.restore_fork(statePtr, stateBytes.length);
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError && err.message.includes('unreachable')) {
        // Normal exit
      } else {
        self.postMessage({ type: 'error', message: err.message });
      }
    }

    // Read exit code from exported function (set by __wasi_proc_exit before trap)
    let exitCode = 0;
    try {
      if (instance.exports.get_exit_code) exitCode = instance.exports.get_exit_code();
    } catch(e) {}
    self.postMessage({ type: 'exit', pid, code: exitCode });
  }
};
