#!/usr/bin/env python3
"""Fix: set m->system->exec = Exec in the -F restore path.

The Exec function pointer is not serialized (it's a host pointer).
Need to set it after deserialization so ExecveBlink works in the child.
"""

with open('/home/ubuntu/blink/blink/blink.c') as f:
    c = f.read()

c = c.replace(
    '    DeserializeForkState(fm, fbuf, flen);\n    free(fbuf);\n    Put64(fm->ax, 0);',
    '    DeserializeForkState(fm, fbuf, flen);\n    free(fbuf);\n    fm->system->exec = Exec;  // function pointer not serialized\n    Put64(fm->ax, 0);'
)

with open('/home/ubuntu/blink/blink/blink.c', 'w') as f:
    f.write(c)

print('Fixed: set exec function pointer in -F restore path')
