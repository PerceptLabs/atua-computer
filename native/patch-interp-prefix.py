#!/usr/bin/env python3
"""Patch Blink's ELF loader to prepend BLINK_PREFIX to PT_INTERP path.

On WASI, the rootfs is mounted at /rootfs but PT_INTERP in ELF binaries
says /lib/ld-musl-x86_64.so.1 (absolute path without prefix). This patch
reads BLINK_PREFIX env var and prepends it to the interpreter path.
"""

LOADER = '/home/ubuntu/blink/blink/loader.c'

with open(LOADER) as f:
    c = f.read()

old = '    if ((fd = VfsOpen(AT_FDCWD, elf->interpreter, O_RDONLY, 0)) == -1 ||'

new = '''    // WASI: prepend BLINK_PREFIX to interpreter path for dynamic linker resolution
    char *interp_path = elf->interpreter;
#ifdef __wasi__
    char interp_buf[4096];
    {
      const char *prefix = getenv("BLINK_PREFIX");
      if (prefix && interp_path[0] == '/') {
        snprintf(interp_buf, sizeof(interp_buf), "%s%s", prefix, interp_path);
        interp_path = interp_buf;
      }
    }
#endif
    if ((fd = VfsOpen(AT_FDCWD, interp_path, O_RDONLY, 0)) == -1 ||'''

c = c.replace(old, new, 1)

with open(LOADER, 'w') as f:
    f.write(c)

print('Patched loader.c: PT_INTERP prefix resolution via BLINK_PREFIX')
