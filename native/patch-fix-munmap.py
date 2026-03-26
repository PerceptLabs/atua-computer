#!/usr/bin/env python3
"""Fix: WASI Munmap should only free() pointers from g_hostpages.

The non-linear path calls Munmap(ToHost(guest_addr)) where ToHost
casts a guest virtual address to a host pointer. On WASI, Munmap
calls free() on this pointer — but it's not from malloc. This
corrupts the allocator.

Fix: check if the pointer is in g_hostpages before freeing.
If not, it's a guest virtual address cast to host — ignore it.
"""

with open('/home/ubuntu/blink/blink/map.c') as f:
    c = f.read()

import re

# Find our WASI Munmap
old = re.search(r'int Munmap\(void \*addr, size_t length\) \{\n#if defined\(__wasi__\)\n  free\(addr\);\n  return 0;\n#endif', c)
if old:
    new_munmap = '''int Munmap(void *addr, size_t length) {
#if defined(__wasi__)
  // Only free() pointers that came from our aligned_alloc (in g_hostpages).
  // ToHost(guest_addr) produces pointers that are NOT from malloc — skip those.
  {
    size_t i;
    for (i = 0; i < g_hostpages.n; i++) {
      if (g_hostpages.p[i] == (u8 *)addr) {
        free(addr);
        return 0;
      }
    }
    // Not a g_hostpages pointer — probably ToHost(guest_vaddr). Don't free.
    return 0;
  }
#endif'''
    c = c[:old.start()] + new_munmap + c[old.end():]

with open('/home/ubuntu/blink/blink/map.c', 'w') as f:
    f.write(c)

print('Fixed: Munmap only frees g_hostpages pointers on WASI')
