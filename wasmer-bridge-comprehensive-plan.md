# CC Prompt: Wasmer WASIX Bridge for atua-computer

## What You Are Building

atua-computer is a browser-native 64-bit Linux distribution. It runs Debian with a real package manager (`apt install` works), real shared libraries, real shell, real `/proc`. Any unmodified x86-64 Linux binary runs — Node.js, Python, gcc, dpkg, anything you can `apt install`. It competes with CheerpX (which is proprietary and 32-bit only). atua-computer is 64-bit, open, and runs on the standard web platform.

The distribution runs on two WASM engines side by side. The native WASM engine (Blink) provides the x86-64 execution environment and the kernel provides a real VFS with the Debian rootfs, real per-process fd tables, and terminal I/O. The Wasmer WASIX endpoint (`wasix-bridge/`, a Rust program compiled to `wasm32-wasip1` running on `@wasmer/sdk`) provides ALL POSIX process primitives: fork, pipes, threading, signals, futexes, sockets, DNS. A SharedArrayBuffer transport connects the two engines.

The JS kernel dispatches file I/O locally and process operations to the Wasmer bridge. The kernel NEVER implements fork, pipe blocking, signal delivery, threading, or socket management in JavaScript. Those are ALL bridge calls to Wasmer's battle-tested Rust implementations.

## Constraints — Read These Before Writing Any Code

- Every function body calls real WASIX syscalls. No stubs returning ENOSYS. No placeholders.
- No fallback paths. If the bridge is not initialized, the kernel throws — it does NOT silently degrade.
- Build ALL modules (pipe, process, thread, signal, socket) in one pass. No "pipes first, fork later."
- Use the `wasix` crate (`crates.io/crates/wasix`) for typed WASIX bindings. Do NOT hand-declare extern signatures unless the crate genuinely lacks the binding — and if it does, use the EXACT signature from wasix.org/docs/api-reference.
- Delete ALL hand-rolled JS pipe/fork/signal/socket code from kernel-worker.js. Not commented out. Not behind a flag. Deleted.
- No setTimeout polling. The bridge service loop uses `std::thread::sleep` or WASIX `futex_wait`.
- No `todo!()` or `unimplemented!()` in shipped Rust code. Every dispatch arm has a real implementation.
- No "temporary" or "for now" workarounds anywhere.

## File Structure

Create at repo root:

```
atua-computer/
  wasix-bridge/
    Cargo.toml
    src/
      main.rs         # Service loop: wait for SAB request → dispatch → respond
      protocol.rs     # SAB layout constants and BridgeResult type
      pipe.rs         # fd_pipe, fd_close for pipe ends
      process.rs      # proc_fork, proc_exec, proc_spawn, proc_join, proc_signal
      thread.rs       # thread_spawn, thread_join, thread_exit, futex_wait, futex_wake, futex_wake_all
      signal.rs       # callback_signal, proc_signal, proc_raise_interval
      socket.rs       # sock_open, sock_bind, sock_listen, sock_connect, sock_accept,
                      #   sock_send, sock_recv, sock_close, sock_sendto, sock_recvfrom, resolve
```

## Cargo.toml

```toml
[package]
name = "wasix-bridge"
version = "0.1.0"
edition = "2021"

[dependencies]
wasix = "0.12"

[profile.release]
opt-level = "s"
lto = true
strip = true
```

Build command:
```bash
cd wasix-bridge
cargo wasix build --release
# OR if cargo-wasix not installed:
rustup target add wasm32-wasip1
cargo build --target wasm32-wasip1 --release

cp target/wasm32-wasip1/release/wasix-bridge.wasm ../src/browser/
```

If the `wasix` crate version 0.12 does not have all needed bindings, run `cargo doc --open` on the crate to see what IS available. For any missing binding, check the crate source for the raw extern declarations and replicate them exactly. The WASIX ABI is stable — the function names and signatures at wasix.org/docs/api-reference are the ground truth.

## protocol.rs — SAB Protocol

The bridge's linear memory is a SharedArrayBuffer (Wasmer requires this for WASIX threading). The kernel worker gets a JS Int32Array view on this same buffer. Both sides read/write atomically.

Control region: 512 bytes (128 × i32) at a fixed offset in bridge memory.

```rust
// Offsets — i32 indices into the control region
pub const CTL_REQUEST_TYPE: usize = 0;
pub const CTL_ARG0: usize = 1;
pub const CTL_ARG1: usize = 2;
pub const CTL_ARG2: usize = 3;
pub const CTL_ARG3: usize = 4;
pub const CTL_ARG4: usize = 5;
pub const CTL_ARG5: usize = 6;
pub const CTL_REQUEST_FLAG: usize = 7;
pub const CTL_RESPONSE_FLAG: usize = 8;
pub const CTL_RESULT: usize = 9;
pub const CTL_RESULT1: usize = 10;
pub const CTL_RESULT2: usize = 11;
pub const CTL_RESULT3: usize = 12;
pub const CTL_ERROR: usize = 13;

// Request types
pub const REQ_PIPE_CREATE: i32 = 1;
pub const REQ_PIPE_CLOSE: i32 = 2;
pub const REQ_FORK: i32 = 10;
pub const REQ_EXEC: i32 = 11;
pub const REQ_SPAWN: i32 = 12;
pub const REQ_WAIT: i32 = 13;
pub const REQ_EXIT_NOTIFY: i32 = 14;
pub const REQ_THREAD_SPAWN: i32 = 20;
pub const REQ_THREAD_JOIN: i32 = 21;
pub const REQ_THREAD_EXIT: i32 = 22;
pub const REQ_FUTEX_WAIT: i32 = 30;
pub const REQ_FUTEX_WAKE: i32 = 31;
pub const REQ_FUTEX_WAKE_ALL: i32 = 32;
pub const REQ_SIGNAL_REGISTER: i32 = 40;
pub const REQ_SIGNAL_SEND: i32 = 41;
pub const REQ_SIGNAL_RAISE_INTERVAL: i32 = 42;
pub const REQ_SOCK_OPEN: i32 = 50;
pub const REQ_SOCK_BIND: i32 = 51;
pub const REQ_SOCK_LISTEN: i32 = 52;
pub const REQ_SOCK_CONNECT: i32 = 53;
pub const REQ_SOCK_ACCEPT: i32 = 54;
pub const REQ_SOCK_SEND: i32 = 55;
pub const REQ_SOCK_RECV: i32 = 56;
pub const REQ_SOCK_CLOSE: i32 = 57;
pub const REQ_SOCK_SENDTO: i32 = 58;
pub const REQ_SOCK_RECVFROM: i32 = 59;
pub const REQ_DNS_RESOLVE: i32 = 60;
pub const REQ_TTY_GET: i32 = 70;
pub const REQ_TTY_SET: i32 = 71;
pub const REQ_SHUTDOWN: i32 = 99;

pub struct BridgeResult {
    pub val: i32,
    pub r1: i32,
    pub r2: i32,
    pub r3: i32,
    pub err: i32,
}

impl BridgeResult {
    pub fn ok(val: i32) -> Self { Self { val, r1: 0, r2: 0, r3: 0, err: 0 } }
    pub fn ok2(val: i32, r1: i32) -> Self { Self { val, r1, r2: 0, r3: 0, err: 0 } }
    pub fn ok4(val: i32, r1: i32, r2: i32, r3: i32) -> Self { Self { val, r1, r2, r3, err: 0 } }
    pub fn err(errno: i32) -> Self { Self { val: 0, r1: 0, r2: 0, r3: 0, err: errno } }
}
```

## main.rs — Service Loop

```rust
mod protocol;
mod pipe;
mod process;
mod thread;
mod signal;
mod socket;

use protocol::*;
use std::sync::atomic::{AtomicI32, Ordering};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let offset: usize = args.get(1)
        .expect("[wasix-bridge] FATAL: must pass control_offset as argv[1]")
        .parse()
        .expect("[wasix-bridge] FATAL: control_offset must be usize");

    let ctl: &[AtomicI32] = unsafe {
        std::slice::from_raw_parts(offset as *const AtomicI32, 128)
    };

    eprintln!("[wasix-bridge] ready, control at offset {offset}");

    loop {
        while ctl[CTL_REQUEST_FLAG].load(Ordering::Acquire) != 1 {
            std::thread::sleep(std::time::Duration::from_micros(50));
        }
        ctl[CTL_REQUEST_FLAG].store(0, Ordering::Release);

        let req = ctl[CTL_REQUEST_TYPE].load(Ordering::Acquire);
        let a0 = ctl[CTL_ARG0].load(Ordering::Acquire);
        let a1 = ctl[CTL_ARG1].load(Ordering::Acquire);
        let a2 = ctl[CTL_ARG2].load(Ordering::Acquire);
        let a3 = ctl[CTL_ARG3].load(Ordering::Acquire);
        let a4 = ctl[CTL_ARG4].load(Ordering::Acquire);
        let a5 = ctl[CTL_ARG5].load(Ordering::Acquire);

        let r = match req {
            REQ_PIPE_CREATE          => pipe::create(),
            REQ_PIPE_CLOSE           => pipe::close(a0),
            REQ_FORK                 => process::fork(),
            REQ_EXEC                 => process::exec(a0, a1),
            REQ_SPAWN                => process::spawn(a0, a1, a2, a3, a4, a5),
            REQ_WAIT                 => process::wait(a0, a1),
            REQ_EXIT_NOTIFY          => process::exit_notify(a0, a1),
            REQ_THREAD_SPAWN         => thread::spawn(a0, a1),
            REQ_THREAD_JOIN          => thread::join(a0),
            REQ_THREAD_EXIT          => thread::exit(a0),
            REQ_FUTEX_WAIT           => thread::futex_wait(a0, a1, a2),
            REQ_FUTEX_WAKE           => thread::futex_wake(a0, a1),
            REQ_FUTEX_WAKE_ALL       => thread::futex_wake_all(a0),
            REQ_SIGNAL_REGISTER      => signal::register(a0, a1),
            REQ_SIGNAL_SEND          => signal::send(a0, a1),
            REQ_SIGNAL_RAISE_INTERVAL => signal::raise_interval(a0, a1, a2),
            REQ_SOCK_OPEN            => socket::open(a0, a1, a2),
            REQ_SOCK_BIND            => socket::bind(a0, a1, a2),
            REQ_SOCK_LISTEN          => socket::listen(a0, a1),
            REQ_SOCK_CONNECT         => socket::connect(a0, a1, a2),
            REQ_SOCK_ACCEPT          => socket::accept(a0),
            REQ_SOCK_SEND            => socket::send(a0, a1, a2),
            REQ_SOCK_RECV            => socket::recv(a0, a1, a2),
            REQ_SOCK_CLOSE           => socket::close(a0),
            REQ_SOCK_SENDTO          => socket::sendto(a0, a1, a2, a3, a4),
            REQ_SOCK_RECVFROM        => socket::recvfrom(a0, a1, a2),
            REQ_DNS_RESOLVE          => socket::resolve(a0, a1),
            REQ_TTY_GET              => socket::tty_stub(), // wire to tty_get when needed
            REQ_TTY_SET              => socket::tty_stub(),
            REQ_SHUTDOWN             => { eprintln!("[wasix-bridge] shutdown"); break; }
            unknown => {
                eprintln!("[wasix-bridge] unknown request: {unknown}");
                BridgeResult::err(38)
            }
        };

        ctl[CTL_RESULT].store(r.val, Ordering::Release);
        ctl[CTL_RESULT1].store(r.r1, Ordering::Release);
        ctl[CTL_RESULT2].store(r.r2, Ordering::Release);
        ctl[CTL_RESULT3].store(r.r3, Ordering::Release);
        ctl[CTL_ERROR].store(r.err, Ordering::Release);
        ctl[CTL_RESPONSE_FLAG].store(1, Ordering::Release);
    }
}
```

## Module Implementations

For each module (`pipe.rs`, `process.rs`, `thread.rs`, `signal.rs`, `socket.rs`):

1. Read the `wasix` crate API (run `cargo doc --open` or check crates.io source)
2. Read wasix.org/docs/api-reference for the corresponding function
3. Call the WASIX function through the crate's binding
4. Map the return to `BridgeResult`

The WASIX functions the bridge calls:

| Module | WASIX Functions |
|--------|----------------|
| pipe.rs | `fd_pipe`, `fd_close` |
| process.rs | `proc_fork`, `proc_exec`, `proc_spawn`, `proc_join`, `proc_signal`, `proc_id`, `proc_parent` |
| thread.rs | `thread_spawn`, `thread_join`, `thread_exit`, `futex_wait`, `futex_wake`, `futex_wake_all` |
| signal.rs | `callback_signal`, `proc_signal`, `proc_raise_interval` |
| socket.rs | `sock_open`, `sock_bind`, `sock_listen`, `sock_connect`, `sock_accept_v2`, `sock_send`, `sock_recv`, `sock_close`, `sock_send_to`, `sock_recv_from`, `resolve` |

Every function in the `wasix` crate corresponds to a WASIX import in the `wasix_32v1` namespace. When the bridge WASM module runs on `@wasmer/sdk`, Wasmer provides these imports. The Rust code calls them as normal function calls. Wasmer's runtime handles the actual implementation (Web Workers for threads, asyncify for fork, SAB ring buffers for pipes, etc.).

## Kernel Integration — kernel-worker.js

### DELETE these (not comment out, not flag-guard — delete):

```
function createPipe()           — entire function
function pipeRead()             — entire function  
function pipeWrite()            — entire function
function pipeClose()            — entire function
function socketRecvToArray()    — entire function
const pipes = new Map()         — declaration and all uses
let nextPipeId = 0              — declaration and all uses
const PIPE_BUF_SIZE             — declaration
const sockets = new Map()       — declaration and all uses
let nextSockId = 0              — declaration
const SOCK_BUF_SIZE             — declaration
self._pendingWaits              — all references
self._exitCodes                 — all references
self._pendingPipeSabs           — all references
case 1013 body                  — SYS_PIPE_READ (bridge handles pipe I/O)
case 1014 body                  — SYS_PIPE_WRITE
case 1015 body                  — SYS_PIPE_CLOSE  
case 1016 body                  — SYS_SOCKET_OPEN stub
case 1017 body                  — SYS_SOCKET_CONNECT stub
case 1018 body                  — SYS_SOCKET_SEND stub
case 1019 body                  — SYS_SOCKET_RECV stub
case 1020 body                  — SYS_SOCKET_CLOSE stub
case 1021 body                  — SYS_SOCKET_POLL stub
```

### ADD bridge initialization:

```javascript
let bridgeControl = null;

// In 'init' message handler, after VFS loading:
if (!msg.bridgeSab) {
  throw new Error('[kernel] FATAL: bridgeSab not provided. Cannot operate without Wasmer bridge.');
}
bridgeControl = new Int32Array(msg.bridgeSab, msg.bridgeControlOffset || 0, 128);
```

### ADD callBridge function:

```javascript
function callBridge(reqType, a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0) {
  Atomics.store(bridgeControl, 0, reqType);
  Atomics.store(bridgeControl, 1, a0);
  Atomics.store(bridgeControl, 2, a1);
  Atomics.store(bridgeControl, 3, a2);
  Atomics.store(bridgeControl, 4, a3);
  Atomics.store(bridgeControl, 5, a4);
  Atomics.store(bridgeControl, 6, a5);
  Atomics.store(bridgeControl, 8, 0);
  Atomics.store(bridgeControl, 7, 1);
  Atomics.wait(bridgeControl, 8, 0);
  return {
    val: Atomics.load(bridgeControl, 9),
    r1: Atomics.load(bridgeControl, 10),
    r2: Atomics.load(bridgeControl, 11),
    r3: Atomics.load(bridgeControl, 12),
    err: Atomics.load(bridgeControl, 13),
  };
}
```

### REWRITE syscall cases — see wasmer-bridge-comprehensive-plan.md for the full case list

Every case that currently returns ENOSYS or stubs for fork/pipe/signal/socket/thread becomes a `callBridge()` call. The cases for file I/O (0, 1, 2, 3, 5, 17, 19, 20, 77, 78, 79, 80, 82, 83, 87, 89, 90, 217, 257, 262, 267, 269, 302, 316, 332) stay as they are — file operations are handled by the kernel's VFS directly.

## atua-computer.js — Boot Sequence

Add bridge boot before kernel boot:

```javascript
import { init, Wasmer } from '@wasmer/sdk';

async boot(opts) {
  await init();

  const bridgeBytes = await fetch('/wasix-bridge.wasm').then(r => r.arrayBuffer());
  const bridgePkg = await Wasmer.fromFile(bridgeBytes);

  const CONTROL_OFFSET = 65536;
  this._bridgeInstance = await bridgePkg.entrypoint.run({
    args: [String(CONTROL_OFFSET)],
  });

  // Get bridge's SharedArrayBuffer memory
  // @wasmer/sdk uses SharedArrayBuffer for WASIX threading support
  const bridgeSab = this._bridgeInstance.memory?.buffer
    || this._bridgeInstance.exports?.memory?.buffer;

  if (!(bridgeSab instanceof SharedArrayBuffer)) {
    throw new Error('Bridge memory must be SharedArrayBuffer. Set COOP/COEP headers.');
  }

  // Boot kernel with bridge SAB reference
  this._kernelWorker = new Worker('/kernel-worker.js', { type: 'module' });
  this._kernelWorker.postMessage({
    type: 'init',
    rootfsTar: opts.rootfsTar,
    files: opts.files,
    bridgeSab,
    bridgeControlOffset: CONTROL_OFFSET,
  });

  // ... rest of boot
}
```

## How Pipe Data Flows

1. Blink guest calls `pipe()` → `host_syscall(22, pipefd, 0, ...)` → kernel
2. Kernel calls `callBridge(REQ_PIPE_CREATE)` → bridge calls WASIX `fd_pipe()` → returns read_fd, write_fd
3. Kernel registers fds in process fdTable, writes to guest memory, returns to Blink
4. Guest calls `write(write_fd, buf, len)` → `host_syscall(1, write_fd, buf, len)` → kernel
5. Kernel looks up fdTable: type is 'pipe' → `callBridge(REQ_PIPE_WRITE, bridgeFd, ...)` → bridge calls WASIX `fd_write(bridgeFd, ...)` → Wasmer handles the pipe buffer → returns bytes written
6. Guest calls `read(read_fd, buf, len)` → kernel → `callBridge(REQ_PIPE_READ, bridgeFd, ...)` → bridge calls WASIX `fd_read(bridgeFd, ...)` → Wasmer BLOCKS until data available (using Atomics.wait in its thread pool) → returns data
7. No deadlock because the bridge runs in Wasmer's thread pool, separate from the kernel worker

Wait — step 6 means the kernel blocks on `Atomics.wait(bridgeControl, 8, 0)` while the bridge blocks on `fd_read`. During this time no other processes can trap to the kernel. If process A is the reader and process B is the writer, and both go through the kernel, there is a potential deadlock: kernel handles A's read, blocks waiting for bridge, bridge blocks waiting for data, but B's write can't reach the bridge because the kernel is blocked.

This is the SAME fundamental problem as before. The bridge doesn't solve it for pipe data — only for pipe creation.

**Solution: pipe data I/O does NOT go through the bridge.** The bridge creates pipes. The pipe SABs (SharedArrayBuffers that Wasmer allocates for pipe buffers) must be exposed to execution workers. Workers read/write pipe SABs directly using `Atomics.wait()` for blocking. The kernel is never involved in pipe data transfer.

The bridge needs to return the pipe buffer SAB references when creating a pipe. The kernel forwards these to the relevant execution workers. Workers check their local pipe fd cache before trapping to the kernel — if the fd is a pipe, do direct SAB I/O.

This is the CheerpX pattern. It is not optional. It is required for correctness. The bridge handles pipe lifecycle (create, close). Workers handle pipe data (read, write) directly on the SABs.

**Implementation:**
- Bridge's `pipe::create()` calls WASIX `fd_pipe()`, then returns the fds AND the memory addresses of the pipe's internal ring buffer (if Wasmer exposes this)
- If Wasmer doesn't expose pipe internals, the bridge allocates its own SAB ring buffer in linear memory, wraps the WASIX pipe fds with it, and returns the SAB offset
- Execution workers get a view on this SAB region (shared because bridge memory is SharedArrayBuffer)
- Workers use `Atomics.wait()` on the ring buffer for blocking reads
- Workers use `Atomics.store() + Atomics.notify()` for writes

**If Wasmer's pipe buffers are not directly accessible from JS:**
The bridge allocates a ring buffer in its own linear memory (which IS a SharedArrayBuffer). The ring buffer layout:
```
[0..3]   write_pos  (AtomicI32)
[4..7]   read_pos   (AtomicI32)
[8..11]  write_closed (AtomicI32, 1 = closed)
[12..15] read_closed  (AtomicI32, 1 = closed)
[16..]   data ring buffer (64KB)
```
Both the bridge and the execution workers have views on the same SAB at this offset. Workers read/write directly. The bridge's Rust code proxies between the ring buffer and the WASIX pipe fd in a background thread (using `thread_spawn`).

This is real engineering. Not a shortcut. Pipe data path correctness requires direct SAB access from workers. The bridge provides lifecycle management and the backing buffer. Workers provide the performance path.

## serve.js / Test Server

Add `/wasix-bridge.wasm` to the file serving map. MIME type: `application/wasm`. COOP/COEP headers are already set (required for SharedArrayBuffer).

## Verification — ALL Must Pass

```bash
npx playwright test --timeout=120000

# Tests:
# e1-hello   — baseline (must not regress)
# e2-debian  — bash boot (uses fork internally)
# e3-fork    — explicit fork test
# e4-pipe    — echo hello | cat (THE test that's been failing)
# e5-interactive — shell session
# e8-blinkenlights — complex guest binary
```

Additional manual verification:
```
echo hello | cat                               # basic pipe
echo hello | cat | cat | cat                    # nested pipes
echo PIPE | while read line; do echo "got:$line"; done  # pipe + read builtin
ls -la / 2>&1                                  # stderr dup2 + pipe
for i in $(seq 1 50); do /bin/echo $i > /dev/null; done && echo OK  # fork stress
bash -c 'kill -0 $$'                           # signal self
```

## What Stays, What Goes

### Stays (kernel-worker.js — the Linux distribution's infrastructure):
- VirtualFS with Debian rootfs and all file I/O cases (0, 1, 2, 3, 5, 17, 19, 20, 77, 78, 79, 80, 82, 83, 87, 89, 90, 217, 257, 262, 267, 269, 302, 316, 332)
- Per-process fd table (unified — the fd table spec still applies)
- Terminal I/O (stdout/stderr to xterm.js, stdin from terminal)
- OPFS persistence (filesystem survives page reloads)
- brk, mmap, mprotect, munmap (memory management)
- uname, getcwd, chdir, getpid, getuid, getgid, gettimeofday, clock_gettime
- All struct serialization (stat, statx, dirent, rlimit — Linux ABI compatibility)
- SAB protocol with execution workers
- callBridge() function and bridge initialization

### Goes (deleted from kernel-worker.js):
- ALL pipe functions and state
- ALL socket functions and state  
- ALL fork/process spawning logic
- ALL signal handling logic
- ALL pending wait queues and exit code tracking

### New:
- wasix-bridge/ Rust crate (all modules)
- wasix-bridge.wasm loaded by @wasmer/sdk
- Bridge SAB transport in kernel
- Pipe SAB direct I/O in execution workers
