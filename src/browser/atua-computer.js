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
      rootfsTar = typeof opts.rootfsUrl === 'string'
        ? await fetch(opts.rootfsUrl).then(r => r.arrayBuffer())
        : (opts.rootfsUrl instanceof ArrayBuffer ? opts.rootfsUrl : opts.rootfsUrl.buffer.slice(opts.rootfsUrl.byteOffset, opts.rootfsUrl.byteOffset + opts.rootfsUrl.byteLength));
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

    // Create engine Worker
    this._worker = new Worker('/engine-main-worker.js', { type: 'module' });

    return new Promise((resolve, reject) => {
      this._exitResolve = resolve;

      this._worker.onmessage = (e) => this._handleWorkerMessage(e, resolve);
      this._worker.onerror = (e) => reject(new Error('Worker error: ' + e.message));

      // Boot the engine on the Worker
      this._worker.postMessage({
        type: 'boot',
        engineWasm: this._engineWasm,
        rootfsTar,
        args: opts.args || ['engine'],
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
    const { state, pid, files, waitFlag, pipeSabs } = msg;

    const child = new Worker('/engine-worker.js');
    this._children.set(pid, child);

    child.onmessage = (ce) => {
      if (ce.data.type === 'stdout') {
        // Forward child stdout to our output
        this.outputCallback(ce.data.data);
      } else if (ce.data.type === 'exit') {
        // Signal parent Worker that child exited
        this._worker.postMessage({ type: 'child-exit', pid: ce.data.pid, code: ce.data.code });
        // Also set the SAB flag directly
        if (waitFlag) {
          const view = new Int32Array(waitFlag);
          Atomics.store(view, 0, 1);
          Atomics.notify(view, 0);
        }
        this._children.delete(pid);
      }
    };

    child.postMessage({
      type: 'restore-fork',
      state,
      pid,
      engineUrl: '/engine.wasm',
      files,
      pipeSabs: pipeSabs || {},
    });
  }
}
