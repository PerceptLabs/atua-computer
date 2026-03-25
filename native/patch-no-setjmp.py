#!/usr/bin/env python3
"""Bypass setjmp in Blink() on WASI since WASIX setjmp is broken.

On WASI, setjmp crashes (exit 79). Since we have no real signal
handling and no threads, we can call Actor(m) directly. Fatal
errors in the interpreter will abort instead of longjmp-recovering.
"""

with open('/home/ubuntu/blink/blink/machine.c') as f:
    c = f.read()

old = '''void Blink(struct Machine *m) {
  int rc;
  for (;;) {
    if (!(rc = sigsetjmp(m->onhalt, 1))) {
      m->canhalt = true;
      Actor(m);
    }
    m->sysdepth = 0;
    m->sigdepth = 0;
    m->canhalt = false;
    m->nofault = false;
    m->insyscall = false;
    CollectPageLocks(m);
    CollectGarbage(m, 0);
    if (IsMakingPath(m)) {
      AbandonPath(m);
    }
    if (rc == kMachineFatalSystemSignal) {
      HandleFatalSystemSignal(m, &g_siginfo);
    }
  }
}'''

new = '''void Blink(struct Machine *m) {
#if defined(__wasi__)
  // WASI: setjmp is broken (wasmer doesn't implement stack_checkpoint).
  // Call Actor directly. Fatal errors will abort instead of recovering.
  m->canhalt = true;
  Actor(m);
#else
  int rc;
  for (;;) {
    if (!(rc = sigsetjmp(m->onhalt, 1))) {
      m->canhalt = true;
      Actor(m);
    }
    m->sysdepth = 0;
    m->sigdepth = 0;
    m->canhalt = false;
    m->nofault = false;
    m->insyscall = false;
    CollectPageLocks(m);
    CollectGarbage(m, 0);
    if (IsMakingPath(m)) {
      AbandonPath(m);
    }
    if (rc == kMachineFatalSystemSignal) {
      HandleFatalSystemSignal(m, &g_siginfo);
    }
  }
#endif
}'''

c = c.replace(old, new, 1)

with open('/home/ubuntu/blink/blink/machine.c', 'w') as f:
    f.write(c)

print('Patched Blink(): bypass setjmp on WASI')
