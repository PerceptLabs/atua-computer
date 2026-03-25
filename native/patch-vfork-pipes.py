#!/usr/bin/env python3
"""Patch Blink for proper vfork pipe support via fd snapshot/restore.

When is_vfork_child is true:
- SysDup2/SysDup3: record op, update guest table only, DON'T call host dup2
- SysClose: record op, remove from guest table only, DON'T call host close
- SysExecve: build posix_spawn file_actions from recorded ops, spawn,
  restore guest fd table from snapshot, return child PID to parent

Host fds are NEVER modified during the vfork child phase.
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# ============================================================
# 1. Replace the existing fd tracking with snapshot/restore
# ============================================================

# Find and replace the existing g_fd_ops section
old_tracking = '''#ifdef __wasi__
// Track fd operations between fork and exec for posix_spawn file_actions
#define MAX_FD_OPS 64
struct FdOp {
    int type;    // 0=dup2, 1=close
    int src_fd;  // source fd (for dup2) or fd (for close)
    int dst_fd;  // dest fd (for dup2)
};
static struct FdOp g_fd_ops[MAX_FD_OPS];
static int g_fd_op_count = 0;
static void RecordFdOp(int type, int src, int dst) {
    if (g_fd_op_count < MAX_FD_OPS) {
        g_fd_ops[g_fd_op_count].type = type;
        g_fd_ops[g_fd_op_count].src_fd = src;
        g_fd_ops[g_fd_op_count].dst_fd = dst;
        g_fd_op_count++;
    }
}
#endif'''

new_tracking = '''#ifdef __wasi__
// Vfork pipe support: fd snapshot/restore + operation recording
#define MAX_FD_OPS 64
struct FdOp {
    int type;    // 0=dup2, 1=close
    int src_fd;
    int dst_fd;
};
static struct FdOp g_fd_ops[MAX_FD_OPS];
static int g_fd_op_count = 0;

static void RecordFdOp(int type, int src, int dst) {
    if (g_fd_op_count < MAX_FD_OPS) {
        g_fd_ops[g_fd_op_count].type = type;
        g_fd_ops[g_fd_op_count].src_fd = src;
        g_fd_ops[g_fd_op_count].dst_fd = dst;
        g_fd_op_count++;
    }
}

// Guest fd table snapshot
struct FdSnap { int fildes; int oflags; };
static struct FdSnap g_fd_snap[256];
static int g_fd_snap_count = 0;

// Saved guest registers for return-to-parent after exec
static i64 g_vfork_rip;

static void SnapshotFds(struct Fds *fds) {
    g_fd_snap_count = 0;
    LOCK(&fds->lock);
    struct Dll *e;
    for (e = dll_first(fds->list); e; e = dll_next(fds->list, e)) {
        if (g_fd_snap_count >= 256) break;
        struct Fd *fd = FD_CONTAINER(e);
        g_fd_snap[g_fd_snap_count].fildes = fd->fildes;
        g_fd_snap[g_fd_snap_count].oflags = fd->oflags;
        g_fd_snap_count++;
    }
    UNLOCK(&fds->lock);
}

static void RestoreFds(struct Fds *fds) {
    // Clear current guest fd table WITHOUT closing host fds
    LOCK(&fds->lock);
    struct Dll *e, *e2;
    for (e = dll_first(fds->list); e; e = e2) {
        e2 = dll_next(fds->list, e);
        dll_remove(&fds->list, e);
        struct Fd *fd = FD_CONTAINER(e);
        free(fd->path);
        fd->path = NULL;
        free(fd);
    }
    // Rebuild from snapshot
    for (int i = 0; i < g_fd_snap_count; i++) {
        AddFd(fds, g_fd_snap[i].fildes, g_fd_snap[i].oflags);
    }
    UNLOCK(&fds->lock);
}
#endif'''

c = c.replace(old_tracking, new_tracking, 1)

# ============================================================
# 2. Fix SysFork: snapshot fds, save RIP, return 0
# ============================================================

old_fork = '''  m->system->isfork = true;
#ifdef __wasi__
  g_fd_op_count = 0;  // Reset fd tracking for new fork+exec cycle
#endif'''

new_fork = '''  m->system->isfork = true;
#ifdef __wasi__
  g_fd_op_count = 0;
  SnapshotFds(&m->system->fds);
  g_vfork_rip = m->ip;  // Save return address for parent path
#endif'''

c = c.replace(old_fork, new_fork, 1)

# ============================================================
# 3. Fix SysDup2: don't call host dup2 during vfork
# ============================================================

# The existing dup2 tracking added in patch-pipe-tracking.py:
old_dup2 = '''  if (fildes != newfildes) {
#ifdef __wasi__
    if (g_machine && g_machine->system->isfork) {
      RecordFdOp(0, fildes, newfildes);
    }
#endif'''

new_dup2 = '''  if (fildes != newfildes) {
#ifdef __wasi__
    if (g_machine && g_machine->system->isfork) {
      // Vfork child: record op, update guest table only, DON'T call host dup2
      RecordFdOp(0, fildes, newfildes);
      LOCK(&m->system->fds.lock);
      struct Fd *existing = GetFd(&m->system->fds, newfildes);
      if (existing) { dll_remove(&m->system->fds.list, &existing->elem); free(existing->path); free(existing); }
      struct Fd *src = GetFd(&m->system->fds, fildes);
      if (src) ForkFd(&m->system->fds, src, newfildes, src->oflags & ~O_CLOEXEC);
      UNLOCK(&m->system->fds.lock);
      return newfildes;
    }
#endif'''

c = c.replace(old_dup2, new_dup2, 1)

# ============================================================
# 4. Fix SysClose: don't call host close during vfork
# ============================================================

old_close = '''static int SysClose(struct Machine *m, int fildes) {
#ifdef __wasi__
  if (m->system->isfork) {
    RecordFdOp(1, fildes, -1);
  }
#endif'''

new_close = '''static int SysClose(struct Machine *m, int fildes) {
#ifdef __wasi__
  if (m->system->isfork) {
    // Vfork child: record op, remove from guest table only, DON'T call host close
    RecordFdOp(1, fildes, -1);
    LOCK(&m->system->fds.lock);
    struct Fd *fd = GetFd(&m->system->fds, fildes);
    if (fd) { dll_remove(&m->system->fds.list, &fd->elem); free(fd->path); free(fd); }
    UNLOCK(&m->system->fds.lock);
    return 0;
  }
#endif'''

c = c.replace(old_close, new_close, 1)

# ============================================================
# 5. Fix SysExecve: posix_spawn, restore fds, return to parent
# ============================================================

# Replace the _Exit after waitpid with restore + return-to-parent
old_exec_exit = '''    int ret = posix_spawn(&pid, engine, actions_ptr, NULL, spawn_argv, envp);
    if (actions_ptr) posix_spawn_file_actions_destroy(&file_actions);
    free(spawn_argv);
    if (ret == 0) {
      // Child spawned. Wait for it and exit with its status.
      int wstatus;
      waitpid(pid, &wstatus, 0);
      if (WIFEXITED(wstatus)) {
        _Exit(WEXITSTATUS(wstatus));
      }
      _Exit(128);
    }
    SYS_LOGF("posix_spawn failed: %d", ret);
    errno = ret;
    free(spawn_argv);
    return -1;'''

new_exec_exit = '''    int ret = posix_spawn(&pid, engine, actions_ptr, NULL, spawn_argv, envp);
    if (actions_ptr) posix_spawn_file_actions_destroy(&file_actions);
    free(spawn_argv);
    if (ret == 0) {
      // Child spawned. Restore parent state and return child PID.
      RestoreFds(&m->system->fds);
      m->system->isfork = false;
      // Jump back to the fork return point with child PID in RAX
      m->ip = g_vfork_rip;
      Put64(m->ax, pid);
      return 0;  // return value ignored — RAX already set
    }
    SYS_LOGF("posix_spawn failed: %d", ret);
    // Restore fds even on failure
    RestoreFds(&m->system->fds);
    m->system->isfork = false;
    m->ip = g_vfork_rip;
    Put64(m->ax, -1);
    errno = ret;
    return -1;'''

c = c.replace(old_exec_exit, new_exec_exit, 1)

# ============================================================
# 6. Fix SysExit/SysExitGroup: don't _Exit during vfork
# ============================================================
# The child code path calls _exit(127) if exec "fails".
# With our new approach, exec doesn't fail — it returns to parent.
# But if the child calls _exit for other reasons, we need to handle it.
# For now, if isfork is true and _exit is called, just restore and return.

old_exit_isfork = '''  if (m->system->isfork) {
#ifndef NDEBUG
    if (FLAG_statistics) {
      PrintStats();
    }
#endif
    THR_LOGF("calling _Exit(%d)", rc);
    _Exit(rc);'''

new_exit_isfork = '''  if (m->system->isfork) {
    // Vfork child calling _exit: restore parent state and return
    RestoreFds(&m->system->fds);
    m->system->isfork = false;
    m->ip = g_vfork_rip;
    Put64(m->ax, -1);  // fork "failed" from parent's perspective
    return;'''

c = c.replace(old_exit_isfork, new_exit_isfork, 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Patched syscall.c: vfork pipe support with fd snapshot/restore')
print('- SysDup2/SysClose: record-only during vfork (no host fd changes)')
print('- SysExecve: posix_spawn with file_actions, restore fds, return to parent')
print('- SysExitGroup: restore and return during vfork instead of _Exit')
