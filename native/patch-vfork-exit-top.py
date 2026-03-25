#!/usr/bin/env python3
"""Move vfork exit intercept to top of OpSyscall (before switch).

The compiler optimizes away m->ip writes inside case 0xE7 because
SysExitGroup is _Noreturn — the compiler treats everything after
the if(isfork) block as unreachable. Moving to the top of OpSyscall
avoids this: OpSyscall itself is a normal void function, so return
is legal and the compiler preserves all writes.
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# 1. Add vfork exit intercept at the TOP of OpSyscall, before any other code
old_top = '''void OpSyscall(P) {
  size_t mark;
  u64 ax, di, si, dx, r0, r8, r9;
  unassert(!m->nofault);'''

new_top = '''void OpSyscall(P) {
#ifdef __wasi__
  // Vfork exit intercept: must be at TOP of OpSyscall (not inside switch)
  // because SysExitGroup is _Noreturn and the compiler eliminates writes
  // to m->ip inside case blocks that end with _Noreturn calls.
  {
    u64 _sysnum = Get64(m->ax) & 0xfff;
    if (m->system->isfork && (_sysnum == 0x3C || _sysnum == 0xE7)) {
      int _rc = (int)Get64(m->di);
      const char *_eng = getenv("BLINK_WASM_SELF");
      if (!_eng) _eng = "/engine/engine-wasix.wasm";
      pid_t _dummy = 0;
      char *_da[] = {(char*)_eng, "/rootfs/bin/busybox.static", "true", NULL};
      posix_spawn(&_dummy, _eng, NULL, NULL, _da, environ);
      RestoreFds(&m->system->fds);
      m->system->isfork = false;
      m->ip = g_vfork_rip;
      Put64(m->ax, _dummy > 0 ? _dummy : 1);
      return;  // legal: OpSyscall is not _Noreturn
    }
  }
#endif
  size_t mark;
  u64 ax, di, si, dx, r0, r8, r9;
  unassert(!m->nofault);'''

c = c.replace(old_top, new_top, 1)

# 2. Remove the old broken intercepts inside case 0x3C and 0xE7
# Case 0x3C (exit)
old_exit = '''    case 0x3C:
      SYS_LOGF("%s(%#" PRIx64 ")", "exit", di);
#ifdef __wasi__
      if (m->system->isfork) {
        pid_t dummy = 0;
        const char *eng = getenv("BLINK_WASM_SELF");
        if (!eng) eng = "/engine/engine-wasix.wasm";
        char *da[] = {(char*)eng, "/rootfs/bin/busybox.static", "true", NULL};
        posix_spawn(&dummy, eng, NULL, NULL, da, environ);
        RestoreFds(&m->system->fds);
        m->system->isfork = false;
        m->ip = g_vfork_rip;
        Put64(m->ax, dummy > 0 ? dummy : 1);
        ax = Get64(m->ax);
        break;
      }
#endif
      SysExit(m, di);'''

new_exit = '''    case 0x3C:
      SYS_LOGF("%s(%#" PRIx64 ")", "exit", di);
      SysExit(m, di);'''

c = c.replace(old_exit, new_exit, 1)

# Case 0xE7 (exit_group)
old_exitgroup = '''    case 0xE7:
      SYS_LOGF("%s(%#" PRIx64 ")", "exit_group", di);
#ifdef __wasi__
      if (m->system->isfork) {
        pid_t dummy = 0;
        const char *eng = getenv("BLINK_WASM_SELF");
        if (!eng) eng = "/engine/engine-wasix.wasm";
        char *da[] = {(char*)eng, "/rootfs/bin/busybox.static", "true", NULL};
        posix_spawn(&dummy, eng, NULL, NULL, da, environ);
        RestoreFds(&m->system->fds);
        m->system->isfork = false;
        m->ip = g_vfork_rip;
        Put64(m->ax, dummy > 0 ? dummy : 1);
        ax = Get64(m->ax);
        break;
      }
#endif
      SysExitGroup(m, di);'''

new_exitgroup = '''    case 0xE7:
      SYS_LOGF("%s(%#" PRIx64 ")", "exit_group", di);
      SysExitGroup(m, di);'''

c = c.replace(old_exitgroup, new_exitgroup, 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Fixed: vfork exit intercept moved to top of OpSyscall')
