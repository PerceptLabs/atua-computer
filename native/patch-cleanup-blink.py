#!/usr/bin/env python3
"""Remove ALL broken debug lines from blink.c and add clean argv dump."""

with open('/home/ubuntu/blink/blink/blink.c') as f:
    lines = f.readlines()

# Remove any line containing broken patterns
cleaned = []
skip_next = False
for i, line in enumerate(lines):
    if skip_next:
        skip_next = False
        continue
    # Skip broken debug lines (have literal newlines in C strings or ARG: pattern)
    if ('{ int _i; for' in line and 'ARG:' in line) or \
       ('"ARG:"' in line) or \
       ('CHILD-F:' in line):
        # Also skip the continuation line if it's a broken string
        if i + 1 < len(lines) and lines[i+1].strip().startswith('"'):
            skip_next = True
        continue
    cleaned.append(line)

with open('/home/ubuntu/blink/blink/blink.c', 'w') as f:
    f.writelines(cleaned)

# Now verify and add clean argv dump
with open('/home/ubuntu/blink/blink/blink.c') as f:
    c = f.read()

# Make sure there's exactly one clean argv dump at the start of main
if 'A0:' not in c:
    c = c.replace(
        'int main(int argc, char *argv[]) {\n',
        'int main(int argc, char *argv[]) {\n  { int _i; char _n[8]; for (_i = 0; _i < argc; _i++) { snprintf(_n, 8, "A%d:", _i); write(1, _n, strlen(_n)); write(1, argv[_i], strlen(argv[_i])); write(1, "\\n", 1); } }\n',
        1
    )

with open('/home/ubuntu/blink/blink/blink.c', 'w') as f:
    f.write(c)

print('Cleaned blink.c and added argv dump')
