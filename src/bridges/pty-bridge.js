/**
 * PtyBridge — Terminal bridge to xterm.js.
 *
 * This bridge routes guest terminal I/O from the engine's
 * WASI fd operations and ioctl calls to xterm.js via xterm-pty patterns.
 *
 * Phase B: Minimal — capture stdout/stderr from engine fd 1/2 writes.
 * Phase C: Full — PTY/TTY with termios, raw mode, line editing for bash.
 */
export class PtyBridge {
  constructor(options = {}) {
    this._terminal = options.terminal || 'xterm.js';
  }

  async open({ cols = 80, rows = 24 } = {}) {
    throw new Error(
      'NOT IMPLEMENTED: PtyBridge.open() — xterm.js integration not yet built. ' +
      'Requires: xterm-pty bridge for PTY/TTY mediation.'
    );
  }

  async write(sessionId, data) {
    throw new Error(`NOT IMPLEMENTED: PtyBridge.write(${sessionId}) — no real terminal connected`);
  }

  async *read(sessionId) {
    throw new Error(`NOT IMPLEMENTED: PtyBridge.read(${sessionId}) — no real terminal connected`);
  }

  async resize(sessionId, { cols, rows }) {
    throw new Error(`NOT IMPLEMENTED: PtyBridge.resize(${sessionId}) — no real terminal connected`);
  }

  snapshot() {
    throw new Error('NOT IMPLEMENTED: PtyBridge.snapshot() — no real terminal to snapshot');
  }

  restore(snapshot) {
    throw new Error('NOT IMPLEMENTED: PtyBridge.restore() — no real terminal to restore');
  }
}
