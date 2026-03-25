#!/usr/bin/env python3
"""Fix RestoreFds to actually restore host fds from saved copies."""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

old = '''static void RestoreFds(struct Fds *fds) {
    // Clear current guest fd table WITHOUT closing host fds
    LOCK(&fds->lock);'''

new = '''static void RestoreFds(struct Fds *fds) {
    // First: restore host fds from saved copies (undo vfork child's dup2/close)
    for (int i = 0; i < 10; i++) {
        if (g_saved_host_fds[i] >= 0) {
            dup2(g_saved_host_fds[i], i);
            close(g_saved_host_fds[i]);
            g_saved_host_fds[i] = -1;
        }
    }
    // Then: rebuild guest fd table from snapshot
    LOCK(&fds->lock);'''

c = c.replace(old, new, 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Fixed RestoreFds: now restores host fds 0-9 before rebuilding guest table')
