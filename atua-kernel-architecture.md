# Centralized Kernel Architecture — Eliminating the Split-Brain VFS

**Status:** This is the next architectural step for atua-computer. Read this entire document before writing any code.

**Problem:** The current architecture has a split-brain fd table. Blink (C/WASM) creates pipe and socket fds internally. JS has its own `openFiles` Map. These two tables don't know about each other. When bash forks and does `dup2(pipefd, 0)`, the JS side returns EBADF because Blink's pipe fd isn't in the JS Map. The child worker has a degraded copy of the parent's VFS using raw Maps with incomplete syscall implementations. This causes DUP2-EBADF errors, demand-paged SIGSEGV on libc, and silent data loss in child processes.

**Solution:** One kernel. One fd table. One VFS. All I/O state lives in a single Kernel Worker. Execution workers (parent and children) are identical thin shells that trap every syscall to the kernel via SharedArrayBuffer + Atomics. This is the CheerpX architecture and the Browsix architecture (MIT, ASPLOS 2017).

---

## The Pattern

### How Linux works
```
Process calls read(fd, buf, len)
  → CPU traps to kernel mode
  → Kernel looks up fd in process's fd table
  → Kernel reads from the file/pipe/socket
  → Kernel copies data into process's buffer
  → Returns to userspace
```

### How atua-computer must work (CheerpX/Browsix pattern)
```
Guest x86 code calls syscall (SYS_read)
  → Blink intercepts, calls host_syscall(0, fd, bufPtr, len)
  → host_syscall writes request to SharedArrayBuffer
  → Atomics.wait() — execution worker sleeps
  → Kernel Worker wakes, reads request from SAB
  → Kernel looks up fd in its SINGLE fd table
  → Kernel reads from VFS/pipe/socket
  → Kernel writes data into execution worker's WASM memory (via SAB)
  → Kernel writes return value to SAB
  → Atomics.notify() — execution worker wakes
  → host_syscall returns the result to Blink
  → Blink returns to guest code
```

### How atua-computer works NOW (broken)
```
Guest x86 code calls syscall (SYS_read)
  → Blink intercepts, calls host_syscall(0, fd, bufPtr, len)
  → host_syscall has a 142-case switch statement IN THE WORKER
  → It looks up fd in the WORKER'S LOCAL openFiles Map
  → If Blink created this fd (pipe, socket), it's NOT in the Map → EBADF
  → Child workers have a DIFFERENT 71-case switch with DIFFERENT Maps
  → Fork serializes SOME fds but misses pipes/sockets → split brain
```

---

## Architecture

### Three types of threads, strict separation

**Main Thread** — owns the DOM, xterm.js terminal, user interaction. Does NOT own any I/O state. Does NOT handle syscalls. Communicates with the Kernel Worker via postMessage (async). This thread cannot use `Atomics.wait()` (browser restriction).

**Kernel Worker** — the brain. Owns:
- `VirtualFS` instance (the single source of truth for all file state)
- Unified fd table (files, pipes, sockets, special files — everything)
- Pipe table (SAB ring buffers)
- Socket table (Wisp relay connections)
- Process table (which workers exist, their PIDs, parent-child relationships)
- mmap table (which guest address ranges map to which files at which offsets)

The Kernel Worker processes syscall requests from execution workers. It runs an event loop that checks each execution worker's SAB for pending requests.

**Execution Workers** — dumb. Run Blink (engine.wasm). Their ONLY job is executing x86 instructions. When Blink hits a syscall, the worker's `host_syscall` function writes the request to a SAB and sleeps. When the kernel responds, it wakes up and returns the result to Blink. ALL execution workers run IDENTICAL code. There is no difference between a "parent worker" and a "child worker."

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ Exec Worker 0│       │ Exec Worker 1│       │ Exec Worker N│
│  (PID 1)     │       │  (PID 42)    │       │  (PID 99)    │
│              │       │              │       │              │
│ engine.wasm  │       │ engine.wasm  │       │ engine.wasm  │
│ host_syscall │       │ host_syscall │       │ host_syscall │
│  = SAB trap  │       │  = SAB trap  │       │  = SAB trap  │
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │ SAB+Atomics          │ SAB+Atomics          │ SAB+Atomics
       ▼                      ▼                      ▼
┌─────────────────────────────────────────────────────────────┐
│                      KERNEL WORKER                          │
│                                                             │
│  VirtualFS (single instance)                                │
│  fd_table: Map<pid, Map<fd, FileDescription>>               │
│  pipe_table: Map<pipeId, {sab, control, data}>              │
│  socket_table: Map<sockId, WispConnection>                  │
│  process_table: Map<pid, {worker, parentPid, exitCode}>     │
│  mmap_table: Map<pid, [{guestAddr, len, filePath, offset}]> │
│                                                             │
│  syscall_dispatch(pid, n, a, b, c, d, e, f) → result        │
└─────────────────────────────────────────────────────────────┘
       │ postMessage (async, DOM events only)
       ▼
┌─────────────────┐
│   Main Thread   │
│   xterm.js      │
│   DOM / UI      │
└─────────────────┘
```

---

## Primitives

### Syscall SAB Protocol

Each execution worker gets a dedicated SAB for communicating with the kernel. Layout:

```
SharedArrayBuffer (256 bytes per worker):
  Int32Array view:
    [0]  = syscall number (n)
    [1]  = arg a
    [2]  = arg b  
    [3]  = arg c
    [4]  = arg d
    [5]  = arg e
    [6]  = arg f
    [7]  = request flag (worker sets to 1, kernel reads and resets to 0)
    [8]  = response flag (kernel sets to 1, worker reads and resets to 0)
    [9]  = return value
    [10] = worker PID (set once at init)
```

**Execution worker sends a syscall:**
```javascript
host_syscall(n, a, b, c, d, e, f) {
  const req = this._syscallSAB; // Int32Array on the per-worker SAB
  Atomics.store(req, 0, n);
  Atomics.store(req, 1, a);
  Atomics.store(req, 2, b);
  Atomics.store(req, 3, c);
  Atomics.store(req, 4, d);
  Atomics.store(req, 5, e);
  Atomics.store(req, 6, f);
  Atomics.store(req, 8, 0);   // clear response flag
  Atomics.store(req, 7, 1);   // set request flag
  Atomics.notify(req, 7);     // wake kernel
  Atomics.wait(req, 8, 0);    // sleep until response
  return Atomics.load(req, 9); // read result
}
```

That's 10 lines. This replaces the 142-case switch in the parent and the 71-case switch in the child. Both workers use this IDENTICAL code.

**Kernel processes the syscall:**
```javascript
// Kernel Worker event loop — polls each worker's SAB
function kernelLoop() {
  for (const [pid, worker] of processTable) {
    const req = worker.syscallSAB;
    if (Atomics.load(req, 7) === 1) {
      // Request pending
      Atomics.store(req, 7, 0); // clear request flag
      const n = Atomics.load(req, 0);
      const a = Atomics.load(req, 1);
      // ... read all args
      const result = syscall_dispatch(pid, n, a, b, c, d, e, f);
      Atomics.store(req, 9, result);
      Atomics.store(req, 8, 1);   // set response flag
      Atomics.notify(req, 8);     // wake worker
    }
  }
  // Use setTimeout or Atomics.waitAsync for the loop
  setTimeout(kernelLoop, 0);
}
```

### Data Transfer for read/write syscalls

Syscall args are integers (fd numbers, pointers, lengths). But `read()` and `write()` need to transfer byte data between the kernel and the worker's WASM memory.

**Option A — Shared WASM memory:** If `WebAssembly.Memory({shared: true})` is used, the kernel can directly read/write the worker's WASM memory. The worker passes a pointer (offset into linear memory) and the kernel reads/writes at that offset in the shared memory. Zero-copy. This is the Browsix approach.

**Option B — Copy via SAB:** The worker copies data from WASM memory into a data SAB before the syscall (for write) or the kernel copies data into a data SAB after processing (for read), and the worker copies it into WASM memory on wake. One copy per syscall. Slightly slower but doesn't require shared WASM memory.

**Option C — Per-worker data SAB:** Each worker gets a large SAB (e.g., 1MB) for bulk data transfer in addition to the 256-byte control SAB. The kernel writes read data into this SAB; the worker copies it into WASM memory. For write, the worker copies from WASM memory into the data SAB before signaling the kernel.

**Recommendation:** Start with Option C (per-worker data SAB). It's simple, proven (Browsix uses a variant), and doesn't require changing the WASM memory to shared. Upgrade to Option A later if profiling shows the copy is a bottleneck.

```
Per-worker SABs:
  controlSAB:  SharedArrayBuffer(256)   — syscall args + flags
  dataSAB:     SharedArrayBuffer(1MB)   — bulk data for read/write/mmap
```

### Unified fd Table

The kernel maintains one fd table per process:

```javascript
// kernel-worker.js
const fdTables = new Map(); // pid → Map<fd, FileDescription>

// A FileDescription is the POSIX concept — the actual open file state
// Multiple fds can point to the same FileDescription (after dup)
class FileDescription {
  constructor(type, data) {
    this.type = type;       // 'file' | 'pipe_read' | 'pipe_write' | 'socket' | 'special'
    this.data = data;       // type-specific: {content, position, path} for files,
                            // {pipeId} for pipes, {sockId} for sockets
    this.flags = 0;         // O_APPEND, O_NONBLOCK, etc.
    this.refcount = 1;      // how many fds point to this description
  }
}
```

When Blink creates a pipe via `SysPipe`:
1. Blink calls `host_syscall(22, ...)` (SYS_pipe)
2. Kernel creates a pipe (SAB ring buffer), creates two FileDescriptions (pipe_read, pipe_write)
3. Kernel adds both fds to the calling process's fd table
4. Returns the two fd numbers to the worker
5. **No split.** The pipe fds exist in the kernel's table. dup2 works on them because the kernel owns them.

When fork happens:
1. Kernel duplicates the parent's fd table for the child PID
2. For each FileDescription, increment refcount (shared after fork, like real POSIX)
3. That's it. No serialization. No reconstruction. The child's fds are in the kernel.

When exec happens:
1. Kernel walks the child's fd table
2. Close every fd with cloexec flag set
3. The remaining fds are available to the new program
4. That's it. No hostOpenFiles. No vfsState. The kernel already has everything.

### Page Fault Chain (for fork)

The kernel maintains the mmap table — which guest virtual address ranges map to which files:

```javascript
const mmapTables = new Map(); // pid → [{guestAddr, length, filePath, fileOffset, prot, flags}]
```

When a forked child's `page_pool_fault` fires:
1. Worker sends a page fault request to the kernel: `syscall(FAULT, faultingPageAddr)`
2. Kernel checks: is this page in the SAB snapshot? → return SAB data
3. Kernel checks: is this address in the mmap table? → read from VFS at the file offset → return file data
4. Kernel checks: is this an anonymous mapping? → return zeros
5. None of the above → return error (SIGSEGV)

This fixes the dpkg SIGSEGV. The child can fault ANY page the parent had — file-backed pages load from the rootfs on demand through the kernel, not from the parent's snapshot.

---

## Migration Path

### What moves where

| Currently in execution workers | Moves to kernel worker |
|-------------------------------|----------------------|
| `VirtualFS` instance | → `kernel-worker.js` |
| `openFiles` Map (142 cases) | → `kernel-worker.js` fd table |
| `pipes` Map + SAB ring buffers | → `kernel-worker.js` pipe table |
| `sockets` Map + Wisp relay | → `kernel-worker.js` socket table |
| `hostState.brk` / mmap tracking | → `kernel-worker.js` per-process memory state |
| HTTP fetch bypass logic | → `kernel-worker.js` socket handler |
| OPFS persistence (flush/load) | → `kernel-worker.js` |
| All 142 syscall cases | → `kernel-worker.js` `syscall_dispatch()` |
| All 71 child syscall cases | **DELETED** — child uses same SAB trap as parent |

| Currently in execution workers | Stays in execution workers |
|-------------------------------|---------------------------|
| WASM instantiation | stays |
| `restore_fork` / `init_for_fork` | stays (CPU state is per-worker) |
| `page_pool_fault` | stays but calls kernel for resolution |
| Terminal output routing | stays (postMessage to main thread) |

### What gets created

**`src/browser/kernel-worker.js`** — new file. The kernel. Contains:
- `VirtualFS` import and single instance
- Unified fd table (Map of Maps)
- Process table
- Pipe table  
- Socket table (Wisp relay management)
- mmap table
- `syscall_dispatch(pid, n, a, b, c, d, e, f)` — the 142-case switch, moved from engine-main-worker.js
- Kernel event loop (poll SABs, dispatch, respond)
- Fork handler (duplicate fd table, create new worker SAB)
- Exec handler (close cloexec fds, reset mmap table)
- Page fault handler (SAB → mmap → zeros → SIGSEGV chain)

**`src/browser/engine-main-worker.js`** — gutted. Becomes:
- WASM instantiation
- The 10-line `host_syscall` SAB trap (replaces 142 cases)
- `page_pool_fault` (calls kernel for page resolution)
- Terminal output (`term_write` → postMessage to main thread)

**`src/browser/engine-worker.js`** — gutted. Becomes:
- IDENTICAL to engine-main-worker.js
- Same 10-line `host_syscall`
- Same `page_pool_fault`
- No VFS. No Maps. No pipe stubs. No socket stubs.
- In fact, consider merging into a single `execution-worker.js`

**`src/browser/atua-computer.js`** — updated. Becomes:
- Creates the Kernel Worker
- Creates the pre-compiled `WebAssembly.Module`
- Worker pool management
- Routes terminal I/O between execution workers and xterm.js
- Routes DOM events to kernel (window resize → SIGWINCH, etc.)

### Execution order

1. **Create `kernel-worker.js`** — move VirtualFS, move the 142 syscall cases, add fd table, add kernel loop. Verify it compiles and the kernel loop runs.

2. **Add syscall SAB protocol** — create per-worker SABs, implement the trap in the kernel, implement the 10-line `host_syscall` in the worker.

3. **Gut `engine-main-worker.js`** — delete the 142 cases, delete local VFS, delete local pipe/socket tables. Replace with SAB trap. Run tests. Fix what breaks.

4. **Gut `engine-worker.js`** — delete all 71 cases, delete all local state. Replace with same SAB trap. Run tests. Fix what breaks.

5. **Add unified fd table** — pipes and sockets created by the kernel, stored in the kernel's fd table. dup/dup2 works on any fd. Fork duplicates the table. Test with pipe-heavy workloads.

6. **Add page fault chain** — kernel maintains mmap table, resolves page faults from SAB → file → zeros. Test with dpkg (the SIGSEGV test).

7. **Merge execution workers** — if engine-main-worker.js and engine-worker.js are now identical, merge into `execution-worker.js`.

### After each step: `npx playwright test` must pass.

---

## References — Read These Before Coding

1. **Browsix `kernel.ts`** — `https://github.com/plasma-umass/browsix/blob/master/src/kernel/kernel.ts` (MIT). The centralized kernel with syscall dispatch, fd tables, process management. ~2000 lines TypeScript. This is the reference implementation for the dispatch pattern.

2. **Browsix paper** — "BROWSIX: Bridging the Gap Between Unix and the Browser" (ASPLOS 2017). Explains the SAB syscall protocol, the kernel architecture, fork/exec handling. PDF: `https://arxiv.org/pdf/1611.07862`

3. **WebAssembly design issue #950** — `https://github.com/WebAssembly/design/issues/950`. Bobby Powers (Browsix author) describes the exact SAB + Atomics.wait syscall protocol.

4. **coincident** — `https://github.com/WebReflection/coincident` (ISC). Atomics-based synchronous RPC proxy between Workers. If the raw SAB protocol is too much boilerplate, coincident handles it. ~50K roundtrips/sec. Evaluate whether it fits the WASM import → JS → SAB call chain.

5. **The existing atua-computer code** — the 142 syscall cases in `engine-main-worker.js` are the kernel logic. They're correct (VFS fixes landed, HTTP bypass works, OPFS works). They just need to move to a kernel worker.

---

## What NOT To Do

- Do NOT keep any I/O state in execution workers. No local Maps. No local fd tracking. No local VFS.
- Do NOT have different code for parent vs child workers. They are identical.
- Do NOT serialize VFS state during fork. The kernel already has it.
- Do NOT serialize fd tables during fork. The kernel already has them.
- Do NOT implement the kernel on the main thread. The main thread cannot use `Atomics.wait`. The kernel must be a Worker.
- Do NOT poll with busy-wait in the kernel loop. Use `Atomics.waitAsync` or `setTimeout(0)` or a combination.
- Do NOT break the existing 15/15 Playwright tests. Migrate incrementally. If a test breaks, fix before proceeding.

---

## Why This Fixes Everything

| Current bug | Root cause | How kernel fixes it |
|-------------|-----------|-------------------|
| DUP2-EBADF on pipe fds | Pipe fds in Blink's C table, not in JS Map | Kernel creates pipes, stores in unified fd table |
| dpkg SIGSEGV on libc pages | Child's SAB missing pages parent never loaded | Kernel's page fault chain reads from rootfs |
| Child mkdir/unlink are no-ops | Child has degraded VFS copy | Child has no VFS — kernel handles all I/O |
| Child networking returns -1 | Socket stubs in child worker | Kernel owns sockets, child traps to kernel |
| VFS state lost on fork | Incomplete serialization | No serialization needed — kernel is persistent |
| Different behavior parent vs child | 142 cases vs 71 cases | Identical 10-line trap in both |
| fork serialization is complex | Must serialize VFS + fds + pipes + metadata | Fork = kernel duplicates fd table. One Map copy. |
