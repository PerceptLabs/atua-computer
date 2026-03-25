#!/usr/bin/env python3
"""Add debug to print m->ip at SysFork time."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

old = '''  g_vfork_rip = m->ip;  // Return address (IP already advanced past SYSCALL)
  m->system->isfork = true;
  return 0;'''

new = '''  g_vfork_rip = m->ip;
  { char b[80]; int n = snprintf(b, 80, "FORK-IP:%lx CS:%lx\\n", (long)m->ip, (long)m->cs.base); write(2, b, n); }
  m->system->isfork = true;
  return 0;'''

c = c.replace(old, new, 1)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Added FORK-IP debug')
