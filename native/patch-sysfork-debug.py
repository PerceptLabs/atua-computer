#!/usr/bin/env python3
"""Add debug to SysFork to trace serialization."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

old = '  WriteForkFile(path, buf, len);'
new = '''  int wret = WriteForkFile(path, buf, len);
  { char d[80]; snprintf(d, 80, "FORK-W:%s r=%d l=%zu\\n", path, wret, len); write(2, d, strlen(d)); }'''

c = c.replace(old, new, 1)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Added SysFork write debug')
