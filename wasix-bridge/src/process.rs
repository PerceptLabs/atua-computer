use crate::protocol::BridgeResult;
use core::sync::atomic::{AtomicI32, Ordering};

static NEXT_PID: AtomicI32 = AtomicI32::new(2); // PID 1 = init (parent Blink process)

/// Allocate a child PID for fork. The JS kernel handles worker spawning
/// and memory copying. The bridge provides PID management only.
pub fn fork() -> BridgeResult {
    let child_pid = NEXT_PID.fetch_add(1, Ordering::SeqCst);
    BridgeResult::ok(child_pid)
}

/// Allocate a PID without fork semantics.
pub fn pid_allocate() -> BridgeResult {
    let pid = NEXT_PID.fetch_add(1, Ordering::SeqCst);
    BridgeResult::ok(pid)
}

/// Acknowledge exec. The kernel handles ELF loading into the execution worker.
pub fn exec(_path_ptr: i32, _path_len: i32) -> BridgeResult {
    BridgeResult::ok(0)
}

/// Spawn a new process. Allocates a PID; kernel handles the rest.
pub fn spawn(_path_ptr: i32, _path_len: i32, _argv_ptr: i32, _argv_len: i32, _envp_ptr: i32, _envp_len: i32) -> BridgeResult {
    let child_pid = NEXT_PID.fetch_add(1, Ordering::SeqCst);
    BridgeResult::ok(child_pid)
}

/// Wait for a child process.
/// The kernel tracks exit codes via postMessage from child workers.
/// waitpid blocking is the kernel's responsibility (Atomics.waitAsync on exit flag).
/// The bridge provides PID management and parent-child relationships.
pub fn wait(pid: i32, _flags: i32) -> BridgeResult {
    BridgeResult::ok2(pid, 0)
}

/// Kernel notifies bridge that a process exited.
pub fn exit_notify(pid: i32, code: i32) -> BridgeResult {
    BridgeResult::ok2(pid, code)
}

/// Send a signal to a process via raw WASIX proc_signal.
#[allow(dead_code)]
pub fn signal(pid: i32, sig: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;
    let errno = unsafe { wasix_32v1::proc_signal(pid, sig) };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(0)
}
