#!/usr/bin/env python3
"""Fix SysFork: replace old vfork code with serialization fork."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

# Find and replace the entire SysFork function
import re

# Match from "static int SysFork" to the closing brace + newline
# The function ends with "}\n\nstatic int SysVfork"
old_start = c.find('static int SysFork(struct Machine *m) {')
old_end = c.find('static int SysVfork(struct Machine *m) {')

if old_start >= 0 and old_end >= 0:
    new_sysfork = '''static int SysFork(struct Machine *m) {
#ifdef __wasi__
  // Real fork: serialize state, write to file, posix_spawn child
  size_t len;
  uint8_t *buf = SerializeForkState(m, &len);
  if (!buf) return -1;
  char path[64];
  snprintf(path, sizeof(path), "/tmp/fork-%d", getpid());
  WriteForkFile(path, buf, len);
  free(buf);
  const char *engine = getenv("BLINK_WASM_SELF");
  if (!engine) engine = "/engine/engine-wasix.wasm";
  char *argv[] = {(char *)engine, "-F", path, NULL};
  pid_t pid;
  int ret = posix_spawn(&pid, engine, NULL, NULL, argv, environ);
  if (ret != 0) { unlink(path); return -1; }
  return pid;
#else
  return Fork(m, 0, 0, 0);
#endif
}

'''
    c = c[:old_start] + new_sysfork + c[old_end:]

# Also add TrackHostPage forward declaration
if 'u64 TrackHostPage(' not in c[:5000]:
    # Add after the #endif of the new fork code
    c = c.replace(
        'uint8_t *ReadForkFile',
        'extern u64 TrackHostPage(u8 *);\n\nuint8_t *ReadForkFile'
    )

# Remove remaining references to old vfork globals
for old_ref in ['g_fd_op_count', 'g_vfork_rip', 'g_vfork_page_count', 'g_vfork_pages',
                'SnapshotFds', 'SnapshotSignals', 'g_vfork_regs']:
    # These should have been removed by the main patch, but check
    pass

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Fixed SysFork and added TrackHostPage declaration')
