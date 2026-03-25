#!/usr/bin/env python3
"""Patch Blink loader.c with debug output for WASI file open diagnosis."""

LOADER = '/home/ubuntu/blink/blink/loader.c'

with open(LOADER) as f:
    lines = f.readlines()

out = []
for i, line in enumerate(lines):
    out.append(line)
    if 'SYS_LOGF("LoadProgram %s", prog);' in line:
        out.append('    write(2, prog, strlen(prog));\n')
        out.append('    write(2, "\\n", 1);\n')
    # Break the compound if into individual checks
    if 'if ((fd = VfsOpen(AT_FDCWD, prog, O_RDONLY, 0)) == -1 ||' in line:
        out.pop()
        out.append('    fd = VfsOpen(AT_FDCWD, prog, O_RDONLY, 0);\n')
        out.append('    if (fd == -1) { write(2, "FAIL:open\\n", 10); }\n')
        out.append('    else if (VfsFstat(fd, &st) == -1) { write(2, "FAIL:fstat\\n", 11); fd = -1; }\n')
        out.append('    else if (CheckExecutableFile(prog, &st) == -1) { write(2, "FAIL:check\\n", 12); fd = -1; }\n')
        out.append('    else if ((map = Mmap(0, (mapsize = st.st_size), PROT_READ | PROT_WRITE,\n')
        out.append('                    MAP_PRIVATE, fd, 0, "loader")) == MAP_FAILED) { write(2, "FAIL:mmap\\n", 11); fd = -1; }\n')
        out.append('    else { write(2, "ALL-OK\\n", 7); }\n')
        out.append('    if (fd == -1 || map == MAP_FAILED) {\n')
        # Skip the original 3 lines of the if statement
        skip = 3
        for j in range(i+1, min(i+4, len(lines))):
            if skip > 0:
                lines[j] = ''  # blank out the original lines
                skip -= 1

with open(LOADER, 'w') as f:
    f.writelines(out)

with open(LOADER) as f:
    for n, l in enumerate(f, 1):
        if 'FAIL:' in l or 'ALL-OK' in l:
            print(f'{n}: {l.rstrip()}')
