#!/usr/bin/env python3
"""Patch Blink to use posix_spawn for fork+exec on WASI.

On WASI, fork() doesn't work (no setjmp). Instead, we implement a
vfork+exec fast path: fork() returns immediately with a fake PID,
and when the child calls execve(), we use posix_spawn to create a
real WASM child process running a new instance of the engine.

The engine binary path is passed via the BLINK_WASM_SELF env var.
"""

import sys

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# 1. Add includes at the top of the file (after the last #include)
spawn_includes = '''
#ifdef __wasi__
#include <spawn.h>
#endif
'''

# Find the last #include line before the first function
last_include_idx = c.rfind('#include', 0, c.find('\nstatic '))
end_of_line = c.find('\n', last_include_idx) + 1
c = c[:end_of_line] + spawn_includes + c[end_of_line:]

# 2. Replace SysFork with a WASI-compatible version
old_sysfork = '''static int SysFork(struct Machine *m) {
  return Fork(m, 0, 0, 0);
}'''

new_sysfork = '''static int SysFork(struct Machine *m) {
#ifdef __wasi__
  // WASI: No real fork. Use vfork semantics:
  // Return 0 to caller (pretend we're the child).
  // The "child" will call execve() which triggers posix_spawn.
  // We set a flag so SysExecve knows to use posix_spawn.
  m->system->isfork = true;
  return 0;  // Always return 0 (child path) - the "parent" continues after execve returns
#else
  return Fork(m, 0, 0, 0);
#endif
}'''

c = c.replace(old_sysfork, new_sysfork, 1)

# 3. Patch SysExecve to use posix_spawn on WASI when in fork context
old_execve = '''static int SysExecve(struct Machine *m, i64 pa, i64 aa, i64 ea) {
  char *prog, **argv, **envp;
  if (!(prog = CopyStr(m, pa))) return -1;
  if (!(argv = CopyStrList(m, aa))) return -1;
  if (!(envp = CopyStrList(m, ea))) return -1;
  LOCK(&m->system->exec_lock);
  ExecveBlink(m, prog, argv, envp);
  SYS_LOGF("execve(%s)", prog);
  VfsExecve(prog, argv, envp);
  UNLOCK(&m->system->exec_lock);
  return -1;
}'''

new_execve = '''static int SysExecve(struct Machine *m, i64 pa, i64 aa, i64 ea) {
  char *prog, **argv, **envp;
  if (!(prog = CopyStr(m, pa))) return -1;
  if (!(argv = CopyStrList(m, aa))) return -1;
  if (!(envp = CopyStrList(m, ea))) return -1;
#ifdef __wasi__
  if (m->system->isfork) {
    // WASI fork+exec fast path: use posix_spawn to create a new
    // engine process running the target binary.
    // Build argv: [engine_path, guest_prog, guest_args...]
    const char *engine = getenv("BLINK_WASM_SELF");
    if (!engine) engine = "/engine/engine-wasix.wasm";
    int argc = 0;
    while (argv[argc]) argc++;
    char **spawn_argv = calloc(argc + 2, sizeof(char *));
    spawn_argv[0] = (char *)engine;
    // The guest program path is the first real argument to the engine
    for (int i = 0; i < argc; i++) {
      spawn_argv[i + 1] = argv[i];
    }
    // Replace argv[0] with the full path to the program
    spawn_argv[1] = prog;
    spawn_argv[argc + 1] = NULL;
    pid_t pid;
    SYS_LOGF("posix_spawn(%s, %s)", engine, prog);
    int ret = posix_spawn(&pid, engine, NULL, NULL, spawn_argv, envp);
    free(spawn_argv);
    if (ret == 0) {
      // Child spawned. Wait for it and exit with its status.
      int wstatus;
      waitpid(pid, &wstatus, 0);
      if (WIFEXITED(wstatus)) {
        _Exit(WEXITSTATUS(wstatus));
      }
      _Exit(128);
    }
    SYS_LOGF("posix_spawn failed: %d", ret);
    errno = ret;
    free(spawn_argv);
    return -1;
  }
#endif
  LOCK(&m->system->exec_lock);
  ExecveBlink(m, prog, argv, envp);
  SYS_LOGF("execve(%s)", prog);
  VfsExecve(prog, argv, envp);
  UNLOCK(&m->system->exec_lock);
  return -1;
}'''

c = c.replace(old_execve, new_execve, 1)

# 4. Also patch SysVfork to use the same path
old_vfork = '''static int SysVfork(struct Machine *m) {
  // TODO: Parent should be stopped while child is running.
  return SysFork(m);
}'''

new_vfork = '''static int SysVfork(struct Machine *m) {
  return SysFork(m);
}'''

c = c.replace(old_vfork, new_vfork, 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Patched syscall.c: SysFork uses vfork semantics, SysExecve uses posix_spawn on WASI')
