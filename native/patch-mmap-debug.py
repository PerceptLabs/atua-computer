#!/usr/bin/env python3
"""Add debug to the WASI Mmap path in map.c."""

with open('/home/ubuntu/blink/blink/map.c') as f:
    c = f.read()

# Find our WASI Mmap patch and add debug
old = '''#if defined(__wasi__)
  // WASI: use malloc for anonymous mappings, read() for file-backed
  if (fd == -1 || (flags & MAP_ANONYMOUS_)) {
    res = malloc(length);
    if (res) memset(res, 0, length);
    else res = MAP_FAILED;
  } else {
    res = malloc(length);
    if (res) {
      if (lseek(fd, offset, SEEK_SET) == -1 ||
          (size_t)read(fd, res, length) != length) {
        free(res);
        res = MAP_FAILED;
      }
    } else {
      res = MAP_FAILED;
    }
  }
  return res;
#endif'''

new = '''#if defined(__wasi__)
  // WASI: use malloc for anonymous mappings, read() for file-backed
  if (fd == -1 || (flags & MAP_ANONYMOUS_)) {
    res = malloc(length);
    if (res) memset(res, 0, length);
    else { write(2, "MMAP:anon-fail\\n", 15); res = MAP_FAILED; }
  } else {
    res = malloc(length);
    if (res) {
      write(2, "MMAP:file-read\\n", 15);
      off_t seekr = lseek(fd, offset, SEEK_SET);
      if (seekr == -1) {
        write(2, "MMAP:seek-fail\\n", 15);
        free(res);
        res = MAP_FAILED;
      } else {
        ssize_t nr = read(fd, res, length);
        if ((size_t)nr != length) {
          write(2, "MMAP:read-fail\\n", 15);
          free(res);
          res = MAP_FAILED;
        }
      }
    } else {
      write(2, "MMAP:malloc-fail\\n", 17);
      res = MAP_FAILED;
    }
  }
  return res;
#endif'''

if old in c:
    c = c.replace(old, new)
    with open('/home/ubuntu/blink/blink/map.c', 'w') as f:
        f.write(c)
    print('Patched map.c Mmap with debug')
else:
    print('ERROR: Could not find WASI Mmap patch to add debug to')
