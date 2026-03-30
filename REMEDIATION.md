# atua-computer Remediation — From Tech Demo to Production Linux Distribution

**Purpose:** This document is the complete, itemized, no-deferral fix list for atua-computer. Every item is architecturally required. Nothing is "for later." CC executes this sequentially. Each section states what's broken, why, what the correct implementation is, and what open-source reference to follow.

**Governing documents:** `atua-computer.md` (architecture), `atua-computer-implementation-addendum.md` (implementation), `CLAUDE.md` (rules). This document does not override them — it enforces them against the current codebase which violates them.

**Competition:** CheerpX runs a full 32-bit Debian Linux in the browser with JIT, persistence, proper fork, proper VFS, init system, and hundreds of syscalls. atua-computer must match that functionality AND beat it with 64-bit support, clean architecture, and agent-native control. The current codebase is a tech demo with 14+ known defects. This document turns it into the product.

---

## Phase 0: Fork Architecture — CheerpX Pattern (BLOCKING)

### What's broken

`engine-main-worker.js` line 1502: `const parentMemory = new Uint8Array(memory.buffer).slice()` copies the ENTIRE parent WASM memory (~26MB+) on every fork. The comment says `// TEMPORARY`. The SAB infrastructure exists alongside it — `guestPagesSab`, `FaultHostPageFromSab`, `page_pool_fault` import — all built, all unused for the actual fork path. CC hit a bug with mmap-mapped pages not being in the SAB, and instead of fixing that one case, shipped the full copy.

Every fork in apt install (hundreds of times for dpkg) copies 26MB+. This is the difference between responsive and unusable.

### What CheerpX does

Each process is a separate Web Worker with its own WASM instance. Guest memory is managed by a software MMU inside the WASM module. Fork copies the page table (~100KB), NOT the memory. Pages are copy-on-write — first write to a shared page allocates a new page and copies just that 4KB page. For fork+exec (95% of forks), the child never touches parent pages because exec discards everything. Near-zero cost.

### Correct implementation

Follow the Browsix pattern (MIT, ASPLOS 2017, `github.com/AskBlink/browsix`) combined with the Gamozo Labs SoftMMU (MIT, `github.com/gamozolabs/fuzz_with_emus`) already partially implemented in C:

**Step 1: Fix mmap page gap.** During `fork_spawn`, write ALL page types to the SAB — pool-allocated pages AND mmap-backed pages. The bug CC hit was that mmap pages weren't in the SAB. The fix: iterate `g_hostpages` AND any mmap-tracked regions, write every page to the SAB. This is the one bug that caused the full-copy fallback.

**Step 2: Remove full memory copy.** Delete line 1502 (`const parentMemory = new Uint8Array(memory.buffer).slice()`). Delete the `parentMemory` parameter from the child Worker message. The child Worker instantiates a fresh WASM module with its own memory. Pages fault lazily from the SAB via `page_pool_fault`.

**Step 3: fork+exec fast path.** Detect fork immediately followed by execve. For these (95% of forks): spawn Worker, send only exec arguments + fd table. No page copy. No SAB copy. Child calls exec which loads the new binary fresh. CheerpX and Browsix both do this.

**Step 4: Pure fork (5% — subshells).** For fork NOT followed by exec: copy page table + SAB snapshot. Child faults pages lazily. First write triggers copy of just that 4KB page. The Gamozo Labs COW bits (`aliased`, `cow`, `dirty`) are the reference — they're already described in `atua-computer-implementation-addendum.md`.

**What NOT to do:**
- Do NOT keep the full memory copy as a fallback
- Do NOT defer this — it makes apt install unusable
- Do NOT implement COW as a separate phase. Wire it now. The C code exists.

**References:**
- Browsix: `github.com/AskBlink/browsix` (MIT) — fork via SAB, per-process page tables
- Browsix paper: ASPLOS 2017, "BROWSIX: Bridging the Gap Between Unix and the Browser"
- WebAssembly design issue #950 — Bobby Powers describes the exact architecture
- Gamozo Labs SoftMMU: `github.com/gamozolabs/fuzz_with_emus` (MIT) — COW, lazy fault, dirty tracking

---

## Phase 1: VFS Correctness (BLOCKING)

### What's broken

The VFS hand-rolls POSIX filesystem semantics and gets many of them wrong. The child Worker VFS is a degraded copy using plain Maps with no-op syscalls. These aren't edge cases — they break apt, dpkg, make, and bash.

### Item 1a: O_APPEND (missing entirely)

Zero occurrences in the codebase. The write handler (`engine-main-worker.js` line 445) writes at `file.position` unconditionally. Any program opening a file with O_APPEND — shell `>>` redirection, apt's dpkg.log, log files — silently corrupts data by writing at offset 0 instead of appending.

**Fix:** In `open()`, store the O_APPEND flag on the fd object. In the write handler, if O_APPEND is set, seek to end of file before writing: `file.position = file.content.length`.

### Item 1b: O_EXCL (missing entirely)

Not handled in open/openat. Lock files created with `O_EXCL | O_CREAT` don't fail if the file already exists. dpkg creates `/var/lib/dpkg/lock` with O_EXCL.

**Fix:** In the `O_CREAT` path, check if `O_EXCL` (0x80 on x86-64) is set. If so AND the file already exists, return `-EEXIST` (-17).

### Item 1c: readdir missing `.` and `..`

Confirmed in `VirtualFS.readdir()` and the getdents64 handler. Many programs expect `.` and `..` as directory entries — `find`, `ls -a`, bash glob expansion, `realpath`.

**Fix:** In `readdir()`, prepend `{ name: '.', type: 'dir' }` and `{ name: '..', type: 'dir' }` to the entries list before returning real children.

### Item 1d: stat returns Date.now() as default mtime

Lines 500-502: `meta.mtime || now` where `now = Math.floor(Date.now() / 1000)`. Every file without explicit metadata returns a DIFFERENT mtime on every stat call. `make` and `dpkg` compare mtimes and see phantom changes.

**Fix:** Set a fixed boot-time timestamp once at VFS initialization: `this.bootTime = Math.floor(Date.now() / 1000)`. Use `meta.mtime || this.bootTime` everywhere. All base-layer files get the same consistent mtime.

### Item 1e: F_DUPFD / F_DUPFD_CLOEXEC broken

Line 680: `if (b === F_DUPFD || b === F_DUPFD_CLOEXEC) return a` — returns the SAME fd instead of creating a new dup'd fd. dup() doesn't actually dup. This breaks any program that dups file descriptors — which is every shell pipeline, every fork+exec setup, every logging framework.

**Fix:** Allocate a new fd number (`nextFd++`), copy the file object reference to the new fd in `openFiles`, return the new fd number. For F_DUPFD_CLOEXEC, also set the close-on-exec flag on the new fd.

### Item 1f: No close-on-exec (O_CLOEXEC / FD_CLOEXEC) tracking

No CLOEXEC bit stored on any fd. No cleanup of marked fds after exec. fd leaks accumulate across fork+exec chains. Programs that set CLOEXEC expect those fds to be closed in the child after exec.

**Fix:** Add a `cloexec` boolean field to each fd entry in `openFiles`. Track it when `O_CLOEXEC` (0x80000 on x86-64) is set on open, or when `fcntl(F_SETFD, FD_CLOEXEC)` is called. In the fork+exec path, close all fds with `cloexec === true` before entering exec.

### Item 1g: Symlink resolution depth is 10, should be 40

`resolvePath` uses `depth > 10`. Linux kernel allows 40 levels. Deep symlink chains in `/usr/lib` (common in Debian with multiarch) can exceed 10.

**Fix:** Change `depth > 10` to `depth > 40` in `VirtualFS.resolvePath()` and the child worker's `resolveSymlinks()`.

### Item 1h: Child Worker VFS is degraded

`engine-worker.js` uses `const vfs = new Map()` — no whiteouts, no children index, no metadata, no copy-up, no proper readdir. mkdir/unlink/rename in the child are literal no-ops (return 0, do nothing). Parent metadata from fchmod/fchown is NOT serialized to the child.

This means any dpkg configure script that creates files, sets permissions, or lists directories in a forked child gets silent data loss.

**Fix:** Serialize the full VirtualFS state from parent to child in the fork message: `files`, `dirs`, `symlinks`, `whiteouts`, `metadata`, `children`. In the child worker, reconstruct a proper VirtualFS instance from this data — NOT raw Maps. All syscall handlers in the child must use the VirtualFS class methods, not hand-rolled logic. Alternatively, use a shared VFS object if the SAB-based fork architecture supports it.

**Reference:** ZenFS (`github.com/zen-fs/core`, MIT) — OverlayFS with proper whiteouts, copy-up, directory merging. Read this before fixing the VFS. Don't use as a dependency — use as the reference for correct POSIX semantics.

---

## Phase 2: Rootfs — Real Debian with Nitro as PID 1 (BLOCKING)

### What's broken

Current rootfs is a manually assembled tar with missing directories, injected `.keep` files, and bash as PID 1. This is not a Linux distribution. This is a shell session with a filesystem taped to it.

### Correct implementation

**Nitro** (`github.com/leahneukirchen/nitro`, MIT) as PID 1. Cross-compile Nitro for x86-64 (it's tiny C, statically links against musl). Include in the rootfs at `/sbin/init`.

**uutils** (`github.com/uutils/coreutils`, MIT) as coreutils. 96% GNU coreutils compatibility. Single multicall binary. Cross-compile for x86-64 musl static. Replace BusyBox entirely. CLAUDE.md already mandates this.

**Full Debian trixie minbase** via debootstrap. Not a hand-assembled tar. Real dpkg database, real apt configuration, real shared libraries, real everything.

**Nitro service structure:**
```
/etc/nitro/
  shell/
    run     ← exec /bin/bash --login
  syslog/
    run     ← exec /usr/bin/logger (or simple log service)
```

The agent's shell is a service under Nitro, not PID 1. Background services (dev servers, databases, language servers) are additional Nitro services created by the agent via folder creation.

**Rootfs format:** Tar for testing (current). EROFS for production (HTTP byte-range fetching, LZ4 compression, block-aligned random access). VFS code must keep the base layer backend swappable behind the `_sys_openat` interface per existing spec.

---

## Phase 3: OPFS Persistence (BLOCKING)

### What's broken

Everything is lost on page reload. A user installs Python, refreshes, Python is gone. A real Linux distribution persists state across reboots.

### Correct implementation

The VFS overlay layer's writable state (`files` Map, `metadata` Map, `dirs` Set, `symlinks` Map, `whiteouts` Set) flushes to OPFS. On boot, check OPFS for existing overlay state before loading from tar/EROFS base layer.

**Use opfs-tools** (`github.com/hughfenghen/opfs-tools`, MIT, 294 stars) or **happy-opfs** (`github.com/JiangJie/happy-opfs`, MIT) as the OPFS API wrapper. Do NOT hand-roll OPFS access patterns. CLAUDE.md: "No hand-rolled implementations when proven libraries exist."

**Persistence strategy:**
- Debounced flush: after any write, schedule a flush to OPFS (e.g., 500ms debounce). Batch multiple writes into one OPFS transaction.
- On boot: check OPFS for overlay data. If present, deserialize into VFS overlay. If not, start fresh from base layer.
- On explicit checkpoint: flush all pending writes immediately. Return when OPFS confirms.
- The tar/EROFS base layer is read-only and cached by the browser HTTP cache. It is NEVER written to OPFS — only the overlay (user changes) persists.

---

## Phase 4: HTTP Fetch Bypass (BLOCKING for performance)

### What's broken

All apt downloads go through interpreted glibc HTTP code running on the Blink x86 interpreter, going through the Wisp TCP relay. Every byte of a 20MB package list takes the slowest possible path through the system. apt update takes minutes instead of seconds.

### Correct implementation

Intercept HTTP traffic at the socket syscall level in JS. When `connect()` targets port 80 or 443, buffer the HTTP request bytes from the guest, recognize the HTTP method/headers, fire native browser `fetch()`, stream the response back through the socket fd.

**Pattern:**
1. Guest calls `connect(fd, {port: 80, addr: "..."})`
2. JS marks this socket fd as "HTTP interceptable"
3. Guest calls `write(fd, "GET /debian/dists/trixie/InRelease HTTP/1.1\r\n...")`
4. JS buffers until `\r\n\r\n`, parses the HTTP request
5. JS fires `fetch(url, { headers })` — native browser HTTP, uses browser's DNS, TLS, HTTP/2, connection pooling
6. JS streams the response back: first synthesize HTTP response headers into the socket buffer, then stream the body
7. Guest reads the response via `read(fd, ...)` — thinks it's talking to a TCP socket

For HTTPS (port 443): same pattern but the guest thinks it's doing TLS. Intercept before the TLS handshake. The browser's `fetch()` handles TLS natively. The guest's OpenSSL never runs — massive performance win.

CheerpX does something similar. ~200 lines of JS in the socket handler.

---

## Phase 5: JIT — Blink's DSL Retargeted to WASM (REQUIRED for production)

### What's broken

Interpretation only. Blink interprets x86-64 instructions one at a time. This is 50-100x slower than native. CheerpX's JIT gets to 5-10x slower than native. Without JIT, CPU-bound workloads (GCC compilation, Python scripts, Node.js execution) are unusably slow.

### Correct implementation

Blink already has a JIT (`jit.c`) that translates x86-64 basic blocks to host native code via an internal DSL. The DSL is architecture-independent. Retarget the DSL to emit WASM bytecodes instead of native machine code.

**Tier 1 (this phase):** Blink's existing DSL → WASM bytecodes → `WebAssembly.compile()` → browser's JIT compiles to native. Hot basic blocks run at near-native speed. This is exactly what v86 does with its x86-to-WASM JIT (`src/rust/jit.rs` in `github.com/copy/v86`, BSD-2-Clause).

**Tier 2-3 (post-YC):** Cranelift (Rust, compiled to WASM) for more aggressive optimization. Deferred.

**References:**
- v86's JIT: `github.com/copy/v86` (BSD-2-Clause) — x86-to-WASM JIT in production for years
- Blink's `jit.c` — the DSL is already there, just emitting to the wrong target

---

## Phase 6: Remaining Syscall / Behavioral Fixes

### Item 6a: Child networking is dead

All socket ops return -1 in `engine-worker.js`. Forked children can't do ANY networking. dpkg configure scripts that need network fail silently.

**Fix:** Wire atua-net's Wisp relay into the child worker the same way it's wired into the parent. Share the Wisp WebSocket connection via the main thread relay, or open a new Wisp connection per child.

### Item 6b: ftruncate is a no-op in child

Line 77 in child's host_syscall: `case 77: return 0` — doesn't actually truncate.

**Fix:** Implement real truncation on the child's VFS file object.

### Item 6c: The `free` crash on apt exit

Noted as "known issue" in session, never fixed. If apt crashes during cleanup, it may not flush dpkg database state, may leave lock files.

**Fix:** Audit the exit path. The `restore_fork` browser path is correct (no NewMachine). The crash is likely in musl's atexit handlers trying to free memory that was allocated in a different state. If the crash is ONLY during exit (after apt has completed its work), it can be handled by catching the trap in the JS wrapper and reporting clean exit. If it corrupts state before exit, the post-fork allocation audit must be extended.

### Item 6d: Worker module caching

Each fork spawns a new Worker that fetches and compiles `engine.wasm` from scratch. `WebAssembly.Module` is transferable via `postMessage`. Compile once on the main thread, transfer the pre-compiled module to each child Worker.

### Item 6e: Worker pool

Don't create and destroy Workers per fork. Pre-spawn 4-8 Workers at boot. When fork happens, grab one from the pool. When the child exits, return the Worker to the pool. Worker creation has OS-level overhead.

---

## Execution Order

This is not a menu. Execute in this order. Do not skip ahead.

1. **Phase 1 (VFS correctness)** — Items 1a through 1h. All JS-only. No WASM rebuild. ~1 session.
2. **Phase 0 (Fork architecture)** — Fix mmap page gap, remove full copy, fork+exec fast path, wire COW. ~2 sessions.
3. **Phase 2 (Rootfs)** — Debian rootfs with Nitro as init, uutils as coreutils. ~1 session.
4. **Phase 3 (OPFS persistence)** — Wire overlay flush to OPFS via opfs-tools or happy-opfs. ~1 session.
5. **Phase 4 (HTTP fetch bypass)** — Intercept at socket level, route through native fetch. ~1 session.
6. **Phase 5 (JIT)** — Retarget Blink's DSL to emit WASM. ~3-5 sessions.
7. **Phase 6 (Remaining fixes)** — Child networking, ftruncate, free crash, worker caching, worker pool. ~1 session.

**Total: ~10-12 sessions to production.**

---

## What NOT To Do

- Do NOT approve any PR/commit with `// TEMPORARY` or `// TODO: replace` comments. If it's temporary, it's not done.
- Do NOT implement a simpler version and call it "phase 1" of the real version. Implement the real version.
- Do NOT return 0 from syscalls that should do real work (mkdir, unlink, rename in child worker).
- Do NOT use plain Maps where VirtualFS is required.
- Do NOT copy 26MB of memory per fork.
- Do NOT hand-roll VFS semantics without reading ZenFS/Unikraft vfscore first.
- Do NOT hand-roll OPFS access without using opfs-tools or happy-opfs.
- Do NOT write a custom init system. Use Nitro.
- Do NOT use BusyBox. Use uutils.
- Do NOT defer items in this document. Every item is architecturally required.

---

## Verification

Each phase has one gate: does real software work end-to-end?

- **After Phase 1:** `ls -la /`, `echo test >> /tmp/log && cat /tmp/log`, `find / -name "*.conf" | head` all produce correct output
- **After Phase 0:** `apt update` forks hundreds of times without OOM or sluggishness. Fork overhead < 10ms for fork+exec.
- **After Phase 2:** System boots with Nitro as PID 1. `ps` shows init, shell service. `apt install python3 && python3 -c "print('hello')"` works end-to-end.
- **After Phase 3:** Install python3, refresh page, python3 is still installed.
- **After Phase 4:** `apt update` completes in < 30 seconds, not 5+ minutes.
- **After Phase 5:** `gcc hello.c -o hello && ./hello` completes in < 10 seconds. Python scripts run at usable interactive speed.
- **After Phase 6:** All 14 Playwright pass. All LTP pass. No known defects list.
