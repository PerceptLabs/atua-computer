#!/usr/bin/env python3
"""Add debug to SysWrite and Blink() to diagnose fd routing."""

# Patch blink.c: add host write before interpreter loop
with open('/home/ubuntu/blink/blink/blink.c') as f:
    c = f.read()

c = c.replace(
    '  Blink(m);\n}',
    '  write(1, "HOST-OK\\n", 8);\n  Blink(m);\n}'
)

if '#include <unistd.h>' not in c[:2000]:
    c = '#include <unistd.h>\n' + c

with open('/home/ubuntu/blink/blink/blink.c', 'w') as f:
    f.write(c)

print('Patched blink.c: host write before interpreter')

# Patch syscall.c: add debug to SysWrite
with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

old = '  if (!fd) return -1;'
# Only replace the one in SysWrite (first occurrence after SysWrite definition)
idx = c.find('static i64 SysWrite')
if idx >= 0:
    idx2 = c.find(old, idx)
    if idx2 >= 0:
        new = '  if (!fd) { char _d[] = {87,78,70,10}; write(2, _d, 4); return -1; }\n  { char _d[] = {87,79,75,10}; write(2, _d, 4); }'
        # WNF = Write No Fd, WOK = Write OK
        c = c[:idx2] + new + c[idx2 + len(old):]

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Patched syscall.c: SysWrite debug')
