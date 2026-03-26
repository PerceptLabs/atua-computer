#!/usr/bin/env python3
"""Use unique fork state file paths (counter-based)."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

c = c.replace(
    '  snprintf(path, sizeof(path), "/rootfs/tmp/fork-%d", getpid());',
    '  { static int fork_counter = 0;\n  snprintf(path, sizeof(path), "/rootfs/tmp/fork-%d-%d", getpid(), fork_counter++); }'
)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Unique fork paths')
