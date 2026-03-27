# Phase E Complete — Cleanup, getcwd, LTP, snapshot

All 8 browser tests pass. E1-E5 done. The engine runs Debian 13 bash in the browser with fork, pipes, and interactive stdin.

## Step 1: getcwd/chdir — real imports, not closure

Add two new `atua_*` imports:

```c
__attribute__((import_module("atua"), import_name("getcwd")))
extern int atua_getcwd(char *buf, int len);

__attribute__((import_module("atua"), import_name("chdir")))
extern int atua_chdir(const char *path);
```

JS host tracks cwd as real state. When guest calls `SysChdir`, Blink calls `atua_chdir` to update JS. Shim's `getcwd` calls `atua_getcwd` to read it. No hardcoded strings. No stubs returning fake values. Real state, properly tracked. Initialize to `"/"` on boot.

## Step 2: Cleanup pass

Remove all debug prints, dead experimental code, speculative ifdefs, and anything not directly serving the working E1-E5 path. This includes leftover mmap debugging, experimental mprotect changes, unused `stdin_guest_active` logging, redundant stat handling, the `patch-*.py` scripts in `native/`. Run all 8 Playwright tests after cleanup. `git diff` against last clean commit — the diff should be small and intentional.

## Step 3: LTP syscall test harness

Cross-compile LTP's syscall tests statically for x86-64. Add them to the Debian rootfs. Write a Playwright test that boots the engine, runs each LTP binary, captures exit codes. Start with the syscalls that already exercise the shim boundary: `open`, `close`, `read`, `write`, `stat`, `fstat`, `mmap`, `getcwd`, `chdir`, `pipe`, `dup2`, `fork`, `waitpid`. Every failure is a shim bug to fix.

## Step 4: Snapshot and push

Clean commit on main. Tag it. Push to GitHub.

**Test every step with Playwright. No manual browser testing. No escape hatches.**
