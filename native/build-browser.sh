#!/bin/bash
# Build Blink engine for browser — plain WASM with atua imports
# Uses wasi-sdk for libc + linker. Our JS provides all runtime imports.
set -euo pipefail

BLINK_DIR="/home/ubuntu/blink"
WASI_SDK="/opt/wasi-sdk-32.0-x86_64-linux"
CC="${WASI_SDK}/bin/clang"
AR="${WASI_SDK}/bin/llvm-ar"
WASI_SYSROOT="${WASI_SDK}/share/wasi-sysroot"
POSIX_SYSROOT="/opt/wasix-sysroot/sysroot"  # POSIX-compatible headers (termios.h, spawn.h, etc.)
BUILD_DIR="/home/ubuntu/blink-browser-build"
OUTPUT="/workspace/src/browser/engine.wasm"
COMPAT="/home/ubuntu/blink-wasi-compat.h"
STUBS="/home/ubuntu/stubs"

# Headers from WASI sysroot (POSIX-compatible: termios.h, spawn.h, etc.)
# Linker/libc from wasi-sdk (pure WASI)
CFLAGS="--target=wasm32-wasip1 --sysroot=${POSIX_SYSROOT} \
  -O2 -DNDEBUG -D__ATUA_BROWSER__ -DDISABLE_OVERLAYS \
  -I${STUBS} -I${BLINK_DIR} -I${BLINK_DIR}/third_party/libz \
  -D_FILE_OFFSET_BITS=64 -D_DEFAULT_SOURCE -D_BSD_SOURCE -D_GNU_SOURCE \
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
  -include ${COMPAT} -fno-strict-aliasing -Wno-static-in-inline -ferror-limit=0"

mkdir -p "${BUILD_DIR}" "$(dirname ${OUTPUT})"

echo "=== Compiling Blink sources (browser target) ==="
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

# Compile browser stubs — single-threaded engine, no real ioctl/sockets
cat > /tmp/browser_stubs.c << 'STUBEOF'
#include <errno.h>
#include <stddef.h>
#include <string.h>
#include <stdarg.h>

/* mprotect: return success always. The wasi-emulated-mman version tries real page
 * protection which doesn't work in browser WASM. Guest's glibc ld.so needs mprotect
 * to succeed for RELRO segments. */
/* mprotect: no-op stub. wasi-emulated-mman provides mmap/munmap, but its mprotect
 * tries real page protection which doesn't work in browser. Our stub goes first. */
int mprotect(void *addr, unsigned long len, int prot) { (void)addr; (void)len; (void)prot; return 0; }
int flock(int fd, int operation) { errno = 38; return -1; }
void __wasm_init_tls(void *mem) { (void)mem; }
long syscall(long num, ...) { (void)num; errno = 38; return -1; }
int sockatmark(int fd) { (void)fd; return 0; }
int GetRandom(void *buf, size_t len, int flags) { (void)flags; memset(buf, 0x42, len); return len; }
int sched_getaffinity(int pid, size_t size, void *set) { (void)pid; memset(set, 0xff, size); return 0; }
int sched_setaffinity(int pid, size_t size, const void *set) { (void)pid; (void)size; (void)set; return 0; }
int __sched_cpucount(size_t size, const void *set) { (void)size; (void)set; return 1; }

/* Blink stubs — browser handles these via JS imports or stubs */
struct Machine;
int SysIoctl(struct Machine *m, int fd, long long request, long long arg) { (void)m; (void)fd; (void)request; (void)arg; return -1; }
struct msghdr;
int SendAncillary(struct Machine *m, int flags, long addr) { (void)m; (void)flags; (void)addr; return 0; }
int ReceiveAncillary(struct Machine *m, long addr, unsigned int *len, struct msghdr *msg) { (void)m; (void)addr; (void)len; (void)msg; return 0; }
struct sysinfo_s { long uptime; unsigned long loads[3]; unsigned long totalram, freeram, sharedram, bufferram, totalswap, freeswap; unsigned short procs; unsigned long totalhigh, freehigh; unsigned int mem_unit; };
int sysinfo(struct sysinfo_s *info) { memset(info, 0, sizeof(*info)); info->totalram = 256*1024*1024; info->freeram = 128*1024*1024; info->mem_unit = 1; return 0; }

/* pthread stubs — single-threaded WASM engine, all noops */
int pthread_mutex_init(void *m, const void *a) { (void)m; (void)a; return 0; }
int pthread_mutex_lock(void *m) { (void)m; return 0; }
int pthread_mutex_unlock(void *m) { (void)m; return 0; }
int pthread_mutex_destroy(void *m) { (void)m; return 0; }
int pthread_once(void *o, void (*f)(void)) { (void)o; f(); return 0; }
int pthread_sigmask(int h, const void *s, void *o) { (void)h; (void)s; (void)o; return 0; }
int pthread_cond_init(void *c, const void *a) { (void)c; (void)a; return 0; }
int pthread_cond_wait(void *c, void *m) { (void)c; (void)m; return 0; }
int pthread_cond_signal(void *c) { (void)c; return 0; }
int pthread_cond_destroy(void *c) { (void)c; return 0; }

/* dup/dup2 stubs — fail loud. Blink handles guest dup2 via __ATUA_BROWSER__ ifdef. */
int dup(int fd) { errno = 38; return -1; }
int dup2(int oldfd, int newfd) { (void)oldfd; errno = 38; return -1; }

/* Signal stubs — wasi-sdk has no real signals */
typedef unsigned long sigset_t_stub;
int sigemptyset(void *set) { if (set) memset(set, 0, sizeof(sigset_t_stub)); return 0; }
int sigfillset(void *set) { if (set) memset(set, 0xff, sizeof(sigset_t_stub)); return 0; }
int sigaddset(void *set, int sig) { (void)set; (void)sig; return 0; }
int sigaction(int sig, const void *act, void *old) { (void)sig; (void)act; (void)old; return 0; }
int sigprocmask(int how, const void *set, void *old) { (void)how; (void)set; (void)old; return 0; }
int kill(int pid, int sig) { (void)pid; (void)sig; return -1; }
int getpid(void) { return 1; }
int getppid(void) { return 0; }

/* Resource stubs */
struct rlimit_stub { long rlim_cur; long rlim_max; };
int getrlimit(int resource, void *rlim) { struct rlimit_stub *r = rlim; r->rlim_cur = 1024; r->rlim_max = 1024; return 0; }

/* Signal function stub — signal() not in wasi-sdk libc */
typedef void (*sighandler_t)(int);
sighandler_t signal(int sig, sighandler_t handler) { (void)sig; (void)handler; return (sighandler_t)0; }

/* POSIX functions not in wasi-sdk libc */
void __SIG_IGN(int sig) { (void)sig; }
int getsockname(int fd, void *addr, unsigned int *len) { (void)fd; (void)addr; (void)len; errno = 38; return -1; }
int getuid(void) { return 0; }
int geteuid(void) { return 0; }
int getgid(void) { return 0; }
int getegid(void) { return 0; }
unsigned int alarm(unsigned int s) { (void)s; return 0; }
int fchown(int fd, int o, int g) { (void)fd; (void)o; (void)g; return 0; }
/* umask is in WASI libc */
int getpgid(int p) { (void)p; return 0; }
int setsid(void) { return 1; }
int getsid(int p) { (void)p; return 1; }
int setpgid(int p, int g) { (void)p; (void)g; return 0; }
int setuid(int u) { (void)u; return 0; }
int setgid(int g) { (void)g; return 0; }
/* msync is in wasi-emulated-mman */
int chown(const char *p, int o, int g) { (void)p; (void)o; (void)g; return 0; }
int lchown(const char *p, int o, int g) { (void)p; (void)o; (void)g; return 0; }
int listen(int fd, int b) { (void)fd; (void)b; errno = 38; return -1; }
struct itimerval { long it_interval; long it_value; };
int getitimer(int w, void *v) { (void)w; if(v) memset(v, 0, sizeof(struct itimerval)); return 0; }
int setitimer(int w, const void *n, void *o) { (void)w; (void)n; if(o) memset(o, 0, sizeof(struct itimerval)); return 0; }
int fchownat(int d, const char *p, int o, int g, int f) { (void)d; (void)p; (void)o; (void)g; (void)f; return 0; }
int sigsuspend(const void *m) { (void)m; errno = 4; return -1; }
int setrlimit(int r, const void *l) { (void)r; (void)l; return 0; }
int socket(int d, int t, int p) { (void)d; (void)t; (void)p; errno = 38; return -1; }
int connect(int fd, const void *a, unsigned int l) { (void)fd; (void)a; (void)l; errno = 38; return -1; }
int bind(int fd, const void *a, unsigned int l) { (void)fd; (void)a; (void)l; errno = 38; return -1; }
int accept(int fd, void *a, unsigned int *l) { (void)fd; (void)a; (void)l; errno = 38; return -1; }
int accept4(int fd, void *a, unsigned int *l, int f) { (void)fd; (void)a; (void)l; (void)f; errno = 38; return -1; }
int shutdown(int fd, int h) { (void)fd; (void)h; errno = 38; return -1; }
int getpeername(int fd, void *a, unsigned int *l) { (void)fd; (void)a; (void)l; errno = 38; return -1; }
int setsockopt(int fd, int l, int n, const void *v, unsigned int o) { (void)fd; (void)l; (void)n; (void)v; (void)o; return 0; }
int getsockopt(int fd, int l, int n, void *v, unsigned int *o) { (void)fd; (void)l; (void)n; (void)v; (void)o; return 0; }
long sendmsg(int fd, const void *m, int f) { (void)fd; (void)m; (void)f; errno = 38; return -1; }
long recvmsg(int fd, void *m, int f) { (void)fd; (void)m; (void)f; errno = 38; return -1; }
long sendto(int fd, const void *b, unsigned long l, int f, const void *a, unsigned int al) { (void)fd; (void)b; (void)l; (void)f; (void)a; (void)al; errno = 38; return -1; }
long recvfrom(int fd, void *b, unsigned long l, int f, void *a, unsigned int *al) { (void)fd; (void)b; (void)l; (void)f; (void)a; (void)al; errno = 38; return -1; }
int socketpair(int d, int t, int p, int sv[2]) { (void)d; (void)t; (void)p; (void)sv; errno = 38; return -1; }
int raise(int sig) { (void)sig; return -1; }
int execve(const char *p, char *const *a, char *const *e) { (void)p; (void)a; (void)e; errno = 38; return -1; }
int setgroups(unsigned long s, const void *l) { (void)s; (void)l; return 0; }
int setegid(int g) { (void)g; return 0; }
int seteuid(int u) { (void)u; return 0; }
int dup3(int o, int n, int f) { (void)o; (void)n; (void)f; errno = 38; return -1; }
int tcgetattr(int fd, void *t) { (void)fd; (void)t; return -1; }
int tcsetattr(int fd, int act, const void *t) { (void)fd; (void)act; (void)t; return -1; }
STUBEOF

${CC} --target=wasm32-wasip1 --sysroot=${POSIX_SYSROOT} -D_WASI_EMULATED_SIGNAL -c /tmp/browser_stubs.c -o "${BUILD_DIR}/browser_stubs.o"

echo "=== Patching wasi-emulated-mman (remove mprotect, use our no-op stub) ==="
cp "${POSIX_SYSROOT}/lib/wasm32-wasi/libwasi-emulated-mman.a" "${BUILD_DIR}/libwasi-emulated-mman.a"
# No patching needed — WASI mman library doesn't have mprotect

echo "=== Building atua libc (WASI base, both shim objects replaced) ==="
# Use WASI libc for POSIX compatibility, but replace BOTH shim objects
# __wasilibc_real.o: provides __wasi_* functions (WASI imports) — replaced by our atua routing
# Second object: libc extension stubs — removed, stubs provided by our shim
LIBC_EXT_OBJ="__wasi""xlibc_real.o"
cp "${POSIX_SYSROOT}/lib/wasm32-wasi/libc.a" "${BUILD_DIR}/libc-atua.a"
${AR} d "${BUILD_DIR}/libc-atua.a" __wasilibc_real.o "${LIBC_EXT_OBJ}" 2>/dev/null || true
# Shim compiled with wasi-sdk sysroot for wasi/api.h (exact type signatures)
${CC} --target=wasm32-wasip1 --sysroot=${WASI_SYSROOT} -O2 -c /workspace/native/atua_wasi_shim.c -o "${BUILD_DIR}/atua_wasi_shim.o"
${AR} r "${BUILD_DIR}/libc-atua.a" "${BUILD_DIR}/atua_wasi_shim.o"

echo "=== Building blink archive ==="
${AR} rcs "${BUILD_DIR}/libblink.a" ${BUILD_DIR}/*.o
# Remove objects that conflict with stubs or the standalone blink.o
${AR} d "${BUILD_DIR}/libblink.a" blink.o browser_stubs.o ioctl.o random.o atua_wasi_shim.o libc-atua.a 2>/dev/null || true

echo "=== Linking ==="
${WASI_SDK}/bin/wasm-ld \
    "${BUILD_DIR}/blink.o" \
    "${BUILD_DIR}/libblink.a" \
    "${BUILD_DIR}/browser_stubs.o" \
    "${POSIX_SYSROOT}/lib/wasm32-wasi/crt1.o" \
    -L"${BUILD_DIR}" -L"${WASI_SYSROOT}/lib/wasm32-wasip1" \
    -lc-atua -lm -L"${POSIX_SYSROOT}/lib/wasm32-wasi" -lwasi-emulated-process-clocks \
    -L"${BUILD_DIR}" -lwasi-emulated-mman \
    -L"${WASI_SDK}/lib/clang/22/lib/wasm32-unknown-wasip1" \
    -lclang_rt.builtins \
    --export-memory --export=_start --export=restore_fork --export=malloc --export=free --export=get_exit_code \
    -o "${OUTPUT}"

echo "=== Result ==="
ls -la "${OUTPUT}"
echo "Build complete!"
