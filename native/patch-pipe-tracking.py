#!/usr/bin/env python3
"""Patch Blink to track fd changes between fork and exec for posix_spawn file_actions.

When the guest shell forks (SysFork sets isfork=true), subsequent dup2/close
calls modify the parent's fd table (since vfork runs in the parent). At execve
time, we need to replay these fd changes as posix_spawn_file_actions.

Approach: Track dup2 and close calls while isfork is true. At execve, build
file_actions from the tracked operations.
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# 1. Add fd tracking arrays to the system struct area
# We'll use a simple global array since we're single-threaded
fd_tracking = '''
#ifdef __wasi__
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
#endif
'''

# Insert after the spawn.h include (which is in the compat header)
# Find a good location - after the includes
idx = c.find('\nstatic ')
if idx > 0:
    c = c[:idx] + '\n' + fd_tracking + c[idx:]

# 2. Track dup2 calls while isfork is true
# Find SysDup2 or SysDup3 and add tracking
old_dup2 = '  if (fildes != newfildes) {'
# We need to find the one in SysDup2/SysDup3 context
# Add tracking right after SysDup2 succeeds
dup2_tracking = '''  if (fildes != newfildes) {
#ifdef __wasi__
    if (g_machine && g_machine->system->isfork) {
      RecordFdOp(0, fildes, newfildes);
    }
#endif'''
c = c.replace(old_dup2, dup2_tracking, 1)

# 3. Track close calls while isfork is true
# Find SysClose and add tracking
old_close_line = 'static int SysClose(struct Machine *m, int fildes) {'
new_close_line = '''static int SysClose(struct Machine *m, int fildes) {
#ifdef __wasi__
  if (m->system->isfork) {
    RecordFdOp(1, fildes, -1);
  }
#endif'''
c = c.replace(old_close_line, new_close_line, 1)

# 4. Update SysExecve to build file_actions from tracked ops
# Replace the posix_spawn call to include file_actions
old_spawn = '''    int ret = posix_spawn(&pid, engine, NULL, NULL, spawn_argv, envp);'''
new_spawn = '''    // Build file_actions from fd operations tracked since fork
    posix_spawn_file_actions_t file_actions;
    posix_spawn_file_actions_t *actions_ptr = NULL;
    if (g_fd_op_count > 0) {
      posix_spawn_file_actions_init(&file_actions);
      for (int i = 0; i < g_fd_op_count; i++) {
        if (g_fd_ops[i].type == 0) {  // dup2
          posix_spawn_file_actions_adddup2(&file_actions, g_fd_ops[i].src_fd, g_fd_ops[i].dst_fd);
        } else if (g_fd_ops[i].type == 1) {  // close
          posix_spawn_file_actions_addclose(&file_actions, g_fd_ops[i].src_fd);
        }
      }
      actions_ptr = &file_actions;
    }
    int ret = posix_spawn(&pid, engine, actions_ptr, NULL, spawn_argv, envp);
    if (actions_ptr) posix_spawn_file_actions_destroy(&file_actions);'''
c = c.replace(old_spawn, new_spawn, 1)

# 5. Reset fd tracking in SysFork
old_fork = '  m->system->isfork = true;'
new_fork = '''  m->system->isfork = true;
#ifdef __wasi__
  g_fd_op_count = 0;  // Reset fd tracking for new fork+exec cycle
#endif'''
c = c.replace(old_fork, new_fork, 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Patched syscall.c: fd tracking between fork and exec for posix_spawn file_actions')
