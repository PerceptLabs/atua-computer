#!/usr/bin/env python3
"""Add debug to LoaderCopy in loader.c to find the hang."""

with open('/home/ubuntu/blink/blink/loader.c') as f:
    c = f.read()

# Add markers around the key operations in LoaderCopy
# Before: unassert(!CopyToUser(m, vaddr, ...));
c = c.replace(
    '  unassert(!CopyToUser(m, vaddr, (u8 *)image + offset, amt));',
    '  { char _x[] = {67,84,85,10}; write(2,_x,4); }\n'  # "CTU\n"
    '  unassert(!CopyToUser(m, vaddr, (u8 *)image + offset, amt));\n'
    '  { char _x[] = {67,84,68,10}; write(2,_x,4); }'  # "CTD\n"
)

# Before first ProtectVirtual
c = c.replace(
    '    unassert(!ProtectVirtual(m->system, base, vaddr + amt - base,\n'
    '                             PROT_READ | PROT_WRITE, false));',
    '    { char _x[] = {80,86,49,10}; write(2,_x,4); }\n'  # "PV1\n"
    '    unassert(!ProtectVirtual(m->system, base, vaddr + amt - base,\n'
    '                             PROT_READ | PROT_WRITE, false));\n'
    '    { char _x[] = {80,68,49,10}; write(2,_x,4); }'  # "PD1\n"
)

# Before second ProtectVirtual (restore protection)
c = c.replace(
    '    unassert(!ProtectVirtual(m->system, base, vaddr + amt - base, prot, false));',
    '    { char _x[] = {80,86,50,10}; write(2,_x,4); }\n'  # "PV2\n"
    '    unassert(!ProtectVirtual(m->system, base, vaddr + amt - base, prot, false));\n'
    '    { char _x[] = {80,68,50,10}; write(2,_x,4); }'  # "PD2\n"
)

with open('/home/ubuntu/blink/blink/loader.c', 'w') as f:
    f.write(c)

print('Patched LoaderCopy with debug')
