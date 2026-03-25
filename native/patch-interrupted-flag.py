#!/usr/bin/env python3
"""Fix: set m->interrupted in SysExecve and vfork exit to prevent RAX clobber.

After SysExecve returns with the child PID in RAX, the post-switch code
in OpSyscall does Put64(m->ax, ax) which overwrites our PID. Setting
m->interrupted = true prevents this clobber.
"""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

# Fix SysExecve: set interrupted before returning
old_exec_return = '''      // Child spawned. Restore parent state and return child PID.
      RestoreFds(&m->system->fds);
      m->system->isfork = false;
      // Jump back to the fork return point with child PID in RAX
      m->ip = g_vfork_rip;
      Put64(m->ax, pid);
      return 0;  // return value ignored — RAX already set'''

new_exec_return = '''      // Child spawned. Restore parent state and return child PID.
      RestoreFds(&m->system->fds);
      m->system->isfork = false;
      m->ip = g_vfork_rip;
      Put64(m->ax, pid);
      m->interrupted = true;  // prevent post-switch RAX clobber
      return 0;'''

c = c.replace(old_exec_return, new_exec_return, 1)

# Fix vfork exit handler at top of OpSyscall: set interrupted
old_exit_return = '''      // Vfork child exit: restore parent state, return fake PID
      RestoreFds(&m->system->fds);
      m->system->isfork = false;
      m->ip = g_vfork_rip;
      Put64(m->ax, 99);  // fake PID
      return;'''

new_exit_return = '''      // Vfork child exit: restore parent state, return fake PID
      RestoreFds(&m->system->fds);
      m->system->isfork = false;
      m->ip = g_vfork_rip;
      Put64(m->ax, 99);  // fake PID
      m->interrupted = true;
      return;'''

c = c.replace(old_exit_return, new_exit_return, 1)

# Also fix the SysExecve failure path
old_exec_fail = '''    RestoreFds(&m->system->fds);
    m->system->isfork = false;
    m->ip = g_vfork_rip;
    Put64(m->ax, -1);
    errno = ret;
    return -1;'''

new_exec_fail = '''    RestoreFds(&m->system->fds);
    m->system->isfork = false;
    m->ip = g_vfork_rip;
    Put64(m->ax, -1);
    m->interrupted = true;
    errno = ret;
    return -1;'''

c = c.replace(old_exec_fail, new_exec_fail, 1)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Fixed: m->interrupted set in all vfork return paths')
