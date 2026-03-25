# Blink WASM Engine Build

## Prerequisites

- Ubuntu 24.04 (Docker container `atua-computer`)
- Emscripten SDK (installed at `/home/ubuntu/emsdk`)
- musl-tools for cross-compiling test binaries
- Blink source (cloned at `/home/ubuntu/blink`)

## Build Steps

```bash
# Inside the atua-computer container:

# 1. Source Emscripten
source /home/ubuntu/emsdk/emsdk_env.sh

# 2. Configure Blink for WASM (no JIT, no threads, no fork, no sockets for Phase B)
cd /home/ubuntu/blink
make clean
CC=emcc ./configure --disable-jit --disable-threads --disable-fork --disable-metal --disable-sockets

# 3. Build object files
make -j$(nproc) o//blink/blink.a o//blink/blink.o

# 4. Link with Emscripten flags for Node.js
emcc o//blink/blink.o o//blink/blink.a \
  -sALLOW_MEMORY_GROWTH \
  -sINITIAL_MEMORY=67108864 \
  -sNODERAWFS \
  -o /workspace/wasm/blink.js

# Output: /workspace/wasm/blink.js + /workspace/wasm/blink.wasm
```

## Build Test ELF Binary

```bash
# Build a static x86-64 test binary with musl
cat > /tmp/hello.c << 'EOF'
#include <unistd.h>
int main() {
    write(1, "hello from atua-computer\n", 25);
    return 0;
}
EOF
musl-gcc -static -o /workspace/test/fixtures/hello.elf /tmp/hello.c
```

## Verify

```bash
# Run the test binary through Blink WASM under Node.js
node /workspace/wasm/blink.js /workspace/test/fixtures/hello.elf
# Expected output: hello from atua-computer
```

## Current Status

- **Emscripten build:** Working (Phase B stepping stone)
- **WASIX build:** Future work — requires WASIX-compatible libc and @wasmer/sdk integration
- **Disabled features:** JIT, threads, fork, metal, sockets (re-enabled in later phases)
- **Engine size:** ~375KB WASM + ~214KB JS glue

## Architecture Note

The addendum specifies WASIX as the target compilation. Emscripten is used as the
Phase B stepping stone because Blink already has `__EMSCRIPTEN__` support and it
provides a proven path to validate x86-64 execution in WASM. The WASIX migration
is tracked as a Phase C/D task. See `atua-computer-implementation-addendum.md` §2.

// TEMPORARY: Emscripten build. Replace with WASIX (wasi-sdk + wasix-libc) build
// when WASIX compilation is validated. Tracked in Phase C planning.
