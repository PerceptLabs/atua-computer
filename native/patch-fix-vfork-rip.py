#!/usr/bin/env python3
"""Fix: move g_vfork_rip save from Fork() to SysFork().

The snapshot/RIP code was placed inside Fork() (the real fork function)
which never runs on WASI. It needs to be in SysFork's #ifdef __wasi__ block.
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# 1. Fix SysFork: add snapshot + RIP save
old_sysfork = '''static int SysFork(struct Machine *m) {
#ifdef __wasi__
  // WASI: No real fork. Use vfork semantics:
  // Return 0 to caller (pretend we're the child).
  // The "child" will call execve() which triggers posix_spawn.
  // We set a flag so SysExecve knows to use posix_spawn.
  m->system->isfork = true;
  return 0;  // Always return 0 (child path) - the "parent" continues after execve returns
#else'''

new_sysfork = '''static int SysFork(struct Machine *m) {
#ifdef __wasi__
  // WASI vfork: snapshot fds, save return RIP, set isfork, return 0 (child path)
  g_fd_op_count = 0;
  SnapshotFds(&m->system->fds);
  g_vfork_rip = m->ip;  // Return address (IP already advanced past SYSCALL)
  m->system->isfork = true;
  return 0;
#else'''

c = c.replace(old_sysfork, new_sysfork, 1)

# 2. Remove misplaced code from inside Fork()
old_fork_code = '''#ifdef __wasi__
  g_fd_op_count = 0;
  SnapshotFds(&m->system->fds);
  g_vfork_rip = m->ip ? m->ip : Get64(m->cx);  // m->ip or RCX from SYSCALL
#endif'''

c = c.replace(old_fork_code, '  // (snapshot code moved to SysFork)', 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Fixed: snapshot + RIP save moved to SysFork WASI block')
