#!/usr/bin/env python3
"""Patch Blink to use posix_spawn for fork+exec on WASI - Version 2.

The key insight: when the guest calls clone(SIGCHLD), we can't actually
split into two processes. Instead:

1. SysClone returns a fake child PID to the parent (nonzero = parent path)
2. But we also need the child path to run and call execve
3. Solution: return 0 first (child runs execve->posix_spawn), then
   posix_spawn creates the real child, and we return the real PID
   to the parent by _Exit'ing with a special code that waitpid handles.

Actually simpler: the vfork model.
- SysFork/SysClone returns 0 (child path runs in parent process)
- Child calls execve -> posix_spawn creates real process -> _Exit with child status
- The shell's waitpid (in parent code) never runs because _Exit kills us
- But that kills the parent too!

The REAL solution for single-binary shells like BusyBox:
BusyBox sh has a built-in fork+exec that we can intercept. But generically,
we need to handle: parent does fork, gets PID, child does execve.

Approach: Use posix_spawn directly in the SysExecve handler.
When the shell does fork+exec, the "fork" returns 0 (child path).
The child immediately calls execve. We posix_spawn and then _Exit
with the child's exit code. This means the shell process itself exits.
But that's OK for -c "command" mode because the shell IS the child.

For interactive shells this won't work. But for "sh -c cmd" it does:
- sh -c "ls" -> sh forks, child execs ls, parent waits
- With our patch: sh "forks" (no-op, returns 0), sh execs ls via posix_spawn,
  sh exits with ls's status. The outer wasmer gets the right exit code.
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# Replace SysFork: return 0 (child path) and set isfork flag
old = '''static int SysFork(struct Machine *m) {
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

new = '''static int SysFork(struct Machine *m) {
#ifdef __wasi__
  // WASI: No real fork. Use vfork semantics.
  // Return 0 (child path). The child will call execve which triggers
  // posix_spawn to create the real child process, then _Exit.
  m->system->isfork = true;
  SYS_LOGF("WASI SysFork: returning 0 (vfork child path)");
  return 0;
#else
  return Fork(m, 0, 0, 0);
#endif
}'''

c = c.replace(old, new, 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Updated SysFork v2')
