/*
 * atua_wasix_shim.c — Replaces __wasixlibc_real.o in libc.a
 *
 * Implements all __wasi_* WASIX extension functions.
 * Most return ENOSYS — Blink handles pipe/fork/futex/signals internally.
 * Only proc_exit2 and proc_id/proc_parent need real implementations.
 */

#include <stdint.h>
#include <stddef.h>

typedef uint16_t __wasi_errno_t;
typedef int      __wasi_fd_t;
typedef uint32_t __wasi_size_t;

#define E_SUCCESS 0
#define E_BADF    8
#define E_NOSYS   52

/* proc_exit2 — used by crt1.o */
_Noreturn void __wasi_proc_exit2(int code) {
    __builtin_trap();
}

/* proc_id / proc_parent */
__wasi_errno_t __wasi_proc_id(uint32_t *pid) { *pid = 1; return E_SUCCESS; }
__wasi_errno_t __wasi_proc_parent(uint32_t *ppid) { *ppid = 0; return E_SUCCESS; }

/* tty stubs */
__wasi_errno_t __wasi_tty_get(void *tty_state) { return E_NOSYS; }
__wasi_errno_t __wasi_tty_set(const void *tty_state) { return E_NOSYS; }

/* getcwd / chdir — Blink handles internally */
__wasi_errno_t __wasi_getcwd(uint8_t *path, __wasi_size_t *path_len) { return E_NOSYS; }
__wasi_errno_t __wasi_chdir(const char *path) { return E_NOSYS; }

/* fd operations — Blink handles internally */
__wasi_errno_t __wasi_fd_dup(__wasi_fd_t fd, __wasi_fd_t *retfd) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_dup2(__wasi_fd_t fd, __wasi_fd_t newfd) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_pipe(__wasi_fd_t *fd0, __wasi_fd_t *fd1) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_event(uint64_t initial, uint16_t flags, __wasi_fd_t *retfd) { return E_NOSYS; }
__wasi_errno_t __wasi_fd_fdflags_get(__wasi_fd_t fd, uint16_t *flags) { *flags = 0; return E_SUCCESS; }
__wasi_errno_t __wasi_fd_fdflags_set(__wasi_fd_t fd, uint16_t flags) { return E_SUCCESS; }

/* path_open2 — wasix extension of path_open */
__wasi_errno_t __wasi_path_open2(__wasi_fd_t dirfd, uint32_t dirflags,
                                 const char *path, uint32_t path_len,
                                 uint16_t oflags, uint64_t fs_rights_base,
                                 uint64_t fs_rights_inheriting,
                                 uint16_t fdflags, __wasi_fd_t *retfd) { return E_NOSYS; }

/* callback / signal */
__wasi_errno_t __wasi_callback_signal(void *callback) { return E_NOSYS; }

/* thread */
__wasi_errno_t __wasi_thread_parallelism(uint32_t *parallelism) { *parallelism = 1; return E_SUCCESS; }
__wasi_errno_t __wasi_thread_signal(uint32_t tid, uint32_t signal) { return E_NOSYS; }
__wasi_errno_t __wasi_thread_id(uint32_t *tid) { *tid = 1; return E_SUCCESS; }
__wasi_errno_t __wasi_thread_join(uint32_t tid) { return E_NOSYS; }
__wasi_errno_t __wasi_thread_sleep(uint64_t duration) { return E_NOSYS; }
__wasi_errno_t __wasi_thread_exit(uint32_t code) { __builtin_trap(); }
__wasi_errno_t __wasi_thread_spawn_v2(void *entry, void *arg, uint32_t *tid) { return E_NOSYS; }

/* futex — Blink handles internally */
__wasi_errno_t __wasi_futex_wait(uint32_t *addr, uint32_t expected, const void *timeout, uint32_t *ret) { return E_NOSYS; }
__wasi_errno_t __wasi_futex_wake(uint32_t *addr, uint32_t count) { return E_SUCCESS; }
__wasi_errno_t __wasi_futex_wake_all(uint32_t *addr, uint32_t count) { return E_SUCCESS; }

/* process */
__wasi_errno_t __wasi_proc_fork(void) { return E_NOSYS; }
__wasi_errno_t __wasi_proc_fork_env(void *env, uint32_t env_len) { return E_NOSYS; }
__wasi_errno_t __wasi_proc_exec(const char *path, const void *args, uint32_t args_len) { return E_NOSYS; }
__wasi_errno_t __wasi_proc_exec2(const char *path, uint32_t path_len, const void *args, uint32_t args_len) { return E_NOSYS; }
__wasi_errno_t __wasi_proc_exec3(const char *path, uint32_t path_len, const void *args, uint32_t args_len) { return E_NOSYS; }
__wasi_errno_t __wasi_proc_spawn(const char *path, uint32_t path_len, const void *args, uint32_t args_len,
                                 __wasi_fd_t stdin_fd, __wasi_fd_t stdout_fd, __wasi_fd_t stderr_fd,
                                 uint32_t *pid) { return E_NOSYS; }
__wasi_errno_t __wasi_proc_spawn2(const char *path, uint32_t path_len, const void *args, uint32_t args_len,
                                  __wasi_fd_t stdin_fd, __wasi_fd_t stdout_fd, __wasi_fd_t stderr_fd,
                                  const char *workdir, uint32_t workdir_len, void *flags, uint32_t *pid) { return E_NOSYS; }
__wasi_errno_t __wasi_proc_join(const uint32_t *pids, uint32_t pids_len, void *status) { return E_NOSYS; }
__wasi_errno_t __wasi_proc_signal(uint32_t pid, uint32_t signal) { return E_NOSYS; }
__wasi_errno_t __wasi_proc_raise_interval(uint64_t interval) { return E_NOSYS; }
__wasi_errno_t __wasi_proc_signals_get(void *signals) { return E_SUCCESS; }
__wasi_errno_t __wasi_proc_signals_sizes_get(uint32_t *count) { *count = 0; return E_SUCCESS; }
__wasi_errno_t __wasi_proc_snapshot(void) { return E_NOSYS; }

/* context switching */
__wasi_errno_t __wasi_context_create(void *entry, void *arg, uint32_t stack_size, uint32_t *ctx) { return E_NOSYS; }
__wasi_errno_t __wasi_context_destroy(uint32_t ctx) { return E_NOSYS; }
__wasi_errno_t __wasi_context_switch(uint32_t ctx) { return E_NOSYS; }

/* closures */
__wasi_errno_t __wasi_closure_allocate(uint32_t *id) { return E_NOSYS; }
__wasi_errno_t __wasi_closure_free(uint32_t id) { return E_NOSYS; }
__wasi_errno_t __wasi_closure_prepare(uint32_t id, void *data, uint32_t len) { return E_NOSYS; }
__wasi_errno_t __wasi_call_dynamic(uint32_t id, void *args, uint32_t args_len, void *ret, uint32_t ret_len) { return E_NOSYS; }

/* dynamic loading */
__wasi_errno_t __wasi_dlopen(const char *path, uint32_t flags, uint32_t *handle) { return E_NOSYS; }
__wasi_errno_t __wasi_dlsym(uint32_t handle, const char *symbol, void **addr) { return E_NOSYS; }
__wasi_errno_t __wasi_dl_invalid_handle(uint32_t *handle) { return E_NOSYS; }

/* reflection */
__wasi_errno_t __wasi_reflect_signature(uint32_t func_idx, void *args_buf, uint32_t args_len,
                                        void *result_buf, uint32_t result_len) { return E_NOSYS; }

/* DNS */
__wasi_errno_t __wasi_resolve(const char *host, uint16_t port, void *addrs, uint32_t addrs_len, uint32_t *naddrs) { return E_NOSYS; }

/* clock */
__wasi_errno_t __wasi_clock_time_set(uint32_t id, uint64_t time) { return E_NOSYS; }

/* stack checkpoint/restore — WASIX fork mechanism */
__wasi_errno_t __wasi_stack_checkpoint(void *buf, uint32_t buf_len) { return E_NOSYS; }
__wasi_errno_t __wasi_stack_restore(const void *buf, uint32_t buf_len) { return E_NOSYS; }

/* epoll */
__wasi_errno_t __wasi_epoll_create(__wasi_fd_t *retfd) { return E_NOSYS; }
__wasi_errno_t __wasi_epoll_ctl(__wasi_fd_t epfd, uint32_t op, __wasi_fd_t fd, void *event) { return E_NOSYS; }
__wasi_errno_t __wasi_epoll_wait(__wasi_fd_t epfd, void *events, uint32_t maxevents, uint32_t timeout, uint32_t *nevents) { return E_NOSYS; }

/* socket operations — all ENOSYS */
__wasi_errno_t __wasi_sock_open(uint32_t af, uint32_t socktype, uint32_t protocol, __wasi_fd_t *retfd) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_pair(uint32_t af, uint32_t socktype, uint32_t protocol, __wasi_fd_t *fd0, __wasi_fd_t *fd1) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_bind(__wasi_fd_t fd, const void *addr) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_listen(__wasi_fd_t fd, uint32_t backlog) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_accept_v2(__wasi_fd_t fd, uint16_t flags, __wasi_fd_t *retfd, void *addr) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_connect(__wasi_fd_t fd, const void *addr) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_recv_from(__wasi_fd_t fd, void *ri_data, uint32_t ri_data_len,
                                     uint16_t ri_flags, uint32_t *ro_datalen, uint16_t *ro_flags, void *addr) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_send_to(__wasi_fd_t fd, const void *si_data, uint32_t si_data_len,
                                   uint16_t si_flags, const void *addr, uint32_t *so_datalen) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_send_file(__wasi_fd_t fd, __wasi_fd_t filefd, uint64_t offset, uint64_t len) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_addr_local(__wasi_fd_t fd, void *addr) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_addr_peer(__wasi_fd_t fd, void *addr) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_set_opt_flag(__wasi_fd_t fd, uint32_t opt, uint32_t flag) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_get_opt_flag(__wasi_fd_t fd, uint32_t opt, uint32_t *flag) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_set_opt_time(__wasi_fd_t fd, uint32_t opt, const void *time) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_get_opt_time(__wasi_fd_t fd, uint32_t opt, void *time) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_set_opt_size(__wasi_fd_t fd, uint32_t opt, uint64_t size) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_get_opt_size(__wasi_fd_t fd, uint32_t opt, uint64_t *size) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_status(__wasi_fd_t fd, uint32_t *status) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_join_multicast_v4(const void *addr, uint32_t iface) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_join_multicast_v6(const void *addr, uint32_t iface) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_leave_multicast_v4(const void *addr, uint32_t iface) { return E_NOSYS; }
__wasi_errno_t __wasi_sock_leave_multicast_v6(const void *addr, uint32_t iface) { return E_NOSYS; }

/* port operations */
__wasi_errno_t __wasi_port_addr_add(const void *addr) { return E_NOSYS; }
__wasi_errno_t __wasi_port_addr_remove(const void *addr) { return E_NOSYS; }
__wasi_errno_t __wasi_port_addr_clear(void) { return E_NOSYS; }
__wasi_errno_t __wasi_port_addr_list(void *addrs, uint32_t *naddrs) { return E_NOSYS; }
__wasi_errno_t __wasi_port_bridge(const char *network, const char *token, uint32_t security) { return E_NOSYS; }
__wasi_errno_t __wasi_port_unbridge(void) { return E_NOSYS; }
__wasi_errno_t __wasi_port_dhcp_acquire(void) { return E_NOSYS; }
__wasi_errno_t __wasi_port_gateway_set(const void *addr) { return E_NOSYS; }
__wasi_errno_t __wasi_port_mac(void *mac) { return E_NOSYS; }
__wasi_errno_t __wasi_port_route_add(const void *cidr, const void *via, const void *preferred, uint32_t expires) { return E_NOSYS; }
__wasi_errno_t __wasi_port_route_remove(const void *cidr) { return E_NOSYS; }
__wasi_errno_t __wasi_port_route_clear(void) { return E_NOSYS; }
__wasi_errno_t __wasi_port_route_list(void *routes, uint32_t *nroutes) { return E_NOSYS; }
