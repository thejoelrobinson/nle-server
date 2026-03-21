#pragma once

#include <string>
#include <vector>
#include <cstdint>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
#include <libavutil/frame.h>
#include <libavutil/opt.h>
}

#include <emscripten/bind.h>
#include <emscripten/val.h>

struct IOState {
    const uint8_t* data;
    size_t size;
    int64_t pos;
};

class FrameServer {
public:
    FrameServer();
    ~FrameServer();

    // data must be a JS Uint8Array passed from the browser via Embind.
    bool open(const std::string& filename, emscripten::val data);
    int get_width();
    int get_height();
    double get_duration();
    double get_fps();
    int get_frame_count();
    bool seek(double timestamp_seconds);
    emscripten::val decode_next_frame();

    /**
     * Seek to the keyframe before target_seconds, flush the codec, then decode
     * forward until reaching a frame whose PTS >= target_seconds - half_frame.
     * Returns the same {y,u,v,…,pts} object as decode_next_frame().
     * Use this for scrubbing; use decode_next_frame() for sequential playback.
     */
    emscripten::val decode_frame_at(double target_seconds);

    void close();

private:
    bool init_decoder();
    void cleanup();

    // Convert frame_ → yuv_frame_ and unref frame_; return PTS in seconds.
    double _consume_frame();
    // Build the JS result object from the current yuv_frame_ + pts.
    emscripten::val _frame_to_result(double pts_sec);

    // AVIO / demux
    IOState              io_state_;
    std::vector<uint8_t> file_buf_;        // owns the file bytes
    uint8_t*             avio_buf_ = nullptr;
    AVIOContext*         avio_ctx_ = nullptr;
    AVFormatContext*     fmt_ctx_  = nullptr;

    // Codec
    AVCodecContext*      codec_ctx_ = nullptr;
    AVFrame*             frame_     = nullptr;
    AVFrame*             yuv_frame_ = nullptr;   // always yuv420p output
    AVPacket*            packet_    = nullptr;
    SwsContext*          sws_ctx_   = nullptr;   // only created if src != yuv420p

    int video_stream_idx_ = -1;
    int width_  = 0;
    int height_ = 0;
};
