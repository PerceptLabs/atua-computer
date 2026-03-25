#!/usr/bin/env python3
"""Patch vfs.h to use free() for VfsMunmap on WASI."""

VFS_FILE = '/home/ubuntu/blink/blink/vfs.h'

with open(VFS_FILE) as f:
    c = f.read()

# Replace both occurrences of: #define VfsMunmap      munmap
# With: #ifdef __wasi__\n#define VfsMunmap(a,l) (free(a),0)\n#else\n#define VfsMunmap munmap\n#endif
old = '#define VfsMunmap      munmap'
new = '#ifdef __wasi__\n#define VfsMunmap(a,l) (free(a),0)\n#else\n#define VfsMunmap      munmap\n#endif'

c = c.replace(old, new)

with open(VFS_FILE, 'w') as f:
    f.write(c)

print('Patched vfs.h: VfsMunmap uses free() on __wasi__')
