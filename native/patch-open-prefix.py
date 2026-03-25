#!/usr/bin/env python3
"""Patch SysOpenat to prepend BLINK_PREFIX to all absolute guest paths.

The musl dynamic linker searches /lib and /usr/lib for shared libraries.
With the rootfs at /rootfs, these paths don't exist. Rather than only
fixing PT_INTERP, prefix ALL guest absolute path operations so the
guest sees / as /rootfs.
"""

with open('/home/ubuntu/blink/blink/open.c') as f:
    c = f.read()

# Add BLINK_PREFIX to SysOpenat for all absolute paths
old = '  if (!(path = LoadStr(m, pathaddr))) return -1;\n  RESTARTABLE(fildes = VfsOpen(GetDirFildes(dirfildes), path, sysflags, mode));'

new = '''  if (!(path = LoadStr(m, pathaddr))) return -1;
#ifdef __wasi__
  char prefixed_path[4096];
  {
    const char *prefix = getenv("BLINK_PREFIX");
    if (prefix && path[0] == '/' && dirfildes == AT_FDCWD_LINUX) {
      snprintf(prefixed_path, sizeof(prefixed_path), "%s%s", prefix, path);
      path = prefixed_path;
    }
  }
#endif
  RESTARTABLE(fildes = VfsOpen(GetDirFildes(dirfildes), path, sysflags, mode));'''

c = c.replace(old, new, 1)

with open('/home/ubuntu/blink/blink/open.c', 'w') as f:
    f.write(c)

print('Patched open.c: BLINK_PREFIX applied to all absolute guest paths')
