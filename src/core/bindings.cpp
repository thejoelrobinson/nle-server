#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <cstdlib>
#include "frame_server.h"

using namespace emscripten;

// ---------------------------------------------------------------------------
// Raw heap helpers – let JS allocate / free a buffer in WASM linear memory
// so it can write file bytes in without an extra copy.
// ---------------------------------------------------------------------------

uintptr_t alloc_buffer(size_t size) {
    return reinterpret_cast<uintptr_t>(std::malloc(size));
}

void free_buffer(uintptr_t ptr) {
    std::free(reinterpret_cast<void*>(ptr));
}

// ---------------------------------------------------------------------------
// Embind bindings
// ---------------------------------------------------------------------------

EMSCRIPTEN_BINDINGS(nle_frame_server) {
    // Heap helpers
    function("alloc_buffer", &alloc_buffer);
    function("free_buffer",  &free_buffer);

    // FrameServer class
    class_<FrameServer>("FrameServer")
        .constructor<>()
        .function("open",             &FrameServer::open)
        .function("get_width",        &FrameServer::get_width)
        .function("get_height",       &FrameServer::get_height)
        .function("get_duration",     &FrameServer::get_duration)
        .function("get_fps",          &FrameServer::get_fps)
        .function("get_frame_count",  &FrameServer::get_frame_count)
        .function("seek",             &FrameServer::seek)
        .function("decode_next_frame",&FrameServer::decode_next_frame)
        .function("close",            &FrameServer::close)
        ;
}
