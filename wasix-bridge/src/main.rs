mod protocol;
mod pipe;
mod process;
mod thread;
mod signal;
mod socket;

use protocol::*;
use core::sync::atomic::Ordering;

fn main() {
    // Zero out the entire ring buffer region on startup
    unsafe {
        let region = core::slice::from_raw_parts_mut(RING_OFFSET as *mut u8, RING_TOTAL_SIZE);
        region.fill(0);
    }

    let header = unsafe { ring_header() };
    eprintln!("[wasix-bridge] ready, ring at offset {RING_OFFSET}, {RING_SLOTS} slots");

    loop {
        // Wait until there's a request to process
        let read_pos = header[RING_READ_POS].load(Ordering::Acquire);
        let write_pos = header[RING_WRITE_POS].load(Ordering::Acquire);

        if read_pos == write_pos {
            // Ring empty — sleep briefly, then re-check
            std::thread::sleep(std::time::Duration::from_micros(50));
            continue;
        }

        // Read the next slot
        let slot_index = read_pos as usize % RING_SLOTS;
        let slot = unsafe { ring_slot(slot_index) };

        // Verify slot has a request (status == 1)
        let status = slot[SLOT_STATUS].load(Ordering::Acquire) as u32;
        if status != STATUS_REQUEST {
            // Slot not ready yet — spin briefly
            std::thread::sleep(std::time::Duration::from_micros(10));
            continue;
        }

        // Read request
        let msg_type = slot[SLOT_MSG_TYPE].load(Ordering::Acquire);
        let a = [
            slot[SLOT_PAYLOAD + 0].load(Ordering::Acquire),
            slot[SLOT_PAYLOAD + 1].load(Ordering::Acquire),
            slot[SLOT_PAYLOAD + 2].load(Ordering::Acquire),
            slot[SLOT_PAYLOAD + 3].load(Ordering::Acquire),
            slot[SLOT_PAYLOAD + 4].load(Ordering::Acquire),
            slot[SLOT_PAYLOAD + 5].load(Ordering::Acquire),
        ];

        // Dispatch to handler
        let r = match msg_type {
            REQ_PIPE_CREATE          => pipe::create(),
            REQ_PIPE_CLOSE           => pipe::close(a[0]),
            REQ_FORK                 => process::fork(),
            REQ_EXEC                 => process::exec(a[0], a[1]),
            REQ_SPAWN                => process::spawn(a[0], a[1], a[2], a[3], a[4], a[5]),
            REQ_WAIT                 => process::wait(a[0], a[1]),
            REQ_PID_ALLOCATE         => process::pid_allocate(),
            REQ_EXIT_NOTIFY          => process::exit_notify(a[0], a[1]),
            REQ_THREAD_SPAWN         => thread::spawn(a[0], a[1]),
            REQ_THREAD_JOIN          => thread::join(a[0]),
            REQ_THREAD_EXIT          => thread::exit(a[0]),
            REQ_FUTEX_WAIT           => thread::futex_wait(a[0], a[1], a[2]),
            REQ_FUTEX_WAKE           => thread::futex_wake(a[0], a[1]),
            REQ_FUTEX_WAKE_ALL       => thread::futex_wake_all(a[0]),
            REQ_SIGNAL_REGISTER      => signal::register(a[0], a[1]),
            REQ_SIGNAL_SEND          => signal::send(a[0], a[1]),
            REQ_SIGNAL_RAISE_INTERVAL => signal::raise_interval(a[0], a[1], a[2]),
            REQ_SOCK_OPEN            => socket::open(a[0], a[1], a[2]),
            REQ_SOCK_BIND            => socket::bind(a[0], a[1], a[2]),
            REQ_SOCK_LISTEN          => socket::listen(a[0], a[1]),
            REQ_SOCK_CONNECT         => socket::connect(a[0], a[1], a[2]),
            REQ_SOCK_ACCEPT          => socket::accept(a[0]),
            REQ_SOCK_SEND            => socket::send(a[0], a[1], a[2]),
            REQ_SOCK_RECV            => socket::recv(a[0], a[1], a[2]),
            REQ_SOCK_CLOSE           => socket::close(a[0]),
            REQ_SOCK_SENDTO          => socket::sendto(a[0], a[1], a[2], a[3], a[4]),
            REQ_SOCK_RECVFROM        => socket::recvfrom(a[0], a[1], a[2]),
            REQ_DNS_RESOLVE          => socket::resolve(a[0], a[1]),
            REQ_SHUTDOWN             => { eprintln!("[wasix-bridge] shutdown"); break; }
            unknown => {
                eprintln!("[wasix-bridge] unknown request: {unknown}");
                BridgeResult::err(38) // ENOSYS
            }
        };

        // Write response into the SAME slot (reuse payload area for results)
        slot[SLOT_PAYLOAD + 0].store(r.val, Ordering::Release);
        slot[SLOT_PAYLOAD + 1].store(r.r1, Ordering::Release);
        slot[SLOT_PAYLOAD + 2].store(r.r2, Ordering::Release);
        slot[SLOT_PAYLOAD + 3].store(r.r3, Ordering::Release);
        slot[SLOT_ERROR].store(r.err, Ordering::Release);

        // Mark slot as response_ready — this wakes the kernel's Atomics.wait
        slot[SLOT_STATUS].store(STATUS_RESPONSE, Ordering::Release);

        // Advance read position
        header[RING_READ_POS].store(read_pos.wrapping_add(1), Ordering::Release);
    }
}
