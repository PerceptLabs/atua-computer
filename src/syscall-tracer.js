/**
 * SyscallTracer — Records real syscall events from the engine.
 *
 * This tracer is designed to record events from actual syscall dispatch
 * inside the Blink engine. Events should only be recorded when a real
 * x86-64 SYSCALL instruction is intercepted and handled.
 *
 * The tracer code itself is sound. The problem was that the old fake
 * engine called trace() with fabricated syscall names that never actually
 * executed. With the real engine, trace() will be called from the WASIX
 * bridge layer when the engine actually dispatches a Linux syscall.
 */

const MUST_HAVE = new Set([
  'execve', 'openat', 'read', 'write', 'close', 'clone', 'wait4',
  'fork', 'exit', 'exit_group', 'brk', 'mmap', 'munmap', 'mprotect',
  'getpid', 'getppid', 'gettid', 'kill', 'pipe', 'pipe2', 'dup2', 'dup3',
  'fcntl', 'ioctl', 'stat', 'fstat', 'lstat', 'fstatat',
  'getdents64', 'mkdir', 'rmdir', 'chdir', 'getcwd',
  'unlink', 'rename', 'link', 'symlink', 'chmod', 'chown',
  'rt_sigaction', 'rt_sigprocmask', 'rt_sigreturn',
  'clock_gettime', 'nanosleep',
  'getuid', 'geteuid', 'getgid', 'getegid', 'umask',
  'uname', 'arch_prctl', 'set_tid_address', 'set_robust_list',
  'futex', 'sched_yield', 'getrandom', 'prctl', 'sysinfo',
  'access', 'readlink', 'pread64', 'pwrite64', 'lseek',
  'select', 'poll', 'epoll_create1', 'epoll_ctl', 'epoll_wait',
]);

const SHOULD_HAVE = new Set([
  'socket', 'connect', 'bind', 'listen', 'accept', 'accept4',
  'sendto', 'recvfrom', 'sendmsg', 'recvmsg',
  'setsockopt', 'getsockopt', 'getpeername', 'getsockname',
  'shutdown', 'socketpair',
  'eventfd2', 'inotify_init1', 'inotify_add_watch',
  'timerfd_create', 'timerfd_settime',
  'memfd_create', 'copy_file_range', 'sendfile',
]);

export class SyscallTracer {
  constructor() {
    this._events = [];
  }

  /**
   * Record a real syscall event from the engine.
   * This should ONLY be called when the engine actually dispatches a syscall.
   */
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
