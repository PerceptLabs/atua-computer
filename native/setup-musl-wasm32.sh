#!/bin/bash
# Set up musl wasm32 arch and compile musl for wasm32-unknown-unknown
set -euo pipefail

MUSL="/home/ubuntu/musl"
CC="/opt/wasi-sdk-32.0-x86_64-linux/bin/clang"
AR="/opt/wasi-sdk-32.0-x86_64-linux/bin/llvm-ar"
RANLIB="/opt/wasi-sdk-32.0-x86_64-linux/bin/llvm-ranlib"
PREFIX="/opt/musl-wasm32"

# === Create wasm32 arch directory ===
mkdir -p ${MUSL}/arch/wasm32/bits

# syscall_arch.h — the key file: routes musl syscalls to our atua imports
cat > ${MUSL}/arch/wasm32/syscall_arch.h << 'ARCHEOF'
/* musl syscall backend for wasm32 — routes to atua_* imports */

#define __SYSCALL_LL_E(x) (x)
#define __SYSCALL_LL_O(x) (x)

/* Import declarations for atua host functions */
__attribute__((import_module("atua"), import_name("host_syscall")))
extern long atua_host_syscall(long n, long a, long b, long c, long d, long e, long f);

static inline long __syscall0(long n) {
    return atua_host_syscall(n, 0, 0, 0, 0, 0, 0);
}
static inline long __syscall1(long n, long a) {
    return atua_host_syscall(n, a, 0, 0, 0, 0, 0);
}
static inline long __syscall2(long n, long a, long b) {
    return atua_host_syscall(n, a, b, 0, 0, 0, 0);
}
static inline long __syscall3(long n, long a, long b, long c) {
    return atua_host_syscall(n, a, b, c, 0, 0, 0);
}
static inline long __syscall4(long n, long a, long b, long c, long d) {
    return atua_host_syscall(n, a, b, c, d, 0, 0);
}
static inline long __syscall5(long n, long a, long b, long c, long d, long e) {
    return atua_host_syscall(n, a, b, c, d, e, 0);
}
static inline long __syscall6(long n, long a, long b, long c, long d, long e, long f) {
    return atua_host_syscall(n, a, b, c, d, e, f);
}
ARCHEOF

# atomic_arch.h — wasm32 is single-threaded for now
cat > ${MUSL}/arch/wasm32/atomic_arch.h << 'ATOMEOF'
#define a_cas a_cas
static inline int a_cas(volatile int *p, int t, int s) {
    int old = *p;
    if (old == t) *p = s;
    return old;
}

#define a_crash a_crash
static inline void a_crash() {
    __builtin_trap();
}
ATOMEOF

# pthread_arch.h — thread pointer for wasm32
cat > ${MUSL}/arch/wasm32/pthread_arch.h << 'PTEOF'
/* wasm32: single-threaded, TLS via global */
static inline uintptr_t __get_tp() {
    /* Use a global variable for thread pointer */
    extern unsigned long __thread_pointer;
    return __thread_pointer;
}

#define TLS_ABOVE_TP
#define GAP_ABOVE_TP 0
#define TP_OFFSET 0
#define DTP_OFFSET 0
PTEOF

# reloc.h — no dynamic linking on wasm32
cat > ${MUSL}/arch/wasm32/reloc.h << 'RELEOF'
#define LDSO_ARCH "wasm32"
#define NO_LEGACY_INITFINI
#define CRTJMP(pc,sp) __builtin_trap()
#define GETFUNCSYM(fp, sym, got) __builtin_trap()
RELEOF

# crt_arch.h — startup
cat > ${MUSL}/arch/wasm32/crt_arch.h << 'CRTEOF'
/* wasm32 startup — _start calls __libc_start_main */
__attribute__((export_name("_start")))
void _start(void) {
    extern int main(int, char **, char **);
    extern void __libc_start_main(int (*)(int, char **, char **), int, char **);
    __libc_start_main(main, 0, (char**)0);
}
CRTEOF

# bits/alltypes.h — fundamental types for wasm32
cat > ${MUSL}/arch/wasm32/bits/alltypes.h.in << 'TYPESEOF'
#define _Addr int
#define _Int64 long long
#define _Reg int

TYPEDEF __builtin_va_list va_list;
TYPEDEF __builtin_va_list __isoc_va_list;

#ifndef __cplusplus
TYPEDEF unsigned wchar_t;
#endif

TYPEDEF float float_t;
TYPEDEF double double_t;

TYPEDEF long time_t;
TYPEDEF long suseconds_t;

TYPEDEF struct { union { int __i[sizeof(long)==8?10:6]; volatile int __vi[sizeof(long)==8?10:6]; volatile void *volatile __p[sizeof(long)==8?10:6]; } __u; } pthread_attr_t;
TYPEDEF struct { union { int __i[sizeof(long)==8?14:8]; volatile int __vi[sizeof(long)==8?14:8]; volatile void *volatile __p[sizeof(long)==8?14:8]; } __u; } pthread_mutex_t;
TYPEDEF struct { union { int __i[sizeof(long)==8?10:6]; volatile int __vi[sizeof(long)==8?10:6]; volatile void *volatile __p[sizeof(long)==8?10:6]; } __u; } mtx_t;
TYPEDEF struct { union { int __i[12]; volatile int __vi[12]; void *__p[12]; } __u; } pthread_cond_t;
TYPEDEF struct { union { int __i[12]; volatile int __vi[12]; void *__p[12]; } __u; } cnd_t;
TYPEDEF struct { union { int __i[sizeof(long)==8?14:8]; volatile int __vi[sizeof(long)==8?14:8]; volatile void *volatile __p[sizeof(long)==8?14:8]; } __u; } pthread_rwlock_t;
TYPEDEF struct { union { int __i[sizeof(long)==8?4:5]; volatile int __vi[sizeof(long)==8?4:5]; volatile void *volatile __p[sizeof(long)==8?4:5]; } __u; } pthread_barrier_t;
TYPEDEF unsigned __socklen_t;
TYPEDEF unsigned short __sa_family_t;
TYPESEOF

# bits/syscall.h.in — syscall numbers (use Linux x86 numbers since Blink emulates Linux)
cat > ${MUSL}/arch/wasm32/bits/syscall.h.in << 'SYSEOF'
/* Use generic/x86-64 syscall numbers — Blink emulates Linux */
#define __NR_read 0
#define __NR_write 1
#define __NR_open 2
#define __NR_close 3
#define __NR_stat 4
#define __NR_fstat 5
#define __NR_lstat 6
#define __NR_lseek 8
#define __NR_mmap 9
#define __NR_mprotect 10
#define __NR_munmap 11
#define __NR_brk 12
#define __NR_ioctl 16
#define __NR_writev 20
#define __NR_dup 32
#define __NR_dup2 33
#define __NR_getpid 39
#define __NR_fork 57
#define __NR_execve 59
#define __NR_exit 60
#define __NR_fcntl 72
#define __NR_getcwd 79
#define __NR_chdir 80
#define __NR_mkdir 83
#define __NR_rmdir 84
#define __NR_unlink 87
#define __NR_readlink 89
#define __NR_getuid 102
#define __NR_getgid 104
#define __NR_geteuid 107
#define __NR_getegid 108
#define __NR_getppid 110
#define __NR_rt_sigaction 13
#define __NR_rt_sigprocmask 14
#define __NR_pipe 22
#define __NR_pipe2 293
#define __NR_clone 56
#define __NR_wait4 61
#define __NR_exit_group 231
#define __NR_clock_gettime 228
#define __NR_clock_getres 229
#define __NR_getrandom 318
#define __NR_set_tid_address 218
#define __NR_set_robust_list 273
SYSEOF

# arch.mak — arch-specific make rules
cat > ${MUSL}/arch/wasm32/arch.mak << 'MAKEOF'
COMPAT_SRC_DIRS =
MAKEOF

echo "wasm32 arch directory created"

# === Configure musl ===
cd ${MUSL}

# musl's configure needs AR and RANLIB
CROSS_COMPILE="" \
CC="${CC} --target=wasm32-unknown-unknown -nostdlib -ffreestanding" \
AR="${AR}" \
RANLIB="${RANLIB}" \
CFLAGS="-O2 -fno-strict-aliasing --target=wasm32-unknown-unknown -nostdlib -ffreestanding -D__wasm32__=1" \
./configure \
    --target=wasm32 \
    --prefix=${PREFIX} \
    --disable-shared \
    --disable-optimize \
    2>&1 | tail -10

echo "=== Building musl ==="
# Build just the static library — skip shared objects and crt files that need linking
make -j4 lib/libc.a 2>&1 | tail -20
echo "make exit: $?"

echo "=== Installing ==="
make install-headers 2>&1 | tail -3
mkdir -p ${PREFIX}/lib
cp lib/libc.a ${PREFIX}/lib/ 2>/dev/null || echo "libc.a not built"
ls -la ${PREFIX}/lib/libc.a 2>&1
ls ${PREFIX}/include/ | head -10
