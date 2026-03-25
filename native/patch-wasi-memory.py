#!/usr/bin/env python3
"""Patch Blink map.c for WASI memory management.

On WASI, real mmap/munmap don't exist. This patch:
1. Replaces Mmap() with aligned_alloc (page-aligned) + read() for file-backed
2. Replaces Munmap() with free()
3. Adds __wasi__ guards to GetSystemPageSize and GetBitsInAddressSpace
"""

MAP_FILE = '/home/ubuntu/blink/blink/map.c'

with open(MAP_FILE) as f:
    c = f.read()

# === 1. Add __wasi__ to GetSystemPageSize ===
c = c.replace(
    '#ifdef __EMSCRIPTEN__\n  // "pages" in Emscripten',
    '#if defined(__EMSCRIPTEN__) || defined(__wasi__)\n  // "pages" in Emscripten/WASI'
)

# === 2. Add __wasi__ to GetBitsInAddressSpace ===
c = c.replace(
    'static int GetBitsInAddressSpace(void) {\n#ifdef __EMSCRIPTEN__\n  return 32;',
    'static int GetBitsInAddressSpace(void) {\n#if defined(__EMSCRIPTEN__) || defined(__wasi__)\n  return 32;'
)

# === 3. Replace Mmap with aligned_alloc on WASI ===
old_mmap_sig = 'void *Mmap(void *addr,     //\n           size_t length,  //\n           int prot,       //\n           int flags,      //\n           int fd,         //\n           off_t offset,   //\n           const char *owner) {\n  void *res;'

new_mmap_sig = '''void *Mmap(void *addr,     //
           size_t length,  //
           int prot,       //
           int flags,      //
           int fd,         //
           off_t offset,   //
           const char *owner) {
  void *res;
#if defined(__wasi__)
  {
    // WASI: use aligned_alloc for page-aligned allocations
    size_t al = (length + 4095) & ~(size_t)4095;
    if (al < 4096) al = 4096;
    if (fd == -1 || (flags & MAP_ANONYMOUS_)) {
      res = aligned_alloc(4096, al);
      if (res) memset(res, 0, al);
      else res = MAP_FAILED;
    } else {
      res = aligned_alloc(4096, al);
      if (res) {
        memset(res, 0, al);
        if (lseek(fd, offset, SEEK_SET) == (off_t)-1) {
          free(res); res = MAP_FAILED;
        } else {
          ssize_t nr = read(fd, res, length);
          if (nr < 0) { free(res); res = MAP_FAILED; }
        }
      } else {
        res = MAP_FAILED;
      }
    }
    return res;
  }
#endif'''

c = c.replace(old_mmap_sig, new_mmap_sig, 1)

# === 4. Replace Munmap with free on WASI ===
old_munmap = 'int Munmap(void *addr, size_t length) {'
new_munmap = '''int Munmap(void *addr, size_t length) {
#if defined(__wasi__)
  free(addr);
  return 0;
#endif'''
c = c.replace(old_munmap, new_munmap, 1)

with open(MAP_FILE, 'w') as f:
    f.write(c)

print('Patched map.c: aligned_alloc Mmap, free Munmap, __wasi__ guards')
