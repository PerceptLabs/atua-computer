/**
 * NetBridge — Network bridge to atua-net (Wisp relay).
 *
 * This bridge routes guest socket operations from the engine's
 * WASIX socket calls to the real atua-net outbound networking stack.
 *
 * Phase D: Full — socket, connect, send, recv, DNS resolution.
 * Not needed for Phase B or C.
 */
export class NetBridge {
  constructor(options = {}) {
    this._transport = options.transport || 'atua-net';
  }

  async open({ host, port, protocol = 'tcp' }) {
    throw new Error(
      `NOT IMPLEMENTED: NetBridge.open(${host}:${port}) — atua-net integration not yet built. ` +
      'Requires: WASIX socket calls routed to atua-net Wisp relay.'
    );
  }

  async send(id, data) {
    throw new Error(`NOT IMPLEMENTED: NetBridge.send(${id}) — no real network connected`);
  }

  async receive(id) {
    throw new Error(`NOT IMPLEMENTED: NetBridge.receive(${id}) — no real network connected`);
  }

  async close(id) {
    throw new Error(`NOT IMPLEMENTED: NetBridge.close(${id}) — no real network connected`);
  }

  stats() {
    return { openSockets: 0, totalSockets: 0 };
  }

  snapshot() {
    throw new Error('NOT IMPLEMENTED: NetBridge.snapshot() — no real network to snapshot');
  }

  restore(snapshot) {
    throw new Error('NOT IMPLEMENTED: NetBridge.restore() — no real network to restore');
  }
}
