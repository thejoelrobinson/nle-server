#include "frame_server.h"
#include <cstring>
#include <cstdio>

// ---------------------------------------------------------------------------
// AVIO callbacks – let libavformat read from our in-memory buffer
// ---------------------------------------------------------------------------

static int avio_read_packet(void* opaque, uint8_t* buf, int buf_size) {
    IOState* s = static_cast<IOState*>(opaque);
    int64_t remaining = static_cast<int64_t>(s->size) - s->pos;
    if (remaining <= 0) return AVERROR_EOF;
    int to_read = (buf_size < remaining) ? buf_size : static_cast<int>(remaining);
    std::memcpy(buf, s->data + s->pos, to_read);
    s->pos += to_read;
    return to_read;
}

static int64_t avio_seek_packet(void* opaque, int64_t offset, int whence) {
    IOState* s = static_cast<IOState*>(opaque);
    int64_t new_pos;
    if (whence == AVSEEK_SIZE) {
        return static_cast<int64_t>(s->size);
    } else if (whence == SEEK_SET) {
        new_pos = offset;
    } else if (whence == SEEK_CUR) {
        new_pos = s->pos + offset;
    } else if (whence == SEEK_END) {
        new_pos = static_cast<int64_t>(s->size) + offset;
    } else {
        return -1;
    }
    if (new_pos < 0 || new_pos > static_cast<int64_t>(s->size)) return -1;
    s->pos = new_pos;
    return new_pos;
}

// ---------------------------------------------------------------------------
// FrameServer
// ---------------------------------------------------------------------------

static constexpr int AVIO_BUF_SIZE = 32 * 1024;  // 32 KB read buffer

FrameServer::FrameServer() = default;

FrameServer::~FrameServer() {
    cleanup();
}

void FrameServer::cleanup() {
    if (sws_ctx_) { sws_freeContext(sws_ctx_); sws_ctx_ = nullptr; }
    if (rgba_frame_) { av_frame_free(&rgba_frame_); }
    if (frame_)      { av_frame_free(&frame_); }
    if (packet_)     { av_packet_free(&packet_); }
    if (codec_ctx_)  { avcodec_free_context(&codec_ctx_); }
    if (fmt_ctx_)    { avformat_close_input(&fmt_ctx_); }
    if (avio_ctx_) {
        av_freep(&avio_ctx_->buffer);
        avio_context_free(&avio_ctx_);
    }
    avio_buf_ = nullptr;
    video_stream_idx_ = -1;
    width_ = height_ = 0;
    rgba_buf_.clear();
    file_buf_.clear();
}

bool FrameServer::open(const std::string& /*filename*/, uintptr_t data_ptr, size_t data_size) {
    cleanup();

    // Copy the file bytes into our own buffer so the JS ArrayBuffer lifetime
    // doesn't matter after this call returns.
    file_buf_.assign(
        reinterpret_cast<const uint8_t*>(data_ptr),
        reinterpret_cast<const uint8_t*>(data_ptr) + data_size
    );

    io_state_.data = file_buf_.data();
    io_state_.size = file_buf_.size();
    io_state_.pos  = 0;

    // Allocate AVIO internal buffer (libavformat will free this)
    avio_buf_ = static_cast<uint8_t*>(av_malloc(AVIO_BUF_SIZE));
    if (!avio_buf_) return false;

    avio_ctx_ = avio_alloc_context(
        avio_buf_, AVIO_BUF_SIZE,
        0,                   // write_flag = 0 (read-only)
        &io_state_,
        avio_read_packet,
        nullptr,             // no write callback
        avio_seek_packet
    );
    if (!avio_ctx_) { av_free(avio_buf_); avio_buf_ = nullptr; return false; }

    fmt_ctx_ = avformat_alloc_context();
    if (!fmt_ctx_) return false;
    fmt_ctx_->pb = avio_ctx_;

    if (avformat_open_input(&fmt_ctx_, "", nullptr, nullptr) < 0) {
        fprintf(stderr, "FrameServer: avformat_open_input failed\n");
        return false;
    }
    if (avformat_find_stream_info(fmt_ctx_, nullptr) < 0) {
        fprintf(stderr, "FrameServer: avformat_find_stream_info failed\n");
        return false;
    }

    return init_decoder();
}

bool FrameServer::init_decoder() {
    // Find best video stream
    video_stream_idx_ = av_find_best_stream(fmt_ctx_, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (video_stream_idx_ < 0) {
        fprintf(stderr, "FrameServer: no video stream found\n");
        return false;
    }

    AVStream* stream = fmt_ctx_->streams[video_stream_idx_];
    const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) {
        fprintf(stderr, "FrameServer: no decoder for codec %d\n", stream->codecpar->codec_id);
        return false;
    }

    codec_ctx_ = avcodec_alloc_context3(codec);
    if (!codec_ctx_) return false;

    if (avcodec_parameters_to_context(codec_ctx_, stream->codecpar) < 0) return false;

    // Single-threaded decode (no pthreads in Phase 1)
    codec_ctx_->thread_count = 1;

    if (avcodec_open2(codec_ctx_, codec, nullptr) < 0) {
        fprintf(stderr, "FrameServer: avcodec_open2 failed\n");
        return false;
    }

    width_  = codec_ctx_->width;
    height_ = codec_ctx_->height;

    frame_      = av_frame_alloc();
    rgba_frame_ = av_frame_alloc();
    packet_     = av_packet_alloc();
    if (!frame_ || !rgba_frame_ || !packet_) return false;

    // Pre-allocate RGBA output buffer
    rgba_buf_.resize(static_cast<size_t>(width_) * height_ * 4);

    av_image_fill_arrays(
        rgba_frame_->data, rgba_frame_->linesize,
        rgba_buf_.data(),
        AV_PIX_FMT_RGBA,
        width_, height_, 1
    );

    sws_ctx_ = sws_getContext(
        width_, height_, codec_ctx_->pix_fmt,
        width_, height_, AV_PIX_FMT_RGBA,
        SWS_BILINEAR, nullptr, nullptr, nullptr
    );
    if (!sws_ctx_) {
        fprintf(stderr, "FrameServer: sws_getContext failed\n");
        return false;
    }

    return true;
}

int FrameServer::get_width()  { return width_; }
int FrameServer::get_height() { return height_; }

double FrameServer::get_duration() {
    if (!fmt_ctx_) return 0.0;
    if (fmt_ctx_->duration != AV_NOPTS_VALUE)
        return static_cast<double>(fmt_ctx_->duration) / AV_TIME_BASE;
    return 0.0;
}

double FrameServer::get_fps() {
    if (!fmt_ctx_ || video_stream_idx_ < 0) return 0.0;
    AVStream* s = fmt_ctx_->streams[video_stream_idx_];
    AVRational r = s->avg_frame_rate;
    if (r.den == 0) return 0.0;
    return static_cast<double>(r.num) / r.den;
}

int FrameServer::get_frame_count() {
    if (!fmt_ctx_ || video_stream_idx_ < 0) return 0;
    AVStream* s = fmt_ctx_->streams[video_stream_idx_];
    if (s->nb_frames > 0) return static_cast<int>(s->nb_frames);
    double dur = get_duration();
    double fps = get_fps();
    if (dur > 0 && fps > 0) return static_cast<int>(dur * fps + 0.5);
    return 0;
}

bool FrameServer::seek(double timestamp_seconds) {
    if (!fmt_ctx_ || video_stream_idx_ < 0) return false;

    AVStream* s   = fmt_ctx_->streams[video_stream_idx_];
    int64_t   ts  = static_cast<int64_t>(timestamp_seconds / av_q2d(s->time_base));
    int ret = av_seek_frame(fmt_ctx_, video_stream_idx_, ts, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) return false;
    avcodec_flush_buffers(codec_ctx_);
    return true;
}

emscripten::val FrameServer::decode_next_frame() {
    if (!fmt_ctx_ || video_stream_idx_ < 0) return emscripten::val::null();

    // Read packets until we get a decoded video frame
    while (true) {
        int ret = av_read_frame(fmt_ctx_, packet_);
        if (ret == AVERROR_EOF) {
            // Flush decoder
            avcodec_send_packet(codec_ctx_, nullptr);
        } else if (ret < 0) {
            return emscripten::val::null();
        } else if (packet_->stream_index != video_stream_idx_) {
            av_packet_unref(packet_);
            continue;
        } else {
            ret = avcodec_send_packet(codec_ctx_, packet_);
            av_packet_unref(packet_);
            if (ret < 0 && ret != AVERROR(EAGAIN)) return emscripten::val::null();
        }

        ret = avcodec_receive_frame(codec_ctx_, frame_);
        if (ret == AVERROR(EAGAIN)) continue;
        if (ret == AVERROR_EOF)     return emscripten::val::null();
        if (ret < 0)                return emscripten::val::null();

        // Convert to RGBA
        sws_scale(
            sws_ctx_,
            frame_->data, frame_->linesize, 0, height_,
            rgba_frame_->data, rgba_frame_->linesize
        );
        av_frame_unref(frame_);

        // Return a Uint8ClampedArray view backed by our pre-allocated buffer.
        // JS must consume (or copy) this before the next decode call.
        return emscripten::val(
            emscripten::typed_memory_view(rgba_buf_.size(), rgba_buf_.data())
        );
    }
}

void FrameServer::close() {
    cleanup();
}
