#!/usr/bin/env python3
"""Add -F flag to Blink's main() for --restore-fork child entry point."""

BLINK_FILE = '/home/ubuntu/blink/blink/blink.c'

with open(BLINK_FILE) as f:
    c = f.read()

# 1. Add FLAG_restore_fork variable
c = c.replace(
    'char *g_blink_path;',
    'char *g_blink_path;\nchar *FLAG_restore_fork;'
)

# 2. Add -F to OPTS string
c = c.replace(
    '#define OPTS "hvjemZs0L:C:"',
    '#define OPTS "hvjemZs0L:C:F:"'
)

# 3. Add case 'F' in GetOpts
c = c.replace(
    "      case 'Z':\n        FLAG_statistics = true;\n        break;",
    "      case 'F':\n        FLAG_restore_fork = optarg_;\n        break;\n      case 'Z':\n        FLAG_statistics = true;\n        break;"
)

# 4. Add restore-fork entry point before the normal Exec path
# Find the right location — after VfsInit and before Commandv
c = c.replace(
    '  g_blink_path = prog = argv[optind_];',
    '''  // Check for fork restore mode
#ifdef __wasi__
  if (FLAG_restore_fork) {
    extern int DeserializeForkState(struct Machine *, const uint8_t *, size_t);
    extern uint8_t *ReadForkFile(const char *, size_t *);
    size_t len;
    uint8_t *buf = ReadForkFile(FLAG_restore_fork, &len);
    if (!buf) { WriteErrorString("failed to read fork state\\n"); exit(1); }
    struct Machine *m = NewMachine(NewSystem(XED_MACHINE_MODE_LONG), 0);
    int i;
    for (i = 0; i < 10; ++i) AddStdFd(&m->system->fds, i);
    DeserializeForkState(m, buf, len);
    free(buf);
    Put64(m->ax, 0);  // child sees fork() == 0
    m->canhalt = true;
    Actor(m);  // resume interpreter — never returns
  }
#endif

  g_blink_path = prog = argv[optind_];'''
)

with open(BLINK_FILE, 'w') as f:
    f.write(c)

print('Added -F flag for fork restore entry point')
