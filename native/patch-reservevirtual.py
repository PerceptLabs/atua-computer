#!/usr/bin/env python3
"""Add debug to ReserveVirtual in memorymalloc.c to find the hang."""

with open('/home/ubuntu/blink/blink/memorymalloc.c') as f:
    c = f.read()

# Add debug at the start of ReserveVirtual
c = c.replace(
    '  MEM_LOGF("ReserveVirtual(%#" PRIx64 ", %#" PRIx64 ", %s)", virt, size,\n           DescribeProt(prot));',
    '  MEM_LOGF("ReserveVirtual(%#" PRIx64 ", %#" PRIx64 ", %s)", virt, size,\n           DescribeProt(prot));\n  write(2, "RV:start\\n", 9);'
)

# Debug before RemoveVirtual
c = c.replace(
    '    RemoveVirtual(s, virt, size, &ranges,',
    '    write(2, "RV:rmv\\n", 7);\n    RemoveVirtual(s, virt, size, &ranges,'
)

# Debug before the page table walk loop
c = c.replace(
    '  // add pml4t entries ensuring intermediary tables exist\n  for (result = virt, end = virt + size;;) {',
    '  // add pml4t entries ensuring intermediary tables exist\n  write(2, "RV:ptwalk\\n", 10);\n  for (result = virt, end = virt + size;;) {'
)

# Debug before AllocateBig in the MUG path
c = c.replace(
    '            mug = AllocateBig(mugsize, sysprot, mugflags, fd, mugoff);',
    '            write(2, "RV:mug\\n", 7);\n            mug = AllocateBig(mugsize, sysprot, mugflags, fd, mugoff);'
)

# Debug after TrackHostPage
c = c.replace(
    '            real = TrackHostPage(mug + mugskew);',
    '            real = TrackHostPage(mug + mugskew);\n            write(2, "RV:trk\\n", 7);'
)

# Make sure unistd.h is included
if '#include <unistd.h>' not in c[:3000]:
    c = c.replace('#include <string.h>', '#include <string.h>\n#include <unistd.h>', 1)

with open('/home/ubuntu/blink/blink/memorymalloc.c', 'w') as f:
    f.write(c)

print('Patched memorymalloc.c')
