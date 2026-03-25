#!/usr/bin/env python3
"""Simplify vfork exit handler: no posix_spawn, just restore + return."""

import re

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

# Replace exit handler with minimal version
old = '''    if (m->system->isfork && (_sysnum == 0x3C || _sysnum == 0xE7)) {
      int _rc = (int)Get64(m->di);
      const char *_eng = getenv("BLINK_WASM_SELF");
      if (!_eng) _eng = "/engine/engine-wasix.wasm";
      pid_t _dummy = 0;
      char *_da[] = {(char*)_eng, "/rootfs/bin/busybox.static", "true", NULL};
      posix_spawn(&_dummy, _eng, NULL, NULL, _da, environ);
      RestoreFds(&m->system->fds);
      m->system->isfork = false;
      m->ip = g_vfork_rip;
      Put64(m->ax, _dummy > 0 ? _dummy : 1);
      return;  // legal: OpSyscall is not _Noreturn
    }'''

new = '''    if (m->system->isfork && (_sysnum == 0x3C || _sysnum == 0xE7)) {
      // Vfork child exit: restore parent state, return fake PID
      RestoreFds(&m->system->fds);
      m->system->isfork = false;
      m->ip = g_vfork_rip;
      Put64(m->ax, 99);  // fake PID
      return;
    }'''

c = c.replace(old, new, 1)

# Remove FORK-IP debug print from SysFork
c = re.sub(r'  \{ char b\[80\].*?write\(2, b, n\); \}\n', '', c)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Simplified exit handler + removed debug')
