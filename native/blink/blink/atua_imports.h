/*
 * atua_imports.h — WASM import declarations for the browser target.
 *
 * In the browser, Blink runs as WASM on a Web Worker. There are no host
 * syscalls, no filesystem, no sockets. All I/O goes through JS imports
 * in the "atua" module. This header declares every import the engine uses.
 */
#ifndef BLINK_ATUA_IMPORTS_H_
#define BLINK_ATUA_IMPORTS_H_
#ifdef __ATUA_BROWSER__

/* ── Filesystem ─────────────────────────────────────────────────────── */

__attribute__((import_module("atua"), import_name("fs_open")))
extern int atua_fs_open(const char *path, int flags, int mode);

__attribute__((import_module("atua"), import_name("fs_read")))
extern int atua_fs_read(int handle, void *buf, int len, long long offset);

__attribute__((import_module("atua"), import_name("fs_write")))
extern int atua_fs_write(int handle, const void *buf, int len, long long offset);

__attribute__((import_module("atua"), import_name("fs_close")))
extern void atua_fs_close(int handle);

__attribute__((import_module("atua"), import_name("fs_fstat")))
extern long long atua_fs_fstat(int handle);

__attribute__((import_module("atua"), import_name("fs_stat")))
extern int atua_fs_stat(const char *path, void *stat_buf, int stat_len);

__attribute__((import_module("atua"), import_name("fs_readdir")))
extern int atua_fs_readdir(int handle, void *buf, int len);

/* ── Terminal ───────────────────────────────────────────────────────── */

__attribute__((import_module("atua"), import_name("term_write")))
extern void atua_term_write(const void *buf, int len);

__attribute__((import_module("atua"), import_name("term_read")))
extern int atua_term_read(void *buf, int len);

__attribute__((import_module("atua"), import_name("term_get_size")))
extern void atua_term_get_size(int *rows, int *cols);

/* ── Pipes ──────────────────────────────────────────────────────────── */

__attribute__((import_module("atua"), import_name("pipe_create")))
extern int atua_pipe_create(void);

__attribute__((import_module("atua"), import_name("pipe_read")))
extern int atua_pipe_read(int pipe_id, void *buf, int len);

__attribute__((import_module("atua"), import_name("pipe_write")))
extern int atua_pipe_write(int pipe_id, const void *buf, int len);

__attribute__((import_module("atua"), import_name("pipe_close")))
extern void atua_pipe_close(int pipe_id, int end);

/* ── Sockets ────────────────────────────────────────────────────────── */

__attribute__((import_module("atua"), import_name("socket_open")))
extern int atua_socket_open(int domain, int type, int protocol);

__attribute__((import_module("atua"), import_name("socket_connect")))
extern int atua_socket_connect(int sock_id, const void *addr, int addrlen);

__attribute__((import_module("atua"), import_name("socket_send")))
extern int atua_socket_send(int sock_id, const void *buf, int len);

__attribute__((import_module("atua"), import_name("socket_recv")))
extern int atua_socket_recv(int sock_id, void *buf, int len);

__attribute__((import_module("atua"), import_name("socket_close")))
extern void atua_socket_close(int sock_id);

__attribute__((import_module("atua"), import_name("socket_poll")))
extern int atua_socket_poll(int sock_id);

/* ── Process ────────────────────────────────────────────────────────── */

__attribute__((import_module("atua"), import_name("fork_spawn")))
extern int atua_fork_spawn(const void *state_buf, int state_len);

__attribute__((import_module("atua"), import_name("proc_wait")))
extern int atua_proc_wait(int pid, int *status);

/* ── System ─────────────────────────────────────────────────────────── */

__attribute__((import_module("atua"), import_name("clock_gettime")))
extern long long atua_clock_gettime(void);

__attribute__((import_module("atua"), import_name("sleep_ms")))
extern void atua_sleep_ms(int ms);

#endif /* __ATUA_BROWSER__ */
#endif /* BLINK_ATUA_IMPORTS_H_ */
