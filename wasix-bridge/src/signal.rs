use crate::protocol::BridgeResult;

/// Register a signal handler via raw WASIX callback_signal.
pub fn register(_signal_num: i32, _handler: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    // callback_signal takes a pointer and length for the exported callback function name.
    // The actual signal delivery is handled by the kernel via execution workers.
    let name = "signal_handler";
    unsafe {
        wasix_32v1::callback_signal(name.as_ptr() as i32, name.len() as i32);
    }
    // callback_signal returns void — always succeeds
    BridgeResult::ok(0)
}

/// Send a signal to a process via raw WASIX proc_signal.
pub fn send(pid: i32, signal_num: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let errno = unsafe { wasix_32v1::proc_signal(pid, signal_num) };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(0)
}

/// Set up a recurring signal via raw WASIX proc_raise_interval.
pub fn raise_interval(signal_num: i32, interval_ns: i32, repeat: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    // The raw API takes: signal (i32), interval (i64), repeat (i32 as Bool)
    let errno = unsafe {
        wasix_32v1::proc_raise_interval(
            signal_num,
            interval_ns as i64,
            repeat, // 0 = BOOL_FALSE, 1 = BOOL_TRUE
        )
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(0)
}
