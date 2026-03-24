#pragma once

#include <string>
#include <vector>
#include <map>
#include <cstdint>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include "vendor/nlohmann/json.hpp"

// All timestamps are in AV_TIME_BASE (microseconds) units.
static constexpr int64_t NLE_TIME_BASE = 1000000LL;

enum class TrackType { VIDEO, AUDIO };

struct ClipRef {
    std::string clip_id;
    std::string source_path;
    int64_t     source_in_pts;
    int64_t     source_out_pts;
    int64_t     timeline_in_pts;
    int64_t     timeline_out_pts;   // = timeline_in + (source_out - source_in)
    int         track_index;

    // Source stream metadata (populated from get_stream_info after opening)
    int fps_num        = 30;
    int fps_den        = 1;
    int tb_num         = 1;
    int tb_den         = 1000000;
    int color_primaries = 1;
    int color_trc      = 1;
    int colorspace     = 5;  // AVCOL_SPC_SMPTE170M (BT.601 default)

    // Compositor fields (for GPU rendering with opacity, transform, etc.)
    float opacity   = 1.0f;   // 0.0 = transparent, 1.0 = opaque
    float posX      = 0.0f;   // pixels from sequence center (X)
    float posY      = 0.0f;   // pixels from sequence center (Y)
    float anchorX   = 0.5f;   // anchor point 0.0–1.0 (0.5 = center)
    float anchorY   = 0.5f;
    float userScale = 1.0f;   // uniform scale multiplier
    int blendMode   = 0;      // 0=normal, 1=multiply, 2=screen, 3=overlay, 4=add, etc.
};

struct Track {
    std::string          id;
    std::string          name;
    TrackType            type;
    bool                 muted   = false;
    bool                 locked  = false;
    bool                 visible = true;
    bool                 solo    = false;   // Solo track (only this track plays)
    float                opacity = 1.0f;    // Track-level opacity (0.0–1.0)
    std::vector<ClipRef> clips;  // always sorted by timeline_in_pts
};

struct Sequence {
    std::string        id;
    std::string        name;
    int                width  = 1920;
    int                height = 1080;
    int                fps_num = 24;
    int                fps_den = 1;
    std::vector<Track> video_tracks;
    std::vector<Track> audio_tracks;
};

// ---------------------------------------------------------------------------
// TimelineEngine
// ---------------------------------------------------------------------------

class TimelineEngine {
public:
    TimelineEngine();

    // ── Sequence management ───────────────────────────────────────────────
    std::string create_sequence(const std::string& name,
                                int w, int h, int fps_num, int fps_den);

    // ── Clip CRUD ─────────────────────────────────────────────────────────
    /// Returns clip_id on success, "" if the position overlaps an existing clip.
    std::string add_clip(const std::string& seq_id,
                         const std::string& source_path,
                         int     track_index,
                         int64_t timeline_in_pts,
                         int64_t source_in_pts,
                         int64_t source_out_pts);

    /// Move a clip to a new position/track.  Rejects if target overlaps.
    bool move_clip(const std::string& clip_id,
                   int64_t new_timeline_in_pts,
                   int     new_track_index);

    /// Trim a clip's source in/out points.
    bool trim_clip(const std::string& clip_id,
                   int64_t new_source_in_pts,
                   int64_t new_source_out_pts);

    /// Razor cut: split one clip into two at split_timeline_pts.
    bool split_clip(const std::string& clip_id, int64_t split_timeline_pts);

    bool remove_clip(const std::string& clip_id);

    // ── Clip properties ───────────────────────────────────────────────────
    /// Set opacity on a clip (0.0 = transparent, 1.0 = opaque)
    bool set_clip_opacity(const std::string& clip_id, float opacity);

    /// Set clip position (pixels from sequence center)
    bool set_clip_position(const std::string& clip_id, float posX, float posY);

    /// Set clip scale (uniform multiplier)
    bool set_clip_scale(const std::string& clip_id, float userScale);

    /// Set clip anchor point (0.0–1.0)
    bool set_clip_anchor(const std::string& clip_id, float anchorX, float anchorY);

    /// Set clip blend mode (0=normal, 1=multiply, 2=screen, 3=overlay, 4=add)
    bool set_clip_blend_mode(const std::string& clip_id, int blendMode);

    // ── Track management ──────────────────────────────────────────────────
    bool set_track_muted  (const std::string& seq_id, int track_index, bool v);
    bool set_track_visible(const std::string& seq_id, int track_index, bool v);
    bool set_track_locked (const std::string& seq_id, int track_index, bool v);
    bool set_track_opacity(const std::string& seq_id, int track_index, float opacity);
    bool set_track_solo   (const std::string& seq_id, int track_index, bool v);

    // ── Resolution ────────────────────────────────────────────────────────
    /// Returns { source_path, source_pts } or null if no clip covers timeline_pts.
    /// Picks the topmost (highest track_index) visible, unmuted video track.
    emscripten::val resolve_frame(const std::string& seq_id, int64_t timeline_pts);

    /// Returns array of all visible clips at timeline_pts (bottom-to-top).
    /// Each entry includes opacity, transform, and all clip properties.
    emscripten::val resolve_all_frames(const std::string& seq_id, int64_t timeline_pts);

    // ── Duration ──────────────────────────────────────────────────────────
    int64_t get_sequence_duration(const std::string& seq_id);

    // ── Serialisation ─────────────────────────────────────────────────────
    std::string get_sequence_json(const std::string& seq_id);
    bool        load_sequence_json(const std::string& json_str);

    // ── Utility ───────────────────────────────────────────────────────────
    int64_t pts_from_frame(int frame_number, int fps_num, int fps_den);
    int     frame_from_pts(int64_t pts, int fps_num, int fps_den);

    // ── Edit Generation (for cache invalidation) ──────────────────────────
    /// Get the current edit generation number for a sequence.
    /// Increments whenever clips or tracks are modified.
    int get_edit_generation(const std::string& seq_id) const;

private:
    std::map<std::string, Sequence> sequences_;

    // clip_id → (seq_id, is_video_track, track_vector_index)
    struct ClipLocation { std::string seq_id; bool is_video; size_t track_idx; };
    std::map<std::string, ClipLocation> clip_index_;

    // seq_id → edit generation counter (increments on any mutation)
    std::map<std::string, int> edit_generation_;

    void _bump_gen(const std::string& seq_id);

    int next_id_ = 1;
    std::string make_id(const std::string& prefix);

    // Returns true if [in, out) overlaps any clip in the vector,
    // optionally excluding one clip by id.
    bool has_overlap(const std::vector<ClipRef>& clips,
                     int64_t in_pts, int64_t out_pts,
                     const std::string& exclude_id = "") const;

    Track*   find_track(const std::string& seq_id, int track_index, TrackType type);
    ClipRef* find_clip_ref(const std::string& clip_id,
                           Track** out_track = nullptr);

    void sort_track(Track& t);

    // JSON helpers
    nlohmann::json clip_to_json(const ClipRef& c) const;
    nlohmann::json track_to_json(const Track& t) const;
    ClipRef  json_to_clip(const nlohmann::json& j) const;
    Track    json_to_track(const nlohmann::json& j, TrackType type) const;
};

// Module-level singleton (exposed via get_timeline_engine() in Embind).
TimelineEngine& get_timeline_engine();
