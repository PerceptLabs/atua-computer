#!/usr/bin/env python3
"""Add debug output to Blink's loader.c for diagnosing WASI file open failures."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else '/home/ubuntu/blink/blink/loader.c'

with open(path) as f:
    content = f.read()

# Add debug write after SYS_LOGF line
marker1 = 'SYS_LOGF("LoadProgram %s", prog);'
debug1 = marker1 + '\n    write(2, "BLINK-DBG: LoadProgram reached\\n", 31);'
content = content.replace(marker1, debug1, 1)

# Add debug write before the error message
marker2 = '      WriteErrorString(prog);'
# Only replace the one inside the load failure block (around line 729)
idx = content.find(marker2)
if idx >= 0:
    debug2 = '      write(2, "BLINK-DBG: open/fstat/mmap failed\\n", 35);\n' + marker2
    content = content[:idx] + debug2 + content[idx + len(marker2):]

with open(path, 'w') as f:
    f.write(content)

print('Patched loader.c with debug output')
