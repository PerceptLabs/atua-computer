use crate::protocol::BridgeResult;
use core::sync::atomic::{AtomicI32, Ordering};

static NEXT_TID: AtomicI32 = AtomicI32::new(100);

/// Allocate a thread ID. The kernel creates a new execution worker for each thread.
pub fn spawn(_entry: i32, _user_data: i32) -> BridgeResult {
    let tid = NEXT_TID.fetch_add(1, Ordering::SeqCst);
    BridgeResult::ok(tid)
}

/// Thread join. Kernel handles via Atomics.waitAsync on thread exit flag.
pub fn join(_tid: i32) -> BridgeResult {
    BridgeResult::ok(0)
}

/// Thread exit.
pub fn exit(code: i32) -> BridgeResult {
    BridgeResult::ok(code)
}

/// WASIX futex_wait — blocks until the futex word changes or timeout.
/// addr is an offset in the bridge's DATA region. The kernel copies
/// the futex word there before calling.
pub fn futex_wait(addr: i32, expected: i32, timeout_ns: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    // Build OptionTimestamp on the stack.
    // Layout: tag (u8) + padding + union (u64 Timestamp).
    // The raw API takes a pointer to this struct as i32.
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct RawOptionTimestamp {
        tag: u8,
        _pad: [u8; 7],
        timestamp: u64,
    }

    let timeout = if timeout_ns < 0 {
        RawOptionTimestamp {
            tag: 0, // OPTION_NONE
            _pad: [0; 7],
            timestamp: 0,
        }
    } else {
        RawOptionTimestamp {
            tag: 1, // OPTION_SOME
            _pad: [0; 7],
            timestamp: timeout_ns as u64,
        }
    };

    let mut ret_val: u32 = 0;
    let errno = unsafe {
        wasix_32v1::futex_wait(
            addr,
            expected,
            &timeout as *const RawOptionTimestamp as i32,
            &mut ret_val as *mut u32 as i32,
        )
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    // ret_val: 1 = woken normally (BOOL_TRUE), 0 = timed out (BOOL_FALSE)
    BridgeResult::ok(if ret_val != 0 { 0 } else { -110 }) // -ETIMEDOUT
}

/// WASIX futex_wake — wake up to count waiters on the futex.
pub fn futex_wake(addr: i32, _count: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let mut ret_val: u32 = 0;
    let errno = unsafe {
        wasix_32v1::futex_wake(addr, &mut ret_val as *mut u32 as i32)
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    // ret_val: 1 = woke a thread, 0 = no thread was waiting
    BridgeResult::ok(if ret_val != 0 { 1 } else { 0 })
}

/// WASIX futex_wake_all — wake all waiters on the futex.
pub fn futex_wake_all(addr: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let mut ret_val: u32 = 0;
    let errno = unsafe {
        wasix_32v1::futex_wake_all(addr, &mut ret_val as *mut u32 as i32)
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(if ret_val != 0 { 1 } else { 0 })
}
