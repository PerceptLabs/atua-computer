#!/usr/bin/env python3
"""Minimal test: SysFork saves RIP, SysExecve just restores and returns.
No posix_spawn, no RestoreFds. Just test if m->ip restore works."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

# Replace SysExecve's vfork path with minimal restore
old = '''  if (m->system->isfork) {
    // WASI fork+exec fast path: use posix_spawn to create a new
    // engine process running the target binary.'''

new = '''  if (m->system->isfork) {
    // MINIMAL TEST: just restore RIP and return
    m->system->isfork = false;
    m->ip = g_vfork_rip;
    Put64(m->ax, 99);
    m->interrupted = true;
    return 0;
#if 0
    // WASI fork+exec fast path: use posix_spawn to create a new
    // engine process running the target binary.'''

c = c.replace(old, new, 1)

# Find the end of the isfork block and add #endif
# The block ends with: return -1; } #endif
c = c.replace(
    '    return -1;\n  }\n#endif\n  LOCK(&m->system->exec_lock);',
    '    return -1;\n  }\n#endif\n#endif\n  LOCK(&m->system->exec_lock);'
)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Minimal return test applied')
