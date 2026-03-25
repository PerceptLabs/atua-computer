export class InMemoryNetBridge {
  constructor() {
    this._nextSocket = 1;
    this._sockets = new Map();
  }

  async open({ host, port, protocol = 'tcp' }) {
    const id = this._nextSocket++;
    const socket = { id, host, port, protocol, state: 'open', sent: [], received: [] };
    this._sockets.set(id, socket);
    return { ...socket };
  }

  async send(id, data) {
    const socket = this._mustGet(id);
    socket.sent.push(String(data));
    return socket.sent.length;
  }

  async receive(id, data) {
    const socket = this._mustGet(id);
    socket.received.push(String(data));
  }

  async close(id) {
    const socket = this._mustGet(id);
    socket.state = 'closed';
  }

  stats() {
    return {
      openSockets: Array.from(this._sockets.values()).filter((s) => s.state === 'open').length,
      totalSockets: this._sockets.size,
    };
  }

  snapshot() {
    return {
      nextSocket: this._nextSocket,
      sockets: Array.from(this._sockets.entries()),
    };
  }

  restore(snapshot) {
    this._nextSocket = snapshot?.nextSocket || 1;
    this._sockets = new Map(snapshot?.sockets || []);
  }

  _mustGet(id) {
    const socket = this._sockets.get(id);
    if (!socket) throw new Error(`Socket not found: ${id}`);
    if (socket.state !== 'open') throw new Error(`Socket closed: ${id}`);
    return socket;
  }
}
