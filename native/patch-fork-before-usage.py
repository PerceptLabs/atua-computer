#!/usr/bin/env python3
"""Move the -F restore-fork check BEFORE the optind_==argc usage check.

The child process has no PROG argument (just -F path), so optind_==argc
fires and prints Usage before the -F handler runs.
"""

with open('/home/ubuntu/blink/blink/blink.c') as f:
    c = f.read()

# Remove any existing -F check blocks (they might be in wrong location)
import re
# Remove blocks that start with "// Check for fork restore mode"
c = re.sub(r'  // Check for fork restore mode\n.*?Actor\(m\);.*?\n  \}\n#endif\n', '', c, flags=re.DOTALL)

# Also remove the debug write that was added
c = re.sub(r'    write\(2, "FORK-RESTORE.*?\n', '', c)

# Now insert a clean -F check BEFORE the optind_ == argc check
old = '  if (optind_ == argc) {\n    PrintUsage(argc, argv, 48, 2);'

new_block = '''#ifdef __wasi__
  if (FLAG_restore_fork) {
    extern int DeserializeForkState(struct Machine *, const uint8_t *, size_t);
    extern uint8_t *ReadForkFile(const char *, size_t *);
    size_t flen;
    uint8_t *fbuf = ReadForkFile(FLAG_restore_fork, &flen);
    if (!fbuf) {
      WriteErrorString("failed to read fork state file\\n");
      exit(1);
    }
    struct Machine *fm = NewMachine(NewSystem(XED_MACHINE_MODE_LONG), 0);
    {
      int fi;
      for (fi = 0; fi < 10; ++fi) AddStdFd(&fm->system->fds, fi);
    }
    DeserializeForkState(fm, fbuf, flen);
    free(fbuf);
    Put64(fm->ax, 0);
    fm->canhalt = true;
    Actor(fm);
  }
#endif
  if (optind_ == argc) {
    PrintUsage(argc, argv, 48, 2);'''

c = c.replace(old, new_block, 1)

with open('/home/ubuntu/blink/blink/blink.c', 'w') as f:
    f.write(c)

print('Moved -F check before optind_==argc usage check')
