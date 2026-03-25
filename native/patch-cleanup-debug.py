#!/usr/bin/env python3
"""Remove broken debug lines from syscall.c."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    lines = f.readlines()

# Remove lines containing the broken debug pattern
cleaned = []
skip_next = False
for i, line in enumerate(lines):
    if skip_next:
        skip_next = False
        continue
    # Skip the broken snprintf debug lines (have literal newlines in strings)
    if 'SAVED-RIP:' in line or 'VFORK-EXIT' in line:
        # Also skip the next line if it's part of the broken string
        if i + 1 < len(lines) and ('write(2, b, n)' in lines[i+1] or lines[i+1].strip().startswith('"')):
            skip_next = True
        continue
    # Skip continuation lines of broken strings
    if line.strip().startswith('", ') and ('g_vfork_rip' in line or 'write(2' in line):
        continue
    cleaned.append(line)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.writelines(cleaned)

print(f'Cleaned: removed broken debug lines ({len(lines) - len(cleaned)} lines removed)')
