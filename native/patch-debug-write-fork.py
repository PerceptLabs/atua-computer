#!/usr/bin/env python3
"""Add debug to WriteForkFile."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

old = 'int WriteForkFile(const char *path, const uint8_t *buf, size_t len) {\n    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);'

new = '''int WriteForkFile(const char *path, const uint8_t *buf, size_t len) {
    write(2, "WFORK:", 6); write(2, path, strlen(path)); write(2, "\\n", 1);
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    { char d[32]; snprintf(d, 32, "WFD:%d\\n", fd); write(2, d, strlen(d)); }'''

c = c.replace(old, new, 1)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Added WriteForkFile debug')
