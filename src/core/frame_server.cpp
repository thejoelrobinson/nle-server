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
    if (yuv_frame_) { av_frame_free(&yuv_frame_); }
    if (frame_)     { av_frame_free(&frame_); }
    if (packet_)    { av_packet_free(&packet_); }
    if (codec_ctx_) { avcodec_free_context(&codec_ctx_); }
    if (fmt_ctx_)   { avformat_close_input(&fmt_ctx_); }
    if (avio_ctx_) {
        av_freep(&avio_ctx_->buffer);
        avio_context_free(&avio_ctx_);
    }
    avio_buf_ = nullptr;
    video_stream_idx_ = -1;
    width_ = height_ = 0;
    file_buf_.clear();
}

bool FrameServer::open(const std::string& /*filename*/, emscripten::val data) {
    cleanup();

    // Copy the JS Uint8Array into our own buffer using Embind's typed_memory_view.
    // This avoids any need for the JS caller to touch WASM linear memory directly.
    const size_t length = data["length"].as<size_t>();
    if (length == 0) return false;

    file_buf_.resize(length);
    // Create a writable Uint8Array view over file_buf_ and call .set(data) on it,
    // which copies the JS typed-array bytes into the C++ buffer.
    emscripten::val view = emscripten::val(
        emscripten::typed_memory_view(length, file_buf_.data())
    );
    view.call<void>("set", data);

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

    int ret;
    ret = avformat_open_input(&fmt_ctx_, "", nullptr, nullptr);
    if (ret < 0) {
        char errbuf[128];
        av_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "FrameServer: avformat_open_input failed: %s\n", errbuf);
        return false;
    }
    ret = avformat_find_stream_info(fmt_ctx_, nullptr);
    if (ret < 0) {
        char errbuf[128];
        av_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "FrameServer: avformat_find_stream_info failed: %s\n", errbuf);
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
        fprintf(stderr, "FrameServer: no decoder for codec_id=%d (%s) — not compiled into this WASM build\n",
                stream->codecpar->codec_id,
                avcodec_get_name(stream->codecpar->codec_id));
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

    frame_  = av_frame_alloc();
    packet_ = av_packet_alloc();
    if (!frame_ || !packet_) return false;

    // Pre-allocate a yuv420p output frame so its buffers survive across calls.
    yuv_frame_ = av_frame_alloc();
    if (!yuv_frame_) return false;
    yuv_frame_->format = AV_PIX_FMT_YUV420P;
    yuv_frame_->width  = width_;
    yuv_frame_->height = height_;
    if (av_frame_get_buffer(yuv_frame_, 0) < 0) {
        fprintf(stderr, "FrameServer: av_frame_get_buffer failed\n");
        return false;
    }

    // Only need swscale when the decoder doesn't output yuv420p natively.
    if (codec_ctx_->pix_fmt != AV_PIX_FMT_YUV420P) {
        sws_ctx_ = sws_getContext(
            width_, height_, codec_ctx_->pix_fmt,
            width_, height_, AV_PIX_FMT_YUV420P,
            SWS_BILINEAR, nullptr, nullptr, nullptr
        );
        if (!sws_ctx_) {
            fprintf(stderr, "FrameServer: sws_getContext failed\n");
            return false;
        }
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

        return _frame_to_result(_consume_frame());
    }
}

// ---------------------------------------------------------------------------
// decode_frame_at  –  seek-accurate single-frame decode for scrubbing
// ---------------------------------------------------------------------------

emscripten::val FrameServer::decode_frame_at(double target_seconds) {
    if (!fmt_ctx_ || video_stream_idx_ < 0) return emscripten::val::null();

    // Seek to the keyframe at or before target using the container time-base
    // (stream_index = -1 → timestamps in AV_TIME_BASE = microseconds).
    int64_t ts  = static_cast<int64_t>(target_seconds * AV_TIME_BASE);
    int     ret = av_seek_frame(fmt_ctx_, -1, ts, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) {
        char errbuf[128];
        av_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "FrameServer: decode_frame_at(%.3f): seek failed: %s\n",
                target_seconds, errbuf);
        return emscripten::val::null();
    }

    // CRITICAL: flush the decoder's internal buffer after every seek.
    // Without this, MPEG-2 (and other long-GOP codecs) return stale cached
    // frames from before the seek point.
    avcodec_flush_buffers(codec_ctx_);

    // Half-frame tolerance handles floating-point imprecision when comparing
    // decoded PTS against the requested timestamp.
    const double fps_val   = get_fps();
    const double half_frame = fps_val > 0.0 ? 0.5 / fps_val : 0.02;
    const double threshold  = target_seconds - half_frame;

    AVStream*    s  = fmt_ctx_->streams[video_stream_idx_];
    const double tb = av_q2d(s->time_base);

    // Decode forward until we find a frame at or past the target timestamp.
    // Cap iterations to avoid spinning forever on corrupt streams.
    static const int MAX_ITER = 2000;
    for (int i = 0; i < MAX_ITER; ++i) {
        ret = av_read_frame(fmt_ctx_, packet_);
        if (ret == AVERROR_EOF) {
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

        // best_effort_timestamp is more reliable than pts for MPEG-2 B-frames.
        int64_t pts_raw = frame_->best_effort_timestamp;
        if (pts_raw == AV_NOPTS_VALUE) pts_raw = frame_->pts;
        if (pts_raw == AV_NOPTS_VALUE) pts_raw = frame_->pkt_dts;

        const double frame_pts = (pts_raw != AV_NOPTS_VALUE)
                                 ? pts_raw * tb
                                 : target_seconds;  // unknown PTS: assume on target

        if (frame_pts >= threshold) {
            // This is the frame we want.
            return _frame_to_result(_consume_frame());
        }

        // Not there yet — discard this frame and keep reading.
        av_frame_unref(frame_);
    }

    fprintf(stderr, "FrameServer: decode_frame_at(%.3f) hit iteration limit\n",
            target_seconds);
    return emscripten::val::null();
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

double FrameServer::_consume_frame() {
    // Read PTS before the unref that follows.
    int64_t pts_raw = frame_->best_effort_timestamp;
    if (pts_raw == AV_NOPTS_VALUE) pts_raw = frame_->pts;
    if (pts_raw == AV_NOPTS_VALUE) pts_raw = frame_->pkt_dts;

    AVStream*    s       = fmt_ctx_->streams[video_stream_idx_];
    const double pts_sec = (pts_raw != AV_NOPTS_VALUE)
                           ? pts_raw * av_q2d(s->time_base)
                           : 0.0;

    // Copy/convert into the persistent yuv420p output frame.
    // yuv_frame_->data remains valid until the next _consume_frame() call.
    if (sws_ctx_) {
        sws_scale(sws_ctx_,
                  frame_->data, frame_->linesize, 0, height_,
                  yuv_frame_->data, yuv_frame_->linesize);
    } else {
        av_frame_copy(yuv_frame_, frame_);
    }
    av_frame_unref(frame_);
    return pts_sec;
}

emscripten::val FrameServer::_frame_to_result(double pts_sec) {
    const int half_h = height_ / 2;
    emscripten::val result = emscripten::val::object();
    result.set("y", emscripten::val(emscripten::typed_memory_view(
        static_cast<size_t>(yuv_frame_->linesize[0]) * height_, yuv_frame_->data[0])));
    result.set("u", emscripten::val(emscripten::typed_memory_view(
        static_cast<size_t>(yuv_frame_->linesize[1]) * half_h,  yuv_frame_->data[1])));
    result.set("v", emscripten::val(emscripten::typed_memory_view(
        static_cast<size_t>(yuv_frame_->linesize[2]) * half_h,  yuv_frame_->data[2])));
    result.set("width",   emscripten::val(width_));
    result.set("height",  emscripten::val(height_));
    result.set("strideY", emscripten::val(yuv_frame_->linesize[0]));
    result.set("strideU", emscripten::val(yuv_frame_->linesize[1]));
    result.set("strideV", emscripten::val(yuv_frame_->linesize[2]));
    result.set("pts",     emscripten::val(pts_sec));
    return result;
}

emscripten::val FrameServer::get_stream_info() {
    if (!fmt_ctx_ || video_stream_idx_ < 0 || !codec_ctx_) return emscripten::val::null();
    AVStream* s = fmt_ctx_->streams[video_stream_idx_];
    emscripten::val info = emscripten::val::object();
    info.set("fps_num",        emscripten::val(s->r_frame_rate.num));
    info.set("fps_den",        emscripten::val(s->r_frame_rate.den));
    info.set("tb_num",         emscripten::val(s->time_base.num));
    info.set("tb_den",         emscripten::val(s->time_base.den));
    info.set("width",          emscripten::val(codec_ctx_->width));
    info.set("height",         emscripten::val(codec_ctx_->height));
    info.set("color_primaries",emscripten::val((int)codec_ctx_->color_primaries));
    info.set("color_trc",      emscripten::val((int)codec_ctx_->color_trc));
    info.set("colorspace",     emscripten::val((int)codec_ctx_->colorspace));
    info.set("codec_id",       emscripten::val((int)codec_ctx_->codec_id));
    return info;
}

void FrameServer::close() {
    cleanup();
}
