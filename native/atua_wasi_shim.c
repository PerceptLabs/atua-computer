/*
 * atua_wasi_shim.c — Replaces __wasilibc_real.c.obj in libc.a
 *
 * Implements all __wasi_* functions that wasi-libc expects.
 * Routes I/O to our 12 atua_* imports instead of WASI imports.
 * Everything else (malloc, memcpy, snprintf) stays untouched in libc.a.
 */

#include <stdint.h>
#include <stddef.h>
#include <string.h>

/* WASI types — match wasi/wasip1.h exactly */
typedef uint16_t __wasi_errno_t;
typedef int      __wasi_fd_t;
typedef uint32_t __wasi_size_t;
typedef uint64_t __wasi_filesize_t;
typedef int64_t  __wasi_filedelta_t;
typedef uint64_t __wasi_timestamp_t;
typedef uint32_t __wasi_clockid_t;
typedef uint32_t __wasi_exitcode_t;
typedef uint32_t __wasi_lookupflags_t;
typedef uint16_t __wasi_oflags_t;
typedef uint64_t __wasi_rights_t;
typedef uint16_t __wasi_fdflags_t;
typedef uint8_t  __wasi_whence_t;
typedef uint8_t  __wasi_advice_t;
typedef uint8_t  __wasi_preopentype_t;
typedef uint16_t __wasi_fstflags_t;
typedef uint8_t  __wasi_sdflags_t;
typedef uint16_t __wasi_siflags_t;
typedef uint16_t __wasi_riflags_t;
typedef uint16_t __wasi_roflags_t;
typedef uint64_t __wasi_dircookie_t;

typedef struct __wasi_iovec_t {
    uint8_t *buf;
    __wasi_size_t buf_len;
} __wasi_iovec_t;

typedef struct __wasi_ciovec_t {
    const uint8_t *buf;
    __wasi_size_t buf_len;
} __wasi_ciovec_t;

typedef struct __wasi_prestat_t {
    __wasi_preopentype_t tag;
    union {
        struct { __wasi_size_t pr_name_len; } dir;
    } u;
} __wasi_prestat_t;

typedef struct __wasi_fdstat_t {
    uint8_t fs_filetype;
    __wasi_fdflags_t fs_flags;
    __wasi_rights_t fs_rights_base;
    __wasi_rights_t fs_rights_inheriting;
} __wasi_fdstat_t;

typedef struct __wasi_filestat_t {
    uint64_t dev;
    uint64_t ino;
    uint8_t filetype;
    uint64_t nlink;
    __wasi_filesize_t size;
    __wasi_timestamp_t atim;
    __wasi_timestamp_t mtim;
    __wasi_timestamp_t ctim;
} __wasi_filestat_t;

typedef struct __wasi_subscription_t { char _pad[48]; } __wasi_subscription_t;
typedef struct __wasi_event_t { char _pad[32]; } __wasi_event_t;

/* === Our 12 atua imports === */

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

/* === Internal fd offset table === */
static long long fd_offsets[256];

/* Track whether guest execution has started (set by engine code) */
int stdin_guest_active = 0;

/* === WASI errno constants === */
#define E_SUCCESS 0
#define E_BADF    8
#define E_INVAL   28
#define E_NOENT   44
#define E_NOSYS   52

/* ============================================================
 * Critical functions (must work for hello.elf + ELF loading)
 * ============================================================ */

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
            /* HOST reads on stdin return 0 — GUEST reads handled via SysPreadv2 */
            n = 0;
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
        if (!stdin_guest_active) return E_SUCCESS; /* HOST startup probes: return 0 */
        /* Guest active: read from terminal */
        for (size_t i = 0; i < iovs_len; i++) {
            int n = atua_term_read(iovs[i].buf, iovs[i].buf_len);
            if (n > 0) *nread += n;
            if (n < (int)iovs[i].buf_len) break;
        }
        return E_SUCCESS;
    }
    if (fd == 1 || fd == 2) return E_SUCCESS; /* stdout/stderr reads return 0 */
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
                                const char *path, __wasi_oflags_t oflags,
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
    if (whence == 0) fd_offsets[fd] = offset;           /* SEEK_SET */
    else if (whence == 1) fd_offsets[fd] += offset;     /* SEEK_CUR */
    /* SEEK_END (whence==2) would need file size — return current for now */
    *newoffset = fd_offsets[fd];
    return E_SUCCESS;
}

__wasi_errno_t __wasi_fd_tell(__wasi_fd_t fd, __wasi_filesize_t *offset) {
    if (fd >= 256) return E_BADF;
    *offset = fd_offsets[fd];
    return E_SUCCESS;
}

__wasi_errno_t __wasi_fd_fdstat_get(__wasi_fd_t fd, __wasi_fdstat_t *stat) {
    /* Return sensible defaults */
    if (fd <= 2) stat->fs_filetype = 2; /* character device */
    else stat->fs_filetype = 4;         /* regular file */
    stat->fs_flags = 0;
    stat->fs_rights_base = (uint64_t)-1;
    stat->fs_rights_inheriting = (uint64_t)-1;
    return E_SUCCESS;
}

/* prestat: fd 3 = preopened root dir "/", all others = BADF */
__wasi_errno_t __wasi_fd_prestat_get(__wasi_fd_t fd, __wasi_prestat_t *buf) {
    if (fd == 3) {
        buf->tag = 0; /* __WASI_PREOPENTYPE_DIR */
        buf->u.dir.pr_name_len = 1; /* "/" */
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

__wasi_errno_t __wasi_clock_time_get(__wasi_clockid_t id, __wasi_timestamp_t precision,
                                     __wasi_timestamp_t *time) {
    *time = atua_clock_gettime();
    return E_SUCCESS;
}

__wasi_errno_t __wasi_clock_res_get(__wasi_clockid_t id, __wasi_timestamp_t *resolution) {
    *resolution = 1000; /* 1 microsecond */
    return E_SUCCESS;
}

__wasi_errno_t __wasi_random_get(uint8_t *buf, __wasi_size_t buf_len) {
    atua_random_get(buf, buf_len);
    return E_SUCCESS;
}

/* args/environ: routed to JS imports so the JS layer can provide real values */
__attribute__((import_module("atua"), import_name("args_get")))
extern int atua_args_get(uint8_t **argv, uint8_t *argv_buf);
__attribute__((import_module("atua"), import_name("args_sizes_get")))
extern int atua_args_sizes_get(__wasi_size_t *argc, __wasi_size_t *argv_buf_size);
__attribute__((import_module("atua"), import_name("environ_get")))
extern int atua_environ_get(uint8_t **environ, uint8_t *environ_buf);
__attribute__((import_module("atua"), import_name("environ_sizes_get")))
extern int atua_environ_sizes_get(__wasi_size_t *count, __wasi_size_t *buf_size);

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

/* Exit code storage — JS reads via exported get_exit_code() */
static uint32_t _exit_code = 0;

__attribute__((export_name("get_exit_code")))
uint32_t get_exit_code(void) { return _exit_code; }

_Noreturn void __wasi_proc_exit(__wasi_exitcode_t code) {
    _exit_code = code;
    __builtin_trap();
}

__wasi_errno_t __wasi_sched_yield(void) { return E_SUCCESS; }

__wasi_errno_t __wasi_fd_readdir(__wasi_fd_t fd, uint8_t *buf, __wasi_size_t buf_len,
                                  __wasi_dircookie_t cookie, __wasi_size_t *bufused) {
    *bufused = 0;
    return atua_fs_readdir(fd, buf, buf_len) >= 0 ? E_SUCCESS : E_BADF;
}

/* ============================================================
 * Stub functions — return ENOSYS (not needed for hello.elf/bash)
 * ============================================================ */

__wasi_errno_t __wasi_fd_advise(__wasi_fd_t fd, __wasi_filesize_t offset,
                                __wasi_filesize_t len, __wasi_advice_t advice) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_allocate(__wasi_fd_t fd, __wasi_filesize_t offset,
                                  __wasi_filesize_t len) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_datasync(__wasi_fd_t fd) { return E_SUCCESS; }
__wasi_errno_t __wasi_fd_sync(__wasi_fd_t fd) { return E_SUCCESS; }
__wasi_errno_t __wasi_fd_fdstat_set_flags(__wasi_fd_t fd, __wasi_fdflags_t flags) { return E_SUCCESS; }
__wasi_errno_t __wasi_fd_fdstat_set_rights(__wasi_fd_t fd, __wasi_rights_t base,
                                            __wasi_rights_t inheriting) { return E_SUCCESS; }
__wasi_errno_t __wasi_fd_filestat_get(__wasi_fd_t fd, __wasi_filestat_t *buf) {
    long long sz = atua_fs_fstat(fd);
    if (sz < 0) return E_BADF;
    memset(buf, 0, sizeof(*buf));
    buf->dev = 1;
    buf->ino = fd + 1000;
    buf->filetype = (fd <= 2) ? 2 : 4; /* chardev or regular */
    buf->nlink = 1;
    buf->size = sz;
    return E_SUCCESS;
}
__wasi_errno_t __wasi_fd_filestat_set_size(__wasi_fd_t fd, __wasi_filesize_t size) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_filestat_set_times(__wasi_fd_t fd, __wasi_timestamp_t atim,
                                            __wasi_timestamp_t mtim, __wasi_fstflags_t fst_flags) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_renumber(__wasi_fd_t fd, __wasi_fd_t to) { return E_NOSYS; }
__wasi_errno_t __wasi_path_create_directory(__wasi_fd_t fd, const char *path) { return E_NOSYS; }
__wasi_errno_t __wasi_path_filestat_get(__wasi_fd_t fd, __wasi_lookupflags_t flags,
                                        const char *path, __wasi_filestat_t *buf) {
    int rc = atua_fs_stat(path, buf, sizeof(*buf));
    if (rc < 0) return E_NOENT;
    return E_SUCCESS;
}
__wasi_errno_t __wasi_path_filestat_set_times(__wasi_fd_t fd, __wasi_lookupflags_t flags,
                                              const char *path, __wasi_timestamp_t atim,
                                              __wasi_timestamp_t mtim, __wasi_fstflags_t fst_flags) { return E_NOSYS; }
__wasi_errno_t __wasi_path_link(__wasi_fd_t old_fd, __wasi_lookupflags_t old_flags,
                                const char *old_path, __wasi_fd_t new_fd,
                                const char *new_path) { return E_NOSYS; }
__wasi_errno_t __wasi_path_readlink(__wasi_fd_t fd, const char *path,
                                    uint8_t *buf, __wasi_size_t buf_len,
                                    __wasi_size_t *bufused) { return E_NOSYS; }
__wasi_errno_t __wasi_path_remove_directory(__wasi_fd_t fd, const char *path) { return E_NOSYS; }
__wasi_errno_t __wasi_path_rename(__wasi_fd_t fd, const char *old_path,
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
