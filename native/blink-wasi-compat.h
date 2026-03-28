/* blink-wasi-compat.h — Minimal compat for Blink on upstream musl/wasm32.
 * Most POSIX functions are now in musl (routed through host_syscall).
 * This header only provides Blink-specific config and missing Linux constants. */
#ifndef BLINK_WASI_COMPAT_H_
#define BLINK_WASI_COMPAT_H_

/* Blink config flags */
#define HAVE_MAP_ANONYMOUS 1
#define HAVE_FORK 1
#define IsWasi() (1)

/* wasm32 setjmp is limited — map sigsetjmp to setjmp */
#include <setjmp.h>
#define sigsetjmp(buf, save) setjmp(buf)
#define siglongjmp longjmp

/* spawn.h for WASI fork path */
#include <spawn.h>

/* Linux-specific constants musl may not define */
#ifndef F_OWNER_TID
#define F_OWNER_TID 0
#define F_OWNER_PID 1
#define F_OWNER_PGRP 2
#endif

#endif /* BLINK_WASI_COMPAT_H_ */
