#!/usr/bin/env python3
"""Add debug to SysOpenat to show prefixed paths."""

with open('/home/ubuntu/blink/blink/open.c') as f:
    c = f.read()

old = '  RESTARTABLE(fildes = VfsOpen(GetDirFildes(dirfildes), path, sysflags, mode));'
new = '''  { char _b[256]; int _n = snprintf(_b, sizeof(_b), "OPEN:%s\\n", path); write(2, _b, _n); }
  RESTARTABLE(fildes = VfsOpen(GetDirFildes(dirfildes), path, sysflags, mode));'''

c = c.replace(old, new, 1)

if '#include <unistd.h>' not in c[:2000]:
    c = c.replace('#include <errno.h>', '#include <errno.h>\n#include <unistd.h>', 1)

with open('/home/ubuntu/blink/blink/open.c', 'w') as f:
    f.write(c)

print('Added OPEN debug')
