#!/usr/bin/env bash
# =============================================================================
# build_wasm.sh  –  Build the NLE frame_server WASM module
#
# Prerequisites:
#   - Emscripten SDK active  (source emsdk/emsdk_env.sh)
#   - FFmpeg already compiled to WASM (run scripts/build_ffmpeg.sh first)
#     Expected at:  deps/ffmpeg_wasm/{include,lib}
#
# Usage:
#   ./scripts/build_wasm.sh
#
# Output:  build/frame_server.{js,wasm}
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/build_wasm"

echo "=== NLE Server – WASM module build ==="

# ── Check Emscripten ─────────────────────────────────────────────────────────
if ! command -v emcmake &>/dev/null; then
    echo "ERROR: emcmake not found. Activate Emscripten SDK first:"
    echo "  source /path/to/emsdk/emsdk_env.sh"
    exit 1
fi
echo "emcmake: $(which emcmake)"

# ── Check FFmpeg WASM libs ───────────────────────────────────────────────────
FFMPEG_WASM="$ROOT_DIR/deps/ffmpeg_wasm"
if [[ ! -f "$FFMPEG_WASM/lib/libavcodec.a" ]]; then
    echo "ERROR: FFmpeg WASM libraries not found at $FFMPEG_WASM/lib/"
    echo "Run scripts/build_ffmpeg.sh first."
    exit 1
fi

# ── CMake configure + build ──────────────────────────────────────────────────
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

emcmake cmake "$ROOT_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DFFMPEG_WASM_DIR="$FFMPEG_WASM"

emmake make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

echo
echo "=== Build complete ==="
ls -lh "$ROOT_DIR/build/frame_server."* 2>/dev/null || true
echo
echo "Start the dev server:"
echo "  npm run dev"
