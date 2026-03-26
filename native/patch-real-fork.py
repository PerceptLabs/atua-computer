#!/usr/bin/env python3
"""Replace all vfork machinery with real fork via state serialization.

This patch:
1. Removes ALL vfork globals, functions, and intercepts
2. Adds SerializeForkState / DeserializeForkState (byte buffer API)
3. Replaces SysFork with serialize + posix_spawn
4. Removes the top-of-OpSyscall vfork intercept block
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# ============================================================
# 1. REMOVE all vfork machinery — replace the entire #ifdef __wasi__ block
#    at the top (before the first static function)
# ============================================================

# Find the vfork block — starts with "// Vfork pipe support" or "// Track fd operations"
# and ends before "static int SystemIoctl"
import re

# Remove everything between the spawn.h include marker and SystemIoctl
# The vfork code is between these landmarks
old_vfork_block_start = '#ifdef __wasi__\n// Vfork pipe support:'
old_vfork_block_end = '#endif\n\nstatic int SystemIoctl'

# Find the start and end
start_idx = c.find(old_vfork_block_start)
if start_idx < 0:
    # Try alternative marker
    start_idx = c.find('#ifdef __wasi__\n// Track fd operations')
if start_idx < 0:
    start_idx = c.find('// Vfork pipe support')
if start_idx < 0:
    start_idx = c.find('struct FdOp {')
    if start_idx > 0:
        # Go back to the #ifdef __wasi__ before it
        start_idx = c.rfind('#ifdef __wasi__', 0, start_idx)

end_idx = c.find('static int SystemIoctl')
if start_idx >= 0 and end_idx >= 0:
    # Replace the vfork block with the new serialization code
    new_fork_code = '''#ifdef __wasi__
// Real fork via state serialization.
// SerializeForkState writes guest state to a byte buffer.
// DeserializeForkState reads it back into a fresh Machine.
// SysFork serializes, writes to temp file, posix_spawns a child.

static uint8_t *g_fork_buf;
static size_t g_fork_buf_len;
static size_t g_fork_buf_cap;

static void fork_buf_init(void) {
    g_fork_buf_len = 0;
    g_fork_buf_cap = 1024 * 1024;
    g_fork_buf = (uint8_t *)malloc(g_fork_buf_cap);
}

static void fork_buf_write(const void *data, size_t n) {
    while (g_fork_buf_len + n > g_fork_buf_cap) {
        g_fork_buf_cap *= 2;
        g_fork_buf = (uint8_t *)realloc(g_fork_buf, g_fork_buf_cap);
    }
    memcpy(g_fork_buf + g_fork_buf_len, data, n);
    g_fork_buf_len += n;
}

uint8_t *SerializeForkState(struct Machine *m, size_t *out_len) {
    fork_buf_init();
    #define W(x) fork_buf_write(&(x), sizeof(x))
    // 1. Machine value fields (registers, flags, segments)
    fork_buf_write(m->beg, 128);            // GP registers ax-r15
    fork_buf_write(m->xmm, sizeof(m->xmm)); // SSE registers
    W(m->ip); W(m->flags);
    fork_buf_write(m->seg, sizeof(m->seg));  // all segment descriptors
    W(m->fs); W(m->gs);
    W(m->sigmask); W(m->ctid); W(m->tid);
    // 2. System value fields
    fork_buf_write(m->system->hands, sizeof(m->system->hands));
    W(m->system->brk); W(m->system->automap); W(m->system->cr3);
    W(m->system->pid);
    fork_buf_write(m->system->rlim, sizeof(m->system->rlim));
    W(m->system->blinksigs);
    // 3. Guest pages (index order — page table entries use index << 12)
    W(g_hostpages.n);
    for (size_t i = 0; i < g_hostpages.n; i++)
        fork_buf_write(g_hostpages.p[i], 4096);
    // 4. FD table with type markers
    int fd_count = 0;
    struct Dll *e;
    LOCK(&m->system->fds.lock);
    for (e = dll_first(m->system->fds.list); e; e = dll_next(m->system->fds.list, e))
        fd_count++;
    W(fd_count);
    for (e = dll_first(m->system->fds.list); e; e = dll_next(m->system->fds.list, e)) {
        struct Fd *fd = FD_CONTAINER(e);
        W(fd->fildes); W(fd->oflags);
    }
    UNLOCK(&m->system->fds.lock);
    #undef W
    *out_len = g_fork_buf_len;
    return g_fork_buf;
}

static const uint8_t *g_read_buf;
static size_t g_read_pos;
static void fork_buf_read(void *dst, size_t n) {
    memcpy(dst, g_read_buf + g_read_pos, n);
    g_read_pos += n;
}

int DeserializeForkState(struct Machine *m, const uint8_t *buf, size_t len) {
    g_read_buf = buf;
    g_read_pos = 0;
    #define R(x) fork_buf_read(&(x), sizeof(x))
    // 1. Machine value fields
    fork_buf_read(m->beg, 128);
    fork_buf_read(m->xmm, sizeof(m->xmm));
    R(m->ip); R(m->flags);
    fork_buf_read(m->seg, sizeof(m->seg));
    R(m->fs); R(m->gs);
    R(m->sigmask); R(m->ctid); R(m->tid);
    // 2. System value fields
    fork_buf_read(m->system->hands, sizeof(m->system->hands));
    R(m->system->brk); R(m->system->automap); R(m->system->cr3);
    R(m->system->pid);
    fork_buf_read(m->system->rlim, sizeof(m->system->rlim));
    R(m->system->blinksigs);
    // 3. Guest pages — same index order, PTEs match
    size_t n; R(n);
    for (size_t i = 0; i < n; i++) {
        u8 *page = (u8 *)aligned_alloc(4096, 4096);
        fork_buf_read(page, 4096);
        TrackHostPage(page);
    }
    // 4. FD table
    int fd_count; R(fd_count);
    for (int i = 0; i < fd_count; i++) {
        int fildes, oflags; R(fildes); R(oflags);
        AddFd(&m->system->fds, fildes, oflags);
    }
    #undef R
    return 0;
}

int WriteForkFile(const char *path, const uint8_t *buf, size_t len) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return -1;
    write(fd, buf, len);
    close(fd);
    return 0;
}

uint8_t *ReadForkFile(const char *path, size_t *out_len) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return NULL;
    struct stat st;
    fstat(fd, &st);
    *out_len = st.st_size;
    uint8_t *buf = (uint8_t *)malloc(*out_len);
    read(fd, buf, *out_len);
    close(fd);
    unlink(path);
    return buf;
}
#endif

'''
    c = c[:start_idx] + new_fork_code + c[end_idx:]

# ============================================================
# 2. REMOVE the top-of-OpSyscall vfork intercept block
# ============================================================
# Find and remove the entire #ifdef __wasi__ block at the top of OpSyscall
opsc_start = c.find('void OpSyscall(P) {\n#ifdef __wasi__')
if opsc_start >= 0:
    # Find the matching #endif
    block_start = c.find('#ifdef __wasi__', opsc_start)
    block_end = c.find('#endif', block_start)
    if block_end >= 0:
        block_end = c.find('\n', block_end) + 1  # include the newline
        c = c[:block_start] + c[block_end:]

# ============================================================
# 3. REPLACE SysFork with serialize + posix_spawn
# ============================================================
old_sysfork = '''static int SysFork(struct Machine *m) {
#ifdef __wasi__
  // WASI vfork: snapshot fds, save return RIP, set isfork, return 0 (child path)
  g_fd_op_count = 0;
  SnapshotFds(&m->system->fds);
  SnapshotSignals(m);
  g_vfork_rip = m->ip;
  m->system->isfork = true;
  return 0;
#else
  return Fork(m, 0, 0, 0);
#endif
}'''

new_sysfork = '''static int SysFork(struct Machine *m) {
#ifdef __wasi__
  // Real fork: serialize state to buffer, write to file, posix_spawn child
  size_t len;
  uint8_t *buf = SerializeForkState(m, &len);
  if (!buf) return -1;
  char path[64];
  snprintf(path, sizeof(path), "/tmp/fork-%d", getpid());
  WriteForkFile(path, buf, len);
  free(buf);
  const char *engine = getenv("BLINK_WASM_SELF");
  if (!engine) engine = "/engine/engine-wasix.wasm";
  char *argv[] = {(char *)engine, "-F", path, NULL};
  pid_t pid;
  int ret = posix_spawn(&pid, engine, NULL, NULL, argv, environ);
  if (ret != 0) { unlink(path); return -1; }
  return pid;
#else
  return Fork(m, 0, 0, 0);
#endif
}'''

c = c.replace(old_sysfork, new_sysfork, 1)

# ============================================================
# 4. REMOVE isfork-related code in SysExecve and SysExitGroup
# ============================================================
# Remove the #ifdef __wasi__ / if (m->system->isfork) block in SysExecve
# This is the old posix_spawn path that ran in the vfork child

# Find and remove the isfork block in SysExecve
execve_isfork_start = c.find('  if (m->system->isfork) {\n    // WASI fork+exec fast path')
if execve_isfork_start >= 0:
    # Find the end of this #ifdef __wasi__ block
    endif_after = c.find('#endif\n  LOCK(&m->system->exec_lock);', execve_isfork_start)
    if endif_after >= 0:
        # Remove from #ifdef __wasi__ before isfork to #endif
        wasi_start = c.rfind('#ifdef __wasi__', execve_isfork_start, execve_isfork_start)
        if wasi_start < 0:
            wasi_start = execve_isfork_start - 20  # approximate
        c = c[:wasi_start] + c[endif_after + len('#endif\n'):]

# Remove the broken isfork check in SysExitGroup (if (0) { ... })
c = c.replace(
    '  if (0) {\n    // Vfork exit handling moved to syscall dispatch (can\'t return from _Noreturn)\n  } else {',
    '  if (m->system->isfork) {\n    // This should not happen with real fork\n    _Exit(rc);\n  } else {'
)

# ============================================================
# 5. Clean up any remaining vfork references
# ============================================================
# Remove RecordFdOp calls in SysDup2 and SysClose
c = re.sub(r'#ifdef __wasi__\n\s+if \(g_machine && g_machine->system->isfork\) \{[^}]+\}\n#endif\n', '', c)
c = re.sub(r'  if \(m->system->isfork\) \{\n\s+// Vfork child: record.*?\n\s+RecordFdOp.*?\n\s*\}', '', c)

# Remove the snapshot code from inside Fork() function
c = c.replace('  // (snapshot code moved to SysFork)', '', 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Replaced all vfork machinery with real fork via serialization')
print('Next: add -F flag to blink.c main()')
