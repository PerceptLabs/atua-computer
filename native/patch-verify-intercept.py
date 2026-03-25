#!/usr/bin/env python3
"""Add debug writes to verify the top-of-OpSyscall intercept fires."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

# Add debug right after the execve intercept's return
c = c.replace(
    '    // Intercept execve (0x3B): posix_spawn child, restore, return to parent\n    if (_sysnum == 0x3B) {',
    '    // Intercept execve (0x3B)\n    if (_sysnum == 0x3B) {\n      write(2, "EXEC-TOP\\n", 9);'
)

# Add debug right after the exit intercept's return
c = c.replace(
    '    // Intercept exit/exit_group (0x3C, 0xE7): builtin command finished\n    if (_sysnum == 0x3C || _sysnum == 0xE7) {',
    '    // Intercept exit/exit_group\n    if (_sysnum == 0x3C || _sysnum == 0xE7) {\n      write(2, "EXIT-TOP\\n", 9);'
)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Added debug markers to top-of-OpSyscall intercepts')
