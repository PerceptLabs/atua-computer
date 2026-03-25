#!/usr/bin/env python3
"""Add instruction counter to Actor() loop in machine.c."""

with open('/home/ubuntu/blink/blink/machine.c') as f:
    c = f.read()

# Add counter and periodic debug write
old = '''      ExecuteInstruction(m);
    } else {
      CheckForSignals(m);'''

new = '''      ExecuteInstruction(m);
      { static long _ic = 0; ++_ic;
        if (_ic == 1 || _ic == 10 || _ic == 100 || _ic == 1000 || _ic == 10000) {
          char b[20]; int n = 0;
          b[n++] = 'I'; b[n++] = ':';
          long v = _ic; int d = 0; char t[10];
          do { t[d++] = '0' + v % 10; v /= 10; } while (v);
          while (d--) b[n++] = t[d];
          b[n++] = 10;
          write(2, b, n);
        }
      }
    } else {
      CheckForSignals(m);'''

c = c.replace(old, new, 1)

if '#include <unistd.h>' not in c[:2000]:
    c = '#include <unistd.h>\n' + c

with open('/home/ubuntu/blink/blink/machine.c', 'w') as f:
    f.write(c)

print('Patched machine.c with instruction counter')
