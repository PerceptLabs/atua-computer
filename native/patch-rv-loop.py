#!/usr/bin/env python3
"""Add debug to the inner loop of ReserveVirtual to track page processing."""

with open('/home/ubuntu/blink/blink/memorymalloc.c') as f:
    c = f.read()

# Add include for write()
if '#include <unistd.h>' not in c[:3000]:
    c = c.replace('#include <string.h>', '#include <string.h>\n#include <unistd.h>', 1)

# Add counter at the inner loop progression point
# After: if ((virt += 4096) >= end) {
c = c.replace(
    '        if ((virt += 4096) >= end) {',
    '        { static int _pg = 0; ++_pg;\n'
    '          if (_pg <= 3 || _pg % 100 == 0) {\n'
    '            char _b[32]; int _n = 0;\n'
    '            _b[_n++] = \'P\'; _b[_n++] = \'G\'; _b[_n++] = \':\';\n'
    '            if (_pg >= 1000) _b[_n++] = \'0\' + (_pg/1000)%10;\n'
    '            if (_pg >= 100) _b[_n++] = \'0\' + (_pg/100)%10;\n'
    '            if (_pg >= 10) _b[_n++] = \'0\' + (_pg/10)%10;\n'
    '            _b[_n++] = \'0\' + _pg%10;\n'
    '            _b[_n++] = \'\\n\';\n'
    '            write(2, _b, _n);\n'
    '          }\n'
    '        }\n'
    '        if ((virt += 4096) >= end) {'
)

with open('/home/ubuntu/blink/blink/memorymalloc.c', 'w') as f:
    f.write(c)

print('Patched memorymalloc.c with page counter')
