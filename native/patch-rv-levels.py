#!/usr/bin/env python3
"""Add debug inside the page table level walk."""

with open('/home/ubuntu/blink/blink/memorymalloc.c') as f:
    c = f.read()

# Find the level walk and add debug
# The pattern: for (pt = s->cr3, level = 39; level >= 12; level -= 9) {
#   ti = (virt >> level) & 511;
#   mi = GetPageAddress(s, pt, level == 39) + ti * 8;
c = c.replace(
    '      mi = GetPageAddress(s, pt, level == 39) + ti * 8;',
    '      mi = GetPageAddress(s, pt, level == 39) + ti * 8;\n'
    '      if (!mi && level > 12) { write(2, "RV:mi-null\\n", 11); }'
)

# Add debug before AllocatePageTable
c = c.replace(
    '          if ((pt = AllocatePageTable(s)) == -1) {',
    '          write(2, "RV:apt\\n", 7);\n          if ((pt = AllocatePageTable(s)) == -1) {'
)

with open('/home/ubuntu/blink/blink/memorymalloc.c', 'w') as f:
    f.write(c)

print('Patched level walk debug')
