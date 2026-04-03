# Wasmer Bridge — Gap Analysis & Solutions Addendum

Read `wasmer-bridge-comprehensive-plan.md` first. This addendum addresses five specific engineering gaps in that plan. CC must read BOTH documents.

---

## Gap 1: Actual Rust Module Implementations (wasix crate API)

The `wasix` crate version 0.13.1 exports all WASIX functions from `wasix::lib_generated64::wasix_64v1::*`, re-exported at the crate root via `pub use x::*`. Every function is `unsafe` (raw ABI bindings). The function names exactly match the WASIX API reference at wasix.org/docs/api-reference.

### Concrete pipe.rs implementation:

```rust
use crate::protocol::BridgeResult;

pub fn create() -> BridgeResult {
    let mut ro_fd: u32 = 0;
    let mut rw_fd: u32 = 0;
    let errno = unsafe { wasix::fd_pipe(&mut ro_fd, &mut rw_fd) };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    BridgeResult::ok2(ro_fd as i32, rw_fd as i32)
}

pub fn close(fd: i32) -> BridgeResult {
    let errno = unsafe { wasix::fd_close(fd as u32) };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    BridgeResult::ok(0)
}
```

### Concrete process.rs implementation:

```rust
use crate::protocol::BridgeResult;

pub fn fork() -> BridgeResult {
    let mut pid: u32 = 0;
    // proc_fork(copy_memory: Bool, pid_ptr: *mut Pid) -> Errno
    let errno = unsafe { wasix::proc_fork(wasix::BOOL_TRUE, &mut pid) };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    // In parent: pid = child PID. In child: pid = 0.
    BridgeResult::ok(pid as i32)
}

pub fn wait(pid: i32, _flags: i32) -> BridgeResult {
    let mut status = wasix::JoinStatus {
        tag: wasix::JOIN_STATUS_TYPE_NOTHING,
        u: unsafe { core::mem::zeroed() },
    };
    // proc_join(pid: OptionPid, flags: JoinFlags, status: *mut JoinStatus) -> Errno
    let opt_pid = if pid > 0 {
        wasix::OptionPid { tag: wasix::OPTION_SOME, u: pid as u32 }
    } else {
        wasix::OptionPid { tag: wasix::OPTION_NONE, u: 0 }
    };
    let errno = unsafe { wasix::proc_join(&opt_pid, 0, &mut status) };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    let exit_code = if status.tag == wasix::JOIN_STATUS_TYPE_EXIT_NORMAL {
        unsafe { status.u.exit_normal.exit_code as i32 }
    } else {
        -1
    };
    BridgeResult::ok2(pid, exit_code)
}

pub fn signal(pid: i32, sig: i32) -> BridgeResult {
    let errno = unsafe { wasix::proc_signal(pid as u32, sig as u8) };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    BridgeResult::ok(0)
}

pub fn exec(path_ptr: i32, path_len: i32) -> BridgeResult {
    // proc_exec uses the current process's memory for the path
    let errno = unsafe { wasix::proc_exec(path_ptr as u32, path_len as u32, core::ptr::null(), 0) };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    BridgeResult::ok(0) // unreachable in the calling process
}

pub fn spawn(path_ptr: i32, path_len: i32, argv_ptr: i32, argv_len: i32, envp_ptr: i32, envp_len: i32) -> BridgeResult {
    let mut handles = wasix::ProcessHandles {
        pid: 0,
        stdin: wasix::OptionFd { tag: wasix::OPTION_NONE, u: 0 },
        stdout: wasix::OptionFd { tag: wasix::OPTION_NONE, u: 0 },
        stderr: wasix::OptionFd { tag: wasix::OPTION_NONE, u: 0 },
    };
    // proc_spawn builds the full command environment
    let errno = unsafe {
        wasix::proc_spawn(
            path_ptr as u32, path_len as u32,
            core::ptr::null(), 0, // chdir
            argv_ptr as u32, argv_len as u32,
            envp_ptr as u32, envp_len as u32,
            wasix::BOOL_FALSE, // stdin_inherit
            wasix::StdioMode { tag: 0 }, // stdout mode
            wasix::StdioMode { tag: 0 }, // stderr mode
            core::ptr::null(), 0, // working dir preopens
            &mut handles,
        )
    };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    BridgeResult::ok(handles.pid as i32)
}

pub fn exit_notify(pid: i32, code: i32) -> BridgeResult {
    BridgeResult::ok2(pid, code) // Kernel tracks this
}
```

### Concrete thread.rs implementation:

```rust
use crate::protocol::BridgeResult;

pub fn spawn(entry: i32, user_data: i32) -> BridgeResult {
    let start = wasix::ThreadStart {
        stack_upper: 0,
        tls_base: 0,
        start_funct: entry as u64,
        start_args: user_data as u64,
        reserved: [0; 10],
        stack_size: 1048576, // 1MB stack
        guard_size: 4096,
    };
    let mut tid: i32 = 0;
    let errno = unsafe { wasix::thread_spawn_v2(&start, &mut tid) };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    BridgeResult::ok(tid)
}

pub fn join(tid: i32) -> BridgeResult {
    let errno = unsafe { wasix::thread_join(tid as u32) };
    BridgeResult::err(errno.raw() as i32)
}

pub fn exit(code: i32) -> BridgeResult {
    unsafe { wasix::thread_exit(code as u32) };
    BridgeResult::ok(0) // unreachable
}

pub fn futex_wait(addr: i32, expected: i32, timeout_ns: i32) -> BridgeResult {
    let timeout = if timeout_ns < 0 {
        wasix::OptionTimestamp { tag: wasix::OPTION_NONE, u: 0 }
    } else {
        wasix::OptionTimestamp { tag: wasix::OPTION_SOME, u: timeout_ns as u64 }
    };
    let mut ret: wasix::Bool = wasix::BOOL_FALSE;
    let errno = unsafe { wasix::futex_wait(addr as *mut u32, expected as u32, &timeout, &mut ret) };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    BridgeResult::ok(if ret == wasix::BOOL_TRUE { 0 } else { -110 }) // ETIMEDOUT
}

pub fn futex_wake(addr: i32, count: i32) -> BridgeResult {
    let mut woken: u32 = 0;
    let errno = unsafe { wasix::futex_wake(addr as *mut u32, &mut woken) };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    BridgeResult::ok(woken as i32)
}

pub fn futex_wake_all(addr: i32) -> BridgeResult {
    let mut woken: u32 = 0;
    let errno = unsafe { wasix::futex_wake_all(addr as *mut u32, &mut woken) };
    if errno != wasix::ERRNO_SUCCESS {
        return BridgeResult::err(errno.raw() as i32);
    }
    BridgeResult::ok(woken as i32)
}
```

### Concrete signal.rs implementation:

```rust
use crate::protocol::BridgeResult;

pub fn register(signal: i32, _handler: i32) -> BridgeResult {
    // callback_signal registers that the current process wants to handle this signal
    // The handler address is within the WASIX process's memory space
    let errno = unsafe { wasix::callback_signal(signal as u8) };
    BridgeResult::err(errno.raw() as i32)
}

pub fn send(pid: i32, signal: i32) -> BridgeResult {
    let errno = unsafe { wasix::proc_signal(pid as u32, signal as u8) };
    BridgeResult::err(errno.raw() as i32)
}

pub fn raise_interval(signal: i32, interval_ns: i32, repeat: i32) -> BridgeResult {
    let errno = unsafe {
        wasix::proc_raise_interval(signal as u8, interval_ns as u64, repeat != 0)
    };
    BridgeResult::err(errno.raw() as i32)
}
```

### NOTE on exact signatures:

The `wasix` crate is auto-generated from `.witx` files. The exact struct layouts and function parameter types may differ from what I've written above. CC MUST run `cargo doc --open` on the `wasix` crate after adding it to `Cargo.toml` and verify every function signature before coding. If a struct field name is wrong (e.g., `exit_normal.exit_code` vs `exit_normal.code`), fix it from the docs. Do NOT guess. Do NOT leave it as-is if it doesn't compile.

---

## Gap 2: @wasmer/sdk JS API for Memory Access

`@wasmer/sdk` uses WebAssembly.Memory with `shared: true` for WASIX threading support. The bridge's linear memory is backed by a SharedArrayBuffer. Standard WebAssembly API:

```javascript
// After running the bridge via @wasmer/sdk:
const instance = await pkg.entrypoint.run({ args: [String(CONTROL_OFFSET)] });

// The @wasmer/sdk Instance object wraps the WASM instance.
// The WASM module's memory export is accessible via:
//   instance.exports?.memory?.buffer  — standard WASM API
//
// BUT @wasmer/sdk may not expose .exports directly on its Instance wrapper.
// The SDK's Instance has: .stdin, .stdout, .stderr, .wait()
// It does NOT have .exports or .memory documented in the public API.
//
// SOLUTION: The bridge must EXPORT its memory explicitly.
// In the Rust code, expose the memory location via a known global or function:
//
//   #[no_mangle]
//   pub extern "C" fn get_control_region_ptr() -> *const u8 {
//       // Return pointer to control region in bridge's linear memory
//       CONTROL_OFFSET as *const u8
//   }
//
// Then from JS, after instantiation, if we can call exports:
//   const ptr = instance.exports.get_control_region_ptr();
//
// ALTERNATIVE APPROACH (more reliable):
// Don't share the bridge's WASM memory. Instead, create a SEPARATE
// SharedArrayBuffer in JS and pass it to both the kernel worker and
// the bridge. The bridge reads/writes this SAB via WASI fd_read/fd_write
// on a preopened file descriptor mapped to the SAB.
//
// SIMPLEST APPROACH (recommended):
// Create a SharedArrayBuffer in JS (512 bytes for control).
// Pass it to the kernel worker via postMessage.
// Pass it to the bridge by writing it into a mounted Directory file.
// The bridge reads the SAB reference from stdin or from a file.
//
// BUT: @wasmer/sdk's Directory API takes Uint8Array/string, not SAB.
// We can't pass a SAB through the Directory mount.
//
// ACTUAL SIMPLEST APPROACH:
// Use @wasmer/sdk's stdin stream to send the SAB offset.
// The bridge reads stdin on startup to get configuration.
// The SAB is the bridge's OWN linear memory, which IS shared
// because Wasmer uses SharedArrayBuffer for WASIX threading.
//
// To get the bridge's SAB from JS:
// @wasmer/sdk runs WASM in Web Workers internally.
// The WASM memory buffer is a SharedArrayBuffer.
// We need a way to get a reference to it from the main thread.

// PRACTICAL SOLUTION:
// 1. Don't use @wasmer/sdk's high-level Instance API for memory access.
// 2. Instead, use runWasix() low-level API (if available) or
//    WebAssembly.instantiateStreaming() directly with Wasmer's WASI imports.
// 3. OR: Use a separate SharedArrayBuffer as the transport, not the bridge's memory.
```

### Final Memory Architecture Decision:

**Use a SEPARATE SharedArrayBuffer as the control transport.** Do NOT try to access the bridge's WASM linear memory from JS.

```javascript
// atua-computer.js boot:

// 1. Create control SAB — 512 bytes
const controlSab = new SharedArrayBuffer(512);

// 2. Create data SAB — 1MB for bulk transfers (fork state, socket data)
const dataSab = new SharedArrayBuffer(1024 * 1024);

// 3. Start bridge on @wasmer/sdk, mount the SABs as files
//    The bridge reads/writes the SABs via file I/O on mounted paths
const dir = new Directory();
// Write SAB references as binary blobs the bridge can mmap
// OR: use environment variables to pass SAB info

// 4. Start kernel worker — give it the same SABs
this._kernelWorker.postMessage({
  type: 'init',
  controlSab,
  dataSab,
  rootfsTar: opts.rootfsTar,
});

// Both kernel and bridge have Int32Array views on controlSab.
// Atomics.wait/notify work across Workers (including Wasmer's internal Workers).
```

**BUT WAIT** — The bridge is a WASIX program running inside Wasmer's Web Worker. It doesn't have direct JS access to the SAB. It needs the SAB to be part of its WASM memory OR accessible through WASIX I/O.

**ACTUAL SOLUTION: Allocate the control region inside the bridge's WASM memory.**

1. The bridge WASM module uses `shared: true` memory (required by WASIX for threading).
2. `@wasmer/sdk` must expose the WASM module's SharedArrayBuffer somehow.
3. If the SDK doesn't expose it, we need a workaround.

**Workaround if SDK doesn't expose memory:**

Write a thin JS wrapper that uses `WebAssembly.instantiateStreaming` directly instead of `@wasmer/sdk`'s high-level API. Provide the WASIX imports manually. This gives direct access to the instance's memory.

```javascript
// Low-level approach — bypass @wasmer/sdk's Instance wrapper
import { init } from '@wasmer/sdk';
await init();

// Load bridge WASM bytes
const bridgeBytes = await fetch('/wasix-bridge.wasm').then(r => r.arrayBuffer());

// Create shared memory
const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

// Get WASIX imports from @wasmer/sdk
// The SDK provides a way to get the import object for WASIX modules
// OR we provide minimal WASI imports ourselves (the bridge only uses WASIX calls)

const { instance } = await WebAssembly.instantiate(bridgeBytes, {
  wasi_snapshot_preview1: wasiImports,
  wasix_64v1: wasixImports,
  env: { memory },
});

// Now memory.buffer is a SharedArrayBuffer we can share with the kernel worker
const bridgeSab = memory.buffer; // SharedArrayBuffer
```

**CC MUST verify:** Does `@wasmer/sdk` provide a way to get WASIX imports for manual instantiation? If yes, use that. If no, the bridge module needs to be instantiated with `@wasmer/sdk`'s `runWasix()` function, and CC must find how to access the instance's memory. Check the SDK source at github.com/wasmerio/wasmer-js for `runWasix` or low-level instantiation APIs.

**If neither approach works:** The fallback is the bridge allocates a known region of its linear memory for the protocol, exports a function that returns the pointer, and the JS side reads the pointer. But this requires calling into the bridge instance, which requires access to exports.

This is the hardest integration gap. CC should verify memory access FIRST — before writing any Rust code — by creating a minimal WASIX "hello world" module, loading it with `@wasmer/sdk`, and checking whether `instance.exports.memory.buffer instanceof SharedArrayBuffer`.

---

## Gap 3: Cross-Engine Memory Pointer Problem

When the kernel calls `callBridge(REQ_SOCK_SEND, bridgeFd, bufPtr, len)`, `bufPtr` points into **Blink's WASM memory**, not the bridge's. The bridge can't dereference that pointer.

### Solution: Copy data through the shared data SAB.

```
Kernel has: Blink's WASM memory (SharedArrayBuffer) + Data SAB
Bridge has: Its own WASM memory + Data SAB (same SAB, shared)

For socket send:
1. Kernel reads bytes from Blink's memory at bufPtr
2. Kernel writes those bytes into Data SAB at offset 0
3. Kernel calls callBridge(REQ_SOCK_SEND, bridgeFd, 0, len)
   (offset 0 = start of data in Data SAB)
4. Bridge reads bytes from Data SAB at offset 0
5. Bridge calls wasix::sock_send with a buffer in its own memory
   (copies from Data SAB into its linear memory first)

For socket recv:
1. Kernel calls callBridge(REQ_SOCK_RECV, bridgeFd, 0, maxLen)
2. Bridge calls wasix::sock_recv into its own buffer
3. Bridge copies received bytes into Data SAB at offset 0
4. Bridge returns byte count in result
5. Kernel reads bytes from Data SAB and writes them into Blink's memory at bufPtr
```

This adds one copy per I/O operation. This is acceptable:
- File I/O doesn't go through the bridge (stays in kernel VFS) — zero copies
- Pipe data doesn't go through the bridge (direct worker SAB I/O) — zero copies
- Socket data goes through the bridge — one copy per send/recv
- Fork state goes through the bridge — one copy (but fork is infrequent)

### In kernel-worker.js:

```javascript
// Data SAB: 1MB shared between kernel and bridge
let dataSab = null;  // SharedArrayBuffer
let dataView = null; // Uint8Array view

// Socket send with data copy:
case 44: { // SYS_sendto
  const entry = proc.fdTable.get(a);
  if (!entry || entry.type !== 'socket') { result = -9; break; }
  const count = Math.min(c >>> 0, dataSab.byteLength);
  // Copy from Blink's memory to data SAB
  const src = wasm.subarray(b >>> 0, (b >>> 0) + count);
  dataView.set(src, 0);
  // Call bridge with offset=0 in data SAB
  const resp = callBridge(55, entry.bridgeFd, 0, count);
  result = resp.err ? -resp.err : resp.val;
  break;
}

// Socket recv with data copy:
case 45: { // SYS_recvfrom
  const entry = proc.fdTable.get(a);
  if (!entry || entry.type !== 'socket') { result = -9; break; }
  const maxLen = Math.min(c >>> 0, dataSab.byteLength);
  const resp = callBridge(56, entry.bridgeFd, 0, maxLen);
  if (resp.err) { result = -resp.err; break; }
  // Copy from data SAB to Blink's memory
  const received = resp.val;
  wasm.set(dataView.subarray(0, received), b >>> 0);
  result = received;
  break;
}
```

### In the bridge (Rust), the data SAB access:

The bridge needs to read/write the data SAB. If the data SAB is separate from the bridge's WASM memory, the bridge can't access it directly.

**Solution: Make the data region part of the bridge's own linear memory.**

The bridge allocates a 1MB region in its linear memory for data transfer. The kernel writes to this region via its Int32Array/Uint8Array view on the bridge's SharedArrayBuffer memory. The bridge reads from this region as normal Rust memory.

```rust
// Bridge reserves a data region at a known offset
const DATA_OFFSET: usize = 65536 + 512; // After control region (64K + 512B)
const DATA_SIZE: usize = 1024 * 1024;   // 1MB

fn read_data(offset: usize, len: usize) -> &'static [u8] {
    unsafe { std::slice::from_raw_parts((DATA_OFFSET + offset) as *const u8, len) }
}

fn write_data(offset: usize, data: &[u8]) {
    unsafe {
        let dest = std::slice::from_raw_parts_mut((DATA_OFFSET + offset) as *mut u8, data.len());
        dest.copy_from_slice(data);
    }
}
```

The kernel writes data to `bridgeSab` at `DATA_OFFSET + offset`. The bridge reads it as its own memory. Same SharedArrayBuffer, two views.

---

## Gap 4: Fork With Two Engines

When the bridge calls `proc_fork()`, Wasmer forks **the bridge process** — not Blink. The bridge is a thin service loop. Forking it creates a second service loop. This is NOT what we want for most fork scenarios.

### What fork means in atua-computer:

When Blink's guest calls `SYS_fork`:
1. A new x86-64 process needs to exist with a copy of the parent's address space
2. The child needs its own execution worker (Web Worker running Blink WASM)
3. The child needs to appear in the process table with its own PID
4. The child inherits the parent's fd table (pipe fds, file fds, sockets)

### What the bridge provides for fork:

- **PID management** — the bridge assigns PIDs from Wasmer's process table
- **Signal delivery to children** — `proc_signal(childPid, sig)` works
- **waitpid** — `proc_join(childPid)` blocks until child exits (Wasmer handles blocking)
- **Exit status tracking** — Wasmer tracks child exit codes

### What the bridge does NOT provide for fork:

- **Blink execution worker creation** — that's still JS (the kernel asks the main thread to spawn a Worker)
- **Memory copying** — copying Blink's WASM memory from parent to child is still JS (SharedArrayBuffer subarray + set)
- **Page fault handling** — SoftMMU demand paging is still JS

### Fork flow with bridge:

```
1. Blink hits SYS_fork → kernel
2. Kernel calls callBridge(REQ_FORK)
3. Bridge calls proc_fork() → Wasmer creates child bridge process
   Parent bridge returns childPid, child bridge returns 0
4. If result > 0 (parent):
   a. Kernel creates child process in processTable with childPid
   b. Kernel duplicates parent's fdTable for child
   c. Kernel tells main thread: spawn new execution worker for childPid
   d. Main thread creates Worker, sends it parent's SharedArrayBuffer memory
   e. Child worker does demand-paged memory access via SoftMMU
   f. Kernel returns childPid to parent Blink
5. If result == 0 (child):
   a. This is the child bridge instance — it enters its own service loop
   b. The child execution worker's bridge calls go to THIS child bridge
   c. The child bridge handles the child's signals, waitpid, pipes
```

**The tricky part:** After proc_fork, the child bridge instance needs its own control SAB, or the parent and child bridge instances share the control SAB and multiplex requests. 

**Simplest correct approach:** The bridge does NOT use proc_fork for Blink's fork. Instead:

1. The kernel handles fork by spawning a new execution worker (same as now)
2. The bridge provides a `REQ_PID_ALLOCATE` call — returns a new PID
3. The bridge provides `REQ_WAIT(pid)` — blocks until that PID exits
4. The bridge provides `REQ_EXIT_NOTIFY(pid, code)` — kernel tells bridge when a Blink process exits
5. The bridge provides `REQ_SIGNAL_SEND(pid, sig)` — delivers signals via Wasmer's mechanism

This means fork MEMORY is handled by the JS kernel (it works — SAB page copy). Fork LIFECYCLE is managed through the bridge (PID allocation, wait, signals). Best of both.

---

## Gap 5: Pipe SAB Exposure for Direct Worker I/O

Wasmer's pipe implementation is internal to the runtime. We cannot extract the pipe ring buffers as SABs. The bridge calls `fd_pipe()` and gets two WASIX fd numbers. Reading/writing those fds goes through `fd_read()`/`fd_write()` inside the bridge.

### The problem (from the plan):

If pipe data goes through the bridge, and the kernel blocks on callBridge while waiting for the bridge to complete `fd_read` (which blocks waiting for data), and the writer's `fd_write` also needs the kernel to relay to the bridge — deadlock.

### Solution: Bridge-managed ring buffers in shared memory

The bridge allocates ring buffers in its own linear memory (which IS a SharedArrayBuffer). The kernel gives execution workers views on these ring buffers. Workers read/write directly using Atomics.wait/notify. The bridge does NOT call WASIX `fd_read`/`fd_write` for pipe data — it manages its own ring buffers.

```
Bridge linear memory (SharedArrayBuffer):
  [CONTROL_OFFSET .. CONTROL_OFFSET+512]  — control protocol
  [DATA_OFFSET .. DATA_OFFSET+1MB]        — bulk data transfer
  [PIPE_OFFSET .. PIPE_OFFSET+N*64KB]     — pipe ring buffers

Each pipe ring buffer (64KB + 16 bytes header):
  [0..3]   write_pos   (AtomicI32)
  [4..7]   read_pos    (AtomicI32)  
  [8..11]  write_closed (AtomicI32, 1 = closed)
  [12..15] read_closed  (AtomicI32, 1 = closed)
  [16..]   data ring buffer (64KB)
```

### When kernel creates a pipe:

```javascript
case 22: { // SYS_pipe
  const resp = callBridge(1); // REQ_PIPE_CREATE
  if (resp.err) { result = -resp.err; break; }
  const readFd = resp.val;
  const writeFd = resp.r1;
  const pipeRingOffset = resp.r2; // Offset in bridge SAB where ring buffer lives

  // Register in fd table with ring buffer info
  proc.fdTable.set(readFd, { 
    type: 'pipe', end: 0, 
    ringOffset: pipeRingOffset,  // Offset into bridge SAB
    bridgeSab: bridgeSab,        // Reference to bridge's SharedArrayBuffer
  });
  proc.fdTable.set(writeFd, { 
    type: 'pipe', end: 1, 
    ringOffset: pipeRingOffset,
    bridgeSab: bridgeSab,
  });

  // Push pipe ring info to execution workers for direct I/O
  self.postMessage({
    type: 'pipe-fd-cache',
    pid,
    updates: [
      { fd: readFd, end: 0, ringOffset: pipeRingOffset, sab: bridgeSab },
      { fd: writeFd, end: 1, ringOffset: pipeRingOffset, sab: bridgeSab },
    ]
  });

  wasmDV.setInt32(a >>> 0, readFd, true);
  wasmDV.setInt32((a >>> 0) + 4, writeFd, true);
  result = 0;
  break;
}
```

### Bridge's pipe::create allocates ring buffer:

```rust
use std::sync::atomic::{AtomicU32, Ordering};

const PIPE_REGION_START: usize = 65536 + 512 + 1024 * 1024; // After control + data
const PIPE_SLOT_SIZE: usize = 64 * 1024 + 16; // 16 byte header + 64K data
static NEXT_PIPE_SLOT: AtomicU32 = AtomicU32::new(0);

pub fn create() -> BridgeResult {
    let slot = NEXT_PIPE_SLOT.fetch_add(1, Ordering::SeqCst);
    let ring_offset = PIPE_REGION_START + (slot as usize * PIPE_SLOT_SIZE);
    
    // Zero out the ring buffer header
    unsafe {
        let header = ring_offset as *mut u32;
        *header.add(0) = 0; // write_pos
        *header.add(1) = 0; // read_pos
        *header.add(2) = 0; // write_closed
        *header.add(3) = 0; // read_closed
    }

    // Assign logical fd numbers
    let read_fd = (slot * 2 + 100) as i32;  // Even = read
    let write_fd = (slot * 2 + 101) as i32; // Odd = write

    // Return: read_fd, write_fd, ring_offset
    BridgeResult::ok4(read_fd, write_fd, ring_offset as i32, 0)
}
```

### Execution worker direct pipe I/O (unchanged from CheerpX pattern):

Workers get `bridgeSab` (the bridge's SharedArrayBuffer) and `ringOffset`. They create `Int32Array` and `Uint8Array` views on the ring buffer region. `Atomics.wait()` blocks the worker (not the kernel) when the pipe is empty. `Atomics.notify()` wakes the reader when the writer writes.

This is the same CheerpX pattern from the earlier spec, but the ring buffers live in the bridge's shared memory instead of kernel-allocated SABs.

---

## Summary of Solutions

| Gap | Problem | Solution |
|-----|---------|----------|
| 1. Rust API | Don't know wasix crate signatures | Crate 0.13.1, all in `wasix::*`, all `unsafe`, verify with `cargo doc` |
| 2. JS memory access | @wasmer/sdk may not expose SAB | Bridge's WASM memory IS a SAB; use low-level instantiation if needed; verify first |  
| 3. Cross-engine pointers | Bridge can't read Blink's memory | Data region in bridge's SAB; kernel copies in/out |
| 4. Fork two engines | Bridge fork ≠ Blink fork | Bridge manages PID/wait/signals; kernel manages workers/memory |
| 5. Pipe SABs | Wasmer's pipes not exposed | Bridge allocates ring buffers in its own SAB; workers access directly |

**CC's first task:** Verify Gap 2. Create a minimal WASIX module, load it with `@wasmer/sdk`, check if the instance's memory buffer is a SharedArrayBuffer accessible from JS. If yes, proceed. If no, use low-level `WebAssembly.instantiate` with WASIX imports. This verification takes 30 minutes and determines the entire integration approach.
