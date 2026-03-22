#pragma once

#include <string>
#include <vector>
#include <cstdint>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>
#include <libavutil/frame.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
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
    emscripten::val get_stream_info();
    bool has_audio();
    emscripten::val decode_audio_at(double target_seconds, int num_samples);

    /**
     * Seek to the keyframe before target_seconds, flush the codec, then decode
     * forward until reaching a frame whose PTS >= target_seconds - half_frame.
     * Returns the same {y,u,v,…,pts} object as decode_next_frame().
     * Use this for scrubbing; use decode_next_frame() for sequential playback.
     */
    emscripten::val decode_frame_at(double target_seconds);

    /**
     * Generate an MJPEG proxy file for the currently open video.
     * Every frame is encoded as a JPEG keyframe, enabling O(1) per-frame seek.
     * target_width / target_height must be even numbers.
     * Returns the proxy bytes as a JS Uint8Array, or null on failure.
     */
    emscripten::val generate_proxy(int target_width, int target_height);

    /**
     * Register a JS callback invoked during proxy generation with
     * (current_frame: number, total_frames: number).
     */
    void set_proxy_progress_callback(emscripten::val cb);

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

    int video_stream_idx_   = -1;
    int _audio_stream_index = -1;
    int width_  = 0;
    int height_ = 0;

    // Proxy generation
    emscripten::val _proxy_progress_cb_ = emscripten::val::undefined();

    // Audio decode
    AVCodecContext* _audio_codec_ctx = nullptr;
    SwrContext*     _swr_ctx         = nullptr;
};
