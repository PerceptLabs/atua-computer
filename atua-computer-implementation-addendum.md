# Atua Computer — Implementation Addendum

**Companion to:** `atua-computer.md` (the authoritative architecture and product spec)
**Purpose:** Implementation-level decisions, technology selections, competitive findings, and engineering guidance for Claude Code.
**Relationship:** `atua-computer.md` defines the what and why. This document defines the how. Where they conflict, `atua-computer.md` governs.

---

## 1. Architectural Decision: Single Engine, No Tiers

### What This Means

The `atua-computer` architecture uses one execution engine for everything. There is no Tier 1 / Tier 2 split. There is no WASIX fast path for individual tools. There is no routing layer that decides which tier handles a command. The engine runs real x86-64 Linux binaries from real Alpine packages.

### What This Replaces

| Removed Component | Why |
|-------------------|-----|
| atua-node (vendored Node.js on WASIX) | Real Node.js runs inside the engine |
| @wasmer/sdk as tool runtime | @wasmer/sdk still hosts the engine itself, but no longer hosts individual tools |
| wasmer/python, wasmer/clang, wasmer/curl | Real Alpine packages, installed via apk |
| WASIX compilation pipeline for tools | No tools are compiled to WASIX except the engine and core userland |
| Tier 1/Tier 2 router | One engine, no routing |
| node:sqlite polyfill | Real node:sqlite in real Node.js |
| unenv (Deno API compat layer) | Not needed — real Node.js, real Python, real everything |

### What Remains

| Component | Role | Status |
|-----------|------|--------|
| AtuaFS (OPFS) | Persistent shared filesystem | Exists |
| atua-net | Outbound networking (Wisp relay) | Exists |
| @wasmer/sdk | Hosts the engine WASM binary and provides runtime module compilation | Exists |
| xterm.js | Terminal rendering | Exists |
| CodeMirror 6 | Editor (reads/writes AtuaFS) | Exists |
| Pi / Conductor | Agent framework, MCP orchestration | Exists |
| Hashbrown / atua-ui | UI layer | Exists |

### Strategic Rationale

The multi-tier architecture existed because the full-distro execution path was assumed to be too slow for common tools. A competent JIT (added in Phase 6) removes that assumption. CheerpX proves a single engine with a JIT runs full Debian — including Node.js with V8's JIT — at usable speed. There is no reason to maintain parallel execution paths, WASIX compilation infrastructure, and a routing layer when one engine handles everything.

This decision is conditional. If the JIT proves infeasible or too slow, the multi-tier architecture can be restored. But the interpreter-only engine is still the correct first step regardless, because:
- It validates the syscall layer, bridges, and rootfs
- It runs I/O-heavy workloads (package management, file operations, shell) at acceptable speed even without JIT
- It provides the correctness baseline the JIT builds on

---

## 2. Engine Selection: Blink on WASIX

### Why Blink

Blink (by Justine Tunney) is the starting point for the engine. Selection rationale:

| Criterion | Blink | Alternatives Considered |
|-----------|-------|------------------------|
| Architecture level | Syscall emulation (no kernel) | QEMU-WASM: system emulation (kernel overhead). v86: hardware emulation (more overhead). |
| Bit width | x86-64 | CheerpX: 32-bit only. v86: 32-bit only. |
| Language | 63,500 lines ANSI C11 | QEMU: ~4M lines. v86: Rust+JS (browser-native, not WASIX-compatible). |
| License | ISC (permissive) | QEMU: GPL-2.0. CheerpX: proprietary. |
| WASM compat | Confirmed Emscripten build, 116KB binary (issue #8) | QEMU-WASM: works but ~20MB, GPL. |
| Syscall coverage | ~150-180 (fork, clone, execve, mmap, futex, etc.) | QEMU-user: ~300+ but not ported to WASM. |
| Test suite | 652 tests (194 Cosmopolitan, 350 LTP, 108 musl) | Best coverage of any open-source syscall emulator. |
| VFS | Built-in hostfs, procfs, devfs, mount() support | Already has the abstraction layer we need for AtuaFS bridge. |
| JIT (native) | Baseline JIT on x86-64/aarch64 (threads op functions) | Disabled in WASM mode, but proves the architecture supports JIT. |
| Runs Alpine | Proven: Blink 1.0 release runs bash inside Alpine minirootfs chroot | Validates the target distro works. |
| Dynamic ELF | Supports static and dynamic ELF loading | Required for Alpine packages linked against musl. |

### WASIX, Not Emscripten

Blink's existing WASM port uses Emscripten. We retarget to WASIX:

| | Emscripten (existing) | WASIX (target) |
|---|---|---|
| Compiler | emcc | wasi-sdk + wasix-libc sysroot |
| Runtime | Browser JS glue + WASM | @wasmer/sdk (already loaded) |
| Threading | Emscripten pthreads (SharedArrayBuffer) | WASIX threads |
| FS integration | Emscripten FS API | WASIX fd calls → existing AtuaFS bridge |
| Net integration | Emscripten POSIX socket proxy | WASIX socket calls → existing atua-net bridge |
| Module compilation (for JIT) | `WebAssembly.compile()` via JS import | @wasmer/sdk module compilation API |
| Async I/O | Asyncify or JSPI | SharedArrayBuffer + Atomics.wait() (WASIX pattern) |

The WASIX target means the engine plugs into existing Atua infrastructure. The FS bridge, net bridge, and thread model that atua-node already built are reused directly. The engine is just another WASIX binary on the same runtime.

### Compilation Approach

Same toolchain as atua-node's native libraries:

```
wasi-sdk + wasix-libc sysroot
  → Compile Blink's C11 source to WASM
  → Enable threading (-pthread -matomics -mbulk-memory)
  → Link against wasix-libc for POSIX primitives
  → Output: engine.wasm (~300KB-1MB depending on features)
```

Blink's C11 code has no platform-specific dependencies beyond standard POSIX. The port requires:
1. Replacing Blink's native `fork()` with WASIX-compatible process spawning
2. Replacing Blink's native `mmap()` with WASM linear memory management
3. Routing Blink's VFS calls through WASIX fd operations to AtuaFS
4. Routing Blink's socket calls through WASIX socket operations to atua-net
5. Disabling Blink's native JIT (it generates x86-64 machine code, not applicable in WASM)

Items 1-4 are the same class of work done for every WASIX port. Item 5 is a compile flag.

---

## 3. Syscall Coverage

### Design Principle

The engine implements Linux syscalls directly. When guest x86-64 code executes SYSCALL, the engine intercepts it, decodes the syscall number, and handles it. Unimplemented syscalls return ENOSYS with logging. The log drives implementation priority — implement what real workloads actually demand, not what might theoretically be needed.

### Coverage Tiers

#### Must Have — Shell, Coreutils, Package Management

Required for boot → Nitro → bash → basic commands → apk.

```
Process lifecycle:
  fork, clone, execve, exit, exit_group, wait4, waitid
  getpid, getppid, gettid, getpgrp, setpgid, setsid
  kill, tgkill, tkill

Memory management:
  mmap, munmap, mprotect, brk, mremap, madvise

File I/O:
  open, openat, close, read, write, pread64, pwrite64, lseek
  readv, writev, dup, dup2, dup3, fcntl, flock

File metadata:
  stat, fstat, lstat, fstatat, access, faccessat
  readlink, readlinkat, statfs, fstatfs

Directory operations:
  getdents64, mkdir, mkdirat, rmdir
  chdir, fchdir, getcwd

File manipulation:
  unlink, unlinkat, rename, renameat, renameat2
  link, linkat, symlink, symlinkat
  chmod, fchmod, fchmodat, chown, fchown, fchownat
  utimensat, futimesat

Pipes and polling:
  pipe, pipe2, ioctl
  select, pselect6, poll, ppoll
  epoll_create1, epoll_ctl, epoll_wait, epoll_pwait
  eventfd2

Signals:
  rt_sigaction, rt_sigprocmask, rt_sigreturn
  rt_sigsuspend, sigaltstack

Time:
  clock_gettime, clock_getres, gettimeofday
  nanosleep, clock_nanosleep

Identity:
  getuid, geteuid, getgid, getegid
  setuid, seteuid, setgid, setegid
  getgroups, umask

Resource:
  getrlimit, setrlimit, prlimit64, getrusage

Misc:
  uname, arch_prctl, set_tid_address, set_robust_list
  futex, sched_yield, sched_getaffinity, sched_setaffinity
  getrandom, prctl, sysinfo
```

Blink status: ~90% of the above is already implemented.

#### Should Have — Dev Tools, Node.js, Python

Required for real language runtimes and dev workflows.

```
Network:
  socket, connect, bind, listen, accept, accept4
  sendto, recvfrom, sendmsg, recvmsg
  setsockopt, getsockopt, getpeername, getsockname
  shutdown, socketpair

Threading:
  clone(CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND)
  futex (full: FUTEX_WAIT, FUTEX_WAKE, FUTEX_WAIT_BITSET, etc.)
  set_tid_address

PTY:
  openat(/dev/ptmx), ioctl(TIOCGWINSZ, TIOCSCTTY, TIOCSPGRP, etc.)
  ptsname-related operations

Inotify:
  inotify_init1, inotify_add_watch, inotify_rm_watch

Timer:
  timer_create, timer_settime, timer_delete
  timerfd_create, timerfd_settime, timerfd_gettime

Misc:
  memfd_create, copy_file_range, sendfile
  mlock, munlock
```

Blink status: ~60% implemented. Network basics exist. epoll was added for Linux hosts but needs WASM-portable implementation (poll-based fallback). eventfd is missing (issue #73). PTY and inotify are not implemented.

#### Stub Initially — Add When Demanded

```
Namespace:     unshare, setns, pivot_root
Extended attrs: getxattr, setxattr, listxattr, removexattr
AIO:           io_setup, io_submit, io_getevents
io_uring:      io_uring_setup, io_uring_enter, io_uring_register
Keyring:       add_key, request_key, keyctl
```

These return ENOSYS. Most programs handle ENOSYS gracefully.

### Syscall Bridge Architecture

Each syscall category maps to a host bridge:

```
File operations     → WASIX fd calls      → AtuaFS (OPFS)
Network operations  → WASIX socket calls   → atua-net (Wisp relay)
Terminal I/O        → WASIX fd + ioctl     → xterm.js
Process operations  → Engine-internal      → Web Worker management
Memory operations   → Engine-internal      → WASM linear memory
Time operations     → WASIX clock calls    → Browser performance.now()
Random              → WASIX random calls   → crypto.getRandomValues()
```

### Reference Material for Syscall Semantics

When implementing syscall behavior, consult in this order:
1. Linux man pages (man7.org) — authoritative specification
2. Linux Test Project test cases — concrete expected behavior
3. Blink's existing implementation — proven working code (ISC license)
4. relibc (Redox OS) — clean Rust implementation of POSIX functions, MIT license, readable reference for understanding semantics of complex syscalls like signal handling, fork, exec
5. musl libc source — how the C library wraps syscalls, useful for understanding what arguments look like in practice

---

## 4. JIT Design (Phase 6)

### Architecture: Two-Tier Execution

The engine uses a two-tier execution model, matching the approach described in CheerpX's public documentation and v86's public implementation:

**Tier 1 — Interpreter with Lazy Flags (Phase 1-5)**

Standard decode-dispatch loop. Blink already has this, including lazy flags computation.

Lazy flags: x86 FLAGS register is set by almost every ALU instruction but rarely read before the next ALU instruction overwrites it. Instead of computing flags after each instruction, save the operands and operation type. Compute flags only when something reads them (jcc, cmov, setcc, pushf). This eliminates 60-80% of flag computation. Blink already implements this.

**Tier 2 — x86→WASM Basic Block JIT (Phase 6)**

Hot basic blocks are compiled to WASM modules and executed via @wasmer/sdk.

```
Execution flow:
  1. Interpreter runs, counts basic block entries
  2. Block hits execution threshold (e.g., 64 times)
  3. JIT translator walks the block's x86 instructions
  4. Emits WASM binary format bytes into a buffer
  5. Passes buffer to host via WASIX import
  6. Host calls @wasmer/sdk to compile WASM module
  7. Host returns callable function handle
  8. Engine patches dispatch: next entry to this block calls JIT'd function
  9. JIT'd function reads/writes guest registers + memory via shared linear memory
  10. Returns next program counter to interpreter
```

### WASM Module Compilation via @wasmer/sdk

The engine cannot call `WebAssembly.compile()` directly — it's a WASIX binary, not browser JS. Instead:

```
Engine (WASIX)                          Host (JS/@wasmer/sdk)
─────────────                           ────────────────────
Generate WASM bytes for basic block
  ↓
Call imported host function:
  compile_block(wasm_bytes, block_addr)
                                        Receive WASM bytes
                                        @wasmer/sdk: compile module
                                        @wasmer/sdk: instantiate with imports
                                          (guest registers, guest memory)
                                        Store compiled instance in cache
                                        Return function handle
  ↓
Receive function handle
Store in dispatch table at block_addr
  ↓
Next time block_addr is hit:
  Call through function handle
  JIT'd code executes at near-native speed
  Returns next PC
  Interpreter continues from there
```

### Instructions to JIT First

These ~25 instruction patterns cover ~80% of executed instructions in typical programs:

```
Data movement:    MOV (reg↔reg, reg↔mem, imm→reg, imm→mem)
                  LEA, PUSH, POP, MOVZX, MOVSX, XCHG
Arithmetic:       ADD, SUB, INC, DEC, NEG, IMUL
Logic:            AND, OR, XOR, NOT, TEST
Shift:            SHL, SHR, SAR
Compare/branch:   CMP, Jcc (all conditions), JMP, CALL, RET
```

Each instruction translates to a small sequence of WASM opcodes (i64.load, i64.add, i64.store, etc.). The translation function for each is ~20-50 lines of C. Total translator code: ~1000-2000 lines.

### What Stays in the Interpreter

- Floating point (x87, SSE scalar) — complex, rarely in hot integer loops
- SIMD (SSE2/SSE3/AVX) — wide, complex encoding
- String operations (REP MOVSB, etc.) — rare in hot paths
- System instructions (CPUID, RDTSC) — infrequent
- Obscure addressing modes — handle in interpreter, JIT common patterns only

The interpreter is always the correctness fallback. Every instruction works in the interpreter. The JIT only needs to handle what's hot.

### Self-Modifying Code

When guest code writes to a memory page containing JIT'd blocks:
1. Engine detects the write (memory write tracking per page)
2. Invalidates all JIT'd blocks on that page
3. Reverts to interpreter for those addresses
4. Blocks can be re-JIT'd if they become hot again

This handles V8's JIT (Node.js), which generates and modifies x86 code at runtime. CheerpX handles this — their public documentation describes it as "robust" support for self-modifying code. The page-level invalidation approach is standard in dynamic binary translators.

### Performance Expectations (Honest)

These are targets, not promises. Real numbers require real prototypes.

| Workload | Interpreter Only | With JIT (target) | Rationale |
|----------|-----------------|-------------------|-----------|
| Shell interaction | Responsive | Responsive | Few instructions between syscalls |
| File operations (cp, grep, find) | 3-8x native | 2-5x native | I/O-bound, bridge speed dominates |
| Package management (apk add) | 3-8x native | 2-5x native | Mostly I/O + network |
| Python script | 15-30x native | 5-15x native | CPython bytecode dispatch loop JITs well |
| GCC compilation | 20-40x native | 5-15x native | Integer-heavy hot loops |
| Node.js hello world | Very slow (~30s+) | 5-15s (target) | V8 startup is heavy, JIT-in-JIT |
| Node.js running server | Very slow | 5-15x native (target) | Event loop hot path needs JIT |
| Rust compilation (cargo) | 30-60x native | 10-30x native | LLVM is enormous, needs float JIT too |

CheerpX's published claims: 2-3x best case for integer, 5-10x average. They have years of JIT maturity. We should not expect to match them in year one.

---

## 5. Filesystem Architecture

### Block-Level Streaming

Inspired by CheerpX's public documentation of their HttpBytesDevice + OverlayDevice + IDBDevice pattern. The Alpine rootfs is an ext2 image served from a CDN. Only accessed blocks are downloaded.

```
CDN:   /images/alpine-x86_64-dev.ext2       Full rootfs image (never fully downloaded)
OPFS:  /.atua/blocks/                        Fetched blocks, cached permanently
OPFS:  /.atua/overlay/                       Write overlay (copy-on-write)
```

Flow for reading a file:
1. Engine ext2 code determines which disk blocks are needed
2. Check write overlay in OPFS (local writes take priority)
3. Check block cache in OPFS (previously fetched blocks)
4. Fetch missing blocks from CDN via HTTP range request (~4KB each)
5. Cache fetched blocks in OPFS for permanent reuse

First boot fetches ~5-10MB of blocks. Subsequent visits start from cache.

### Mount Table

```
/                → Block-streaming ext2 (Alpine rootfs, read + write overlay)
/mnt/project     → AtuaFS direct (user's project, shared with editor)
/proc            → Synthetic procfs (engine-generated)
/dev             → Synthetic devfs (null, zero, urandom, tty, ptmx, shm)
/tmp             → tmpfs (in-memory, cleared on reset)
/run             → tmpfs (Nitro control socket, PIDs)
```

### File Visibility Contract

Files in `/mnt/project` are shared between the engine and the editor via AtuaFS. A file written by the editor is immediately visible to guest processes. A file written by guest processes (e.g., `gcc -o hello hello.c`) is immediately visible in the editor. This is the same AtuaFS used by everything else in Atua.

Files in `/` (the rootfs) are private to the engine. The agent doesn't edit `/usr/bin/python3`. Package installations (`apk add`) write to the overlay.

---

## 6. Networking

Syscall-level. No emulated NIC, no emulated kernel TCP stack, no virtio-net. Socket syscalls route directly to the existing atua-net bridge via WASIX socket operations.

```
Guest calls: socket(AF_INET, SOCK_STREAM, 0)
Engine:      Creates fd in process table → returns fd

Guest calls: connect(fd, {addr, port}, ...)
Engine:      → WASIX socket call → atua-net → Wisp relay → real TCP

Guest calls: write(fd, data, len)
Engine:      → WASIX socket call → atua-net → Wisp → sends data

Guest calls: read(fd, buf, len)
Engine:      → WASIX socket call → atua-net → Wisp → receives data
```

HTTPS works (atua-net handles TLS). DNS works (intercept resolver queries, resolve via atua-net or browser fetch). `curl`, `git clone`, `apk add`, `pip install`, `npm install` all work through the same path.

---

## 7. Process Model

### fork() in WASIX

The hardest problem. Blink on native POSIX uses real `fork()`. WASIX has no `fork()`.

**Solution: State serialization + Worker spawning.**

1. Guest calls fork()
2. Engine serializes state (registers, dirty memory pages, fd table, signal handlers)
3. Host spawns new WASIX instance (new @wasmer/sdk instance in a Web Worker)
4. New instance deserializes parent state
5. Parent returns child PID; child returns 0

**fork+exec fast path (critical optimization):**

95%+ of fork() calls are immediately followed by execve() (every shell command does this). Detect this pattern and skip the full state serialization. Just spawn a new Worker and load the new binary directly. This transforms the expensive operation into a cheap one for the dominant case.

### clone() for Threads

clone(CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND) creates a thread. Threads share the WASM linear memory (SharedArrayBuffer). Each thread runs as a WASIX thread managed by @wasmer/sdk. Futex operations map to Atomics.wait() / Atomics.notify(). This is the standard WASIX threading model.

### Nitro as PID 1

Engine boots, loads `/sbin/init` (Nitro) as the first x86-64 binary. Nitro provides:

- PID 1 responsibilities (zombie reaping, signal propagation, orderly shutdown)
- Service supervision (start, restart on crash, stop, logging)
- `nitroctl` for programmatic control (maps to MCP service() tool)
- Directory-based configuration (services are scripts in `/etc/nitro/`)
- Zero runtime memory allocations, event-driven, no polling

Nitro's syscall footprint: fork, exec, wait, pipe, signal handling, file I/O. All Phase 1 syscalls. No cgroups, no dbus, no kernel modules.

Pre-configured services in the rootfs:

```
/etc/nitro/
  SYS/
    setup           # mount /proc, /dev; set hostname, PATH, env defaults
    finish          # orderly shutdown
  agent-shell/
    run             # exec bash -l
    log -> .log     # capture shell output
```

The agent's persistent shell is a Nitro-managed service. If bash crashes, Nitro restarts it automatically. Additional services are created at runtime by the agent via the service() MCP tool.

### Reference Material for Process Model

Redox OS's `redox-rt` library (MIT license) implements fork, exec, and signal handling in userspace Rust — outside the kernel. This is architecturally similar to what our engine does (implementing these operations outside a kernel, in the host). Their signal delivery pattern using atomic bitsets in the Thread Control Block is directly applicable.

---

## 8. Alpine Rootfs Composition

### Core Userland

#### uutils coreutils (replacing BusyBox)

uutils is a cross-platform Rust reimplementation of GNU coreutils. MIT licensed. Version 0.6.0 achieves 96.28% compatibility with the GNU coreutils test suite. All programs are implemented. Differences with GNU are treated as bugs.

Builds as a multicall binary (~10-15MB) with symlinks for each command. Drop-in replacement for BusyBox coreutils with dramatically better GNU compatibility.

**Why not BusyBox:** BusyBox's `sed` doesn't support all GNU extensions. Its `grep` is missing flags. Its `find` behaves differently. Agents learned Linux from GNU-flavored documentation. Every BusyBox quirk is a silent agent failure.

**Why not GNU coreutils:** GPL-3.0 license, larger binary size (~15-20MB), no multicall binary. uutils provides 96% of the compatibility at MIT license and lower size.

**Why not chimerautils (FreeBSD ports):** BSD tools behave differently from GNU on flags and options. Agents' training data assumes GNU behavior. Wrong direction for compatibility.

#### GNU Tools Retained

Certain GNU tools are retained because their flag differences bite agents hardest:

- **GNU grep** — `-P` (Perl regex) is GNU-only and heavily used
- **GNU sed** — `-i` without backup extension is GNU behavior
- **GNU awk (gawk)** — field-splitting edge cases differ from mawk/nawk
- **GNU findutils** — `-print0`, `-exec +` syntax
- **GNU tar** — `--transform`, long option naming
- **GNU diffutils** — `--color`, `-u` unified format

#### libc: musl

musl stays. The compatibility gaps (locale collation, dlopen chains, threading edge cases) don't affect agent workloads. What agents care about — file I/O, process management, networking, string handling — musl handles correctly.

For the rare package that genuinely needs glibc (precompiled binary wheels, proprietary tools), Alpine has `apk add gcompat` which provides a glibc compatibility shim. This covers the edge cases without bloating the base.

#### Init System: Nitro

Nitro (by Leah Neukirchen, Void Linux maintainer). MIT license. Single static binary (~100KB). Zero runtime allocations. Event-driven, no polling. Designed for containers, embedded, and minimal environments — exactly the profile of our engine.

### Size Budget

| Component | Compressed | In ext2 | Notes |
|-----------|-----------|---------|-------|
| musl libc + base Alpine | ~2MB | ~8MB | Minimal bootable base |
| uutils coreutils | ~4MB | ~12MB | Multicall binary, 96% GNU compat |
| GNU grep/sed/awk/find/tar/diff | ~2MB | ~6MB | Retained for agent compat |
| bash | ~0.5MB | ~2MB | Agent's shell |
| Nitro + config | ~0.1MB | ~0.2MB | PID 1 |
| **Minimal bootable** | **~9MB** | **~28MB** | Boots to shell |
| Dev toolkit (gcc, python, git, node, curl, make, cmake) | ~40MB | ~120MB | On-demand via apk or pre-installed |
| **Full dev image** | **~50MB** | **~150MB** | Never fully downloaded |

With block-level streaming, first boot fetches ~5-10MB. Typical dev session: ~30-50MB of blocks. The 150MB image sits on the CDN.

### Engine Size

| Component | Size |
|-----------|------|
| Engine WASM binary (Blink on WASIX) | ~300KB-1MB |
| JS bridge code (block streaming, module compilation, terminal) | ~50-100KB |
| **Engine total** | **~500KB-1.5MB** |

**First meaningful output (bash prompt):** Engine (~1MB) + initial rootfs blocks (~5MB) = ~6MB downloaded.

---

## 9. MCP Tool Surface

The full `AtuaComputer` interface is defined in `atua-computer.md` and is authoritative. This section provides implementation notes for each tool.

### exec(command, opts?)

Sends command to the persistent agent-shell service's stdin. Reads stdout/stderr until the shell prompt returns. Extracts exit code via a prompt protocol (e.g., echo `$?` after each command with a unique delimiter).

The persistent shell maintains cwd, environment variables, shell variables, aliases, and command history across calls. If bash crashes, Nitro restarts it — the MCP bridge detects the restart and re-establishes the I/O connection.

### spawn(command, opts?)

Starts a new process. For short-lived commands, can run via exec() and return a ProcessHandle. For long-lived processes, creates an ad-hoc Nitro service with the command as the run script.

### service(action, name, opts?)

Maps directly to Nitro operations:
- `create`: Write `/etc/nitro/{name}/run` script, chmod +x
- `start`: `nitroctl start {name}`
- `stop`: `nitroctl stop {name}`
- `restart`: `nitroctl restart {name}`
- `status`: `nitroctl status {name}` → parse output
- `logs`: Read from Nitro's log service for the named service

### install(packages)

Runs `apk add {packages}` via exec(). Returns structured result with installed package list, stdout, stderr, exit code.

### checkpoint(label?) / restore(id)

Checkpoint captures:
- The ext2 write overlay (OPFS snapshot)
- The current Nitro service state (which services exist, their configs)
- Open file state is NOT captured (checkpoint is filesystem-level, not process-level)

Restore:
- Reverts the ext2 write overlay to the checkpoint
- Stops all Nitro services
- Re-reads service configs from the restored overlay
- Restarts services that were running at checkpoint time

### reset()

Deletes the ext2 write overlay entirely. Clears block cache if desired. Next boot fetches fresh blocks from CDN. Clean state.

### status()

Combines:
- `nitroctl status` → service list with states
- Process table from engine → running processes
- OPFS usage query → disk stats
- Engine uptime → uptime

---

## 10. Competitive Landscape and Borrowable Projects

### Primary Engine Reference

| Project | License | What We Borrow | How |
|---------|---------|---------------|-----|
| **Blink** (jart/blink) | ISC | Engine starting point — x86-64 interpreter, syscall layer, ELF loader, VFS, lazy flags | Fork and compile to WASIX |

### JIT Reference Material (Phase 6)

| Project | License | What We Study | How |
|---------|---------|--------------|-----|
| **v86** (copy/v86) | BSD-2-Clause | x86→WASM JIT patterns — proven basic block translation in the browser, WASM binary emission | Study public source for translation patterns (32-bit, we extend to 64-bit) |
| **QEMU-WASM** (ktock/qemu-wasm) | GPL-2.0 | TCG WASM backend — two-tier TCI+TCG model, hot block detection, WASM module compilation patterns | Study public FOSDEM talk, patch series, and documentation for architectural approach. Do NOT copy GPL code. |

### Infrastructure

| Project | License | What We Use | How |
|---------|---------|------------|-----|
| **Nitro** (leahneukirchen/nitro) | MIT | PID 1, service supervision | Include static binary in rootfs |
| **uutils** (uutils/coreutils) | MIT | GNU-compatible coreutils | Include multicall binary in rootfs |
| **xterm-pty** (ktock/xterm-pty) | MIT | Terminal bridge patterns | Reference for PTY integration |
| **container2wasm** (ktock/container2wasm) | Apache-2.0 | Dockerfile → ext2 image pipeline | Reference for rootfs build process |

### POSIX Semantics Reference (Read-Only)

| Project | License | What We Study | How |
|---------|---------|--------------|-----|
| **relibc** (redox-os/relibc) | MIT | POSIX function implementations in Rust — fork, exec, signals, pthreads | Read for understanding syscall semantics. Especially signal delivery via atomic bitsets in TCB. |
| **redox-rt** (redox-os) | MIT | Userspace POSIX implementation patterns — how to implement fork/exec/signals outside a kernel | Architectural reference for engine-side process management |

### Future Opportunities (Track, Don't Build On)

| Project | Why Track | Current Status |
|---------|-----------|---------------|
| **linux-wasm** (joelseverin/linux-wasm) | Linux kernel compiled to WASM as native arch. Near-native speed. If it matures, could replace the x86 emulation layer for WASM-compiled binaries. | Tech demo. Crashes on basic commands. NOMMU (no mmap). 15,000 lines of LLVM patches. One developer. Not a foundation. |
| **QEMU-WASM user mode** | QEMU-user with TCG JIT in WASM would be our entire engine — syscall emulation + mature JIT — done by NTT Corp. | System mode works. User mode listed as future work. TCG WASM backend being upstreamed to mainline QEMU. Watch the mailing list. |
| **WasmLinux** | LKL (Linux Kernel Library) as WASM — kernel as a library, not emulated. | NOMMU. No fork. Piping broken. Early prototype. Interesting architecture, not buildable. |
| **WebCM** (edubart/webcm) | RISC-V emulator, 500 MIPS, single 32MB WASM file. Clean architecture. | RISC-V only. No x86 binary compat. Different ecosystem. |

---

## 11. Implementation Roadmap

Follows `atua-computer.md` Phase structure. This section adds implementation-level detail.

### Phase 0: Clean-Room Framework

Per `atua-computer.md`. This addendum document, plus:
- Standards reference index (Linux man pages, ELF spec, WASM spec, ext2 spec)
- Acceptance test skeleton (shell boot, file sharing, network, package install, Node.js, service lifecycle, checkpoint/restore — per atua-computer.md §Testing)

### Phase 1: Engine Bring-Up

**Goal:** Blink compiled to WASIX, runs a static x86-64 ELF, stdout appears in terminal.

| Task | Details |
|------|---------|
| Fork Blink | Strip native JIT, native fork, native mmap. Keep interpreter, ELF loader, syscall dispatch, VFS, lazy flags. |
| WASIX build | wasi-sdk + wasix-libc sysroot. Enable threading. Resolve any C11 compat issues with wasix-libc. |
| Minimal syscall set | write, exit, brk — enough to run a static "hello world" ELF. |
| Terminal bridge | Route fd 1/2 writes to xterm.js via WASIX fd + host bridge. |
| Test | Compile a static x86-64 hello world with musl. Engine loads it, executes it, "hello" appears in terminal. |

**Acceptance per atua-computer.md:** Engine loads in a dedicated worker. A simple static x86-64 binary executes to completion. Basic stdout/stderr bridging works.

### Phase 2: Filesystem and Terminal

**Goal:** Shell boots. Shared project mount works.

| Task | Details |
|------|---------|
| FS bridge | Route Blink VFS → WASIX fd calls → AtuaFS. Implement open, read, write, stat, readdir, mkdir, unlink, rename via the existing AtuaFS bridge. |
| Block-streaming ext2 | JS-side ext2 block reader. HTTP range requests to CDN. OPFS block cache. Write overlay. |
| Alpine rootfs | Build ext2 image: base Alpine + uutils + bash + Nitro + GNU grep/sed/awk. Host on CDN. |
| Terminal | PTY/TTY ioctl for raw mode. Enough for bash to function (line editing, cursor movement, tab completion). |
| Nitro boot | Engine loads Nitro as PID 1. Nitro runs SYS/setup. Nitro starts agent-shell. Bash prompt appears. |
| Shared mount | `/mnt/project` mapped to AtuaFS project directory. Write file in editor → visible in shell. Write file in shell → visible in editor. |

**Acceptance per atua-computer.md:** Shell boots. Project file visibility in both directions. Terminal interaction sufficient for login shell.

### Phase 3: Networking and Packages

**Goal:** `apk add` works. Outbound networking functions.

| Task | Details |
|------|---------|
| Net bridge | Route Blink socket syscalls → WASIX socket calls → atua-net. Implement socket, connect, send, recv, setsockopt, getsockopt, getpeername, getsockname, shutdown. |
| DNS | Intercept queries to resolv.conf-configured nameserver, route through atua-net or browser fetch. |
| Missing syscalls | epoll (poll-based fallback), eventfd (in-memory pipe simulation), statfs (return reasonable defaults). |
| Dynamic ELF | Validate musl's dynamic linker loads shared libraries from the ext2 rootfs correctly. |
| Package test | `apk update && apk add curl && curl https://httpbin.org/get` end-to-end. |

**Acceptance per atua-computer.md:** Outbound fetch succeeds. Package manager installs test package set. Profile is reproducibly bootable.

### Phase 4: Process Model and Services

**Goal:** fork/exec works. Pipelines work. Nitro services work.

| Task | Details |
|------|---------|
| fork() | State serialization + WASIX instance spawning. fork+exec fast path. |
| Pipes | `ls | grep foo | wc -l`. Inter-process communication via SharedArrayBuffer or WASIX pipe primitives. |
| Signals | SIGINT (Ctrl+C), SIGPIPE, SIGCHLD. Basic signal delivery. Reference: Redox redox-rt atomic signal patterns. |
| Service lifecycle | Create Nitro service → start → status → logs → stop. Full cycle via nitroctl. |
| Shell persistence | Environment persists across exec() calls. cwd persists. Shell crash → Nitro restart → MCP bridge reconnects. |

**Acceptance per atua-computer.md:** Shell state persists. Managed service full lifecycle works. Process status is accurate enough for MCP use.

### Phase 5: Agent APIs and Checkpoints

**Goal:** Full AtuaComputer interface. Another agent can drive the runtime entirely through structured APIs.

| Task | Details |
|------|---------|
| MCP bridge | Wire exec(), spawn(), signal(), read(), write(), install(), service(), checkpoint(), restore(), reset(), status() to engine and Nitro. |
| Streaming | AsyncIterable over stdout for long-running commands. |
| Checkpoint | OPFS snapshot of ext2 write overlay + Nitro service configs. |
| Restore | Revert overlay, reconcile services. |
| Integration test | Agent installs packages, compiles code, starts service, streams logs, checkpoints, restores. Full workflow. |

**Acceptance per atua-computer.md:** Agent drives runtime entirely through structured APIs. Checkpoint/restore works for supported state subset.

### Phase 6: JIT

**Goal:** Hot code runs faster. No correctness regressions.

| Task | Details |
|------|---------|
| Block detection | Execution counter per basic block entry. Threshold triggers JIT. |
| WASM emitter | Emit valid WASM binary format for basic blocks. ~25 instruction patterns (mov, add, sub, cmp, jcc, call, ret, push, pop, lea, test, and/or/xor, shl/shr, imul, movzx/movsx). |
| Host compilation bridge | WASIX import: engine passes WASM bytes to host. Host uses @wasmer/sdk to compile + instantiate. Returns callable handle. |
| Dispatch patching | Replace interpreter block entry with JIT'd function call. Cache with page-level invalidation. |
| Benchmarking | Measure real workloads: gcc, python, node. Identify next instructions to add. Iterate. |

**Acceptance per atua-computer.md:** No correctness regressions vs interpreter. Measured speedup on defined benchmarks. Unsupported instructions fall back to interpreter.

---

## 12. Risk Register (Implementation-Level)

Supplements `atua-computer.md` §Risk Register with implementation specifics.

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Blink WASIX compilation fails or produces buggy binary | High — blocks everything | Blink is ANSI C11 with minimal platform deps. Start this immediately in Phase 1 to validate. If WASIX port is blocked, Emscripten remains as fallback (less integrated but proven working). |
| WASIX threading model incompatible with Blink's fork() emulation | High — blocks Phase 4 | Validate fork+exec fast path early with minimal prototype. If WASIX instance spawning is too slow or limited, explore SharedArrayBuffer-based memory cloning within single instance. |
| @wasmer/sdk cannot compile WASM modules at runtime (for JIT) | Medium — blocks Phase 6 only | Verify this capability early with a minimal test: generate trivial WASM bytes, compile via @wasmer/sdk, call result. If blocked, JIT can fall back to browser-side `WebAssembly.compile()` via message passing to a JS Worker. |
| ext2 block streaming too slow or complex | Medium — degrades startup UX | ext2 is well-specified and multiple JS implementations exist. CheerpX proves the pattern in production. If ext2 is too complex initially, fall back to tar download + OPFS unpack (slower first boot, same subsequent behavior). |
| Alpine packages need syscalls we haven't implemented | Medium — specific packages fail | ENOSYS stub + logging. Fix in priority order. Expected to be an ongoing process, not a one-time problem. |
| Dynamic ELF loading edge cases with musl | Medium — some binaries crash | musl's dynamic linker is simpler than glibc's. Test with top-20 Alpine packages early. Fix ELF loader issues as found. |
| epoll in WASIX has no native equivalent | Medium — Node.js, Python async need it | Implement as poll()-based fallback. Correctness maintained. Performance acceptable for agent workloads (not high-connection servers). |
| Memory limits (WASM 4GB linear memory) | Low for now — hits edge cases | Sufficient for most dev workloads. Error clearly when exceeded. WASM memory64 proposal (browser support growing) will lift this eventually. |
| JIT is harder than estimated | Low — only affects Phase 6 | Interpreter works without JIT. JIT is purely additive. Each instruction added makes things faster. Ship without JIT, add incrementally. Even interpreter-only is viable for agent workloads that are primarily I/O. |
| Nitro fails on engine's syscall set | Low — tiny syscall footprint | Nitro only needs fork, exec, wait, pipe, signals, file I/O — all Phase 1 syscalls. If Nitro fails, fall back to bash as PID 1 (works, no service supervision). |

---

## 13. Testing Strategy

Per `atua-computer.md` §Testing and Acceptance. Implementation notes:

### Acceptance Scenarios (mapped to phases)

| Scenario | Phase | Test |
|----------|-------|------|
| Boot and Shell | 2 | Engine → Nitro → bash → `echo hello` → verify output → subsequent commands work |
| Shared Project Mount | 2 | Editor writes file → shell reads it. Shell writes file → editor sees it. |
| Outbound Networking | 3 | `curl https://httpbin.org/get` returns valid JSON |
| Package Installation | 3 | `apk add python3 && python3 -c "print('hello')"` |
| Real Node Runtime | 3+ | `apk add nodejs && node -e "console.log('hi')"` |
| Managed Service Lifecycle | 4 | Create service → start → status shows UP → logs show output → stop → status shows DOWN |
| Checkpoint and Restore | 5 | Checkpoint → write file → restore → file is gone |

### Syscall Conformance

Run Blink's existing test suites (652 tests) against the WASIX build. Track pass/fail delta against native Blink. Any regression is a bug.

### Real Workload Tests

Beyond synthetic tests, validate with real agent workflows:
- Clone a git repo, npm install, npm run build
- Write Python script, pip install dependencies, run it
- GCC compile a C project with multiple files and a Makefile
- Start a dev server as a Nitro service, curl it from inside the engine

---

## 14. Licenses

| Component | License | Role |
|-----------|---------|------|
| Blink | ISC | Engine starting point |
| Nitro | MIT | Init system |
| uutils coreutils | MIT | GNU-compatible coreutils |
| @wasmer/sdk | MIT | WASM runtime |
| Alpine packages | Various (MIT/GPL) | Rootfs contents |
| musl libc | MIT | Alpine's libc |
| Our engine code | MIT | WASIX port, JIT, bridges |

No GPL in the engine or bridge code. Alpine packages in the rootfs include GPL software (GCC, bash, etc.) but these are end-user programs running inside the engine, not linked into it. Standard distribution model.

---

## 15. Clean Room Compliance

Per `atua-computer.md` §Clean-Room Rules. This addendum was produced from:

**Allowed sources used:**
- Public documentation: CheerpX docs (cheerpx.io/docs), blog posts, FOSDEM talks. Blink README and release notes. v86 README. QEMU-WASM README, FOSDEM slides, LKML patch series. Nitro README. uutils README and release notes. relibc README. linux-wasm README and web page. WebCM README. Redox OS book.
- Public APIs: CheerpX npm package metadata and type definitions. Blink CLI interface. QEMU-WASM build instructions.
- Public standards: Linux syscall ABI (man pages), ELF format (System V ABI), x86-64 ISA (Intel SDM), WASM spec (webassembly.org), ext2 filesystem specification, WASIX specification (wasix.org).
- Black-box observations: CheerpX/WebVM public demo performance. QEMU-WASM public demo. linux-wasm public demo.

**Prohibited sources NOT used:**
- No proprietary source code was read (CheerpX engine internals, WebContainers internals).
- No decompilation or reverse engineering of proprietary binaries.
- No GPL source code will be copied into MIT-licensed engine code. QEMU-WASM and v86 are studied for architectural patterns only.

**Team split model:** This document is a research/spec team output. Claude Code (implementation team) implements from this document, public standards, and Blink's ISC-licensed source code. CC does not consult CheerpX internals, QEMU GPL source, or other prohibited materials.
