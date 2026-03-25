#!/usr/bin/env python3
"""Snapshot ALL allocated guest pages at fork, restore at exec/exit.

g_hostpages.p[0..n-1] are pointers to 4KB guest pages.
At fork: malloc shadow copies, memcpy each page.
At restore: memcpy back, free shadows.

This is ~2-8MB for a typical BusyBox process. Takes ~1-2ms.
"""

SYSCALL_FILE = '/home/ubuntu/blink/blink/syscall.c'

with open(SYSCALL_FILE) as f:
    c = f.read()

# Replace the stack/register snapshot with a full page snapshot
old_snapshot_vars = '''static u8 g_vfork_regs[8 * 16];  // 16 GP registers * 8 bytes each
static u64 g_vfork_flags;
static u8 g_vfork_stack[65536];  // 64KB stack snapshot
static u64 g_vfork_stack_base;
static size_t g_vfork_stack_size;'''

new_snapshot_vars = '''static u8 g_vfork_regs[8 * 16];  // 16 GP registers * 8 bytes each
static u64 g_vfork_flags;

// Full guest memory snapshot — copies all allocated pages
static u8 **g_vfork_pages;       // shadow copies of guest pages
static size_t g_vfork_page_count; // number of pages at snapshot time'''

c = c.replace(old_snapshot_vars, new_snapshot_vars, 1)

# Replace the stack save in SysFork with full page snapshot
old_fork_save = '''  g_vfork_rip = m->ip;
  // Save guest stack (64KB below RSP)
  {
    u64 rsp = Get64(m->sp);
    g_vfork_stack_size = 65536;
    g_vfork_stack_base = rsp - g_vfork_stack_size;
    u8 *stack_ptr = LookupAddress(m, g_vfork_stack_base);
    if (stack_ptr) memcpy(g_vfork_stack, stack_ptr, g_vfork_stack_size);
  }'''

new_fork_save = '''  g_vfork_rip = m->ip;
  // Snapshot ALL allocated guest pages
  {
    size_t n = g_hostpages.n;
    g_vfork_page_count = n;
    g_vfork_pages = (u8 **)malloc(n * sizeof(u8 *));
    for (size_t i = 0; i < n; i++) {
      g_vfork_pages[i] = (u8 *)malloc(4096);
      memcpy(g_vfork_pages[i], g_hostpages.p[i], 4096);
    }
  }'''

c = c.replace(old_fork_save, new_fork_save, 1)

# Replace the stack restore in execve intercept with full page restore
old_exec_restore = '''      // Restore guest stack
      { u8 *sp = LookupAddress(m, g_vfork_stack_base); if (sp) memcpy(sp, g_vfork_stack, g_vfork_stack_size); }
      memcpy(m->ax, g_vfork_regs, sizeof(g_vfork_regs));
      m->flags = g_vfork_flags;
      Put64(m->ax, ret == 0 ? pid : (u64)-1);'''

new_exec_restore = '''      // Restore ALL guest pages
      { size_t n = g_vfork_page_count < g_hostpages.n ? g_vfork_page_count : g_hostpages.n;
        for (size_t i = 0; i < n; i++) memcpy(g_hostpages.p[i], g_vfork_pages[i], 4096);
        for (size_t i = 0; i < g_vfork_page_count; i++) free(g_vfork_pages[i]);
        free(g_vfork_pages); g_vfork_pages = NULL; }
      memcpy(m->ax, g_vfork_regs, sizeof(g_vfork_regs));
      m->flags = g_vfork_flags;
      Put64(m->ax, ret == 0 ? pid : (u64)-1);'''

c = c.replace(old_exec_restore, new_exec_restore, 1)

# Replace the stack restore in exit intercept too
old_exit_restore = '''      // Restore guest stack
      { u8 *sp = LookupAddress(m, g_vfork_stack_base); if (sp) memcpy(sp, g_vfork_stack, g_vfork_stack_size); }
      memcpy(m->ax, g_vfork_regs, sizeof(g_vfork_regs));
      m->flags = g_vfork_flags;
      Put64(m->ax, dummy > 0 ? dummy : 1);'''

new_exit_restore = '''      // Restore ALL guest pages
      { size_t n = g_vfork_page_count < g_hostpages.n ? g_vfork_page_count : g_hostpages.n;
        for (size_t i = 0; i < n; i++) memcpy(g_hostpages.p[i], g_vfork_pages[i], 4096);
        for (size_t i = 0; i < g_vfork_page_count; i++) free(g_vfork_pages[i]);
        free(g_vfork_pages); g_vfork_pages = NULL; }
      memcpy(m->ax, g_vfork_regs, sizeof(g_vfork_regs));
      m->flags = g_vfork_flags;
      Put64(m->ax, dummy > 0 ? dummy : 1);'''

c = c.replace(old_exit_restore, new_exit_restore, 1)

with open(SYSCALL_FILE, 'w') as f:
    f.write(c)

print('Full guest memory snapshot: all allocated pages saved/restored at fork/exec')
