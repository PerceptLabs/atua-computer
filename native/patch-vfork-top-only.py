#!/usr/bin/env python3
"""Move ALL vfork intercepts to the top of OpSyscall.

The post-switch code in OpSyscall corrupts m->ip (rip=0x2 = child PID).
The ONLY safe place to set m->ip and return is at the TOP of OpSyscall,
before the switch statement. Return immediately — no break, no fallthrough.

Intercept both exit/exit_group AND execve at the top.
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# Replace the existing top-of-OpSyscall intercept with one that handles
# BOTH exit and execve during vfork
old_top = '''#ifdef __wasi__
  // Vfork exit intercept: must be at TOP of OpSyscall (not inside switch)
  // because SysExitGroup is _Noreturn and the compiler eliminates writes
  // to m->ip inside case blocks that end with _Noreturn calls.
  {
    u64 _sysnum = Get64(m->ax) & 0xfff;
    if (m->system->isfork && (_sysnum == 0x3C || _sysnum == 0xE7)) {
      // Vfork child exit: restore parent state, return fake PID
      RestoreFds(&m->system->fds);
      m->system->isfork = false;
      m->ip = g_vfork_rip;
      Put64(m->ax, 99);  // fake PID
      m->interrupted = true;
      return;
    }
  }
#endif'''

new_top = '''#ifdef __wasi__
  // ALL vfork intercepts at TOP of OpSyscall. Return immediately.
  // The post-switch code (Put64, CollectPageLocks, CollectGarbage)
  // corrupts m->ip — we must never reach it during vfork return.
  if (m->system->isfork) {
    u64 _sysnum = Get64(m->ax) & 0xfff;

    // Intercept execve (0x3B): posix_spawn child, restore, return to parent
    if (_sysnum == 0x3B) {
      i64 pa = Get64(m->di), aa = Get64(m->si), ea = Get64(m->dx);
      char *prog, **argv, **envp;
      if ((prog = CopyStr(m, pa)) && (argv = CopyStrList(m, aa)) &&
          (envp = CopyStrList(m, ea))) {
        const char *engine = getenv("BLINK_WASM_SELF");
        if (!engine) engine = "/engine/engine-wasix.wasm";
        int argc = 0;
        while (argv[argc]) argc++;
        char **spawn_argv = calloc(argc + 2, sizeof(char *));
        spawn_argv[0] = (char *)engine;
        for (int i = 0; i < argc; i++) spawn_argv[i + 1] = argv[i];
        spawn_argv[1] = prog;
        spawn_argv[argc + 1] = NULL;

        // Build file_actions from recorded fd ops
        posix_spawn_file_actions_t file_actions;
        posix_spawn_file_actions_t *actions_ptr = NULL;
        if (g_fd_op_count > 0) {
          posix_spawn_file_actions_init(&file_actions);
          for (int i = 0; i < g_fd_op_count; i++) {
            if (g_fd_ops[i].type == 0)
              posix_spawn_file_actions_adddup2(&file_actions, g_fd_ops[i].src_fd, g_fd_ops[i].dst_fd);
            else if (g_fd_ops[i].type == 1)
              posix_spawn_file_actions_addclose(&file_actions, g_fd_ops[i].src_fd);
          }
          actions_ptr = &file_actions;
        }

        pid_t pid = 0;
        int ret = posix_spawn(&pid, engine, actions_ptr, NULL, spawn_argv, envp);
        if (actions_ptr) posix_spawn_file_actions_destroy(&file_actions);
        free(spawn_argv);

        RestoreFds(&m->system->fds);
        m->system->isfork = false;
        m->ip = g_vfork_rip;
        Put64(m->ax, ret == 0 ? pid : (u64)-1);
      }
      return;  // return from OpSyscall — interpreter resumes at g_vfork_rip
    }

    // Intercept exit/exit_group (0x3C, 0xE7): builtin command finished
    if (_sysnum == 0x3C || _sysnum == 0xE7) {
      // Spawn a dummy child so parent has a PID to waitpid on
      const char *eng = getenv("BLINK_WASM_SELF");
      if (!eng) eng = "/engine/engine-wasix.wasm";
      pid_t dummy = 0;
      char *da[] = {(char*)eng, "/rootfs/bin/busybox.static", "true", NULL};
      posix_spawn(&dummy, eng, NULL, NULL, da, environ);

      RestoreFds(&m->system->fds);
      m->system->isfork = false;
      m->ip = g_vfork_rip;
      Put64(m->ax, dummy > 0 ? dummy : 1);
      return;  // return from OpSyscall
    }
  }
#endif'''

c = c.replace(old_top, new_top, 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('All vfork intercepts moved to top of OpSyscall with immediate return')
