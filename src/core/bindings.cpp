#include <emscripten/bind.h>
#include <emscripten/val.h>
#include "frame_server.h"
#include "timeline_engine.h"

using namespace emscripten;

// ---------------------------------------------------------------------------
// FrameServer bindings
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
        .function("get_stream_info",  &FrameServer::get_stream_info)
        .function("has_audio",        &FrameServer::has_audio)
        .function("decode_audio_at",  &FrameServer::decode_audio_at)
        .function("close",            &FrameServer::close)
        ;
}

// ---------------------------------------------------------------------------
// TimelineEngine bindings
// ---------------------------------------------------------------------------

EMSCRIPTEN_BINDINGS(nle_timeline_engine) {
    class_<TimelineEngine>("TimelineEngine")
        .constructor<>()
        .function("create_sequence",      &TimelineEngine::create_sequence)
        .function("add_clip",             &TimelineEngine::add_clip)
        .function("move_clip",            &TimelineEngine::move_clip)
        .function("trim_clip",            &TimelineEngine::trim_clip)
        .function("split_clip",           &TimelineEngine::split_clip)
        .function("remove_clip",          &TimelineEngine::remove_clip)
        .function("set_track_muted",      &TimelineEngine::set_track_muted)
        .function("set_track_visible",    &TimelineEngine::set_track_visible)
        .function("set_track_locked",     &TimelineEngine::set_track_locked)
        .function("resolve_frame",        &TimelineEngine::resolve_frame)
        .function("get_sequence_duration",&TimelineEngine::get_sequence_duration)
        .function("get_sequence_json",    &TimelineEngine::get_sequence_json)
        .function("load_sequence_json",   &TimelineEngine::load_sequence_json)
        .function("pts_from_frame",       &TimelineEngine::pts_from_frame)
        .function("frame_from_pts",       &TimelineEngine::frame_from_pts)
        ;

    // Module-level singleton getter
    function("get_timeline_engine",
             +[]() -> TimelineEngine* { return &get_timeline_engine(); },
             allow_raw_pointers());
}
