#!/usr/bin/env python3
"""Intercept exit/exit_group at dispatch level for vfork child.

Can't return from _Noreturn SysExitGroup. Instead, intercept at
the syscall dispatch before calling the noreturn function.
When isfork is true, handle the exit by restoring state and
returning to the parent fork point.
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# Replace the exit dispatch to intercept vfork exits
old_exit = '''    case 0x3C:
      SYS_LOGF("%s(%#" PRIx64 ")", "exit", di);
      SysExit(m, di);
    case 0xE7:
      SYS_LOGF("%s(%#" PRIx64 ")", "exit_group", di);
      SysExitGroup(m, di);'''

new_exit = '''    case 0x3C:
      SYS_LOGF("%s(%#" PRIx64 ")", "exit", di);
#ifdef __wasi__
      if (m->system->isfork) {
        // Vfork child exit: spawn dummy child, restore state, return to parent
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
      SysExit(m, di);
    case 0xE7:
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

c = c.replace(old_exit, new_exit, 1)

# Also remove the old broken vfork handler inside SysExitGroup
# (which tries to return from a _Noreturn function)
old_broken = '''  if (m->system->isfork) {
    // Vfork child calling _exit (builtin command, no exec).
    // Spawn a dummy child that exits with the given code so parent can waitpid.
    const char *engine = getenv("BLINK_WASM_SELF");
    if (!engine) engine = "/engine/engine-wasix.wasm";
    pid_t dummy_pid = 0;
    {
      char rc_str[16];
      snprintf(rc_str, sizeof(rc_str), "%d", rc);
      char *dargv[] = {(char *)engine, "-e", rc_str, NULL};
      // Spawn engine with no args — it will print version and exit
      // Actually: we just need ANY process that exits with code rc.
      // Use a minimal approach: spawn shell with exit command
      char exit_cmd[32];
      snprintf(exit_cmd, sizeof(exit_cmd), "exit %d", rc);
      char *sargv[] = {(char *)engine, "/rootfs/bin/busybox.static", "true", NULL};
      posix_spawn(&dummy_pid, engine, NULL, NULL, sargv, environ);
    }
    RestoreFds(&m->system->fds);
    m->system->isfork = false;
    m->ip = g_vfork_rip;
    Put64(m->ax, dummy_pid > 0 ? dummy_pid : 1);
    return;
  } else {'''

new_broken = '''  if (0) {
    // Vfork exit handling moved to syscall dispatch (can't return from _Noreturn)
  } else {'''

c = c.replace(old_broken, new_broken, 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Patched: vfork exit handling moved to syscall dispatch level')
