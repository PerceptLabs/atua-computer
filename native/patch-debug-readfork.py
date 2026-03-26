#!/usr/bin/env python3
"""Add debug to ReadForkFile to show the exact open() failure."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

import re

# Replace ReadForkFile with a debug version
old = re.search(r'uint8_t \*ReadForkFile\(.*?\n\}', c, re.DOTALL)
if old:
    c = c[:old.start()] + '''uint8_t *ReadForkFile(const char *path, size_t *out_len) {
    write(2, "READ-FORK:", 10);
    write(2, path, strlen(path));
    write(2, "\\n", 1);
    int fd = open(path, O_RDONLY);
    { char d[32]; snprintf(d, 32, "RFD:%d E:%d\\n", fd, errno); write(2, d, strlen(d)); }
    if (fd < 0) return NULL;
    struct stat st;
    fstat(fd, &st);
    *out_len = st.st_size;
    { char d[32]; snprintf(d, 32, "RLEN:%zu\\n", *out_len); write(2, d, strlen(d)); }
    uint8_t *buf = (uint8_t *)malloc(*out_len);
    ssize_t nr = read(fd, buf, *out_len);
    close(fd);
    unlink(path);
    return buf;
}''' + c[old.end():]

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Added ReadForkFile debug')
