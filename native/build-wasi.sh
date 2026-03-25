#!/bin/bash
# Build Blink engine as WASI binary for @wasmer/sdk
# Run inside the atua-computer Docker container
set -euo pipefail

BLINK_DIR="/home/ubuntu/blink"
WASI_SDK="/opt/wasi-sdk-32.0-x86_64-linux"
CC="${WASI_SDK}/bin/clang"
AR="${WASI_SDK}/bin/llvm-ar"
SYSROOT="${WASI_SDK}/share/wasi-sysroot"
TARGET="wasm32-wasip1"
OUTPUT_DIR="/workspace/wasm"
FIXTURES_DIR="/workspace/test/fixtures"
BUILD_DIR="/home/ubuntu/blink-wasi-build"

CFLAGS="--target=${TARGET} --sysroot=${SYSROOT} -O2 -D_FILE_OFFSET_BITS=64 -D_DEFAULT_SOURCE -D_BSD_SOURCE -D_GNU_SOURCE -I${BLINK_DIR} -I${BLINK_DIR}/third_party/libz -fno-strict-aliasing"

mkdir -p "${BUILD_DIR}" "${OUTPUT_DIR}" "${FIXTURES_DIR}"

echo "=== Phase 1: Compiling Blink sources to WASI objects ==="

# Get list of Blink .c files (excluding blinkenlights and platform-specific)
BLINK_SRCS=$(ls ${BLINK_DIR}/blink/*.c | grep -v blinkenlights.c | grep -v xnu.c)

OBJECTS=""
ERRORS=""
COMPILED=0
FAILED=0

for src in ${BLINK_SRCS}; do
  base=$(basename "$src" .c)
  obj="${BUILD_DIR}/${base}.o"

  if ${CC} ${CFLAGS} -c "$src" -o "$obj" 2>/tmp/wasi-err-${base}.txt; then
    OBJECTS="${OBJECTS} ${obj}"
    COMPILED=$((COMPILED + 1))
  else
    FAILED=$((FAILED + 1))
    ERRORS="${ERRORS}\n=== FAILED: ${base}.c ===\n$(cat /tmp/wasi-err-${base}.txt | head -10)"
  fi
done

echo "Compiled: ${COMPILED}, Failed: ${FAILED}"

if [ ${FAILED} -gt 0 ]; then
  echo -e "\n=== Compilation failures: ===${ERRORS}"
fi

# Compile zlib
echo "=== Phase 2: Compiling zlib ==="
ZLIB_SRCS=$(ls ${BLINK_DIR}/third_party/libz/*.c)
for src in ${ZLIB_SRCS}; do
  base=$(basename "$src" .c)
  obj="${BUILD_DIR}/zlib_${base}.o"
  ${CC} ${CFLAGS} -w -c "$src" -o "$obj" 2>/dev/null && OBJECTS="${OBJECTS} ${obj}" || true
done

echo "=== Phase 3: Creating static library ==="
${AR} rcs "${BUILD_DIR}/libblink.a" ${OBJECTS}

echo "=== Phase 4: Linking WASI binary ==="
# Compile blink main entry point
${CC} ${CFLAGS} -c "${BLINK_DIR}/blink/blink.c" -o "${BUILD_DIR}/blink_main.o" \
  -DCONFIG_ARGUMENTS="\"wasi-build\"" \
  -DBUILD_TOOLCHAIN="\"wasi-sdk-32\"" \
  -DBUILD_TIMESTAMP="\"$(date -u)\"" \
  -DBLINK_COMMITS="\"1\"" \
  -DBLINK_UNAME_V="\"NOJIT-WASI\"" \
  -DBLINK_GITSHA="\"wasi\"" \
  -DBUILD_MODE="\"\"" 2>/tmp/wasi-main-err.txt || {
    echo "Failed to compile blink.c:"
    cat /tmp/wasi-main-err.txt
    exit 1
  }

# Link
${WASI_SDK}/bin/wasm-ld \
  "${BUILD_DIR}/blink_main.o" \
  "${BUILD_DIR}/libblink.a" \
  -L"${SYSROOT}/lib/wasm32-wasip1" \
  -lc -lc++ -lc++abi \
  --no-entry --export=main --export=__main_argc_argv \
  -o "${OUTPUT_DIR}/engine.wasm" 2>/tmp/wasi-link-err.txt || {
    echo "=== Link failed ==="
    cat /tmp/wasi-link-err.txt | head -40
    echo ""
    echo "Trying with just -lc..."
    ${WASI_SDK}/bin/wasm-ld \
      "${BUILD_DIR}/blink_main.o" \
      "${BUILD_DIR}/libblink.a" \
      -L"${SYSROOT}/lib/wasm32-wasip1" \
      -lc \
      -o "${OUTPUT_DIR}/engine.wasm" 2>&1 | head -40
  }

echo "=== Phase 5: Checking output ==="
ls -la "${OUTPUT_DIR}/engine.wasm" 2>/dev/null || echo "engine.wasm not produced"

echo "=== Build complete ==="
