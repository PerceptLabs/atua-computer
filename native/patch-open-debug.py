#!/usr/bin/env python3
"""Add debug output to SysOpenat to trace fd allocation."""

with open('/home/ubuntu/blink/blink/open.c') as f:
    c = f.read()

old = '  RESTARTABLE(fildes = VfsOpen(GetDirFildes(dirfildes), path, sysflags, mode));'
new = '''  RESTARTABLE(fildes = VfsOpen(GetDirFildes(dirfildes), path, sysflags, mode));
  { char _b[256]; int _n = snprintf(_b, sizeof(_b), "OPEN:%s fd=%d\\n", path, fildes); write(2, _b, _n); }'''

c = c.replace(old, new, 1)

if '#include <unistd.h>' not in c[:2000]:
    c = c.replace('#include <errno.h>', '#include <errno.h>\n#include <unistd.h>', 1)

with open('/home/ubuntu/blink/blink/open.c', 'w') as f:
    f.write(c)

print('Added debug to SysOpenat')
