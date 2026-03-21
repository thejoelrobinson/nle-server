#!/usr/bin/env bash
# =============================================================================
# build_ffmpeg.sh  –  Compile FFmpeg to WebAssembly via Emscripten
#
# Prerequisites:
#   - Emscripten SDK active in current shell  (source emsdk/emsdk_env.sh)
#   - FFmpeg source tree (will be cloned if not present)
#
# Usage:
#   chmod +x scripts/build_ffmpeg.sh
#   ./scripts/build_ffmpeg.sh
#
# Output:  deps/ffmpeg_wasm/{include,lib}
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DEPS_DIR="$ROOT_DIR/deps"
FFMPEG_SRC="$DEPS_DIR/ffmpeg"
FFMPEG_OUT="$DEPS_DIR/ffmpeg_wasm"
FFMPEG_VERSION="n6.1"          # Tested against FFmpeg 6.1

echo "=== NLE Server – FFmpeg WASM build ==="
echo "Root     : $ROOT_DIR"
echo "FFmpeg src: $FFMPEG_SRC"
echo "Output   : $FFMPEG_OUT"
echo

# ── Check Emscripten ─────────────────────────────────────────────────────────
if ! command -v emcc &>/dev/null; then
    echo "ERROR: emcc not found. Activate Emscripten SDK first:"
    echo "  source /path/to/emsdk/emsdk_env.sh"
    exit 1
fi
echo "Emscripten: $(emcc --version | head -1)"

# ── Clone FFmpeg if needed ───────────────────────────────────────────────────
mkdir -p "$DEPS_DIR"
if [[ ! -d "$FFMPEG_SRC/.git" ]]; then
    echo "Cloning FFmpeg ${FFMPEG_VERSION}…"
    git clone --depth 1 --branch "$FFMPEG_VERSION" \
        https://github.com/FFmpeg/FFmpeg.git "$FFMPEG_SRC"
else
    echo "FFmpeg source already present, skipping clone."
fi

# ── Configure ────────────────────────────────────────────────────────────────
cd "$FFMPEG_SRC"

echo "Running emconfigure ./configure …"
emconfigure ./configure \
    --prefix="$FFMPEG_OUT" \
    \
    --target-os=none \
    --arch=x86_32 \
    --enable-cross-compile \
    \
    --cc=emcc \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --nm=emnm \
    \
    --disable-everything \
    --disable-autodetect \
    --disable-asm \
    --disable-inline-asm \
    --disable-stripping \
    --disable-programs \
    --disable-doc \
    --disable-debug \
    --disable-network \
    --disable-avdevice \
    --disable-avfilter \
    --disable-postproc \
    --disable-swresample \
    \
    --enable-avformat \
    --enable-avcodec \
    --enable-swscale \
    --enable-avutil \
    \
    --enable-static \
    --disable-shared \
    \
    --enable-small \
    --enable-optimizations \
    \
    --enable-decoder=h264 \
    --enable-decoder=hevc \
    --enable-decoder=vp9 \
    --enable-decoder=av1 \
    --enable-decoder=prores \
    --enable-decoder=dnxhd \
    --enable-decoder=mpeg4 \
    --enable-decoder=mjpeg \
    --enable-decoder=png \
    \
    --enable-demuxer=mov \
    --enable-demuxer=matroska \
    --enable-demuxer=mp4 \
    --enable-demuxer=avi \
    --enable-demuxer=mpegts \
    --enable-demuxer=image2 \
    \
    --enable-protocol=file \
    \
    --enable-parser=h264 \
    --enable-parser=hevc \
    --enable-parser=vp9 \
    --enable-parser=av1 \
    --enable-parser=mpeg4video \
    --enable-parser=mjpeg \
    \
    --extra-cflags="-O3" \
    --extra-cxxflags="-O3"

# ── Build & install ──────────────────────────────────────────────────────────
CPU_COUNT=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
echo "Building with ${CPU_COUNT} parallel jobs…"
emmake make -j"$CPU_COUNT"
emmake make install

echo
echo "=== Done ==="
echo "Libraries installed to: $FFMPEG_OUT/lib"
ls -lh "$FFMPEG_OUT/lib/"*.a 2>/dev/null || true
echo
echo "Next step: build the WASM module:"
echo "  mkdir -p build_wasm && cd build_wasm"
echo "  emcmake cmake .. && emmake make"
