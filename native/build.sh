#!/bin/bash
# Build Blink engine as WASM for atua-computer
# Run inside the atua-computer Docker container
set -euo pipefail

BLINK_DIR="/home/ubuntu/blink"
EMSDK_DIR="/home/ubuntu/emsdk"
OUTPUT_DIR="/workspace/wasm"
FIXTURES_DIR="/workspace/test/fixtures"

echo "=== Sourcing Emscripten ==="
source "${EMSDK_DIR}/emsdk_env.sh" 2>/dev/null

echo "=== Configuring Blink ==="
cd "${BLINK_DIR}"
make clean 2>/dev/null || true
CC=emcc ./configure \
  --disable-jit \
  --disable-threads \
  --disable-fork \
  --disable-metal \
  --disable-sockets

echo "=== Building Blink ==="
make -j"$(nproc)" o//blink/blink.a o//blink/blink.o

echo "=== Linking for Node.js ==="
mkdir -p "${OUTPUT_DIR}"
emcc o//blink/blink.o o//blink/blink.a \
  -sALLOW_MEMORY_GROWTH \
  -sINITIAL_MEMORY=67108864 \
  -sNODERAWFS \
  -o "${OUTPUT_DIR}/blink.js"

echo "=== Building test ELF ==="
mkdir -p "${FIXTURES_DIR}"
cat > /tmp/hello.c << 'CEOF'
#include <unistd.h>
int main() {
    write(1, "hello from atua-computer\n", 25);
    return 0;
}
CEOF
musl-gcc -static -o "${FIXTURES_DIR}/hello.elf" /tmp/hello.c

echo "=== Verifying ==="
node "${OUTPUT_DIR}/blink.js" "${FIXTURES_DIR}/hello.elf" 2>/dev/null
echo "=== Build complete ==="
ls -la "${OUTPUT_DIR}/blink.js" "${OUTPUT_DIR}/blink.wasm" "${FIXTURES_DIR}/hello.elf"
