# Phase C Validation Report

- **Updated:** 2026-03-25
- **Decision:** Partial Pass — core filesystem operations work, fork blocked

## Exit Criteria Results

| Criterion | Status | Evidence |
|---|---|---|
| `ls /` lists real Alpine rootfs files | ✅ PASS | `busybox.static ls /rootfs` → bin dev etc home lib media mnt opt proc root run sbin srv sys tmp usr var |
| `cat /etc/os-release` shows Alpine info | ✅ PASS | NAME="Alpine Linux", VERSION_ID=3.21.6 |
| File write roundtrip | ✅ PASS | `echo hello > /tmp/test` then `cat /tmp/test` → "hello-roundtrip" (across separate invocations) |
| Shell boots and accepts commands | ✅ PASS (builtins) | `busybox.static sh -c "echo hello"` → "hello" |
| Shell runs external commands (fork+exec) | ❌ BLOCKED | setjmp/longjmp broken on wasmer — fork requires working setjmp for error recovery |

## What Works

- **147/147 Blink source files** compiled to WASI (wasi-sdk 32 + wasix-libc sysroot)
- **Alpine 3.21.6 rootfs** with BusyBox, bash, musl libc
- **Static x86-64 binaries** execute through Blink WASM on wasmer CLI
- **Real filesystem operations**: open, read, write, close, stat, getdents, mkdir work through wasmer --volume mapping
- **Tested commands**: `ls /`, `cat /etc/os-release`, `echo hello`, `echo data > file`, `cat file`
- All output comes from **real x86-64 instruction execution**, not mocked

## What's Blocked

### setjmp/longjmp (Critical)

WASIX setjmp uses `__wasi_stack_snapshot_t` which requires wasmer's `stack_checkpoint` import — **not implemented in wasmer 7.0.1** (crashes with exit 79).

The EH-based alternative (wasix-libc sysroot-eh with `-fwasm-exceptions`) compiles and the setjmp call works, but **wasmer doesn't catch the WASM exception thrown by longjmp** ("Uncaught exception with payload").

Tested: standard sysroot, sysroot-eh, sysroot-exnref-eh. All fail.

**Impact:** Without setjmp, Blink's `Blink()` main loop can't recover from errors (uses sigsetjmp/siglongjmp). The Phase B bypass (call Actor directly, longjmp→exit) keeps single-binary execution working but breaks fork — fork needs setjmp for the child process to properly initialize.

### fork/exec

Blink implements fork (SysFork at syscall.c:478) and execve, but requires:
1. `HAVE_FORK` enabled in config (currently commented out for WASI)
2. Working setjmp for error recovery
3. Host `fork()` call — WASIX provides `proc_fork` but it also relies on stack serialization (asyncify/exceptions)

**Result:** External commands in shell (`ls`, `cat` as separate binaries, pipes) don't work. Only shell builtins work.

## Tracked Gaps

1. **setjmp/longjmp** — wasmer needs to implement WASM exception catching or `stack_checkpoint`
2. **fork/exec** — blocked by setjmp; also needs WASIX proc_fork validation
3. **Dynamic ELF loading** — not tested yet (all tests use static binaries)
4. **Write roundtrip in single session** — works across invocations, not within single `sh -c "echo && cat"` (needs fork for cat)

## Next Steps

1. Monitor wasmer releases for exception handling / stack_checkpoint support
2. Investigate alternative: implement Blink's error recovery without setjmp (e.g., return codes instead of longjmp)
3. Test dynamic ELF loading with musl `ld-musl-x86_64.so.1`
4. Once fork unblocks: test bash, pipes, full shell workflows
