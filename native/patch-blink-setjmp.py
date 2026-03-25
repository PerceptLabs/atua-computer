#!/usr/bin/env python3
"""Add debug to Blink() to check setjmp return value."""

with open('/home/ubuntu/blink/blink/machine.c') as f:
    c = f.read()

old = '''void Blink(struct Machine *m) {
  int rc;
  for (;;) {
    if (!(rc = sigsetjmp(m->onhalt, 1))) {
      m->canhalt = true;
      Actor(m);
    }'''

new = '''void Blink(struct Machine *m) {
  int rc;
  { char b[] = {66,76,75,10}; write(2, b, 4); }
  for (;;) {
    rc = sigsetjmp(m->onhalt, 1);
    { char b[16]; int n = 0;
      b[n++] = 'J'; b[n++] = ':';
      if (rc < 0) { b[n++] = '-'; rc = -rc; }
      if (rc >= 100) b[n++] = '0' + (rc/100)%10;
      if (rc >= 10) b[n++] = '0' + (rc/10)%10;
      b[n++] = '0' + rc%10;
      b[n++] = 10;
      write(2, b, n);
    }
    if (!rc) {
      m->canhalt = true;
      Actor(m);
    }'''

c = c.replace(old, new, 1)

if '#include <unistd.h>' not in c[:2000]:
    c = '#include <unistd.h>\n' + c

with open('/home/ubuntu/blink/blink/machine.c', 'w') as f:
    f.write(c)

print('Patched Blink() with setjmp debug')
