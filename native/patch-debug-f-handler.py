#!/usr/bin/env python3
"""Add debug to the -F handler in blink.c to trace child startup."""

with open('/home/ubuntu/blink/blink/blink.c') as f:
    c = f.read()

c = c.replace(
    '  if (FLAG_restore_fork) {\n    extern int DeserializeForkState',
    '  if (FLAG_restore_fork) {\n    write(1, "CHILD-F:", 8); write(1, FLAG_restore_fork, strlen(FLAG_restore_fork)); write(1, "\\n", 1);\n    extern int DeserializeForkState'
)

with open('/home/ubuntu/blink/blink/blink.c', 'w') as f:
    f.write(c)

print('Added CHILD-F debug')
