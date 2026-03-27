# Blink WASM Engine Build

## Prerequisites

- Ubuntu 24.04 (Docker container `atua-computer`)
- wasi-sdk 32 (installed at `/opt/wasi-sdk-32.0-x86_64-linux`)
- wasi-sdk sysroot (installed at `/opt/wasi-sysroot/sysroot`)
- Blink source (patched, at `/home/ubuntu/blink`)
- blink-wasi-compat.h (at `/home/ubuntu/blink-wasi-compat.h`)
- Stub headers (at `/home/ubuntu/stubs/sys/mount.h`)

## Build

```bash
# Inside the atua-computer container:
docker exec atua-computer /bin/bash /workspace/native/build-wasi.sh
```

## Key Build Details

- **Target:** wasm32-wasip1 (WASI via wasi-sdk sysroot)
- **Entry:** `_start` from crt1.o (not `--entry=__main_argc_argv`)
- **Libraries:** `-lc -lm -lwasi-emulated-mman -lwasi-emulated-process-clocks -lpthread -lclang_rt.builtins-wasm32`
- **Stubs:** `wasi_stubs.o` provides `mprotect`, `flock`, `__wasm_init_tls`, `syscall`, `sockatmark`, `GetRandom`, `sched_*`, `SysIoctl`, `SendAncillary`, `ReceiveAncillary`, `sysinfo`
- **Compat header:** Force-included, provides S_IFIFO/S_IFSOCK overrides, HAVE_FORK, spawn.h, sigsetjmp→setjmp mapping
- **Assertions:** Disabled with `-DNDEBUG` (assertions trigger on WASI due to setjmp limitations)
- **ancillary.c:** Fails to compile (nonnull error) — not needed, stubs provided

## Runtime

```bash
wasmer run \
  --volume /path/to/rootfs:/rootfs \
  --env BLINK_PREFIX=/rootfs \
  --env BLINK_WASM_SELF=/rootfs/engine.wasm \
  engine-wasi.wasm -- /rootfs/bin/bash -c "echo hello"
```

- `BLINK_PREFIX`: Prepended to guest absolute paths for host file access
- `BLINK_WASM_SELF`: Path to engine binary within the volume (needed for fork+exec)

## Current Capabilities

- Static x86-64 ELF execution
- Dynamic ELF loading (musl ld.so, libreadline, libncursesw)
- Alpine bash (musl) — full shell builtins
- Debian bash (glibc/trixie) — dynamic linking with IRELATIVE relocations
- Fork+exec via posix_spawn (external commands like `busybox ls`)
- Fork state serialization (2.7MB state, looped writes for WASI 2MB limit)
- Pipe fd inheritance via posix_spawn_file_actions

## Known Gaps

- Fork-restore subshell hangs (child stuck in guest instruction loop, no syscalls reached)
- Symlinks in rootfs not followed by WASI volume mounts (use real files)
- Pipe between fork-restored children not yet tested end-to-end
