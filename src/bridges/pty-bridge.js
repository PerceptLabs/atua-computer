export class InMemoryPtyBridge {
  constructor() {
    this._nextSession = 1;
    this._sessions = new Map();
  }

  async open({ cols = 80, rows = 24 } = {}) {
    const id = this._nextSession++;
    this._sessions.set(id, { id, cols, rows, in: [], out: [] });
    return { sessionId: id, cols, rows };
  }

  async write(id, data) {
    const session = this._mustGet(id);
    session.in.push(String(data));
  }

  async pushOutput(id, data) {
    const session = this._mustGet(id);
    session.out.push(String(data));
  }

  async *read(id) {
    const session = this._mustGet(id);
    for (const chunk of session.out) {
      yield chunk;
    }
  }

  async resize(id, { cols, rows }) {
    const session = this._mustGet(id);
    if (cols) session.cols = cols;
    if (rows) session.rows = rows;
  }

  snapshot() {
    return {
      nextSession: this._nextSession,
      sessions: Array.from(this._sessions.entries()),
    };
  }

  restore(snapshot) {
    this._nextSession = snapshot?.nextSession || 1;
    this._sessions = new Map(snapshot?.sessions || []);
  }

  _mustGet(id) {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`PTY session not found: ${id}`);
    return session;
  }
}
