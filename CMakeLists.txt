cmake_minimum_required(VERSION 3.20)
project(NLEFrameServer)

# ── Require Emscripten ───────────────────────────────────────────────────────
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR
        "This project must be built with Emscripten.\n"
        "Run:  emcmake cmake .. && emmake make")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── FFmpeg library paths ─────────────────────────────────────────────────────
# Default: look for pre-built FFmpeg WASM libs in deps/ffmpeg_wasm/
# Override with -DFFMPEG_WASM_DIR=/path/to/ffmpeg/install
set(FFMPEG_WASM_DIR "${CMAKE_SOURCE_DIR}/deps/ffmpeg_wasm"
    CACHE PATH "Root of FFmpeg WASM install (must have include/ and lib/)")

set(FFMPEG_INCLUDE_DIR "${FFMPEG_WASM_DIR}/include")
set(FFMPEG_LIB_DIR     "${FFMPEG_WASM_DIR}/lib")

# ── Source files ─────────────────────────────────────────────────────────────
add_executable(frame_server
    src/core/frame_server.cpp
    src/core/timeline_engine.cpp
    src/core/bindings.cpp
)

target_include_directories(frame_server PRIVATE
    src/core
    src/core/vendor
    ${FFMPEG_INCLUDE_DIR}
)

# SIMD + full optimisation for the frame_server compile units.
# -msimd128 enables WebAssembly SIMD (128-bit); gives ~1.5–2× on the WASM
# fallback path for codecs without WebCodecs support (ProRes, MPEG-2, etc.).
target_compile_options(frame_server PRIVATE -O3 -msimd128)

# ── FFmpeg static libraries (order matters for linker) ──────────────────────
target_link_libraries(frame_server PRIVATE
    ${FFMPEG_LIB_DIR}/libavformat.a
    ${FFMPEG_LIB_DIR}/libavcodec.a
    ${FFMPEG_LIB_DIR}/libswscale.a
    ${FFMPEG_LIB_DIR}/libswresample.a
    ${FFMPEG_LIB_DIR}/libavutil.a
)

# ── Emscripten link flags ────────────────────────────────────────────────────
set(EM_LINK_FLAGS
    "-s WASM=1"
    "-s ALLOW_MEMORY_GROWTH=1"
    "-s INITIAL_MEMORY=32MB"
    "-s MAXIMUM_MEMORY=4GB"
    "-s USE_PTHREADS=0"            # Phase 1: single-threaded
    "-s EXPORT_ES6=1"
    "-s MODULARIZE=1"
    "-s EXPORT_NAME=createFrameServer"
    "-s ENVIRONMENT=web"
    "--bind"                       # Embind
    "-s ASSERTIONS=0"
    "-O3"
    "-msimd128"                    # WebAssembly SIMD (128-bit)
    "--js-opts 1"                  # Enable JS optimiser passes
)

# CMake requires a single string for link options
string(JOIN " " EM_LINK_FLAGS_STR ${EM_LINK_FLAGS})
set_target_properties(frame_server PROPERTIES
    LINK_FLAGS "${EM_LINK_FLAGS_STR}"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/build"
    OUTPUT_NAME "frame_server"
)

# Also place the .wasm next to the .js in build/
set_target_properties(frame_server PROPERTIES
    SUFFIX ".js"
)

message(STATUS "FFmpeg include : ${FFMPEG_INCLUDE_DIR}")
message(STATUS "FFmpeg libs    : ${FFMPEG_LIB_DIR}")
message(STATUS "Output         : ${CMAKE_SOURCE_DIR}/build/frame_server.{js,wasm}")
