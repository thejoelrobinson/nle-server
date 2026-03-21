#pragma once

#include <string>
#include <vector>
#include <cstdint>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
#include <libavutil/imgutils.h>
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

    bool open(const std::string& filename, uintptr_t data_ptr, size_t data_size);
    int get_width();
    int get_height();
    double get_duration();
    double get_fps();
    int get_frame_count();
    bool seek(double timestamp_seconds);
    emscripten::val decode_next_frame();
    void close();

private:
    bool init_decoder();
    void cleanup();

    // AVIO / demux
    IOState              io_state_;
    std::vector<uint8_t> file_buf_;        // owns the file bytes
    uint8_t*             avio_buf_ = nullptr;
    AVIOContext*         avio_ctx_ = nullptr;
    AVFormatContext*     fmt_ctx_  = nullptr;

    // Codec
    AVCodecContext*      codec_ctx_ = nullptr;
    AVFrame*             frame_     = nullptr;
    AVFrame*             rgba_frame_= nullptr;
    AVPacket*            packet_    = nullptr;
    SwsContext*          sws_ctx_   = nullptr;

    int video_stream_idx_ = -1;
    int width_  = 0;
    int height_ = 0;

    // Scratch RGBA buffer (width * height * 4 bytes)
    std::vector<uint8_t> rgba_buf_;
};
