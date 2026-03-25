#!/usr/bin/env python3
"""Debug: print m->ip at key points around the OpSyscall return."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

# Add debug BEFORE the return in the execve intercept
c = c.replace(
    '      return;  // return from OpSyscall — interpreter resumes at g_vfork_rip\n    }\n\n    // Intercept exit',
    '      { char _z[80]; snprintf(_z, 80, "PRE-RET ip=%lx ax=%lx\\n", (long)m->ip, (long)Get64(m->ax)); write(2, _z, strlen(_z)); }\n      return;\n    }\n\n    // Intercept exit'
)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Added PRE-RET debug')
