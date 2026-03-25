#!/usr/bin/env python3
"""Add instruction counter to Blink's execution loop for debugging."""

with open('/home/ubuntu/blink/blink/machine.c') as f:
    c = f.read()

old = '      ExecuteInstruction(m);\n    } else {'

new = '''      ExecuteInstruction(m);
      { static long _ic = 0; ++_ic;
        if (_ic == 1) { char m[] = "EXEC:1\\n"; write(2, m, 7); }
        if (_ic == 100) { char m[] = "EXEC:100\\n"; write(2, m, 9); }
        if (_ic == 10000) { char m[] = "EXEC:10K\\n"; write(2, m, 9); }
        if (_ic == 1000000) { char m[] = "EXEC:1M\\n"; write(2, m, 8); }
      }
    } else {'''

c = c.replace(old, new, 1)

# Add #include <unistd.h> at top if not present
if '#include <unistd.h>' not in c:
    c = c.replace('#include <errno.h>', '#include <errno.h>\n#include <unistd.h>', 1)

with open('/home/ubuntu/blink/blink/machine.c', 'w') as f:
    f.write(c)

print('Patched machine.c')
