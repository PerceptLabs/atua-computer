/**
 * No separate "Production" PTY bridge exists.
 * PtyBridge IS the production bridge — it connects to xterm.js
 * or throws NOT IMPLEMENTED. There is no in-memory fallback.
 */
export { PtyBridge as ProductionPtyBridge } from './pty-bridge.js';
