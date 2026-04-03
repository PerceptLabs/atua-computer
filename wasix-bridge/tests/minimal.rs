// Minimal WASIX module to test @wasmer/sdk memory access
// Writes a magic value to a known location so JS can verify access

#[no_mangle]
pub static MAGIC_OFFSET: u32 = 65536;

#[no_mangle]
pub extern "C" fn get_magic_ptr() -> *const u8 {
    65536 as *const u8
}

fn main() {
    // Write magic bytes at offset 65536
    unsafe {
        let ptr = 65536 as *mut u32;
        core::ptr::write_volatile(ptr, 0xDEADBEEF);
        core::ptr::write_volatile(ptr.add(1), 0xCAFEBABE);
    }
    eprintln!("[test-bridge] magic written at offset 65536");
    // Keep running so JS can inspect memory
    std::thread::sleep(std::time::Duration::from_secs(30));
}
