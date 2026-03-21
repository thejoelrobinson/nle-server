#include <emscripten/bind.h>
#include <emscripten/val.h>
#include "frame_server.h"

using namespace emscripten;

// ---------------------------------------------------------------------------
// Embind bindings
//
// open() now accepts a JS Uint8Array directly (emscripten::val), so the JS
// side no longer needs to manage raw WASM heap pointers.  alloc_buffer /
// free_buffer have been removed.
// ---------------------------------------------------------------------------

EMSCRIPTEN_BINDINGS(nle_frame_server) {
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
        .function("decode_frame_at",  &FrameServer::decode_frame_at)
        .function("close",            &FrameServer::close)
        ;
}
