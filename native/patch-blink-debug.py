#!/usr/bin/env python3
"""Add debug output to Blink's startup flow to find the hang point."""

with open('/home/ubuntu/blink/blink/blink.c') as f:
    c = f.read()

# Add debug after LoadProgram in Exec()
c = c.replace(
    'LoadProgram(m, execfn, prog, argv, envp, NULL);\n    SetupCod(m);',
    'LoadProgram(m, execfn, prog, argv, envp, NULL);\n    write(2, "DBG:loaded\\n", 11);\n    SetupCod(m);\n    write(2, "DBG:setupcod\\n", 14);'
)

# Add debug after AddStdFd loop
c = c.replace(
    'ProgramLimit(m->system, RLIMIT_NOFILE, RLIMIT_NOFILE_LINUX);',
    'write(2, "DBG:fds\\n", 8);\n    ProgramLimit(m->system, RLIMIT_NOFILE, RLIMIT_NOFILE_LINUX);\n    write(2, "DBG:limit\\n", 10);'
)

# Add debug before Blink(m)
c = c.replace(
    '  Blink(m);\n}',
    '  write(2, "DBG:blink\\n", 10);\n  Blink(m);\n}'
)

# Add debug in Blink() function before and after sigsetjmp
c = c.replace(
    'void Blink(struct Machine *m) {\n  int rc;\n  for (;;) {\n    if (!(rc = sigsetjmp(m->onhalt, 1))) {',
    'void Blink(struct Machine *m) {\n  int rc;\n  write(2, "DBG:blink-enter\\n", 16);\n  for (;;) {\n    write(2, "DBG:sjlj\\n", 9);\n    if (!(rc = sigsetjmp(m->onhalt, 1))) {\n      write(2, "DBG:actor\\n", 10);'
)

# Make sure unistd.h is included
if '#include <unistd.h>' not in c[:2000]:
    c = '#include <unistd.h>\n' + c

with open('/home/ubuntu/blink/blink/blink.c', 'w') as f:
    f.write(c)

print('Patched blink.c with debug output')
