#!/usr/bin/env python3
"""Save/restore signal state in the vfork snapshot.

The vfork child modifies signal handlers (rt_sigaction) and signal mask
(rt_sigprocmask). These changes corrupt the parent's signal state.
Save them at fork time, restore after exec/exit.
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# 1. Add signal state to the snapshot globals
old_globals = 'static int g_saved_host_fds[10] = {-1,-1,-1,-1,-1,-1,-1,-1,-1,-1};'
new_globals = '''static int g_saved_host_fds[10] = {-1,-1,-1,-1,-1,-1,-1,-1,-1,-1};

// Saved signal state for vfork restore
static struct sigaction_linux g_saved_hands[64];
static u64 g_saved_sigmask;'''

c = c.replace(old_globals, new_globals, 1)

# 2. In SnapshotFds, also save signal state
old_snapshot_save = '''    // Save host fds that might be modified by vfork child
    for (int i = 0; i < 10; i++) {
        g_saved_host_fds[i] = dup(i);  // -1 if fd i doesn't exist
    }
}'''

new_snapshot_save = '''    // Save host fds that might be modified by vfork child
    for (int i = 0; i < 10; i++) {
        g_saved_host_fds[i] = dup(i);
    }
}

static void SnapshotSignals(struct Machine *m) {
    memcpy(g_saved_hands, m->system->hands, sizeof(g_saved_hands));
    g_saved_sigmask = m->sigmask;
}

static void RestoreSignals(struct Machine *m) {
    memcpy(m->system->hands, g_saved_hands, sizeof(g_saved_hands));
    m->sigmask = g_saved_sigmask;
}'''

c = c.replace(old_snapshot_save, new_snapshot_save, 1)

# 3. In SysFork, also save signals
old_fork_snap = '''  g_fd_op_count = 0;
  SnapshotFds(&m->system->fds);
  g_vfork_rip = m->ip;'''

new_fork_snap = '''  g_fd_op_count = 0;
  SnapshotFds(&m->system->fds);
  SnapshotSignals(m);
  g_vfork_rip = m->ip;'''

c = c.replace(old_fork_snap, new_fork_snap, 1)

# 4. In the execve intercept's RestoreFds call, also restore signals
# Find all RestoreFds calls in the top-of-OpSyscall block and add RestoreSignals after each
c = c.replace(
    '      RestoreFds(&m->system->fds);\n      m->system->isfork = false;\n      m->ip = g_vfork_rip;\n      Put64(m->ax, ret == 0 ? pid : (u64)-1);',
    '      RestoreFds(&m->system->fds);\n      RestoreSignals(m);\n      m->system->isfork = false;\n      m->ip = g_vfork_rip;\n      Put64(m->ax, ret == 0 ? pid : (u64)-1);'
)

# Also in the exit intercept
c = c.replace(
    '      RestoreFds(&m->system->fds);\n      m->system->isfork = false;\n      m->ip = g_vfork_rip;\n      Put64(m->ax, dummy > 0 ? dummy : 1);',
    '      RestoreFds(&m->system->fds);\n      RestoreSignals(m);\n      m->system->isfork = false;\n      m->ip = g_vfork_rip;\n      Put64(m->ax, dummy > 0 ? dummy : 1);'
)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Added signal state save/restore to vfork snapshot')
