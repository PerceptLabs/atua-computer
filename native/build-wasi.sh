#!/bin/bash
# Build Blink engine as WASIX binary for @wasmer/sdk
# Run inside the atua-computer Docker container
#
# Usage: docker exec atua-computer /bin/bash /workspace/native/build-wasi.sh
#
# Prerequisites:
#   - wasi-sdk 32 at /opt/wasi-sdk-32.0-x86_64-linux
#   - wasix-libc sysroot at /opt/wasix-sysroot/sysroot
#   - Blink source (patched) at /home/ubuntu/blink
#   - blink-wasix-compat.h at /home/ubuntu/blink-wasix-compat.h
#   - stubs dir at /home/ubuntu/stubs (contains sys/mount.h stub)
set -euo pipefail

BLINK_DIR="/home/ubuntu/blink"
WASI_SDK="/opt/wasi-sdk-32.0-x86_64-linux"
CC="${WASI_SDK}/bin/clang"
AR="${WASI_SDK}/bin/llvm-ar"
WASIX_SYSROOT="/opt/wasix-sysroot/sysroot"
BUILD_DIR="/home/ubuntu/blink-wasi-build"
OUTPUT="/workspace/wasm/engine-wasix.wasm"
COMPAT="/home/ubuntu/blink-wasix-compat.h"
STUBS="/home/ubuntu/stubs"

CFLAGS="--target=wasm32-wasip1 --sysroot=${WASIX_SYSROOT} -O2 -DNDEBUG \
  -I${STUBS} -I${BLINK_DIR} -I${BLINK_DIR}/third_party/libz \
  -D_FILE_OFFSET_BITS=64 -D_DEFAULT_SOURCE -D_BSD_SOURCE -D_GNU_SOURCE \
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
  -include ${COMPAT} -fno-strict-aliasing -Wno-static-in-inline -ferror-limit=0"

mkdir -p "${BUILD_DIR}"

# === Phase 1: Compile all Blink sources ===
echo "=== Compiling Blink sources ==="
rm -f ${BUILD_DIR}/*.o

COMPILED=0
FAILED=0
for src in ${BLINK_DIR}/blink/*.c; do
    base=$(basename "$src" .c)
    [[ "$base" == "blinkenlights" || "$base" == "xnu" ]] && continue
    if ${CC} ${CFLAGS} -Wno-error -c "$src" -o "${BUILD_DIR}/${base}.o" 2>/dev/null; then
        COMPILED=$((COMPILED + 1))
    else
        FAILED=$((FAILED + 1))
        echo "FAILED: ${base}.c"
    fi
done
echo "Compiled: ${COMPILED}, Failed: ${FAILED}"

# === Phase 2: Compile zlib ===
echo "=== Compiling zlib ==="
for src in ${BLINK_DIR}/third_party/libz/*.c; do
    base=$(basename "$src" .c)
    ${CC} ${CFLAGS} -w -c "$src" -o "${BUILD_DIR}/zlib_${base}.o" 2>/dev/null || true
done

# === Phase 3: Compile WASIX stubs ===
echo "=== Compiling WASIX stubs ==="
cat > /tmp/wasix_stubs.c << 'STUBEOF'
#include <errno.h>
#include <stddef.h>
#include <string.h>
#include <stdarg.h>
int mprotect(void *addr, unsigned long len, int prot) { return 0; }
int flock(int fd, int operation) { errno = 38; return -1; }
void __wasm_init_tls(void *mem) { (void)mem; }
long syscall(long num, ...) { (void)num; errno = 38; return -1; }
int sockatmark(int fd) { (void)fd; return 0; }
void GetRandom(void *buf, size_t len, int flags) { (void)flags; memset(buf, 0x42, len); }
int sched_getaffinity(int pid, size_t size, void *set) { (void)pid; memset(set, 0xff, size); return 0; }
int sched_setaffinity(int pid, size_t size, const void *set) { (void)pid; (void)size; (void)set; return 0; }
int __sched_cpucount(size_t size, const void *set) { (void)size; (void)set; return 1; }
struct Machine;
int SysIoctl(struct Machine *m, int fd, long long request, long long arg) { (void)m; (void)fd; (void)request; (void)arg; return -1; }
struct msghdr;
int SendAncillary(struct Machine *m, int flags, long addr) { (void)m; (void)flags; (void)addr; return 0; }
int ReceiveAncillary(struct Machine *m, long addr, unsigned int *len, struct msghdr *msg) { (void)m; (void)addr; (void)len; (void)msg; return 0; }
struct sysinfo_s { long uptime; unsigned long loads[3]; unsigned long totalram, freeram, sharedram, bufferram, totalswap, freeswap; unsigned short procs; unsigned long totalhigh, freehigh; unsigned int mem_unit; };
int sysinfo(struct sysinfo_s *info) { memset(info, 0, sizeof(*info)); info->totalram = 256*1024*1024; info->freeram = 128*1024*1024; info->mem_unit = 1; return 0; }
STUBEOF
${CC} --target=wasm32-wasip1 --sysroot=${WASIX_SYSROOT} -D_WASI_EMULATED_SIGNAL -c /tmp/wasix_stubs.c -o "${BUILD_DIR}/wasix_stubs.o"

# === Phase 4: Create archive and link ===
echo "=== Building archive ==="
${AR} rcs "${BUILD_DIR}/libblink.a" ${BUILD_DIR}/*.o
${AR} d "${BUILD_DIR}/libblink.a" wasix_stubs.o 2>/dev/null || true
${AR} d "${BUILD_DIR}/libblink.a" blink.o 2>/dev/null || true

echo "=== Linking ==="
${WASI_SDK}/bin/wasm-ld \
    "${BUILD_DIR}/blink.o" \
    "${BUILD_DIR}/libblink.a" \
    "${BUILD_DIR}/wasix_stubs.o" \
    "${WASIX_SYSROOT}/lib/wasm32-wasi/crt1.o" \
    -L"${WASIX_SYSROOT}/lib/wasm32-wasi" \
    -lc -lm -lwasi-emulated-mman -lwasi-emulated-process-clocks -lpthread \
    -L"${WASI_SDK}/lib/clang/22/lib/wasip1" \
    -lclang_rt.builtins-wasm32 \
    -o "${OUTPUT}"

echo "=== Result ==="
ls -la "${OUTPUT}"
echo "Build complete!"
