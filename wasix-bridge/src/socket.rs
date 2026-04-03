use crate::protocol::*;

/// Read bytes from the bridge's DATA region.
#[allow(dead_code)]
fn read_data(offset: usize, len: usize) -> &'static [u8] {
    unsafe { core::slice::from_raw_parts((DATA_OFFSET + offset) as *const u8, len) }
}

/// Write bytes into the bridge's DATA region.
fn write_data(offset: usize, data: &[u8]) {
    unsafe {
        let dest = core::slice::from_raw_parts_mut((DATA_OFFSET + offset) as *mut u8, data.len());
        dest.copy_from_slice(data);
    }
}

/// Open a socket via raw WASIX sock_open.
pub fn open(domain: i32, sock_type: i32, protocol: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let mut ret_fd: u32 = 0;
    let errno = unsafe {
        wasix_32v1::sock_open(
            domain,
            sock_type,
            protocol,
            &mut ret_fd as *mut u32 as i32,
        )
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(ret_fd as i32)
}

/// Bind a socket. Address bytes are in DATA region at addr_offset.
pub fn bind(fd: i32, addr_offset: i32, _addr_len: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let addr_ptr = (DATA_OFFSET + addr_offset as usize) as i32;
    let errno = unsafe { wasix_32v1::sock_bind(fd, addr_ptr) };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(0)
}

/// Listen on a socket.
pub fn listen(fd: i32, backlog: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let errno = unsafe { wasix_32v1::sock_listen(fd, backlog) };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(0)
}

/// Connect a socket. Address bytes in DATA region.
pub fn connect(fd: i32, addr_offset: i32, _addr_len: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let addr_ptr = (DATA_OFFSET + addr_offset as usize) as i32;
    let errno = unsafe { wasix_32v1::sock_connect(fd, addr_ptr) };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(0)
}

/// Accept a connection on a socket.
pub fn accept(fd: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let mut ret_fd: u32 = 0;
    // AddrPort is a variable-size tagged union; allocate enough space on the stack
    let mut ret_addr = [0u8; 128];
    let errno = unsafe {
        wasix_32v1::sock_accept_v2(
            fd,
            0, // flags
            &mut ret_fd as *mut u32 as i32,
            ret_addr.as_mut_ptr() as i32,
        )
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(ret_fd as i32)
}

/// Send data on a socket. Data is in DATA region at data_offset.
/// Uses raw WASIX sock_send_to with a null address (for connected sockets).
pub fn send(fd: i32, data_offset: i32, len: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let data_ptr = (DATA_OFFSET + data_offset as usize) as *const u8;

    // Build a Ciovec on the stack: { buf: *const u8, buf_len: usize }
    // On wasm32, both fields are 4 bytes (pointer is i32, usize is u32).
    #[repr(C)]
    struct RawCiovec {
        buf: u32,
        buf_len: u32,
    }
    let ciov = RawCiovec {
        buf: data_ptr as u32,
        buf_len: len as u32,
    };

    // Build an "unspec" AddrPort for null address (tag=0, rest zeroed)
    let null_addr = [0u8; 128];

    let mut sent: u32 = 0;
    let errno = unsafe {
        wasix_32v1::sock_send_to(
            fd,
            &ciov as *const RawCiovec as i32,
            1, // iovec count
            0, // si_flags
            null_addr.as_ptr() as i32,
            &mut sent as *mut u32 as i32,
        )
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(sent as i32)
}

/// Receive data from a socket. Data written to DATA region at data_offset.
/// Uses raw WASIX sock_recv_from.
pub fn recv(fd: i32, data_offset: i32, max_len: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let buf_ptr = (DATA_OFFSET + data_offset as usize) as *mut u8;

    // Build an Iovec on the stack: { buf: *mut u8, buf_len: usize }
    #[repr(C)]
    struct RawIovec {
        buf: u32,
        buf_len: u32,
    }
    let iov = RawIovec {
        buf: buf_ptr as u32,
        buf_len: max_len as u32,
    };

    let mut received: u32 = 0;
    let mut roflags: u32 = 0;
    let mut ret_addr = [0u8; 128];

    let errno = unsafe {
        wasix_32v1::sock_recv_from(
            fd,
            &iov as *const RawIovec as i32,
            1, // iovec count
            0, // ri_flags
            &mut received as *mut u32 as i32,
            &mut roflags as *mut u32 as i32,
            ret_addr.as_mut_ptr() as i32,
        )
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(received as i32)
}

/// Close a socket (uses WASI fd_close — typed API works fine here).
pub fn close(fd: i32) -> BridgeResult {
    match unsafe { wasix::wasi::fd_close(fd as u32) } {
        Ok(()) => BridgeResult::ok(0),
        Err(errno) => BridgeResult::err(errno.raw() as i32),
    }
}

/// Send data to a specific address (UDP sendto).
pub fn sendto(fd: i32, data_offset: i32, len: i32, addr_offset: i32, _addr_len: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let data_ptr = (DATA_OFFSET + data_offset as usize) as *const u8;
    let addr_ptr = (DATA_OFFSET + addr_offset as usize) as i32;

    #[repr(C)]
    struct RawCiovec {
        buf: u32,
        buf_len: u32,
    }
    let ciov = RawCiovec {
        buf: data_ptr as u32,
        buf_len: len as u32,
    };

    let mut sent: u32 = 0;
    let errno = unsafe {
        wasix_32v1::sock_send_to(
            fd,
            &ciov as *const RawCiovec as i32,
            1, // iovec count
            0, // si_flags
            addr_ptr,
            &mut sent as *mut u32 as i32,
        )
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    BridgeResult::ok(sent as i32)
}

/// Receive data from a specific address (UDP recvfrom).
pub fn recvfrom(fd: i32, data_offset: i32, max_len: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let buf_ptr = (DATA_OFFSET + data_offset as usize) as *mut u8;

    #[repr(C)]
    struct RawIovec {
        buf: u32,
        buf_len: u32,
    }
    let iov = RawIovec {
        buf: buf_ptr as u32,
        buf_len: max_len as u32,
    };

    let mut received: u32 = 0;
    let mut roflags: u32 = 0;
    // Write the returned address into DATA region at offset 0 so the kernel can read it
    let mut ret_addr = [0u8; 128];

    let errno = unsafe {
        wasix_32v1::sock_recv_from(
            fd,
            &iov as *const RawIovec as i32,
            1, // iovec count
            0, // ri_flags
            &mut received as *mut u32 as i32,
            &mut roflags as *mut u32 as i32,
            ret_addr.as_mut_ptr() as i32,
        )
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }
    // Write the address back to DATA region at offset 0 for kernel to read
    write_data(0, &ret_addr);
    BridgeResult::ok(received as i32)
}

/// DNS resolve. Host name in DATA region at name_offset.
pub fn resolve(name_offset: i32, name_len: i32) -> BridgeResult {
    use wasix::x::wasix_32v1;

    let name_ptr = (DATA_OFFSET + name_offset as usize) as i32;

    // Allocate space for up to 4 Addr results on the stack.
    // Addr is a tagged union; use a generous buffer.
    let mut addrs = [0u8; 4 * 128];
    let mut count: u32 = 0;

    let errno = unsafe {
        wasix_32v1::resolve(
            name_ptr,
            name_len,
            0, // port hint (zero = no hint)
            addrs.as_mut_ptr() as i32,
            4, // max addresses
            &mut count as *mut u32 as i32,
        )
    };
    if errno != 0 {
        return BridgeResult::err(errno);
    }

    // Write first resolved address back to DATA region for kernel to read
    if count > 0 {
        // Copy the raw address bytes — the kernel knows the Addr layout
        let addr_size = core::mem::size_of::<wasix::Addr>();
        let bytes = &addrs[..addr_size];
        write_data(0, bytes);
    }
    BridgeResult::ok(count as i32)
}
