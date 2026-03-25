# Atua Computer — CC Implementation Brief

**For:** Claude Code (Opus) implementation sessions
**From:** Architecture review session (March 25, 2026)
**Status:** The repo has scaffolding. Zero real implementation exists. Start from Phase B.

---

## 1. Current State of the Repo — Be Honest With Yourself

The `atua-computer` repo contains a mock. Read this section completely before touching any code.

### What's fake (all of it)

**`src/engine/atua-linux-engine.js`** — This is an if/else chain that pattern-matches command strings and returns hardcoded output. `node -v` returns `'v22.0.0-atua\n'`. `python --version` returns `'Python 3.12.0-atua\n'`. No x86 code executes. No ELF is loaded. No instruction is decoded. No syscall is handled. Delete this file entirely and replace it with a real engine integration.

**`src/engine/production-atua-linux-engine.js`** — Extends the fake engine, adds a label. Delete.

**`src/bridges/production-fs-bridge.js`** — Extends `InMemoryFsBridge`, adds a label saying "AtuaFS". It's still an in-memory JavaScript Map. Not connected to OPFS, AtuaFS, or any real filesystem. Delete and replace with real AtuaFS bridge.

**`src/bridges/production-net-bridge.js`** — Same pattern. Not connected to atua-net. Delete and replace.

**`src/bridges/production-pty-bridge.js`** — Same pattern. Not connected to xterm.js. Delete and replace.

**`src/syscall-tracer.js`** — Traces syscall names that the fake engine manually logs. The tracer itself is fine code. But it's recording fiction — the engine calls `this._tracer.trace({ syscall: 'epoll_wait' })` when you type `node -v`, but nothing actually executed epoll_wait. The tracer should record real syscall events from a real engine.

**All validation reports** — Every phase report says "Go" because tests validate the mock. Phase B "engine bring-up" tests check that `ls /` returns exit code 0 — the mock always returns 0. Phase C tests `node -v` — the mock returns the canned string. Phase F2 "production parity" checks if class names start with "Production" instead of "InMemory". All reports must be regenerated against real behavior.

**The progress tracker** says "All phases complete — production parity achieved." This is false. Phase A (scaffolding) is complete. Phase B has not started.

### What's real and worth keeping

**`src/runtime.js`** — The `AtuaComputerRuntime` class. The interface shape is correct: boot(), exec(), spawn(), signal(), read(), write(), install(), service(), checkpoint(), restore(), status(), reset(). Keep this as the outer shell. The real engine plugs in behind `this._engine.run()`.

**`src/mcp/tool-registry.js`** — The MCP tool surface. Correct tool names, correct schemas, correct delegation to runtime methods. Keep.

**The event emission pattern** — `_emit()` with typed events, timestamps, severity. Good observability. Keep.

**`docs/atua-computer-execution-plan.md`** — The phase plan is sound. The phases are correctly sequenced. The gate criteria are right. Keep as the roadmap.

**`atua-computer.md`** (root) — The authoritative architecture spec. Read it. Follow it. It governs all decisions.

**`atua-computer-implementation-addendum.md`** (root) — Implementation-level companion to atua-computer.md. Contains engine selection rationale, syscall coverage plan, JIT design, rootfs composition, and the full borrowable project landscape.

---

## 2. What You Are Actually Building

A browser-native Linux userspace runtime. Real x86-64 binaries from real Alpine packages execute inside a Blink-derived engine compiled to WASIX, running on @wasmer/sdk. The engine interprets x86-64 instructions and handles Linux syscalls by routing them to Atua's existing infrastructure (AtuaFS for files, atua-net for networking, xterm.js for terminal).

### The engine

Blink (github.com/jart/blink, ISC license) is a 63,500-line ANSI C11 x86-64 Linux userspace emulator. It interprets 500+ x86-64 instructions and handles 150+ Linux syscalls. It has an ELF loader (static and dynamic), a VFS layer, lazy flags computation, and passes 652 test suites.

Your job: compile Blink to WASIX using wasi-sdk + wasix-libc sysroot. Replace its native I/O with WASIX bridges to AtuaFS, atua-net, and xterm.js. The result is `engine.wasm` — a WASIX binary that @wasmer/sdk loads and runs.

### The bridges

Each bridge routes a category of Linux syscalls from the engine to the browser host:

- **FS bridge:** open, read, write, stat, readdir, mkdir, unlink, rename → AtuaFS (OPFS). Use the existing AtuaFS bridge infrastructure from atua-node where possible.
- **Net bridge:** socket, connect, send, recv → atua-net (Wisp relay). Use existing atua-net infrastructure.
- **Terminal bridge:** TTY read/write + ioctl for termios → xterm.js. Use xterm-pty patterns (ktock/xterm-pty, MIT).
- **Time:** clock_gettime → performance.now().
- **Random:** getrandom → crypto.getRandomValues().

### The rootfs

An ext2 disk image containing Alpine Linux x86-64 with:
- uutils coreutils (MIT, 96% GNU compat multicall binary) replacing BusyBox
- GNU grep, sed, gawk, findutils, tar, diffutils (retained for agent compat)
- bash
- Nitro init system (MIT, ~100KB static binary) as PID 1
- musl libc

The rootfs is served from a CDN. The engine reads ext2 blocks on demand via HTTP range requests. Fetched blocks cache in OPFS. Writes go to a copy-on-write overlay in OPFS. First boot fetches ~5-10MB of blocks, not the full image.

### The init system

Nitro (github.com/leahneukirchen/nitro, MIT) runs as PID 1 inside the engine. It's a real x86-64 binary that the engine executes like any other. It provides service supervision: start, restart on crash, stop, logging. The agent's persistent bash shell is a Nitro-managed service. The MCP `service()` tool maps to `nitroctl` commands running inside the engine.

---

## 3. Phase B — The First Real Task

**Goal:** Blink compiled to WASIX. Loads a static x86-64 ELF. Executes it. Output appears in the terminal.

### Step 1: Fork Blink and set up WASIX build

```
git clone https://github.com/jart/blink
```

Strip what doesn't apply in WASIX:
- Blink's native JIT (generates x86-64 machine code — not applicable in WASM)
- Native fork() calls (WASIX has no fork — needs serialization-based emulation later)
- Native mmap(PROT_EXEC) (WASM can't execute generated code in linear memory)

Keep everything else: interpreter, ELF loader, syscall dispatch, VFS, lazy flags, instruction decoder.

Compile with:
```
wasi-sdk + wasix-libc sysroot
-pthread -matomics -mbulk-memory
```

Target output: `engine.wasm` that @wasmer/sdk can load.

### Step 2: Minimal syscall set

Implement just enough to run a static "hello world" x86-64 ELF:
- `write(1, "hello\n", 6)` → route fd 1 to terminal bridge
- `exit(0)` → terminate execution
- `brk()` → manage WASM linear memory
- `arch_prctl()` → set FS base for TLS
- `uname()` → return fake Linux uname

### Step 3: Build a static test binary

Cross-compile a trivial C program with musl for x86-64:
```c
#include <unistd.h>
int main() {
    write(1, "hello from atua-computer\n", 25);
    return 0;
}
```
```
x86_64-linux-musl-gcc -static -o hello hello.c
```

### Step 4: Wire it into the runtime

Replace the fake engine with real engine integration in `runtime.js`:
- `boot()` → load engine.wasm via @wasmer/sdk, initialize bridges
- `exec("./hello")` → engine loads hello ELF, interprets x86-64 instructions, write() syscall routes to terminal, "hello from atua-computer" appears

### Step 5: Validate

The test is not "does the mock return exit code 0." The test is: "does a real x86-64 binary execute real instructions and produce real output through real bridges."

```javascript
// This is a real Phase B test
const runtime = new AtuaComputerRuntime({ /* real bridges */ });
await runtime.boot();
// hello is a REAL static x86-64 ELF binary
const result = await runtime.exec('./hello');
assert.strictEqual(result.stdout, 'hello from atua-computer\n');
assert.strictEqual(result.exitCode, 0);
```

---

## 4. Phase Sequence After B

Each phase builds on real, tested behavior from the previous phase. Do NOT skip ahead. Do NOT mark phases complete with mocked behavior.

### Phase C: Shell + Filesystem

- Expand syscall coverage: openat, read, write, close, stat, fstat, getdents64, mmap, mprotect, munmap, pipe, dup2, fcntl, ioctl
- FS bridge connected to real AtuaFS (OPFS)
- Alpine rootfs ext2 with block-streaming
- Nitro boots as PID 1, starts bash
- **Real test:** `ls /` lists actual files from the ext2 rootfs. `cat /etc/os-release` shows real Alpine os-release content. `echo hello > /tmp/test && cat /tmp/test` round-trips through real filesystem.

### Phase D: Networking + Packages

- Socket syscalls routed to real atua-net
- DNS resolution
- epoll (poll-based fallback), eventfd
- Dynamic ELF loading (musl dynamic linker)
- **Real test:** `apk update && apk add curl && curl https://httpbin.org/get` — real network traffic, real package installation, real binary execution.

### Phase E: Process Model + Services

- fork() via state serialization (fork+exec fast path)
- Pipes between processes
- Signal delivery (SIGINT, SIGPIPE, SIGCHLD)
- Nitro service supervision working
- **Real test:** `gcc hello.c -o hello && ./hello` (fork+exec in shell). `ls | grep pattern | wc -l` (pipes). `nitroctl start myservice && nitroctl status myservice` (services).

### Phase F: Agent Integration

- Full MCP tool surface wired to real engine
- Streaming stdout for long-running commands
- Checkpoint/restore (OPFS overlay snapshot)
- **Real test:** Agent drives full workflow through MCP: install packages, compile code, start service, stream logs, checkpoint, restore.

### Phase G: JIT (future)

- Hot basic block detection
- x86→WASM translator for top ~25 instructions
- Compilation via @wasmer/sdk module compilation API
- Dispatch patching with page-level invalidation
- **Real test:** Measured speedup on gcc, python, node benchmarks. No correctness regressions.

---

## 5. Technical References

### Primary source: Blink
- Repo: https://github.com/jart/blink
- License: ISC
- Key files: `blink/syscall.c` (syscall dispatch), `blink/x86.c` (instruction interpreter), `blink/loader.c` (ELF loading), `blink/vfs.c` (virtual filesystem)

### Init system: Nitro
- Repo: https://github.com/leahneukirchen/nitro
- License: MIT
- Compile statically against musl for inclusion in rootfs

### Coreutils: uutils
- Repo: https://github.com/uutils/coreutils
- License: MIT
- Build as multicall binary for rootfs

### Architecture reference for JIT (Phase G)
- v86 JIT: https://github.com/copy/v86 (BSD-2-Clause) — x86→WASM basic block compilation patterns
- QEMU-WASM TCG backend: https://github.com/ktock/qemu-wasm — study FOSDEM talk and patch series for architectural approach. Do NOT copy GPL code.

### POSIX semantics reference
- relibc (Redox OS): https://github.com/redox-os/relibc (MIT) — Rust implementation of POSIX functions, readable reference for syscall behavior
- Linux man pages (man7.org) — authoritative syscall specification

### Spec documents (in repo root)
- `atua-computer.md` — authoritative architecture spec. Governs all decisions.
- `atua-computer-implementation-addendum.md` — implementation details, technology selections, borrowable project catalog.

---

## 6. What "Done" Looks Like for Each Phase

Phase B is done when: a real x86-64 static ELF binary executes real instructions on a real Blink-on-WASIX engine and produces real output through a real terminal bridge. Not when a mock returns a canned string.

Phase C is done when: real bash runs on a real Alpine rootfs with real files accessible through a real AtuaFS bridge. Not when an in-memory Map returns hardcoded directory listings.

Phase D is done when: `apk add python3` downloads a real package over a real network via real atua-net and the installed binary actually runs. Not when `install()` writes a string to a Map.

If you find yourself writing `if (command === 'node -v') return 'v22.0.0'` — stop. That is the exact failure mode this repo already has. The entire point is that real binaries run on a real engine. If something doesn't work yet, say so in the validation report. Do not fake it.
