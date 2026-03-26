#!/usr/bin/env python3
"""Add argv dump at the start of main() to see what the child receives."""

with open('/home/ubuntu/blink/blink/blink.c') as f:
    c = f.read()

# Remove previous broken attempt
c = c.replace(
    '  { int _i; for (_i=0; _i<argc; _i++) { write(1, "ARG:", 4); write(1, argv[_i], strlen(argv[_i])); write(1, "\\n", 1); } }\n',
    ''
)

# Add clean argv dump
old = 'int main(int argc, char *argv[]) {'
new = '''int main(int argc, char *argv[]) {
  { int _i; char _n[8];
    for (_i = 0; _i < argc; _i++) {
      snprintf(_n, 8, "A%d:", _i);
      write(1, _n, strlen(_n));
      write(1, argv[_i], strlen(argv[_i]));
      write(1, "\\n", 1);
    }
  }'''

c = c.replace(old, new, 1)

with open('/home/ubuntu/blink/blink/blink.c', 'w') as f:
    f.write(c)

print('Added argv dump')
