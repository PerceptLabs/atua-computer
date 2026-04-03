use crate::protocol::*;
use core::sync::atomic::{AtomicU32, Ordering};

static NEXT_PIPE_SLOT: AtomicU32 = AtomicU32::new(0);

/// Create a new pipe. Returns (read_fd, write_fd, ring_offset_in_bridge_sab).
///
/// The ring buffer is allocated in the bridge's own linear memory (which is a
/// SharedArrayBuffer). Execution workers read/write these ring buffers directly
/// using Atomics.wait/notify. The kernel is NEVER involved in pipe data transfer.
///
/// Ring buffer layout per pipe slot (PIPE_SLOT_SIZE = 64KB + 16 bytes):
///   Bytes  0..3:  write_pos   (u32, atomic)
///   Bytes  4..7:  read_pos    (u32, atomic)
///   Bytes  8..11: write_closed (u32, 1 = closed)
///   Bytes 12..15: read_closed  (u32, 1 = closed)
///   Bytes 16..:   data ring buffer (65536 bytes)
pub fn create() -> BridgeResult {
    let slot = NEXT_PIPE_SLOT.fetch_add(1, Ordering::SeqCst);
    let ring_offset = PIPE_REGION_START + (slot as usize * PIPE_SLOT_SIZE);

    // Zero out ring buffer header
    unsafe {
        let h = ring_offset as *mut u32;
        core::ptr::write_volatile(h.add(0), 0); // write_pos
        core::ptr::write_volatile(h.add(1), 0); // read_pos
        core::ptr::write_volatile(h.add(2), 0); // write_closed
        core::ptr::write_volatile(h.add(3), 0); // read_closed
    }

    let read_fd = (slot * 2 + 100) as i32;
    let write_fd = (slot * 2 + 101) as i32;

    BridgeResult::ok3(read_fd, write_fd, ring_offset as i32)
}

/// Close one end of a pipe. Sets the write_closed or read_closed flag
/// so the other end sees EOF.
pub fn close(fd: i32) -> BridgeResult {
    let slot_base = ((fd - 100) / 2) as usize;
    let is_write = (fd % 2) == 1;
    let ring_offset = PIPE_REGION_START + slot_base * PIPE_SLOT_SIZE;

    unsafe {
        let h = ring_offset as *mut u32;
        if is_write {
            core::ptr::write_volatile(h.add(2), 1); // write_closed = 1
        } else {
            core::ptr::write_volatile(h.add(3), 1); // read_closed = 1
        }
    }
    BridgeResult::ok(0)
}
