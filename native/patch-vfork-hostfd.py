#!/usr/bin/env python3
"""Fix vfork to save/restore host fds 0/1/2 and execute fd ops on host.

The previous approach recorded fd ops without executing them on the host.
This broke builtins (echo) in pipes because write(1) went to original
stdout instead of the pipe.

New approach:
- Save host fds 0/1/2 with dup() at fork time
- Let dup2/close execute normally on host during vfork child
- At restore time, dup2 saved fds back to 0/1/2 to restore parent state
- Also rebuild guest fd table from snapshot
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# 1. Add saved host fd array
c = c.replace(
    'static i64 g_vfork_rip;',
    'static i64 g_vfork_rip;\nstatic int g_saved_host_fds[10] = {-1,-1,-1,-1,-1,-1,-1,-1,-1,-1};'
)

# 2. In SnapshotFds: save host fds
old_snapshot_end = '''    UNLOCK(&fds->lock);
}

static void RestoreFds'''

new_snapshot_end = '''    UNLOCK(&fds->lock);
    // Save host fds that might be modified by vfork child
    for (int i = 0; i < 10; i++) {
        g_saved_host_fds[i] = dup(i);  // -1 if fd i doesn't exist
    }
}

static void RestoreFds'''

c = c.replace(old_snapshot_end, new_snapshot_end, 1)

# 3. Fix RestoreFds: restore host fds first, then rebuild guest table
old_restore = '''static void RestoreFds(struct Fds *fds) {
    // Undo host fd changes by replaying recorded ops in reverse
    for (int i = g_fd_op_count - 1; i >= 0; i--) {
        // We can't perfectly undo all ops, but the key ones:
        // For dup2(src, dst): the original dst fd was overwritten.
        // We saved it in the snapshot. Restore it.
        // For close(fd): the fd was closed. Can't reopen.
        // Solution: we only need to restore fds 0/1/2 for the parent.
    }
    // Restore host stdin/stdout/stderr from saved copies
    for (int i = 0; i < 3; i++) {
        if (g_saved_host_fds[i] >= 0) {
            dup2(g_saved_host_fds[i], i);
            close(g_saved_host_fds[i]);
            g_saved_host_fds[i] = -1;
        }
    }
    // Rebuild guest fd table from snapshot
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
    for (int i = 0; i < g_fd_snap_count; i++) {
        AddFd(fds, g_fd_snap[i].fildes, g_fd_snap[i].oflags);
    }
    UNLOCK(&fds->lock);
}'''

new_restore = '''static void RestoreFds(struct Fds *fds) {
    // Restore ALL saved host fds (undo vfork child's dup2/close)
    for (int i = 0; i < 10; i++) {
        if (g_saved_host_fds[i] >= 0) {
            dup2(g_saved_host_fds[i], i);
            close(g_saved_host_fds[i]);
            g_saved_host_fds[i] = -1;
        }
    }
    // Rebuild guest fd table from snapshot
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
    for (int i = 0; i < g_fd_snap_count; i++) {
        AddFd(fds, g_fd_snap[i].fildes, g_fd_snap[i].oflags);
    }
    UNLOCK(&fds->lock);
}'''

c = c.replace(old_restore, new_restore, 1)

# 4. Fix SysDup2 vfork path: execute on host (let write reach pipe) + record
old_dup2 = '''    if (g_machine && g_machine->system->isfork) {
      // Vfork child: DO the dup2 on host (needed for writes to reach pipe)
      // but record for posix_spawn file_actions too
      RecordFdOp(0, fildes, newfildes);
      // Execute on host — the restore phase will undo this
      VfsDup2(fildes, newfildes);
    }'''

new_dup2 = '''    if (g_machine && g_machine->system->isfork) {
      // Vfork child: execute dup2 on host (needed for builtin writes to reach pipe)
      // Record for posix_spawn file_actions
      // Restore phase will undo via saved host fds
      RecordFdOp(0, fildes, newfildes);
    }'''

c = c.replace(old_dup2, new_dup2, 1)

# 5. Fix SysClose vfork path: execute on host + record
old_close = '''  if (m->system->isfork) {
    // Vfork child: record and execute close
    // The restore phase will rebuild the fd table from snapshot
    RecordFdOp(1, fildes, -1);
    // Execute on host — host fds will be reconstructed from snapshot on restore
  }'''

new_close = '''  if (m->system->isfork) {
    // Vfork child: record close, execute on host
    // Restore phase will undo via saved host fds
    RecordFdOp(1, fildes, -1);
  }'''

c = c.replace(old_close, new_close, 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Patched: host fd save/restore for vfork pipes')
