/*
 * atua_wasi_shim.c — Replaces __wasilibc_real.c.obj in wasi-sdk's libc.a
 *
 * Implements all __wasi_* functions that wasi-libc expects.
 * Routes I/O to our atua_* imports instead of WASI host imports.
 * Everything else (malloc, memcpy, snprintf) stays untouched in libc.a.
 *
 * Types come from wasi-sdk's <wasi/api.h> — compiler enforces exact signatures.
 */

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <wasi/api.h>

/* === atua imports — provided by JS host === */

__attribute__((import_module("atua"), import_name("fs_open")))
extern int atua_fs_open(const char *path, int flags, int mode);

__attribute__((import_module("atua"), import_name("fs_read")))
extern int atua_fs_read(int handle, void *buf, int len, long long offset);

__attribute__((import_module("atua"), import_name("fs_write")))
extern int atua_fs_write(int handle, const void *buf, int len, long long offset);

__attribute__((import_module("atua"), import_name("fs_close")))
extern void atua_fs_close(int handle);

__attribute__((import_module("atua"), import_name("fs_stat")))
extern int atua_fs_stat(const char *path, void *stat_buf, int stat_len);

__attribute__((import_module("atua"), import_name("fs_fstat")))
extern long long atua_fs_fstat(int handle);

__attribute__((import_module("atua"), import_name("fs_readdir")))
extern int atua_fs_readdir(int handle, void *buf, int len);

__attribute__((import_module("atua"), import_name("term_write")))
extern void atua_term_write(const void *buf, int len);

__attribute__((import_module("atua"), import_name("term_read")))
extern int atua_term_read(void *buf, int len);

__attribute__((import_module("atua"), import_name("fork_spawn")))
extern int atua_fork_spawn(const void *state_buf, int state_len);

__attribute__((import_module("atua"), import_name("proc_wait")))
extern int atua_proc_wait(int pid, int *status);

__attribute__((import_module("atua"), import_name("clock_gettime")))
extern long long atua_clock_gettime(void);

__attribute__((import_module("atua"), import_name("random_get")))
extern void atua_random_get(void *buf, int len);

__attribute__((import_module("atua"), import_name("args_get")))
extern int atua_args_get(uint8_t **argv, uint8_t *argv_buf);

__attribute__((import_module("atua"), import_name("args_sizes_get")))
extern int atua_args_sizes_get(__wasi_size_t *argc, __wasi_size_t *argv_buf_size);

__attribute__((import_module("atua"), import_name("environ_get")))
extern int atua_environ_get(uint8_t **environ, uint8_t *environ_buf);

__attribute__((import_module("atua"), import_name("environ_sizes_get")))
extern int atua_environ_sizes_get(__wasi_size_t *count, __wasi_size_t *buf_size);

/* === Internal state === */

static long long fd_offsets[256];
int stdin_guest_active = 0; /* Set by Blink's SysRead/SysPreadv2 when guest starts */
static uint32_t _exit_code = 0;

#define E_SUCCESS 0
#define E_BADF    8
#define E_INVAL   28
#define E_NOENT   44
#define E_NOSYS   52

/* === Core I/O functions === */

__wasi_errno_t __wasi_fd_write(__wasi_fd_t fd, const __wasi_ciovec_t *iovs,
                               size_t iovs_len, __wasi_size_t *nwritten) {
    *nwritten = 0;
    for (size_t i = 0; i < iovs_len; i++) {
        if (fd == 1 || fd == 2) {
            atua_term_write(iovs[i].buf, iovs[i].buf_len);
        } else {
            atua_fs_write(fd, iovs[i].buf, iovs[i].buf_len,
                          fd < 256 ? fd_offsets[fd] : 0);
            if (fd < 256) fd_offsets[fd] += iovs[i].buf_len;
        }
        *nwritten += iovs[i].buf_len;
    }
    return E_SUCCESS;
}

__wasi_errno_t __wasi_fd_read(__wasi_fd_t fd, const __wasi_iovec_t *iovs,
                              size_t iovs_len, __wasi_size_t *nread) {
    *nread = 0;
    for (size_t i = 0; i < iovs_len; i++) {
        int n;
        if (fd == 0) {
            n = 0; /* HOST reads on stdin return 0 — guest reads via SysPreadv2 */
        } else {
            n = atua_fs_read(fd, iovs[i].buf, iovs[i].buf_len,
                             fd < 256 ? fd_offsets[fd] : 0);
            if (n > 0 && fd < 256) fd_offsets[fd] += n;
        }
        if (n > 0) *nread += n;
        if (n < (int)iovs[i].buf_len) break;
    }
    return E_SUCCESS;
}

__wasi_errno_t __wasi_fd_pread(__wasi_fd_t fd, const __wasi_iovec_t *iovs,
                               size_t iovs_len, __wasi_filesize_t offset,
                               __wasi_size_t *nread) {
    *nread = 0;
    if (fd == 0) {
        if (!stdin_guest_active) return E_SUCCESS;
        for (size_t i = 0; i < iovs_len; i++) {
            int n = atua_term_read(iovs[i].buf, iovs[i].buf_len);
            if (n > 0) *nread += n;
            if (n < (int)iovs[i].buf_len) break;
        }
        return E_SUCCESS;
    }
    if (fd == 1 || fd == 2) return E_SUCCESS;
    for (size_t i = 0; i < iovs_len; i++) {
        int n = atua_fs_read(fd, iovs[i].buf, iovs[i].buf_len, offset + *nread);
        if (n > 0) *nread += n;
        if (n < (int)iovs[i].buf_len) break;
    }
    return E_SUCCESS;
}

__wasi_errno_t __wasi_fd_pwrite(__wasi_fd_t fd, const __wasi_ciovec_t *iovs,
                                size_t iovs_len, __wasi_filesize_t offset,
                                __wasi_size_t *nwritten) {
    *nwritten = 0;
    for (size_t i = 0; i < iovs_len; i++) {
        atua_fs_write(fd, iovs[i].buf, iovs[i].buf_len, offset + *nwritten);
        *nwritten += iovs[i].buf_len;
    }
    return E_SUCCESS;
}

__wasi_errno_t __wasi_path_open(__wasi_fd_t dirfd, __wasi_lookupflags_t dirflags,
                                const char *path,
                                __wasi_oflags_t oflags,
                                __wasi_rights_t fs_rights_base,
                                __wasi_rights_t fs_rights_inheriting,
                                __wasi_fdflags_t fdflags, __wasi_fd_t *retptr0) {
    int handle = atua_fs_open(path, oflags | fdflags, 0666);
    if (handle < 0) return E_NOENT;
    *retptr0 = handle;
    if (handle < 256) fd_offsets[handle] = 0;
    return E_SUCCESS;
}

__wasi_errno_t __wasi_fd_close(__wasi_fd_t fd) {
    atua_fs_close(fd);
    if (fd < 256) fd_offsets[fd] = 0;
    return E_SUCCESS;
}

__wasi_errno_t __wasi_fd_seek(__wasi_fd_t fd, __wasi_filedelta_t offset,
                              __wasi_whence_t whence, __wasi_filesize_t *newoffset) {
    if (fd >= 256) return E_BADF;
    if (whence == 0) fd_offsets[fd] = offset;
    else if (whence == 1) fd_offsets[fd] += offset;
    *newoffset = fd_offsets[fd];
    return E_SUCCESS;
}

__wasi_errno_t __wasi_fd_tell(__wasi_fd_t fd, __wasi_filesize_t *offset) {
    if (fd >= 256) return E_BADF;
    *offset = fd_offsets[fd];
    return E_SUCCESS;
}

/* === Stat/metadata === */

__wasi_errno_t __wasi_fd_fdstat_get(__wasi_fd_t fd, __wasi_fdstat_t *stat) {
    if (fd <= 2) stat->fs_filetype = __WASI_FILETYPE_CHARACTER_DEVICE;
    else stat->fs_filetype = __WASI_FILETYPE_REGULAR_FILE;
    stat->fs_flags = 0;
    stat->fs_rights_base = (uint64_t)-1;
    stat->fs_rights_inheriting = (uint64_t)-1;
    return E_SUCCESS;
}

__wasi_errno_t __wasi_fd_filestat_get(__wasi_fd_t fd, __wasi_filestat_t *buf) {
    long long sz = atua_fs_fstat(fd);
    if (sz < 0) return E_BADF;
    memset(buf, 0, sizeof(*buf));
    buf->dev = 1;
    buf->ino = fd + 1000;
    buf->filetype = (fd <= 2) ? __WASI_FILETYPE_CHARACTER_DEVICE : __WASI_FILETYPE_REGULAR_FILE;
    buf->nlink = 1;
    buf->size = sz;
    return E_SUCCESS;
}

__wasi_errno_t __wasi_path_filestat_get(__wasi_fd_t fd, __wasi_lookupflags_t flags,
                                        const char *path, __wasi_filestat_t *buf) {
    int rc = atua_fs_stat(path, buf, sizeof(*buf));
    if (rc < 0) return E_NOENT;
    return E_SUCCESS;
}

/* === Prestat — fd 3 = preopened root dir "/" === */

__wasi_errno_t __wasi_fd_prestat_get(__wasi_fd_t fd, __wasi_prestat_t *buf) {
    if (fd == 3) {
        buf->tag = __WASI_PREOPENTYPE_DIR;
        buf->u.dir.pr_name_len = 1;
        return E_SUCCESS;
    }
    return E_BADF;
}

__wasi_errno_t __wasi_fd_prestat_dir_name(__wasi_fd_t fd, uint8_t *path,
                                          __wasi_size_t path_len) {
    if (fd == 3 && path_len >= 1) {
        path[0] = '/';
        return E_SUCCESS;
    }
    return E_BADF;
}

/* === Time/random === */

__wasi_errno_t __wasi_clock_time_get(__wasi_clockid_t id, __wasi_timestamp_t precision,
                                     __wasi_timestamp_t *time) {
    *time = atua_clock_gettime();
    return E_SUCCESS;
}

__wasi_errno_t __wasi_clock_res_get(__wasi_clockid_t id, __wasi_timestamp_t *resolution) {
    *resolution = 1000;
    return E_SUCCESS;
}

__wasi_errno_t __wasi_random_get(uint8_t *buf, __wasi_size_t buf_len) {
    atua_random_get(buf, buf_len);
    return E_SUCCESS;
}

/* === Args/environ — routed to JS === */

__wasi_errno_t __wasi_args_get(uint8_t **argv, uint8_t *argv_buf) {
    return atua_args_get(argv, argv_buf);
}

__wasi_errno_t __wasi_args_sizes_get(__wasi_size_t *argc, __wasi_size_t *argv_buf_size) {
    return atua_args_sizes_get(argc, argv_buf_size);
}

__wasi_errno_t __wasi_environ_get(uint8_t **environ, uint8_t *environ_buf) {
    return atua_environ_get(environ, environ_buf);
}

__wasi_errno_t __wasi_environ_sizes_get(__wasi_size_t *count, __wasi_size_t *buf_size) {
    return atua_environ_sizes_get(count, buf_size);
}

/* === Exit === */

__attribute__((export_name("get_exit_code")))
uint32_t get_exit_code(void) { return _exit_code; }

_Noreturn void __wasi_proc_exit(__wasi_exitcode_t code) {
    _exit_code = code;
    __builtin_trap();
}

/* WASI crt1.o compatibility — these are called by the WASI startup code
 * even though we use wasi-sdk libc. The WASI crt1.o is used because it's
 * smaller and doesn't require TLS initialization. */
_Noreturn void __wasi_proc_exit2(int code) {
    _exit_code = code;
    __builtin_trap();
}

/* __wasi_init_signals is in WASI libc's sigaction.o — don't duplicate */

void __wasi_callback_signal(const char *name) {
    (void)name; /* No-op */
}

/* === WASI extension stubs ===
 * These functions are called by WASI libc objects (fcntl.o, getpid.o, etc.)
 * that reference __wasi_fd_dup, __wasi_proc_id, etc.
 * Signatures match what the WASI libc callers expect.
 * All stubs — no real implementation needed in browser mode. */

/* fd_dup: fcntl.o expects (fd, min_result_fd, cloexec, *retfd) */
__wasi_errno_t __wasi_fd_dup(__wasi_fd_t fd, __wasi_fd_t *retfd) {
    static int next_fd = 100;
    if (retfd) *retfd = next_fd++;
    return 0;
}

__wasi_errno_t __wasi_fd_dup2(__wasi_fd_t fd, __wasi_fd_t min_fd,
                               uint32_t cloexec, __wasi_fd_t *retfd) {
    if (retfd) *retfd = min_fd;
    return 0;
}

/* proc_id/proc_parent */
__wasi_errno_t __wasi_proc_id(uint32_t *pid) { *pid = 1; return 0; }
__wasi_errno_t __wasi_proc_parent(uint32_t pid, uint32_t *ppid) {
    (void)pid; if (ppid) *ppid = 0; return 0;
}

/* tty */
__wasi_errno_t __wasi_tty_get(void *state) { (void)state; return 52; }
__wasi_errno_t __wasi_tty_set(const void *state) { (void)state; return 52; }

/* thread */
__wasi_errno_t __wasi_thread_parallelism(uint32_t *p) { *p = 1; return 0; }
__wasi_errno_t __wasi_thread_signal(uint32_t tid, uint32_t sig) { (void)tid; (void)sig; return 52; }

/* futex */
__wasi_errno_t __wasi_futex_wait(uint32_t *addr, uint32_t exp, const void *to, uint32_t *ret) {
    (void)addr; (void)exp; (void)to; (void)ret; return 52;
}
__wasi_errno_t __wasi_futex_wake(uint32_t *addr, uint32_t count) { (void)addr; (void)count; return 0; }
__wasi_errno_t __wasi_futex_wake_all(uint32_t *addr, uint32_t count) { (void)addr; (void)count; return 0; }

/* fd flags */
__wasi_errno_t __wasi_fd_fdflags_get(__wasi_fd_t fd, uint16_t *flags) { *flags = 0; return 0; }
__wasi_errno_t __wasi_fd_fdflags_set(__wasi_fd_t fd, uint16_t flags) { (void)fd; (void)flags; return 0; }

/* path_open2 — WASI extension (openat.o calls this) */
__wasi_errno_t __wasi_path_open2(__wasi_fd_t dirfd, uint32_t dirflags,
                                  const char *path, uint32_t oflags,
                                  uint64_t rights_base, uint64_t rights_inh,
                                  uint16_t fdflags, uint16_t fdflagsext,
                                  __wasi_fd_t *retfd) {
    int handle = atua_fs_open(path, oflags | fdflags, 0666);
    if (handle < 0) return 44;
    *retfd = handle;
    if (handle < 256) fd_offsets[handle] = 0;
    return 0;
}

/* Remaining WASI stubs — all return ENOSYS (52) */
__wasi_errno_t __wasi_fd_pipe(__wasi_fd_t *fd0, __wasi_fd_t *fd1) { (void)fd0; (void)fd1; return 52; }
__wasi_errno_t __wasi_fd_event(uint64_t init, uint16_t flags, __wasi_fd_t *retfd) { (void)init; (void)flags; (void)retfd; return 52; }
__wasi_errno_t __wasi_proc_fork(void) { return 52; }
__wasi_errno_t __wasi_proc_exec3(const char *p, uint32_t pl, const void *a, uint32_t al, __wasi_fd_t prefd) { (void)p; (void)pl; (void)a; (void)al; (void)prefd; return 52; }
__wasi_errno_t __wasi_proc_join(const uint32_t *pids, uint32_t len, void *status) { (void)pids; (void)len; (void)status; return 52; }
__wasi_errno_t __wasi_proc_signal(uint32_t pid, uint32_t sig) { (void)pid; (void)sig; return 52; }
__wasi_errno_t __wasi_proc_raise_interval(uint32_t sig, uint64_t interval, uint32_t *old) { (void)sig; (void)interval; if(old)*old=0; return 52; }
__wasi_errno_t __wasi_proc_signals_get(void *s) { (void)s; return 0; }
__wasi_errno_t __wasi_proc_signals_sizes_get(uint32_t *c) { *c = 0; return 0; }
__wasi_errno_t __wasi_getcwd(uint8_t *path, uint32_t *path_len) { (void)path; (void)path_len; return 52; }
__wasi_errno_t __wasi_chdir(const char *path) { (void)path; return 52; }

/* Socket stubs — all ENOSYS */
__wasi_errno_t __wasi_sock_open(uint32_t af, uint32_t st, uint32_t pr, __wasi_fd_t *fd) { (void)af; (void)st; (void)pr; (void)fd; return 52; }
__wasi_errno_t __wasi_sock_pair(uint32_t af, uint32_t st, uint32_t pr, __wasi_fd_t *f0, __wasi_fd_t *f1) { (void)af; (void)st; (void)pr; (void)f0; (void)f1; return 52; }
__wasi_errno_t __wasi_sock_bind(__wasi_fd_t fd, const void *a) { (void)fd; (void)a; return 52; }
__wasi_errno_t __wasi_sock_listen(__wasi_fd_t fd, uint32_t b) { (void)fd; (void)b; return 52; }
__wasi_errno_t __wasi_sock_accept_v2(__wasi_fd_t fd, uint16_t f, __wasi_fd_t *r, void *a) { (void)fd; (void)f; (void)r; (void)a; return 52; }
__wasi_errno_t __wasi_sock_connect(__wasi_fd_t fd, const void *a) { (void)fd; (void)a; return 52; }
__wasi_errno_t __wasi_sock_recv_from(__wasi_fd_t fd, void *d, uint32_t dl, uint16_t f, uint32_t *rl, uint16_t *rf, void *a) { (void)fd; (void)d; (void)dl; (void)f; (void)rl; (void)rf; (void)a; return 52; }
__wasi_errno_t __wasi_sock_send_to(__wasi_fd_t fd, const void *d, uint32_t dl, uint16_t f, const void *a, uint32_t *sl) { (void)fd; (void)d; (void)dl; (void)f; (void)a; (void)sl; return 52; }
__wasi_errno_t __wasi_sock_addr_local(__wasi_fd_t fd, void *a) { (void)fd; (void)a; return 52; }
__wasi_errno_t __wasi_sock_addr_peer(__wasi_fd_t fd, void *a) { (void)fd; (void)a; return 52; }
__wasi_errno_t __wasi_sock_set_opt_flag(__wasi_fd_t fd, uint32_t o, uint32_t f) { (void)fd; (void)o; (void)f; return 52; }
__wasi_errno_t __wasi_sock_get_opt_flag(__wasi_fd_t fd, uint32_t o, uint32_t *f) { (void)fd; (void)o; (void)f; return 52; }
__wasi_errno_t __wasi_sock_set_opt_time(__wasi_fd_t fd, uint32_t o, const void *t) { (void)fd; (void)o; (void)t; return 52; }
__wasi_errno_t __wasi_sock_get_opt_time(__wasi_fd_t fd, uint32_t o, void *t) { (void)fd; (void)o; (void)t; return 52; }
__wasi_errno_t __wasi_sock_set_opt_size(__wasi_fd_t fd, uint32_t o, uint64_t s) { (void)fd; (void)o; (void)s; return 52; }
__wasi_errno_t __wasi_sock_get_opt_size(__wasi_fd_t fd, uint32_t o, uint64_t *s) { (void)fd; (void)o; (void)s; return 52; }

/* === Misc === */

__wasi_errno_t __wasi_sched_yield(void) { return E_SUCCESS; }

__wasi_errno_t __wasi_fd_readdir(__wasi_fd_t fd, uint8_t *buf, __wasi_size_t buf_len,
                                  __wasi_dircookie_t cookie, __wasi_size_t *bufused) {
    *bufused = 0;
    return atua_fs_readdir(fd, buf, buf_len) >= 0 ? E_SUCCESS : E_BADF;
}

/* === Stubs — return ENOSYS or no-op === */

__wasi_errno_t __wasi_fd_advise(__wasi_fd_t fd, __wasi_filesize_t offset,
                                __wasi_filesize_t len, __wasi_advice_t advice) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_allocate(__wasi_fd_t fd, __wasi_filesize_t offset,
                                  __wasi_filesize_t len) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_datasync(__wasi_fd_t fd) { return E_SUCCESS; }
__wasi_errno_t __wasi_fd_sync(__wasi_fd_t fd) { return E_SUCCESS; }
__wasi_errno_t __wasi_fd_fdstat_set_flags(__wasi_fd_t fd, __wasi_fdflags_t flags) { return E_SUCCESS; }
__wasi_errno_t __wasi_fd_fdstat_set_rights(__wasi_fd_t fd, __wasi_rights_t base,
                                            __wasi_rights_t inheriting) { return E_SUCCESS; }
__wasi_errno_t __wasi_fd_filestat_set_size(__wasi_fd_t fd, __wasi_filesize_t size) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_filestat_set_times(__wasi_fd_t fd, __wasi_timestamp_t atim,
                                            __wasi_timestamp_t mtim, __wasi_fstflags_t fst_flags) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_renumber(__wasi_fd_t fd, __wasi_fd_t to) { return E_NOSYS; }
/* Signatures match wasi-sdk's wasi/wasip1.h exactly — no path_len params */
__wasi_errno_t __wasi_path_create_directory(__wasi_fd_t fd, const char *path) { return E_NOSYS; }
__wasi_errno_t __wasi_path_filestat_set_times(__wasi_fd_t fd, __wasi_lookupflags_t flags,
                                              const char *path,
                                              __wasi_timestamp_t atim, __wasi_timestamp_t mtim,
                                              __wasi_fstflags_t fst_flags) { return E_NOSYS; }
__wasi_errno_t __wasi_path_link(__wasi_fd_t old_fd, __wasi_lookupflags_t old_flags,
                                const char *old_path,
                                __wasi_fd_t new_fd,
                                const char *new_path) { return E_NOSYS; }
__wasi_errno_t __wasi_path_readlink(__wasi_fd_t fd, const char *path,
                                    uint8_t *buf, __wasi_size_t buf_len,
                                    __wasi_size_t *bufused) { return E_NOSYS; }
__wasi_errno_t __wasi_path_remove_directory(__wasi_fd_t fd, const char *path) { return E_NOSYS; }
__wasi_errno_t __wasi_path_rename(__wasi_fd_t old_fd, const char *old_path,
                                  __wasi_fd_t new_fd, const char *new_path) { return E_NOSYS; }
__wasi_errno_t __wasi_path_symlink(const char *old_path, __wasi_fd_t fd,
                                   const char *new_path) { return E_NOSYS; }
__wasi_errno_t __wasi_path_unlink_file(__wasi_fd_t fd, const char *path) { return E_NOSYS; }
__wasi_errno_t __wasi_poll_oneoff(const __wasi_subscription_t *in, __wasi_event_t *out,
                                  __wasi_size_t nsubscriptions, __wasi_size_t *nevents) {
    *nevents = 0;
    return E_NOSYS;
}
__wasi_errno_t __wasi_sock_accept(__wasi_fd_t fd, __wasi_fdflags_t flags,
                                  __wasi_fd_t *retptr0) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_recv(__wasi_fd_t fd, const __wasi_iovec_t *ri_data,
                                size_t ri_data_len, __wasi_riflags_t ri_flags,
                                __wasi_size_t *ro_datalen, __wasi_roflags_t *ro_flags) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_send(__wasi_fd_t fd, const __wasi_ciovec_t *si_data,
                                size_t si_data_len, __wasi_siflags_t si_flags,
                                __wasi_size_t *so_datalen) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_shutdown(__wasi_fd_t fd, __wasi_sdflags_t how) { return E_NOSYS; }
