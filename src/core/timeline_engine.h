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
};

struct Track {
    std::string          id;
    std::string          name;
    TrackType            type;
    bool                 muted   = false;
    bool                 locked  = false;
    bool                 visible = true;
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

    // ── Track management ──────────────────────────────────────────────────
    bool set_track_muted  (const std::string& seq_id, int track_index, bool v);
    bool set_track_visible(const std::string& seq_id, int track_index, bool v);
    bool set_track_locked (const std::string& seq_id, int track_index, bool v);

    // ── Resolution ────────────────────────────────────────────────────────
    /// Returns { source_path, source_pts } or null if no clip covers timeline_pts.
    /// Picks the topmost (highest track_index) visible, unmuted video track.
    emscripten::val resolve_frame(const std::string& seq_id, int64_t timeline_pts);

    // ── Duration ──────────────────────────────────────────────────────────
    int64_t get_sequence_duration(const std::string& seq_id);

    // ── Serialisation ─────────────────────────────────────────────────────
    std::string get_sequence_json(const std::string& seq_id);
    bool        load_sequence_json(const std::string& json_str);

    // ── Utility ───────────────────────────────────────────────────────────
    int64_t pts_from_frame(int frame_number, int fps_num, int fps_den);
    int     frame_from_pts(int64_t pts, int fps_num, int fps_den);

private:
    std::map<std::string, Sequence> sequences_;

    // clip_id → (seq_id, is_video_track, track_vector_index)
    struct ClipLocation { std::string seq_id; bool is_video; size_t track_idx; };
    std::map<std::string, ClipLocation> clip_index_;

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
