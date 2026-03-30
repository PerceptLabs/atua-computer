# atua-computer Full Remediation — One Plan, No Stops

**For CC. Execute sequentially. Do not stop between phases. Do not ask for review. Do not generate sub-plans. Read this document once, then execute every item top to bottom. only stop if you absolutly hit a wall and have had no luck fixing it, if you get stuck do research. Use subagents to help!

**What you are building:** A 64-bit Linux distribution that runs in the browser. Not a shell. Not a demo. A real system with init, persistence, process supervision, proper fork, proper VFS, and a JIT path. The competition is CheerpX — they run full 32-bit Debian with JIT, persistence, and hundreds of syscalls. You must match that AND beat it with 64-bit, clean architecture, and agent-native control.

**Governing documents:** `atua-computer.md`, `atua-computer-implementation-addendum.md`, `CLAUDE.md`. Read them. Follow them. This document enforces them against the current codebase which violates them.

**Rules:**
- No `// TEMPORARY` comments. If it's temporary, it's not done.
- No `return 0` from syscalls that should do real work.
- No plain Maps where VirtualFS is required.
- No hand-rolled implementations when proven libraries exist (CLAUDE.md rule).
- No full memory copy per fork.
- No deferrals. Every item in this document is architecturally required.
- After each phase: `npx playwright test` must pass 14/14. If it doesn't, fix before proceeding.

---

## Phase 1: VFS Correctness (JS-only, no WASM rebuild)

### 1a: O_APPEND

**Bug:** Zero occurrences of O_APPEND in the codebase. `write()` always writes at `file.position`. Shell `>>`, apt's dpkg.log, any append-mode file silently writes at offset 0 instead of appending.

**Files:** `src/browser/filesystem.js` (open method), `src/browser/engine-main-worker.js` (host_syscall case 1, case 20)

**Fix:**
- In `VirtualFS.open()`: when creating the fd object, add `append: !!(flags & 0x400)` (O_APPEND = 0x400 on Linux x86-64)
- In `VirtualFS.write()`: if `this.openFiles.get(fd).append`, set offset to `file.content.length` before writing
- In `engine-main-worker.js` host_syscall case 1 (SYS_write): before `vfs.write(a, buf, file.position)`, check `if (file.append) file.position = file.content.length`
- In case 20 (SYS_writev): same check
- In child worker `engine-worker.js` case 1 and case 20: same check

**Verify:** `echo test >> /tmp/log && echo test >> /tmp/log && wc -l /tmp/log` → output is `2`, not `1`.

### 1b: O_EXCL

**Bug:** `open()` with `O_CREAT | O_EXCL` succeeds even if file exists. dpkg lock files don't work.

**File:** `src/browser/filesystem.js` open method, around the O_CREAT block

**Fix:** Before the `O_CREAT` creates a new file, check:
```javascript
if ((flags & 0x40) && (flags & 0x80)) { // O_CREAT | O_EXCL
  if (this.files.has(resolved) || this.dirs.has(resolved)) return -17; // EEXIST
}
```

Also add the same check in `engine-main-worker.js` host_syscall case 2 / case 257 (SYS_open / SYS_openat) and in the child worker's case 2 / case 257.

### 1c: readdir missing `.` and `..`

**Bug:** `readdir()` returns only real children. `find`, `ls -a`, bash glob, `realpath` expect `.` and `..`.

**File:** `src/browser/filesystem.js` readdir method

**Fix:** At the top of `readdir()`, before scanning children:
```javascript
const entries = [
  { name: '.', type: 'dir' },
  { name: '..', type: 'dir' },
];
```
Then append real children. Same fix in child worker's getdents64 handler (case 217) — prepend `.` and `..` to `_dirEntries`.

### 1d: stat returns Date.now() as default mtime

**Bug:** `meta.mtime || now` where `now = Math.floor(Date.now() / 1000)`. Every stat call returns a different mtime. `make` and `dpkg` compare mtimes — they see phantom changes.

**Files:** `src/browser/filesystem.js` (constructor), `src/browser/engine-main-worker.js` (stat handlers cases 4/5/6/262)

**Fix:**
- Add `this.bootTime = Math.floor(Date.now() / 1000)` in `VirtualFS` constructor
- In all stat handlers: replace `meta.mtime || now` with `meta.mtime || vfs.bootTime`
- Same for `meta.atime || vfs.bootTime`
- In `fork_spawn`, include `bootTime: vfs.bootTime` in the child message
- In child worker stat handlers: use the inherited `bootTime`, not `Date.now()`

### 1e: F_DUPFD / F_DUPFD_CLOEXEC returns same fd (dup is broken)

**Bug:** `engine-main-worker.js` line 680: `return a` — returns the SAME fd. dup() doesn't actually dup. Every shell pipeline, every fork+exec fd setup is broken.

**File:** `src/browser/engine-main-worker.js` fcntl handler (case 72)

**Fix:** Replace the entire case 72 block in BOTH parent and child workers:
```javascript
case 72: { // SYS_fcntl(fd=a, cmd=b, arg=c)
  const file = vfs.openFiles.get(a);
  if (!file) return -9; // EBADF
  if (b === 0 || b === 1030) { // F_DUPFD or F_DUPFD_CLOEXEC
    const newFd = vfs.nextFd++;
    // dup'd fds share the same file description — use same content reference
    vfs.openFiles.set(newFd, {
      content: file.content, // shared reference, not copy
      position: file.position,
      path: file.path,
      isDir: file.isDir,
      dirPath: file.dirPath,
      special: file.special,
      append: file.append,
      cloexec: (b === 1030), // F_DUPFD_CLOEXEC sets cloexec
    });
    return newFd;
  }
  if (b === 1) return file.cloexec ? 1 : 0; // F_GETFD
  if (b === 2) { file.cloexec = !!(c & 1); return 0; } // F_SETFD
  if (b === 3) { // F_GETFL
    let fl = 0;
    if (file.append) fl |= 0x400;
    return fl;
  }
  if (b === 4) return 0; // F_SETFL
  return 0;
}
```

**Note on shared file description:** Real POSIX dup makes two fds share the same offset — read from one, position advances for both. The above is close enough for now (separate position tracking) because the vast majority of dup usage is fork+exec fd redirection where only one side reads. If you encounter a test failure from shared-offset semantics, refactor to a shared file description object.

### 1f: No close-on-exec tracking

**Bug:** No cloexec bit on any fd. No cleanup after exec. fd leaks across fork+exec chains.

**Files:** `src/browser/filesystem.js` (open), `src/browser/engine-main-worker.js` (open, fcntl)

**Fix:**
- In `VirtualFS.open()`: add `cloexec: !!(flags & 0x80000)` to the fd object (O_CLOEXEC = 0x80000)
- In `engine-main-worker.js` host_syscall case 257 (openat): pass the cloexec flag through to `vfs.open()`
- The fcntl F_GETFD/F_SETFD handlers from item 1e already handle the runtime get/set
- In `fork_spawn` when serializing `hostOpenFiles` for the child: exclude fds with `cloexec === true`

### 1g: Symlink resolution depth 10, should be 40

**Bug:** `resolvePath` uses `depth > 10`. Linux allows 40. Debian multiarch symlink chains can exceed 10.

**Files:** `src/browser/filesystem.js` line 159, `src/browser/engine-worker.js` resolveSymlinks function

**Fix:** Change `depth > 10` to `depth > 40` in both files.

### 1h: Child Worker VFS is degraded

**Bug:** `engine-worker.js` uses `const vfs = new Map()` — no whiteouts, no children index, no metadata, no copy-up. mkdir/unlink/rename in child are literal no-ops (return 0, do nothing). Parent metadata from fchmod/fchown is NOT serialized to child.

**Files:** `src/browser/engine-main-worker.js` (fork_spawn), `src/browser/engine-worker.js`

**Fix:**

**In fork_spawn** — serialize full VFS state:
```javascript
const vfsState = {
  files: {}, // path → ArrayBuffer
  dirs: Array.from(vfs.dirs),
  symlinks: Object.fromEntries(vfs.symlinks),
  whiteouts: Array.from(vfs.whiteouts),
  metadata: Object.fromEntries(vfs.metadata),
  children: {},
  bootTime: vfs.bootTime,
};
for (const [path, content] of vfs.files) {
  if (content && content.buffer) {
    vfsState.files[path] = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
  }
}
for (const [path, childSet] of vfs.children) {
  vfsState.children[path] = Array.from(childSet);
}
```

**In engine-worker.js** — import and reconstruct VirtualFS:
- Import `VirtualFS` from `./filesystem.js` (change the worker to a module worker if needed, or inline the class)
- On receiving `restore-fork`, reconstruct:
```javascript
const childVfs = new VirtualFS();
childVfs.bootTime = vfsState.bootTime;
for (const dir of vfsState.dirs) childVfs.dirs.add(dir);
for (const wo of vfsState.whiteouts) childVfs.whiteouts.add(wo);
for (const [path, target] of Object.entries(vfsState.symlinks)) childVfs.symlinks.set(path, target);
for (const [path, meta] of Object.entries(vfsState.metadata)) childVfs.metadata.set(path, meta);
for (const [path, children] of Object.entries(vfsState.children)) childVfs.children.set(path, new Set(children));
for (const [path, buf] of Object.entries(vfsState.files)) childVfs.files.set(path, new Uint8Array(buf));
```
- Replace ALL hand-rolled stat/access/readdir/open/write logic in the child worker with calls to `childVfs` methods
- mkdir/unlink/rename in child MUST call `childVfs.mkdir()`, `childVfs.unlink()`, `childVfs.rename()` — NOT return 0

**Reference:** Read ZenFS OverlayFS source (`github.com/zen-fs/core`, MIT) for correct overlay semantics before implementing.

**Run `npx playwright test` — 14/14 must pass.**

---

## Phase 2: Fork Architecture — CheerpX Pattern

### 2a: Fix mmap page gap in SAB

**Bug:** During `fork_spawn`, only pool-allocated pages are written to the SAB. mmap-backed pages (demand-paged library sections) are missing. CC hit this bug and fell back to full memory copy instead of fixing it.

**File:** `src/browser/engine-main-worker.js` fork_spawn function (lines ~1480-1500)

**Fix:** The loop that copies host pages to the SAB iterates `g_hostpages`. Verify that mmap-backed pages are tracked in `g_hostpages`. If they're not (which is the bug CC hit), add them: in the C code (`native/blink/blink/map.c` or `memorymalloc.c`), when Blink maps a page via mmap, it must be registered in `g_hostpages` alongside pool-allocated pages. Every page the guest can access must be in `g_hostpages` — no exceptions.

If the mmap pages are tracked but at addresses outside the pool range, the SAB copy loop needs to handle non-pool pages too — copy them by their host address rather than pool index.

**Verify:** After this fix, the SAB contains every page the guest can access. Test by temporarily removing the full memory copy and running `echo hello | cat` — if it works with only SAB page faulting, the gap is fixed.

### 2b: Remove full memory copy

**Bug:** `engine-main-worker.js` line 1502: `const parentMemory = new Uint8Array(memory.buffer).slice()` — copies ENTIRE parent WASM memory. Comment says `// TEMPORARY`. Every fork copies 26MB+.

**File:** `src/browser/engine-main-worker.js` fork_spawn, `src/browser/engine-worker.js` restore-fork handler

**Fix:**
- Delete line 1502 (`const parentMemory = ...`)
- Remove `parentMemory` from the `postMessage` to the child
- Remove `parentMemory` from the `transferList`
- In child worker: remove the block that copies `parentBytes` into the child's memory
- The child Worker instantiates a fresh WASM module with empty memory. Pages fault lazily from the SAB via `page_pool_fault`
- The fork state blob (registers + page table) is written into the child's memory at a known location. `restore_fork` reads it and restores CPU state.

**Critical:** The child's `restore_fork` in C (`blink.c` line 400) uses `g_machine` which points to existing memory. With a fresh WASM instance, `g_machine` is initialized by `_start` → `main()`. The browser `restore_fork` path must either:
1. Skip `_start` entirely and enter at `restore_fork` directly (requires the WASM entry point to be `restore_fork`, not `_start`), OR
2. Run `_start` → `main()` which initializes `g_machine`, then call `restore_fork` which overwrites only CPU registers (current approach — works because `restore_fork` doesn't allocate)

The current approach (option 2) works IF `page_pool_fault` correctly supplies every page the child touches. That's why 2a must be done first.

### 2c: fork+exec fast path

**Bug:** 95% of forks are immediately followed by exec. Currently each one copies 26MB (or after 2b, faults dozens of pages from SAB). For fork+exec, the child never uses parent memory — exec discards everything.

**Files:** `native/blink/blink/syscall.c` (SysFork, SysExecve), `src/browser/engine-main-worker.js` (fork_spawn)

**Fix:** Detect the fork+exec pattern:
- In `SysFork` (C code), set a flag: `m->fork_pending = 1`
- In `SysExecve` (C code), check `m->fork_pending`. If set, this is fork+exec:
  - Call `atua_fork_spawn` with exec arguments (path, argv, envp) instead of fork state
  - The JS side spawns a Worker, passes exec arguments, the child loads the binary fresh — no SAB, no page fault, no memory copy
  - Near-zero cost per fork+exec
- If `SysExecve` is NOT called immediately (pure fork), `fork_pending` remains and the next syscall clears it — the fork has already been dispatched the normal way

**Reference:** Browsix (`github.com/AskBlink/browsix`, MIT) — fork+exec fast path. CheerpX does the same.

### 2d: Worker module caching

**Bug:** Each fork spawns a Worker that fetches and compiles `engine.wasm` from scratch.

**File:** `src/browser/atua-computer.js` or wherever the main thread creates child Workers

**Fix:** Compile `engine.wasm` once on the main thread at boot:
```javascript
const engineModule = await WebAssembly.compile(engineBytes);
```
Transfer the pre-compiled `WebAssembly.Module` to each child Worker via `postMessage`. The child calls `WebAssembly.instantiate(module, imports)` — milliseconds instead of hundreds of milliseconds. `WebAssembly.Module` is transferable.

### 2e: Worker pool

**Bug:** Workers are created and destroyed per fork. Worker creation has OS-level overhead (thread creation, memory allocation).

**Fix:** Pre-spawn 4-8 Workers at boot. On fork, grab one from the pool, send it the fork state. On child exit, return the Worker to the pool. If the pool is empty, create a new Worker (but this should be rare for agent workloads).

**Run `npx playwright test` — 14/14 must pass. Run `apt update` — should fork without OOM. Fork overhead < 10ms for fork+exec.**

---

## Phase 3: Rootfs — Real Debian with Nitro as PID 1

### 3a: Build Debian rootfs via debootstrap

```bash
debootstrap --variant=minbase --arch=amd64 trixie /tmp/debian-rootfs http://deb.debian.org/debian
# Strip unnecessary bulk
rm -rf /tmp/debian-rootfs/usr/share/doc/*
rm -rf /tmp/debian-rootfs/usr/share/man/*
rm -rf /tmp/debian-rootfs/usr/share/locale/*
rm -rf /tmp/debian-rootfs/var/cache/apt/*
```

### 3b: Cross-compile Nitro for x86-64 musl static

Nitro (`github.com/leahneukirchen/nitro`, MIT) is tiny C. Cross-compile:
```bash
git clone https://github.com/leahneukirchen/nitro
cd nitro
CC=x86_64-linux-musl-gcc LDFLAGS="-static" make
cp nitro /tmp/debian-rootfs/sbin/init
```

Set up service directories:
```
/tmp/debian-rootfs/etc/nitro/shell/run:
  #!/bin/sh
  exec /bin/bash --login

/tmp/debian-rootfs/etc/nitro/syslog/run:
  #!/bin/sh
  exec logger
```

Make Nitro PID 1. The guest boots → Nitro starts → shell service comes up → agent interacts with the shell service.

### 3c: Cross-compile uutils for x86-64 musl static

uutils (`github.com/uutils/coreutils`, MIT). CLAUDE.md mandates this over BusyBox.
```bash
git clone https://github.com/uutils/coreutils
cd coreutils
# Build multicall binary
cargo build --release --features unix --target x86_64-unknown-linux-musl
cp target/x86_64-unknown-linux-musl/release/coreutils /tmp/debian-rootfs/usr/bin/coreutils
# Create symlinks for each utility
cd /tmp/debian-rootfs/usr/bin
for cmd in ls cat cp mv rm mkdir rmdir chmod chown ln head tail wc sort uniq tr cut paste tee; do
  ln -sf coreutils $cmd
done
```

### 3d: Package the rootfs

```bash
cd /tmp/debian-rootfs && tar cf /path/to/atua-computer/wasm/debian-rootfs.tar .
```

Update the e9 test and boot configuration to use this rootfs. Update the boot sequence to exec Nitro as PID 1 instead of bash.

**Verify:** System boots. `ps` shows Nitro as PID 1, shell as a child service. `apt install python3 && python3 -c "print('hello')"` works.

---

## Phase 4: OPFS Persistence

### 4a: Install OPFS wrapper

Use **opfs-tools** (`github.com/hughfenghen/opfs-tools`, MIT) or **happy-opfs** (`github.com/JiangJie/happy-opfs`, MIT). Do NOT hand-roll OPFS access. CLAUDE.md: "No hand-rolled implementations when proven libraries exist."

```bash
npm install opfs-tools
# or
npm install happy-opfs
```

### 4b: Wire VFS overlay flush to OPFS

**File:** `src/browser/filesystem.js`

Add persistence methods to `VirtualFS`:

```javascript
async flushToOPFS() {
  // Serialize: files, dirs, symlinks, whiteouts, metadata, children
  // Write to OPFS under /atua-computer/overlay/
  // Use opfs-tools write() for each component
}

async loadFromOPFS() {
  // Check if /atua-computer/overlay/ exists in OPFS
  // If yes, deserialize into this.files, this.dirs, etc.
  // If no, return false (boot from base layer)
}
```

### 4c: Debounced flush

After any write syscall that modifies the overlay (write, unlink, rename, mkdir, chmod, chown, utimens):
```javascript
clearTimeout(this._flushTimer);
this._flushTimer = setTimeout(() => this.flushToOPFS(), 500);
```

### 4d: Boot-time load

In the boot sequence, before loading the tar/EROFS base layer:
```javascript
const hasOverlay = await vfs.loadFromOPFS();
if (hasOverlay) {
  console.log('Restored persistent state from OPFS');
} else {
  console.log('Fresh boot — loading base rootfs');
  await vfs.loadTar(tarData);
}
```

The base layer (tar/EROFS) is always loaded (it's read-only, cached by browser). The overlay (user changes) is loaded on top from OPFS.

### 4e: Explicit checkpoint

Add to the MCP tool surface / runtime API:
```javascript
async checkpoint() {
  clearTimeout(this._flushTimer);
  await this.flushToOPFS();
}
```

**Verify:** Install python3 in the browser. Refresh the page. python3 is still installed.

---

## Phase 5: HTTP Fetch Bypass

### 5a: Detect HTTP connections at socket level

**File:** `src/browser/engine-main-worker.js` — socket connect handler

When `connect()` targets port 80 or 443:
```javascript
if (port === 80 || port === 443) {
  socket.httpIntercept = true;
  socket.httpBuffer = [];
  socket.httpPort = port;
  // Don't send through Wisp relay yet — buffer until we see the HTTP request
  return 0; // connect "succeeds" immediately
}
```

### 5b: Buffer and parse HTTP request

In the write handler, when `socket.httpIntercept` is true:
```javascript
// Append written bytes to httpBuffer
socket.httpBuffer.push(new Uint8Array(data));
// Check if we have a complete HTTP request (ends with \r\n\r\n)
const combined = concatenate(socket.httpBuffer);
const headerEnd = findCRLFCRLF(combined);
if (headerEnd !== -1) {
  const requestText = new TextDecoder().decode(combined.subarray(0, headerEnd));
  const { method, path, headers } = parseHTTPRequest(requestText);
  const host = headers['host'];
  const scheme = socket.httpPort === 443 ? 'https' : 'http';
  const url = `${scheme}://${host}${path}`;
  // Fire native fetch
  socket.httpResponse = fetch(url, {
    method,
    headers: sanitizeHeaders(headers), // remove Host, Connection, etc.
  });
  socket.httpResponseStarted = true;
}
```

### 5c: Stream response back through socket fd

In the read handler, when `socket.httpResponseStarted`:
```javascript
const response = await socket.httpResponse;
if (!socket.httpHeadersSent) {
  // Synthesize HTTP response headers
  const statusLine = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
  const respHeaders = [...response.headers.entries()]
    .map(([k, v]) => `${k}: ${v}`).join('\r\n');
  const headerBytes = new TextEncoder().encode(statusLine + respHeaders + '\r\n\r\n');
  // Write to socket read buffer
  socket.httpHeadersSent = true;
}
// Stream body chunks from response.body reader into socket read buffer
```

The guest's glibc HTTP code reads from the socket, gets native-speed HTTP responses. Thinks it's talking to a TCP connection.

For HTTPS (port 443): intercept BEFORE the TLS handshake. The guest's OpenSSL never runs. The browser's `fetch()` handles TLS natively. This is the biggest single performance optimization — it eliminates interpreted OpenSSL entirely.

**Verify:** `apt update` completes in < 30 seconds, not 5+ minutes.

---

## Phase 6: Child Worker Remaining Fixes

### 6a: Child networking

**Bug:** All socket ops return -1 in child worker. Forked children can't network.

**File:** `src/browser/engine-worker.js` — socket stubs

**Fix:** Wire the Wisp relay into child workers. Options:
1. Share the parent's Wisp WebSocket via the main thread (main thread relays socket data between child Worker and Wisp connection), OR
2. Open a new Wisp WebSocket connection per child Worker

Option 1 is simpler — the main thread already manages the Wisp connection. Add message types for socket operations between child Worker and main thread.

### 6b: ftruncate in child

**Bug:** Child's `case 77: return 0` doesn't truncate.

**Fix:**
```javascript
case 77: { // ftruncate(fd=a, length=b)
  const file = openFiles.get(a);
  if (!file) return -9;
  const newLen = b >>> 0;
  if (newLen < file.content.length) {
    file.content = file.content.slice(0, newLen);
  } else if (newLen > file.content.length) {
    const grown = new Uint8Array(newLen);
    grown.set(file.content);
    file.content = grown;
  }
  return 0;
}
```

### 6c: free crash on apt exit

**Bug:** apt crashes during cleanup. If it corrupts dpkg state before exiting, that's data loss.

**Fix:** Audit the exit path:
1. The `restore_fork` browser path is correct (no NewMachine, no malloc)
2. The crash is likely musl's `atexit` handlers freeing memory. Since the child process is about to exit anyway, the crash during cleanup is cosmetic IF all work is already done
3. In the child Worker's catch block for the `unreachable` trap on exit: check if exit code was set via `get_exit_code()`. If it was, treat it as a clean exit — the trap is just musl's cleanup failing
4. If the crash happens BEFORE exit (during apt's actual work), the post-fork allocation audit must be extended — look for any function call between `restore_fork` and `Actor()` that allocates

### 6d: Proper SYS_dup / SYS_dup2 / SYS_dup3

**Bug:** Cases 32 (dup) and 33 (dup2) may also be broken in addition to fcntl F_DUPFD.

**File:** Both workers' host_syscall

**Fix:**
```javascript
case 32: { // dup(oldfd)
  const file = vfs.openFiles.get(a);
  if (!file) return -9;
  const newFd = vfs.nextFd++;
  vfs.openFiles.set(newFd, { ...file, cloexec: false });
  return newFd;
}
case 33: { // dup2(oldfd, newfd)
  if (a === b) return b; // dup2 to same fd is a no-op
  const file = vfs.openFiles.get(a);
  if (!file) return -9;
  vfs.openFiles.delete(b); // close newfd if open
  vfs.openFiles.set(b, { ...file, cloexec: false });
  if (b >= vfs.nextFd) vfs.nextFd = b + 1;
  return b;
}
case 292: { // dup3(oldfd, newfd, flags)
  if (a === b) return -22; // EINVAL — dup3 rejects same fd
  const file = vfs.openFiles.get(a);
  if (!file) return -9;
  vfs.openFiles.delete(b);
  vfs.openFiles.set(b, { ...file, cloexec: !!(c & 0x80000) }); // O_CLOEXEC
  if (b >= vfs.nextFd) vfs.nextFd = b + 1;
  return b;
}
```

---

## Phase 7: JIT — Blink's DSL Retargeted to WASM

### 7a: Read references first

Before writing any code:
1. Read Blink's `native/blink/blink/jit.c` — understand the DSL, how basic blocks are identified, how native code is emitted
2. Read v86's JIT: `github.com/copy/v86` `src/rust/jit.rs` (BSD-2-Clause) — this is the closest reference for x86-to-WASM JIT. Study how they emit WASM bytecodes for x86 instructions
3. Read the WASM binary format spec for function bodies — you need to emit valid WASM bytecodes

### 7b: Implement WASM bytecode emitter

Replace Blink's native code emitter in `jit.c` with a WASM bytecode emitter under `#ifdef __ATUA_BROWSER__`:

1. When a basic block is hot (executed N times), extract the x86-64 instructions
2. Translate each x86-64 instruction to equivalent WASM bytecodes that operate on the guest register file and memory (both stored in WASM linear memory)
3. Emit a valid WASM function body (local declarations + bytecodes)
4. Call the JS host import `atua_jit_compile(wasmBytesPtr, wasmBytesLen)` which:
   ```javascript
   async function jit_compile(ptr, len) {
     const bytes = new Uint8Array(memory.buffer, ptr, len);
     const module = await WebAssembly.compile(bytes);
     const instance = await WebAssembly.instantiate(module, { env: { memory } });
     // Cache the compiled function, patch Blink's dispatch table
   }
   ```
5. Future executions of that basic block call the compiled WASM function instead of interpreting

### 7c: Start with arithmetic/logic/branch only

Don't try to JIT every x86 instruction on day one. Start with:
- Integer arithmetic: add, sub, and, or, xor, shl, shr, sar, mul, div
- Comparisons: cmp, test + conditional branches (jz, jnz, jl, jg, etc.)
- Memory: mov reg↔mem, lea
- Control flow: jmp, call, ret

These cover the hot loops in most programs (string processing, hash computation, loop counters). Syscall instructions and complex x86 features (SSE, x87 FPU) fall back to the interpreter.

**Verify:** `gcc hello.c -o hello && ./hello` completes in < 10 seconds. Python scripts run at interactive speed.

---

## Phase 8: Final Verification

After all phases are complete, run these tests. ALL must pass.

```bash
# Boot test — Nitro as PID 1
# Expected: system boots, ps shows init + shell service

# Package management
apt update
apt install -y python3 curl git

# Python
python3 -c "import json; print(json.dumps({'status': 'ok'}))"

# Networking
curl -s http://example.com | head -5

# Persistence — refresh the page, then:
python3 --version
# Expected: still installed

# Fork stress
for i in $(seq 1 100); do echo $i | cat > /dev/null; done
# Expected: completes without OOM or crash

# File operations
echo test >> /tmp/append.log
echo test >> /tmp/append.log
wc -l /tmp/append.log
# Expected: 2

ls -la /
# Expected: includes . and ..

find / -maxdepth 1 -type d
# Expected: lists real directories

# Service management
mkdir -p /etc/nitro/httpserver/
echo '#!/bin/sh\nexec python3 -m http.server 8080' > /etc/nitro/httpserver/run
chmod +x /etc/nitro/httpserver/run
# Nitro picks up and starts the service
curl http://localhost:8080/
# Expected: directory listing

# All automated tests
npx playwright test
# Expected: 14/14 pass (plus new tests for each phase)
```

---

## What NOT To Do

- Do NOT stop between phases to ask for review
- Do NOT generate sub-plans for individual phases
- Do NOT approve any code with `// TEMPORARY` or `// TODO: replace`
- Do NOT return 0 from syscalls that should do real work
- Do NOT use plain Maps where VirtualFS is required
- Do NOT copy 26MB of memory per fork
- Do NOT hand-roll OPFS access — use opfs-tools or happy-opfs
- Do NOT write a custom init system — use Nitro
- Do NOT use BusyBox — use uutils
- Do NOT defer any item in this document
- Do NOT implement a simpler version and call it done

