#!/usr/bin/env python3
"""Add loop entry marker to the page processing loop in memorymalloc.c."""

with open('/home/ubuntu/blink/blink/memorymalloc.c') as f:
    c = f.read()

# Add a write after the u64 real declaration in the inner for(;;) loop
old = '      for (;;) {\n        u64 real;\n'
new = '      for (;;) {\n        u64 real;\n        { char _m[] = {76, 10}; write(2, _m, 2); }\n'
# 76 = 'L', 10 = newline

c = c.replace(old, new, 1)

with open('/home/ubuntu/blink/blink/memorymalloc.c', 'w') as f:
    f.write(c)

print('Added L marker')
