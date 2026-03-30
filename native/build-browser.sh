#!/bin/bash
# Build Blink engine for browser — upstream musl libc, atua imports, zero WASI.
# musl routes all libc I/O through host_syscall. Blink routes guest I/O through atua_* imports.
set -euo pipefail

BLINK_DIR="/workspace/native/blink"
WASI_SDK="/opt/wasi-sdk-32.0-x86_64-linux"
CC="${WASI_SDK}/bin/clang"
AR="${WASI_SDK}/bin/llvm-ar"
MUSL="/opt/musl-atua"
BUILD_DIR="/tmp/blink-browser-build"
OUTPUT="/workspace/src/browser/engine.wasm"
COMPAT="/workspace/native/blink-wasi-compat.h"
STUBS="/workspace/native/stubs"
RT="${WASI_SDK}/lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a"

# Use upstream musl headers. -nostdinc suppresses clang builtins that conflict.
# -isystem musl/include first, then clang intrinsics (stdarg.h, stddef.h).
CFLAGS="--target=wasm32-unknown-unknown -nostdinc -ffreestanding \
  -isystem ${MUSL}/include \
  -isystem ${WASI_SDK}/lib/clang/22/include \
  -O2 -DNDEBUG -D__ATUA_BROWSER__ -DDISABLE_OVERLAYS \
  -I${STUBS} -I${BLINK_DIR} -I${BLINK_DIR}/third_party/libz \
  -D_FILE_OFFSET_BITS=64 -D_DEFAULT_SOURCE -D_BSD_SOURCE -D_GNU_SOURCE \
  -include ${COMPAT} -fno-strict-aliasing -Wno-static-in-inline -ferror-limit=0"

mkdir -p "${BUILD_DIR}" "$(dirname ${OUTPUT})"

echo "=== Compiling Blink sources ==="
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

# Compile zlib
for src in ${BLINK_DIR}/third_party/libz/*.c; do
    base=$(basename "$src" .c)
    ${CC} ${CFLAGS} -w -c "$src" -o "${BUILD_DIR}/zlib_${base}.o" 2>/dev/null || true
done

# Provide __thread_pointer (musl's pthread_arch.h references it)
echo "unsigned long __thread_pointer;" | ${CC} --target=wasm32-unknown-unknown -nostdinc -ffreestanding \
  -isystem ${MUSL}/include -isystem ${WASI_SDK}/lib/clang/22/include \
  -c -x c - -o "${BUILD_DIR}/tp.o"

# Provide setjmp/longjmp (wasm32 has no register context to save)
cat > "${BUILD_DIR}/sjlj.c" << 'EOF'
#include <setjmp.h>
int setjmp(jmp_buf env) { (void)env; return 0; }
_Noreturn void longjmp(jmp_buf env, int val) { (void)env; (void)val; __builtin_trap(); }
EOF
${CC} --target=wasm32-unknown-unknown -nostdinc -ffreestanding \
  -isystem ${MUSL}/include -isystem ${WASI_SDK}/lib/clang/22/include \
  -c "${BUILD_DIR}/sjlj.c" -o "${BUILD_DIR}/sjlj.o"

# Provide get_exit_code export
cat > "${BUILD_DIR}/exitcode.c" << 'EOF'
static unsigned _exit_code;
__attribute__((export_name("get_exit_code")))
unsigned get_exit_code(void) { return _exit_code; }
EOF
${CC} --target=wasm32-unknown-unknown -nostdinc -ffreestanding \
  -isystem ${MUSL}/include -isystem ${WASI_SDK}/lib/clang/22/include \
  -c "${BUILD_DIR}/exitcode.c" -o "${BUILD_DIR}/exitcode.o"

# Provide _start (crt1) — calls musl's __libc_start_main
cat > "${BUILD_DIR}/crt1.c" << 'EOF'
extern int main(int, char **);
extern void __wasm_call_ctors(void);

/* Get args from JS via atua imports */
__attribute__((import_module("atua"), import_name("args_sizes_get")))
extern int _args_sizes_get(int *argc, int *argv_buf_size);
__attribute__((import_module("atua"), import_name("args_get")))
extern int _args_get(char **argv, char *argv_buf);

/* Normal entry: init C runtime + run main */
__attribute__((export_name("_start")))
void _start(void) {
    __wasm_call_ctors();

    int argc = 0, argv_buf_size = 0;
    _args_sizes_get(&argc, &argv_buf_size);

    char *argv_buf[4096];
    char argv_data[8192];
    char **argv = (char **)argv_buf;
    _args_get(argv, (char *)argv_data);
    argv[argc] = 0;

    main(argc, argv);
    __builtin_trap();
}

/* Fork child entry: init C runtime WITHOUT main.
 * Child gets a fresh WASM instance with uninitialized musl.
 * This makes malloc/brk/TLS work before restore_fork runs. */
__attribute__((export_name("init_for_fork")))
void init_for_fork(void) {
    __wasm_call_ctors();
}
EOF
${CC} --target=wasm32-unknown-unknown -nostdinc -ffreestanding \
  -isystem ${MUSL}/include -isystem ${WASI_SDK}/lib/clang/22/include \
  -c "${BUILD_DIR}/crt1.c" -o "${BUILD_DIR}/crt1.o"

echo "=== Building blink archive ==="
${AR} rcs "${BUILD_DIR}/libblink.a" ${BUILD_DIR}/*.o
# Remove standalone objects that are linked separately
${AR} d "${BUILD_DIR}/libblink.a" blink.o crt1.o tp.o sjlj.o exitcode.o 2>/dev/null || true

echo "=== Linking ==="
${WASI_SDK}/bin/wasm-ld \
    "${BUILD_DIR}/crt1.o" \
    "${BUILD_DIR}/blink.o" \
    "${BUILD_DIR}/libblink.a" \
    "${BUILD_DIR}/tp.o" \
    "${BUILD_DIR}/sjlj.o" \
    "${BUILD_DIR}/exitcode.o" \
    ${MUSL}/lib/libc.a \
    ${RT} \
    -z stack-size=1048576 \
    --export-memory --export=_start --export=init_for_fork --export=restore_fork --export=malloc --export=free --export=get_exit_code \
    --export=get_pagepool_base --export=get_pagepool_size --export=get_hostpages_count --export=get_hostpages_addrs \
    -o "${OUTPUT}"

echo "=== Result ==="
ls -la "${OUTPUT}"
echo "Build complete!"
