fn main() {
    // Write magic bytes at offset 65536 so JS can verify memory access
    unsafe {
        let ptr = 65536 as *mut u32;
        core::ptr::write_volatile(ptr, 0xDEADBEEF);
        core::ptr::write_volatile(ptr.add(1), 0xCAFEBABE);
    }
    eprintln!("[wasix-bridge] magic written, waiting...");
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}
