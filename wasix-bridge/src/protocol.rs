use core::sync::atomic::{AtomicI32, AtomicU32};

// ─── Memory layout ──────────────────────────────────────────────
pub const RING_OFFSET: usize = 65536;
pub const RING_SLOTS: usize = 32;
pub const RING_SLOT_SIZE: usize = 64;
pub const RING_HEADER_SIZE: usize = 16;
pub const RING_TOTAL_SIZE: usize = RING_HEADER_SIZE + RING_SLOTS * RING_SLOT_SIZE;
pub const DATA_OFFSET: usize = RING_OFFSET + RING_TOTAL_SIZE;
pub const DATA_SIZE: usize = 1024 * 1024;
pub const PIPE_REGION_START: usize = DATA_OFFSET + DATA_SIZE;
pub const PIPE_SLOT_SIZE: usize = 64 * 1024 + 16;

// ─── Ring header offsets (u32 indices into ring header) ─────────
pub const RING_WRITE_POS: usize = 0;
pub const RING_READ_POS: usize = 1;
#[allow(dead_code)]
pub const RING_NEXT_ID: usize = 2;

// ─── Message slot offsets (i32 indices within a 64-byte slot) ───
#[allow(dead_code)]
pub const SLOT_REQUEST_ID: usize = 0;
pub const SLOT_MSG_TYPE: usize = 1;
pub const SLOT_STATUS: usize = 2; // 0=free, 1=request_ready, 2=response_ready
pub const SLOT_ERROR: usize = 3;
pub const SLOT_PAYLOAD: usize = 4; // payload[0..7] = 8 × i32
#[allow(dead_code)]
pub const SLOT_DATA_OFFSET: usize = 12;
#[allow(dead_code)]
pub const SLOT_DATA_LENGTH: usize = 13;

pub const STATUS_REQUEST: u32 = 1;
pub const STATUS_RESPONSE: i32 = 2;

// ─── Request types ──────────────────────────────────────────────
pub const REQ_PIPE_CREATE: i32 = 1;
pub const REQ_PIPE_CLOSE: i32 = 2;
pub const REQ_FORK: i32 = 10;
pub const REQ_EXEC: i32 = 11;
pub const REQ_SPAWN: i32 = 12;
pub const REQ_WAIT: i32 = 13;
pub const REQ_PID_ALLOCATE: i32 = 14;
pub const REQ_EXIT_NOTIFY: i32 = 15;
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
pub const REQ_SHUTDOWN: i32 = 99;

// ─── Result type ────────────────────────────────────────────────
pub struct BridgeResult {
    pub val: i32,
    pub r1: i32,
    pub r2: i32,
    pub r3: i32,
    pub err: i32,
}

impl BridgeResult {
    pub fn ok(val: i32) -> Self {
        Self { val, r1: 0, r2: 0, r3: 0, err: 0 }
    }
    pub fn ok2(val: i32, r1: i32) -> Self {
        Self { val, r1, r2: 0, r3: 0, err: 0 }
    }
    pub fn ok3(val: i32, r1: i32, r2: i32) -> Self {
        Self { val, r1, r2, r3: 0, err: 0 }
    }
    pub fn err(errno: i32) -> Self {
        Self { val: 0, r1: 0, r2: 0, r3: 0, err: errno }
    }
}

// ─── Ring buffer helpers (Rust side — bridge consumer) ──────────

/// Get the ring header as AtomicU32 slice (4 entries at RING_OFFSET)
pub unsafe fn ring_header() -> &'static [AtomicU32] {
    core::slice::from_raw_parts(RING_OFFSET as *const AtomicU32, 4)
}

/// Get a message slot as AtomicI32 slice (16 entries = 64 bytes)
pub unsafe fn ring_slot(index: usize) -> &'static [AtomicI32] {
    let offset = RING_OFFSET + RING_HEADER_SIZE + (index % RING_SLOTS) * RING_SLOT_SIZE;
    core::slice::from_raw_parts(offset as *const AtomicI32, RING_SLOT_SIZE / 4)
}
