# CheerpX Deep Architecture Analysis — Clean Room Findings

**For:** Claude Code implementation of atua-computer (Team B reads this, never sees cx.js)
**Source:** Public `@leaningtech/cheerpx` v1.2.8 npm package, public API documentation, black-box behavioral analysis of the shipped cx.js (31,400 lines beautified, 776 functions, ~775KB)
**Clean room status:** Team A (this document's author) analyzed the public package. Team B (CC) implements from this document, public standards, and Blink's ISC-licensed source only.

---

## 1. Overall Architecture

CheerpX is a two-process architecture: a **main thread** that handles all browser I/O, and an **engine Worker** that runs the x86 CPU emulation loop.

### Main Thread Responsibilities
- Public JavaScript API (`CheerpX.Linux.create()`, `.run()`, `.setCustomConsole()`, etc.)
- Block device I/O (HTTP range requests, IndexedDB persistence)
- JIT compilation (`WebAssembly.compile()`)
- Network I/O (WebSocket connections)
- Terminal/console rendering
- Keyboard and mouse input capture
- Performance profiling and debug UI
- Worker lifecycle management

### Engine Worker Responsibilities
- x86 instruction interpretation and execution
- Syscall interception and dispatch
- Guest memory management
- JIT profiling (detecting hot basic blocks)
- The actual CPU emulation loop

### Communication
- **SharedArrayBuffer** for guest memory (`HEAP8`, `HEAP16`, `HEAP32` views)
- **postMessage** for typed command/response messages (88 postMessage calls, 8 onmessage handlers observed)
- **MessageChannel** ports for dedicated communication with sub-workers (clock worker)
- **Atomics.wait()** in Worker for blocking on I/O

### Evidence Summary
- `Worker` constructor: 3 occurrences (engine worker, clock worker, optional additional worker)
- `SharedArrayBuffer` transferred at init with `asyncPtrOffset` and `startRealTime`
- `Atomics.wait(HEAP32, 0, 0, 0)` used to test SharedArrayBuffer support
- `MessageChannel` used to create dedicated port between existing worker and new clock worker

---

## 2. Complete Message Protocol

47 distinct message types observed. Each message is a plain JS object with a `type` field and operation-specific fields.

### Initialization and Configuration

| Type | Direction | Fields | Purpose |
|------|-----------|--------|---------|
| 0 | Main→Worker | buffer, asyncPtrOffset, startRealTime, port | **Init**: transfer SharedArrayBuffer, set async sync offset, provide clock port |
| 1 | Worker→Main | value | **Init error**: loading cxcore failed |
| 2 | Main→Worker | (none) | **Start execution**: begin CPU emulation loop |
| 8 | Main→Worker | mhz, mem, bios, vgaBios | **Machine config**: CPU speed, memory size, firmware |
| 86 | Main→Worker | value | **Port transfer**: MessagePort for sub-worker communication |

### Block Device Operations

| Type | Direction | Fields | Purpose |
|------|-----------|--------|---------|
| 9 | Main→Worker | diskType, index, devId, len | **Disk registration**: register a block device with engine |
| 10 | Worker→Main | devId, start, len, ioTransaction, value | **Block read request**: engine wants disk blocks |
| 11 | Worker→Main | devId, start, len, ioTransaction, value | **Block write request**: engine wants to write blocks |
| 12 | Main→Worker | ioTransaction | **I/O completion**: notify engine that I/O request finished |
| 41 | Main→Worker | index, len | **Block device size**: inform engine of device dimensions |
| 45 | Main→Worker | index, devId, len, writeProtected | **Block device config**: full device setup with write protection flag |
| 81 | Worker→Main | tid, devId, len | **Device I/O**: per-thread device operation |
| 96 | Worker→Main | tid, devId, path | **Device mount**: mount device at filesystem path |
| 15 | Main→Worker | tid, mountType, path, devId | **Mount notification**: confirm mount to engine |

### Process and Thread Management

| Type | Direction | Fields | Purpose |
|------|-----------|--------|---------|
| 59 | Main→Worker | path, args, env, tid, index, handlers, cwd, uid, gid | **Process exec**: launch a new process (full exec with all POSIX fields) |
| 79 | Main→Worker | path, args, stdout, stderr, env, tid | **Run with capture**: exec with stdout/stderr capture callbacks |
| 43 | Main→Worker | tid | **Thread create**: create new thread |
| 33 | Main→Worker | arg1 | **Thread control**: thread management operation |
| 62 | Worker→Main | tid, value | **Thread result**: thread operation completed (value is errno, e.g., -30 = ENOSYS) |
| 56 | Main→Worker | value, arg1 | **Signal delivery**: deliver signal to process |

### JIT Compilation

| Type | Direction | Fields | Purpose |
|------|-----------|--------|---------|
| 47 | Worker→Main | start, len, replyType | **JIT compile request**: WASM bytes in HEAP8[start..start+len] |
| 48 | Main→Worker | wasmModule | **JIT compile response**: compiled WebAssembly.Module |
| 42 | Worker→Main | path, value='fail.wasm' | **JIT failure download**: save failed WASM for debugging |
| 44 | Worker→Main | traces | **JIT traces**: array of hex addresses of JIT'd blocks |
| 78 | Worker→Main | (none) | **Trace dump request**: request hex dump of all JIT'd addresses |

### Networking

| Type | Direction | Fields | Purpose |
|------|-----------|--------|---------|
| 35 | Main→Worker | id, remotePort, value | **Port pair**: establish network connection with MessagePort |
| 37 | Main→Worker | retCode, id, localPort | **Connect result**: connection outcome (-98=EADDRINUSE, 0=success) |
| 38 | Main→Worker | value | **Data send**: outbound network data |
| 83 | Main→Worker | id | **Socket operation**: socket lifecycle |
| 103 | Main→Worker | data, id, remoteAddr, remotePort | **UDP data**: inbound UDP datagram |
| 104 | Main→Worker | data, id | **TCP data**: inbound TCP data |
| 105 | Main→Worker | retCode, localPort, id | **Bind result**: bind operation outcome (-111=ECONNREFUSED, 0=success) |
| 106 | Main→Worker | id, remoteAddr, remotePort, localPort | **Accept**: new inbound TCP connection |

### Terminal and Input

| Type | Direction | Fields | Purpose |
|------|-----------|--------|---------|
| 87 | Main→Worker | columns, rows | **Terminal resize**: update terminal dimensions |
| 92 | Main→Worker | value (keyCode) | **Keydown**: keyboard key press |
| 93 | Main→Worker | value (keyCode) | **Keyup**: keyboard key release |
| 94 | Main→Worker | value, keyCode, timeStamp | **Input event**: batched input with timestamps |
| 95 | Main→Worker | width, height | **Display resize**: update framebuffer dimensions |
| 76 | Main→Worker | value, x, y, timeStamp, button | **Mouse event**: mouse input (coords are 14-bit fixed-point scaled) |

### Debug and Profiling

| Type | Direction | Fields | Purpose |
|------|-----------|--------|---------|
| 14 | Worker→Main | intWrapper, statName, statType | **Statistics**: profiling/performance data |
| 25 | Worker→Main | ctxType, value, dbgState | **Debug context**: JIT state information |
| 26 | Worker→Main | ctxType, value, dbgState | **Debug context update** |
| 46 | Worker→Main | ctxType, value, dbgState | **Debug context extended** |
| 32 | Worker→Main | text | **Text display**: debug text output |
| 40 | Worker→Main | value | **Error message**: initialization or runtime error |
| 57 | Main→Worker | eventType | **Event registration**: register for callback events |
| 80 | Main→Worker | eventType | **Event unregister**: unregister callback |

---

## 3. JIT Compilation — Complete Flow

This is the most architecturally significant pattern. The JIT is a service, not an in-engine compiler.

### Step-by-step flow (from code analysis):

```
ENGINE WORKER                              MAIN THREAD
═══════════                               ═══════════

1. CPU loop detects hot basic block
   (execution count > threshold)

2. Translates x86 basic block → WASM bytes
   Writes WASM bytes into HEAP8 buffer
   (SharedArrayBuffer, shared with main)

3. Sends message:                         4. Receives type 47 message:
   { type: 47,                               - Extract bytes: HEAP8.subarray(start, start+len)
     start: <offset>,                        - If browser needs copy: new Uint8Array(bytes)
     len: <byte count>,                      - Compile: WebAssembly.compile(bytes)
     replyType: 48 }                         - Returns Promise

                                          5a. On success (p8 callback):
                                              - Build response: { type: replyType, wasmModule: module }
                                              - Set HEAP32[asyncPtrOffset + 5] = 2 (if type 48)
                                              - Set HEAP32[asyncPtrOffset] = -2 (signal completion)
                                              - postMessage(response) to Worker

6a. Receives type 48 message:
    - Instantiates WebAssembly.Module
    - Patches dispatch table
    - Next hit → calls JIT'd function

                                          5b. On failure (p5 callback):
                                              - console.log(error)
                                              - Call user's JIT error callback if registered
                                              - Create Blob from failed WASM bytes
                                              - Download as 'fail.wasm' via type 42 message
                                              - Interpreter continues (no crash)

6b. Never receives module
    - Interpreter continues for that block
    - Block may be retried later
```

### Key implementation details:

**SharedArrayBuffer optimization:** The WASM bytes live in the shared HEAP8 buffer. No copy is needed for the type 47 message — just offset and length. The main thread reads bytes directly from shared memory. One browser compatibility check: if `A.i8` flag is set (detected at init via a WebAssembly.Module test), the bytes are copied to a new Uint8Array before compilation. This handles browsers where SharedArrayBuffer views can't be passed to WebAssembly.compile() directly.

**Synchronization flags:** HEAP32 at `asyncPtrOffset` is used as a signaling mechanism:
- Value `-2` means "I/O or JIT complete, check your messages"
- `asyncPtrOffset + 5` set to `2` specifically for JIT type 48 responses
- The Worker likely polls or uses Atomics.wait() on these offsets

**JIT Bisect debugging UI:** CheerpX includes a built-in debug panel with:
- A textarea showing hex addresses of all JIT'd blocks
- "Bisect" buttons to narrow down which JIT'd block causes a bug
- Trace dump (type 78/44) for the full list of JIT'd addresses

### Atua adaptation:

For atua-computer on browser-native WASM:
- Engine (Blink compiled to WASM) writes WASM bytes to shared linear memory
- Calls an atua import: `__host_compile_block(offset, length) → handle`
- Host JS receives the call, extracts bytes from shared memory
- Host compiles via `@wasmer/sdk` module compilation or `WebAssembly.compile()`
- Returns handle that engine stores in its dispatch table
- On failure: save bytes, log error, interpreter continues

---

## 4. Block Device Architecture — Complete Flow

### Device Class Hierarchy (from public API and code analysis)

```
Device (base — wraps arbitrary JS object as device)
├── BlockDevice (abstract — block-level I/O)
│   ├── HttpBytesDevice    — HTTP Range requests for remote read-only blocks
│   ├── CloudDevice        — WebSocket-based remote block access (Last-Modified tracking)
│   ├── GitHubDevice       — GitHub-hosted block images
│   ├── FileDevice         — Single file as device (dumpable)
│   └── OverlayDevice      — Combines read-only base + read-write layer
└── CheerpOSDevice
    ├── IDBDevice          — IndexedDB-backed persistent storage
    ├── DataDevice         — In-memory data device (writeFile support)
    └── WebDevice          — Web-backed CheerpOS device
```

### Block Read Flow (HttpBytesDevice)

```javascript
// From xe() function - HTTP Range request
xhr = new XMLHttpRequest();
xhr.open("GET", device.url);
xhr.setRequestHeader("Range", "bytes=" + start + "-" + (start + length - 1));
xhr.responseType = "arraybuffer";
xhr.onload = function() {
    data = new Uint8Array(xhr.response);
    // Copy to engine's shared memory or return via callback
};
xhr.send();
```

### Block Read Flow (CloudDevice — WebSocket)

```javascript
// From networking code
ws = new WebSocket(device.url);
ws.binaryType = 'arraybuffer';
ws.onmessage = function(event) {
    data = event.data;  // ArrayBuffer
    if (data.byteLength === 0) {
        // Connection close signal
    } else if (data.byteLength === 1) {
        // Reconnect signal — create new WebSocket
        newWs = new WebSocket(device.url);
        // ... reconnection logic
    } else {
        // Actual block data
        blockData = new Uint8Array(data);
        // Return to engine
    }
};
ws.send(rangeString);  // e.g., "1024-2047"
```

### Overlay Device

The OverlayDevice combines a read-only base (HttpBytesDevice) with a read-write layer (IDBDevice):
```
OverlayDevice.create(readOnlyBase, readWriteLayer)
```
- Read: check write layer first (local writes), fall back to base (remote)
- Write: always goes to write layer (IDBDevice)
- `dumpDevice()`: serialize the write layer for export

### Device Registration with Engine

When a device is registered, the main thread sends:
```javascript
{ type: 9, diskType: type, index: deviceIndex, devId: device.id, len: device.length }
```
Followed by:
```javascript
{ type: 45, index: deviceIndex, devId: device.id, len: device.length, writeProtected: flag }
{ type: 41, index: deviceIndex, len: device.length }
```

### I/O Transaction Flow

1. Engine Worker needs a disk block → sends type 10 (read) or 11 (write) with `devId`, `start`, `len`, `ioTransaction`
2. Main thread looks up device by `devId` in a device registry array (`P`)
3. Calls `device.read(continuation, device, context, start, len, HEAP8, value)` or `.write()`
4. I/O completes (async callback) → main thread sends type 12 with `ioTransaction` and sets `HEAP32[asyncPtrOffset] = -2`
5. Engine Worker resumes execution

### Unrolled Memory Copy

When block data arrives, it's copied into the engine's shared memory using an optimized 8-byte unrolled loop:

```javascript
// Simplified from yR/xu functions
remainder = length & 7;
for (i = 0; i < remainder; i++) {
    HEAP8[destOffset + i] = sourceData[i];
}
for (; i < length; i += 8) {
    HEAP8[destOffset + i + 0] = sourceData[i + 0];
    HEAP8[destOffset + i + 1] = sourceData[i + 1];
    HEAP8[destOffset + i + 2] = sourceData[i + 2];
    HEAP8[destOffset + i + 3] = sourceData[i + 3];
    HEAP8[destOffset + i + 4] = sourceData[i + 4];
    HEAP8[destOffset + i + 5] = sourceData[i + 5];
    HEAP8[destOffset + i + 6] = sourceData[i + 6];
    HEAP8[destOffset + i + 7] = sourceData[i + 7];
}
```

### Atua adaptation:

- Use `fetch()` with Range headers instead of XHR (modern, promise-based)
- Use OPFS (AtuaFS) instead of IndexedDB for the write layer — OPFS is faster for file-like access
- Same overlay pattern: OPFS cache + OPFS write overlay over HTTP CDN base
- Block size granularity: use 4KB blocks (ext2 default, aligned with OPFS)
- Device registration protocol maps to engine initialization messages

---

## 5. Process Execution Model

### Process Launch (type 59)

When `cx.run("/bin/bash", ["--login"], { env: [...], cwd: "/home" })` is called:

```javascript
message = {
    type: 59,
    path: "/bin/bash",           // executable path
    args: ["--login"],           // argument array
    env: ["HOME=/home", ...],    // environment array
    tid: threadId,               // thread ID (from a pool, reused)
    index: processIndex,         // index in process callback array
    handlers: signalHandlers,    // Uint8Array(32) — 32 signal dispositions
    cwd: "/home",                // working directory (null = inherit)
    uid: 1000,                   // user ID (default 1000)
    gid: 1000                    // group ID (default 1000)
};
worker.postMessage(message);
```

### Run with Capture (type 79)

For `cx.run()` with stdout/stderr capture:
```javascript
message = {
    type: 79,
    path: "/bin/ls",
    args: ["-la"],
    stdout: stdoutCallback,    // function to receive stdout data
    stderr: stderrCallback,    // function to receive stderr data
    env: [...],
    tid: threadId
};
```

### Signal Handling

Signals are modeled as a 32-entry Uint8Array (one byte per signal number, 32 signals = standard POSIX signals):
```javascript
handlers = new Uint8Array(32);
// Default disposition for most signals
for (i = 0; i < 32; i++) handlers[i] = defaultHandler;
// SIGUSR1 gets special handling if specified
if (options.SIGUSR1 !== undefined) handlers[10] = options.SIGUSR1;
```

The `CheerpXProcess.setSignalHandlers()` API allows updating signal handlers after process creation.

Signal delivery uses type 56 messages: `{ type: 56, value: signalNumber, arg1: data }`.

### Process Callbacks

Processes are tracked in an array (`a28`). When a process slot is needed:
```javascript
index = processArray.indexOf(null);  // find free slot
if (index < 0) {
    index = processArray.length;
    processArray.push(callback);     // grow array
} else {
    processArray[index] = callback;  // reuse slot
}
```

This is a lightweight PID-like system without actual kernel PID management.

### Atua adaptation:

- Process exec maps to loading ELF binary in the engine, setting up registers, jumping to entry point
- Signal handlers map to Blink's existing signal infrastructure
- The type 59 message fields (path, args, env, cwd, uid, gid) are exactly what Blink's `execve()` handler needs
- stdout/stderr capture (type 79) maps to redirecting fd 1/2 to message-passing callbacks
- Default uid/gid 1000 matches Alpine's default user — adopt the same default

---

## 6. Networking Architecture

### Multiple Backend System

CheerpX supports four network backends, selected at creation time:

| Backend | Transport | Use Case |
|---------|-----------|----------|
| `StreamNetwork(url)` | WebSocket | Default — proxy all TCP/UDP through WebSocket relay |
| `TailscaleNetwork(config)` | WebSocket + Tailscale WASM | VPN — direct connectivity via Tailscale mesh |
| `DirectSocketsNetwork` | Chrome Direct Sockets API | Raw TCP/UDP (Chrome only, origin trial) |
| `DummyNetwork` | None | No networking (offline mode) |

### WebSocket Connection Pattern

All WebSocket connections use binary mode:
```javascript
ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';
ws.onmessage = handler;
```

### Network Message Flow

```
Guest process calls socket/connect/send/recv
     ↓
Engine Worker intercepts syscall
     ↓
Engine sends network message to main thread
     ↓
Main thread operates on WebSocket (connect, send data)
     ↓
Main thread receives data from WebSocket
     ↓
Main thread sends data message to engine Worker
     ↓
Engine delivers data to guest process
```

Specific messages:
- **UDP data in**: `{ type: 103, data: ArrayBuffer, id: socketId, remoteAddr: addr, remotePort: port }`
- **TCP data in**: `{ type: 104, data: ArrayBuffer, id: socketId }`
- **Connect result**: `{ type: 37, retCode: errno, id: socketId, localPort: port }`
  - retCode 0 = success, -98 = EADDRINUSE
- **Bind result**: `{ type: 105, retCode: errno, localPort: port, id: socketId }`
  - retCode 0 = success, -111 = ECONNREFUSED
- **Accept**: `{ type: 106, id: socketId, remoteAddr: addr, remotePort: port, localPort: port }`
- **Port pair**: `{ type: 35, id: socketId, remotePort: port, value: MessagePort }`

### Error Code Mapping

CheerpX uses Linux errno values in network messages:
- `-98` = EADDRINUSE (address already in use)
- `-111` = ECONNREFUSED (connection refused)
- `-30` = ENOSYS (function not implemented — used in thread results too)

### Atua adaptation:

- atua-net already provides WebSocket-based networking via Wisp relay — same architecture
- Map network syscalls (socket, connect, bind, listen, accept, send, recv) to messages
- Use same errno codes (they're Linux errno values, which Blink already uses)
- No need for TailscaleNetwork or DirectSocketsNetwork initially — StreamNetwork equivalent via atua-net is sufficient

---

## 7. Terminal I/O Architecture

### Console Setup

CheerpX offers two console modes:

**Simple console** (`setConsole(element)`):
- Output goes directly to DOM element's `textContent`
- Simple but limited

**Custom console** (`setCustomConsole(writeCallback, columns, rows)`):
- Returns an input function
- Sends terminal dimensions to engine: `{ type: 87, columns: cols, rows: rows }`
- Stores write callback for output data
- Returns function that sends input bytes

```javascript
// API usage (from CheerpX docs, confirmed by code):
const inputFunction = cx.setCustomConsole(
    (data) => { terminal.write(new Uint8Array(data)); },  // output
    80,  // columns
    24   // rows
);
// Send input:
inputFunction(charCode);
```

### Keyboard Input

Key events are captured from the document and sent as messages:

```javascript
// Keydown (type 92)
document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey) return;  // Pass through Ctrl+Shift
    event.preventDefault();
    HEAP32[asyncPtrOffset] = -2;  // Signal the engine
    worker.postMessage({ type: 92, value: event.keyCode });
});

// Keyup (type 93)
document.addEventListener('keyup', (event) => {
    if (event.ctrlKey && event.shiftKey) return;
    event.preventDefault();
    HEAP32[asyncPtrOffset] = -2;
    worker.postMessage({ type: 93, value: event.keyCode });
});
```

### Batched Input (type 94)

For high-throughput input (paste, fast typing), events are batched:
```javascript
{ type: 94, value: 0, keyCode: code, timeStamp: timestamp }
```
This sends multiple events with timestamps for proper ordering.

### Atua adaptation:

- xterm.js serves as the terminal renderer
- Input: xterm.js `onData()` → message to engine Worker with character codes
- Output: engine Worker → message to main thread → `terminal.write()`
- Terminal resize: xterm.js `onResize()` → message with new columns/rows
- The `setCustomConsole` pattern is exactly what we need — adopt it

---

## 8. Async I/O Synchronization Mechanism

### The asyncPtrOffset Pattern

CheerpX uses a specific location in shared HEAP32 memory as a synchronization flag between the engine Worker and the main thread.

**Initialization:**
```javascript
// Main thread sets up the async pointer:
worker.postMessage({
    kind: 1,
    buffer: sharedArrayBuffer,
    basePtr: asyncPtrOffset,       // Offset into HEAP32 for sync flags
    startRealTime: performance.now(),
    port: messageChannelPort
});
```

**Engine blocks on I/O:**
The engine Worker likely uses `Atomics.wait(HEAP32, asyncPtrOffset, currentValue)` to block until the main thread completes an I/O operation.

**Main thread signals completion:**
```javascript
// After completing any I/O, JIT compile, etc.:
HEAP32[asyncPtrOffset] = -2;  // Signal: "check your messages"
worker.postMessage(responseMessage);
```

**For JIT specifically:**
```javascript
// In p8 (JIT success callback):
if (replyType === 48) {
    HEAP32[asyncPtrOffset + 5] = 2;  // JIT-specific flag
}
HEAP32[asyncPtrOffset] = -2;         // General "done" flag
worker.postMessage({ type: 48, wasmModule: compiled });
```

### I/O Transaction Pattern

Every blocking I/O operation has a `ioTransaction` field that acts as a correlation ID:
```javascript
// Engine sends read request:
worker.postMessage({ type: 10, devId: 3, start: 4096, len: 512, ioTransaction: txId });

// Main thread completes read, sends:
HEAP32[asyncPtrOffset] = -2;
worker.postMessage({ type: 12, ioTransaction: txId });
```

### Atua adaptation:

For browser-native WASM:
- WASM threads support `Atomics.wait()` / `Atomics.notify()` on SharedArrayBuffer
- The engine's linear memory IS a SharedArrayBuffer (requirement for threading)
- When engine needs I/O: call an atua import function that triggers the host
- Host completes I/O, writes result to shared memory, calls `Atomics.notify()`
- Engine wakes up and reads the result
- This is simpler than CheerpX's approach because WASM provides the blocking primitive natively

---

## 9. Worker Initialization Sequence

### Main Engine Worker

```
1. Load cxcore.js as Worker
   - Either: new Worker('cxcore.js')
   - Or: create Blob from inlined code, URL.createObjectURL(), new Worker(blobUrl)

2. Set up message handler on Worker (onmessage)

3. Create MessageChannel for clock worker
   - port1 → sent to existing engine Worker via { type: 86, value: port1 }
   - port2 → sent to new clock Worker

4. Transfer SharedArrayBuffer to engine Worker:
   {
       kind: 1,
       buffer: sharedArrayBuffer,
       basePtr: asyncPtrOffset,
       startRealTime: performance.now(),
       port: port2  // clock channel
   }

5. On first message back from Worker (type 0 handler):
   - HEAP8 = new Uint8Array(buffer)
   - HEAP16 = new Uint16Array(buffer)
   - HEAP32 = new Int32Array(buffer)
   - Test WebAssembly.Module compatibility with SharedArrayBuffer views
   - Store asyncPtrOffset
   - Initialize clock Worker
```

### Clock Worker

Separate worker (`workerclock.js`) connected via MessageChannel port. Provides high-resolution timing independent of the main thread's event loop.

### Additional Workers

CheerpX can spawn additional workers for CPU-parallel operations. Each new worker:
1. Gets its own MessageChannel port
2. Receives the SharedArrayBuffer
3. Shares the same HEAP8/16/32 views

### Atua adaptation:

The boot sequence for atua-computer should be:
1. Load engine.wasm in Worker via @wasmer/sdk
2. Initialize WASM instance with shared memory
3. Attach bridges (FS, net, terminal) via atua imports
4. Engine starts, loads Nitro as PID 1 from ext2 rootfs
5. Nitro boots, starts agent-shell service
6. Bash prompt appears in xterm.js

No separate clock worker needed — `performance.now()` is available in Workers via the atua clock import. No separate MessageChannel needed — the engine worker handles thread communication internally.

---

## 10. Mount System

### Mount Configuration at Create Time

Mounts are configured when creating the Linux instance:
```javascript
cx = await CheerpX.Linux.create({
    mounts: [
        { type: "ext2", path: "/", dev: overlayDevice },
        { type: "dir", path: "/home", dev: dataDevice },
        // ... additional mounts
    ]
});
```

### Mount Validation

From the code:
- First mount MUST have path "/" (root). If not, logs error.
- Mounts are processed in order: type, dev (device object), path
- Each mount is stored with its type string and device reference

### Mount Message

After processing, mount info is sent to the engine:
```javascript
{ type: 15, tid: threadId, mountType: typeString, path: mountPath, devId: deviceId }
```

### Atua adaptation:

Mount table for atua-computer:
```javascript
mounts: [
    { type: "ext2", path: "/",           dev: overlayDevice },  // Alpine rootfs (CDN + OPFS overlay)
    { type: "atuafs", path: "/mnt/project", dev: atuaFsDevice },  // Shared project directory
    { type: "proc", path: "/proc",       dev: procDevice },     // Synthetic procfs
    { type: "dev", path: "/dev",         dev: devDevice },      // Synthetic devfs
    { type: "tmp", path: "/tmp",         dev: tmpDevice },      // In-memory tmpfs
]
```

---

## 11. Performance Profiling System

### Callback Registration

CheerpX maintains a global callback registry (`a$` array) indexed by event type:

```javascript
// Internal: a$[0..4] = callback registrations
// a$[2] = "cpu" events (profiling, "wait"/"ready" state)
// a$[3] = "disk" events (I/O timing)

// Register:
cx.registerCallback(eventType, callback);
// Sends: { type: 57, eventType: typeIndex } to engine

// Unregister:
cx.unregisterCallback(eventType, callback);
// Sends: { type: 80, eventType: typeIndex } to engine
```

### Timing Pattern

Operations are timed with `performance.now()`:
```javascript
startTime = performance.now();
// ... execute operation ...
elapsed = performance.now() - startTime;
callback(Math.floor(elapsed));  // Integer milliseconds
```

This is used for:
- Block device read timing (to identify slow devices)
- CPU operation timing (to identify JIT candidates)
- Overall performance monitoring

### HUD (Heads-Up Display)

`createHud()` creates a debug overlay showing:
- JIT bisect controls (textarea + buttons)
- Performance statistics
- JIT trace addresses

### Atua adaptation:

Add profiling from Phase 1:
- Time every exec() call
- Time every syscall bridge round-trip
- Time every block fetch
- Expose timing via the MCP status() tool
- Use timing data to prioritize JIT targets (Phase 6)

---

## 12. State Machine / Continuation Pattern

### How CheerpX handles async operations in compiled C++

The largest functions in cx.js (l0: 630 lines, uc: 580 lines, tM: 539 lines) are async state machines. Cheerp compiles C++ coroutines/callbacks into JavaScript state machines with this pattern:

```javascript
function largeFn(args) {
    switch (state & 15) {
        case 0: /* initial state */ break;
        case 1: /* after first await */ break;
        case 2: /* after second await */ break;
        // ... up to 15 states
    }

    while (1) {
        switch (currentAction) {
            case 0: /* do work, maybe set up async op */ break;
            case 1: /* resume after async op completed */ break;
            // ...
        }
    }
}
```

Each async operation (HTTP fetch, IDB read, WebSocket message) saves the current state, registers a callback, and returns. When the callback fires, it re-enters the state machine at the saved state.

### Continuation objects

Continuations are represented as objects with:
- `a0` — callback function (success)
- `a1` — callback function (failure/cleanup)
- `a2` — state data (results, intermediate values)
- `a3` — nested continuation
- `i4` — state index (integer)

The pattern `if (a[f].a0 !== null)` checks whether a continuation has a pending callback. If yes, save state and break. If no, inline the next step.

### Atua adaptation:

This pattern is specific to Cheerp's compilation of C++ async code to JavaScript. Atua doesn't need this because:
- Blink compiled to WASM uses native blocking (Atomics.wait) — no callback-based async
- Host-side JS uses standard async/await
- The message-passing protocol handles the async boundary

However, understanding this pattern helps interpret what the large CheerpX functions are doing: they're not algorithmic complexity, they're async state machines for I/O operations.

---

## 13. Browser Compatibility Handling

### SharedArrayBuffer Detection

```javascript
// Test if Atomics.wait works (requires CrossOriginIsolation)
try {
    Atomics.wait(HEAP32, 0, 0, 0);
    // Supported
} catch (e) {
    // Not supported — need COOP/COEP headers
}
```

### WebAssembly.Module Compatibility

```javascript
// Test if SharedArrayBuffer views work with WebAssembly.Module
try {
    new WebAssembly.Module(HEAP8.subarray(0, 0));
} catch (e) {
    if (e.message == 'first argument must be an ArrayBuffer or typed array object') {
        // Browser requires copying SharedArrayBuffer to ArrayBuffer for WASM compilation
        needsCopy = true;
    }
}
```

If `needsCopy` is true, JIT compile requests copy the WASM bytes to a new Uint8Array before calling `WebAssembly.compile()`.

### Worker Loading

Two paths for loading the engine Worker:
1. **Direct**: `new Worker('cxcore.js')` — when served from same origin
2. **Blob URL**: `new Blob([code]) → URL.createObjectURL() → new Worker(blobUrl)` — when cross-origin

### Atua adaptation:

- Always require CrossOriginIsolation (Atua already needs it for SharedArrayBuffer in other subsystems)
- Test WebAssembly.Module + SharedArrayBuffer compatibility at startup
- Always use Blob URL for Worker loading (avoids same-origin restrictions)

---

## 14. File List and External Dependencies

### Files loaded by CheerpX

| File | Purpose |
|------|---------|
| `cx.js` | Main thread: public API, message dispatch, I/O bridges, JIT compiler host |
| `cxcore.js` | Engine Worker bootstrap: loads cxcore.wasm, sets up message handling |
| `cxcore.wasm` | Engine: compiled C++ x86 emulator (instruction interpreter, syscall dispatch, memory management) |
| `cxcore-no-return-call.js` | Alternative cxcore loader (for specific error recovery) |
| `workerclock.js` | Clock Worker: high-resolution timing independent of main thread |
| `cheerpOS.js` | CheerpOS integration (optional) |
| `cxbridge.js` | Bridge for CheerpOS (optional) |
| `tun/tailscale_tun_auto.js` | Tailscale network integration (optional) |
| `tun/direct.js` | Direct Sockets network integration (optional) |
| `fail.wasm` | Downloaded on JIT failure for debugging |

### Browser APIs Used (with occurrence counts)

| API | Count | Purpose |
|-----|-------|---------|
| postMessage | 88 | Worker communication |
| document.createElement | 32 | UI elements (HUD, debug panels) |
| requestAnimationFrame | 9 | Display rendering (VGA framebuffer) |
| onmessage | 8 | Worker message handlers |
| Blob | 7 | Worker creation, fail.wasm download |
| XMLHttpRequest | 6 | Block device I/O |
| URL.createObjectURL | 4 | Worker Blob URLs, file downloads |
| WebSocket | 3 | Network I/O, CloudDevice |
| Worker | 3 | Engine, clock, additional workers |
| performance.now | 3 | Profiling |
| fetch | 2 | Resource loading |
| MessageChannel | 2 | Worker-to-Worker communication |
| URL.revokeObjectURL | 2 | Cleanup |
| IndexedDB | 2 | Persistent block storage |
| WebAssembly.compile | 1 | JIT compilation |
| WebAssembly.Module | 1 | Compatibility test |
| Atomics.wait | 1 | SharedArrayBuffer sync test |
| setTimeout | 1 | Delayed operations |
| setInterval | 1 | Periodic operations |

---

## 15. Summary: What to Build for Atua

Based on this comprehensive analysis, here are the core architectural components atua-computer needs, mapped from CheerpX's proven patterns:

### Must build:
1. **Engine Worker** — Blink compiled to WASM, running in a dedicated Worker
2. **Typed message protocol** — structured {type, ...fields} messages between engine and host
3. **SharedArrayBuffer memory** — engine's linear memory shared with host for zero-copy I/O and JIT
4. **Block device streaming** — HTTP Range fetch + OPFS cache + OPFS write overlay
5. **Terminal bridge** — xterm.js ↔ engine message passing (output callback + input send function)
6. **Network bridge** — atua-net WebSocket relay, mapping Linux errno codes
7. **Process exec** — path, args, env, cwd, uid, gid, signal handlers
8. **I/O synchronization** — Atomics.wait()/notify() for blocking syscalls

### Build later (Phase 6+):
9. **JIT compilation service** — engine sends WASM bytes, host compiles, engine patches dispatch
10. **JIT debug tooling** — fail.wasm download, trace dump, bisect UI

### Skip (not needed for agent use case):
- VGA framebuffer rendering (requestAnimationFrame display loop)
- Mouse input (agents use CLI)
- Multiple CPU/clock workers (single-thread sufficient initially)
- TailscaleNetwork / DirectSocketsNetwork (atua-net is sufficient)
- CheerpOS integration
- Floppy/BIOS/VGA BIOS loading (syscall-level emulation, no hardware)
