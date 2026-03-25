const MUST_HAVE = new Set(['execve', 'openat', 'read', 'write', 'close', 'clone', 'wait4']);
const SHOULD_HAVE = new Set(['socket', 'connect', 'epoll_wait', 'eventfd2', 'futex', 'mmap']);

export class SyscallTracer {
  constructor() {
    this._events = [];
  }

  trace({ pid, syscall, result = 0, meta = {} }) {
    const entry = {
      ts: new Date().toISOString(),
      pid,
      syscall,
      tier: this._tierFor(syscall),
      result,
      meta,
    };
    this._events.push(entry);
    return entry;
  }

  _tierFor(syscall) {
    if (MUST_HAVE.has(syscall)) return 'must-have';
    if (SHOULD_HAVE.has(syscall)) return 'should-have';
    return 'stub-later';
  }

  list() {
    return [...this._events];
  }

  countsByTier() {
    const counts = { 'must-have': 0, 'should-have': 0, 'stub-later': 0 };
    for (const evt of this._events) counts[evt.tier] += 1;
    return counts;
  }

  coverage() {
    const seen = new Set(this._events.map((e) => e.syscall));
    const missingMustHave = [...MUST_HAVE].filter((name) => !seen.has(name));
    const missingShouldHave = [...SHOULD_HAVE].filter((name) => !seen.has(name));
    return {
      seen: [...seen].sort(),
      missingMustHave,
      missingShouldHave,
    };
  }

  snapshot() {
    return { events: this.list() };
  }

  restore(snapshot) {
    this._events = [...(snapshot?.events || [])];
  }
}
