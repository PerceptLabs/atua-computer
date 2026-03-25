#!/usr/bin/env python3
"""Add deep debug to Blink's loader.c to find the exact hang point."""

with open('/home/ubuntu/blink/blink/loader.c') as f:
    c = f.read()

# Add debug after "ALL-OK" (the mmap succeeded)
c = c.replace(
    'else { write(2, "ALL-OK\\n", 7); }',
    'else { write(2, "ALL-OK\\n", 7); }'
)

# Add debug before CanEmulateData
c = c.replace(
    '    status = CanEmulateData(m, &prog, &args, isfirst, (char *)map, mapsize);',
    '    write(2, "DBG:ced\\n", 8);\n    status = CanEmulateData(m, &prog, &args, isfirst, (char *)map, mapsize);\n    write(2, "DBG:ced-done\\n", 13);'
)

# Add debug before ResetCpu
c = c.replace(
    '  ResetCpu(m);',
    '  write(2, "DBG:reset\\n", 10);\n  ResetCpu(m);'
)

# Add debug before ReserveVirtual calls in LoadElf
# Find the first ReserveVirtual in the ELF loader
c = c.replace(
    '      if (ReserveVirtual(s, start, bulk, key, fd, offset, 0, 0) == -1) {',
    '      write(2, "DBG:rv1\\n", 8);\n      if (ReserveVirtual(s, start, bulk, key, fd, offset, 0, 0) == -1) {'
)

# Find the second ReserveVirtual (BSS)
c = c.replace(
    '      if (ReserveVirtual(s, start, end - start, key, -1, 0, 0, 0) == -1) {',
    '      write(2, "DBG:rv2\\n", 8);\n      if (ReserveVirtual(s, start, end - start, key, -1, 0, 0, 0) == -1) {'
)

# Add debug before stack allocation
c = c.replace(
    '    if ((stack = ReserveVirtual(',
    '    write(2, "DBG:stack\\n", 10);\n    if ((stack = ReserveVirtual('
)

# Make sure unistd.h is included for write()
if '#include <unistd.h>' not in c[:3000]:
    c = c.replace('#include <string.h>', '#include <string.h>\n#include <unistd.h>', 1)

with open('/home/ubuntu/blink/blink/loader.c', 'w') as f:
    f.write(c)

# Verify
with open('/home/ubuntu/blink/blink/loader.c') as f:
    for n, l in enumerate(f, 1):
        if 'DBG:' in l:
            print(f'{n}: {l.rstrip()}')
