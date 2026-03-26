#!/usr/bin/env python3
"""Fix WriteForkFile — remove broken debug, add clean debug."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

# Replace the entire WriteForkFile function with a clean version
import re
# Find from "int WriteForkFile" to the next function
match = re.search(r'int WriteForkFile\(.*?\n\}', c, re.DOTALL)
if match:
    c = c[:match.start()] + '''int WriteForkFile(const char *path, const uint8_t *buf, size_t len) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return -1;
    ssize_t w = write(fd, buf, len);
    close(fd);
    return w == (ssize_t)len ? 0 : -1;
}''' + c[match.end():]

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Fixed WriteForkFile — clean, no debug')
