#include "timeline_engine.h"
#include <algorithm>
#include <cstdio>
#include <sstream>
#define __STDC_FORMAT_MACROS
#include <inttypes.h>

extern "C" {
#include <libavutil/mathematics.h>
}

using json = nlohmann::json;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

TimelineEngine& get_timeline_engine() {
    static TimelineEngine instance;
    return instance;
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

TimelineEngine::TimelineEngine() = default;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

std::string TimelineEngine::make_id(const std::string& prefix) {
    return prefix + "_" + std::to_string(next_id_++);
}

bool TimelineEngine::has_overlap(const std::vector<ClipRef>& clips,
                                  int64_t in_pts, int64_t out_pts,
                                  const std::string& exclude_id) const {
    for (const auto& c : clips) {
        if (c.clip_id == exclude_id) continue;
        // Overlap: [in, out) ∩ [c.in, c.out) ≠ ∅
        if (in_pts < c.timeline_out_pts && out_pts > c.timeline_in_pts)
            return true;
    }
    return false;
}

Track* TimelineEngine::find_track(const std::string& seq_id,
                                   int track_index, TrackType type) {
    auto sit = sequences_.find(seq_id);
    if (sit == sequences_.end()) return nullptr;
    auto& tracks = (type == TrackType::VIDEO)
                   ? sit->second.video_tracks
                   : sit->second.audio_tracks;
    // Extend tracks vector if needed
    while (static_cast<int>(tracks.size()) <= track_index) {
        Track t;
        t.type = type;
        const int idx = static_cast<int>(tracks.size());
        t.id   = make_id(type == TrackType::VIDEO ? "vt" : "at");
        t.name = (type == TrackType::VIDEO ? "V" : "A") + std::to_string(idx + 1);
        tracks.push_back(std::move(t));
    }
    return &tracks[static_cast<size_t>(track_index)];
}

ClipRef* TimelineEngine::find_clip_ref(const std::string& clip_id,
                                        Track** out_track) {
    auto cit = clip_index_.find(clip_id);
    if (cit == clip_index_.end()) return nullptr;

    const ClipLocation& loc = cit->second;
    auto sit = sequences_.find(loc.seq_id);
    if (sit == sequences_.end()) return nullptr;

    auto& tracks = loc.is_video ? sit->second.video_tracks
                                : sit->second.audio_tracks;
    if (loc.track_idx >= tracks.size()) return nullptr;

    Track& track = tracks[loc.track_idx];
    if (out_track) *out_track = &track;

    for (auto& c : track.clips)
        if (c.clip_id == clip_id) return &c;
    return nullptr;
}

void TimelineEngine::sort_track(Track& t) {
    std::sort(t.clips.begin(), t.clips.end(),
              [](const ClipRef& a, const ClipRef& b) {
                  return a.timeline_in_pts < b.timeline_in_pts;
              });
}

// ---------------------------------------------------------------------------
// Sequence management
// ---------------------------------------------------------------------------

std::string TimelineEngine::create_sequence(const std::string& name,
                                             int w, int h,
                                             int fps_num, int fps_den) {
    Sequence seq;
    seq.id      = make_id("seq");
    seq.name    = name;
    seq.width   = w;
    seq.height  = h;
    seq.fps_num = fps_num;
    seq.fps_den = fps_den;
    std::string id = seq.id;
    sequences_.emplace(id, std::move(seq));
    return id;
}

// ---------------------------------------------------------------------------
// Clip CRUD
// ---------------------------------------------------------------------------

std::string TimelineEngine::add_clip(const std::string& seq_id,
                                      const std::string& source_path,
                                      int     track_index,
                                      int64_t timeline_in_pts,
                                      int64_t source_in_pts,
                                      int64_t source_out_pts) {
    if (source_out_pts <= source_in_pts) {
        fprintf(stderr, "TimelineEngine::add_clip: source_out <= source_in\n");
        return "";
    }
    int64_t duration       = source_out_pts - source_in_pts;
    int64_t timeline_out   = timeline_in_pts + duration;

    Track* track = find_track(seq_id, track_index, TrackType::VIDEO);
    if (!track) {
        fprintf(stderr, "TimelineEngine::add_clip: seq not found: %s\n", seq_id.c_str());
        return "";
    }

    if (has_overlap(track->clips, timeline_in_pts, timeline_out)) {
        fprintf(stderr, "TimelineEngine::add_clip: overlap on track %d at %" PRId64 "\n",
                track_index, timeline_in_pts);
        return "";
    }

    ClipRef clip;
    clip.clip_id          = make_id("c");
    clip.source_path      = source_path;
    clip.source_in_pts    = source_in_pts;
    clip.source_out_pts   = source_out_pts;
    clip.timeline_in_pts  = timeline_in_pts;
    clip.timeline_out_pts = timeline_out;
    clip.track_index      = track_index;

    // Record the vector index before the track may be re-found
    auto sit = sequences_.find(seq_id);
    const bool is_video = true;
    const size_t tidx   = static_cast<size_t>(track_index);

    std::string id = clip.clip_id;
    track->clips.push_back(std::move(clip));
    sort_track(*track);

    clip_index_[id] = { seq_id, is_video, tidx };
    return id;
}

bool TimelineEngine::move_clip(const std::string& clip_id,
                                int64_t new_timeline_in_pts,
                                int     new_track_index) {
    Track*   old_track = nullptr;
    ClipRef* clip      = find_clip_ref(clip_id, &old_track);
    if (!clip || !old_track) {
        fprintf(stderr, "TimelineEngine::move_clip: clip not found: %s\n", clip_id.c_str());
        return false;
    }

    auto& loc    = clip_index_[clip_id];
    auto  sit    = sequences_.find(loc.seq_id);
    if (sit == sequences_.end()) return false;

    int64_t dur  = clip->source_out_pts - clip->source_in_pts;
    int64_t new_out = new_timeline_in_pts + dur;

    // Resolve target track (auto-extend if needed)
    Track* new_track = find_track(loc.seq_id, new_track_index, TrackType::VIDEO);
    if (!new_track) return false;

    // When moving within same track, exclude self from overlap check
    const std::string& excl = (old_track == new_track) ? clip_id : "";
    if (has_overlap(new_track->clips, new_timeline_in_pts, new_out, excl)) {
        fprintf(stderr, "TimelineEngine::move_clip: overlap at %" PRId64 "\n",
                new_timeline_in_pts);
        return false;
    }

    if (old_track != new_track) {
        // Move between tracks: copy clip, erase from old, add to new
        ClipRef moved = *clip;
        old_track->clips.erase(
            std::remove_if(old_track->clips.begin(), old_track->clips.end(),
                           [&](const ClipRef& c){ return c.clip_id == clip_id; }),
            old_track->clips.end());

        moved.timeline_in_pts  = new_timeline_in_pts;
        moved.timeline_out_pts = new_out;
        moved.track_index      = new_track_index;
        new_track->clips.push_back(std::move(moved));
        sort_track(*new_track);

        loc.track_idx = static_cast<size_t>(new_track_index);
    } else {
        clip->timeline_in_pts  = new_timeline_in_pts;
        clip->timeline_out_pts = new_out;
        clip->track_index      = new_track_index;
        sort_track(*old_track);
    }

    return true;
}

bool TimelineEngine::trim_clip(const std::string& clip_id,
                                int64_t new_source_in_pts,
                                int64_t new_source_out_pts) {
    if (new_source_out_pts <= new_source_in_pts) return false;

    Track*   track = nullptr;
    ClipRef* clip  = find_clip_ref(clip_id, &track);
    if (!clip || !track) return false;

    int64_t new_dur = new_source_out_pts - new_source_in_pts;
    int64_t new_out = clip->timeline_in_pts + new_dur;

    // Check the new duration doesn't overlap a neighbour on the same track
    if (has_overlap(track->clips, clip->timeline_in_pts, new_out, clip_id)) {
        fprintf(stderr, "TimelineEngine::trim_clip: trimmed extent overlaps neighbour\n");
        return false;
    }

    clip->source_in_pts    = new_source_in_pts;
    clip->source_out_pts   = new_source_out_pts;
    clip->timeline_out_pts = new_out;
    return true;
}

bool TimelineEngine::split_clip(const std::string& clip_id,
                                 int64_t split_timeline_pts) {
    Track*   track = nullptr;
    ClipRef* clip  = find_clip_ref(clip_id, &track);
    if (!clip || !track) return false;

    if (split_timeline_pts <= clip->timeline_in_pts ||
        split_timeline_pts >= clip->timeline_out_pts) {
        fprintf(stderr, "TimelineEngine::split_clip: split point outside clip range\n");
        return false;
    }

    // How far into the clip is the split point?
    int64_t offset     = split_timeline_pts - clip->timeline_in_pts;
    int64_t split_src  = clip->source_in_pts + offset;

    // Build the second half first (so we still have the original data)
    ClipRef second;
    second.clip_id          = make_id("c");
    second.source_path      = clip->source_path;
    second.source_in_pts    = split_src;
    second.source_out_pts   = clip->source_out_pts;
    second.timeline_in_pts  = split_timeline_pts;
    second.timeline_out_pts = clip->timeline_out_pts;
    second.track_index      = clip->track_index;

    // Truncate the first half in-place
    clip->source_out_pts   = split_src;
    clip->timeline_out_pts = split_timeline_pts;

    // Register the second half
    ClipLocation loc = clip_index_[clip_id];  // copy
    std::string second_id = second.clip_id;
    track->clips.push_back(std::move(second));
    sort_track(*track);

    clip_index_[second_id] = loc;
    return true;
}

bool TimelineEngine::remove_clip(const std::string& clip_id) {
    Track*   track = nullptr;
    ClipRef* clip  = find_clip_ref(clip_id, &track);
    if (!clip || !track) return false;

    track->clips.erase(
        std::remove_if(track->clips.begin(), track->clips.end(),
                       [&](const ClipRef& c){ return c.clip_id == clip_id; }),
        track->clips.end());
    clip_index_.erase(clip_id);
    return true;
}

// ---------------------------------------------------------------------------
// Track management
// ---------------------------------------------------------------------------

bool TimelineEngine::set_track_muted(const std::string& seq_id,
                                      int track_index, bool v) {
    Track* t = find_track(seq_id, track_index, TrackType::VIDEO);
    if (!t) return false;
    t->muted = v;
    return true;
}

bool TimelineEngine::set_track_visible(const std::string& seq_id,
                                        int track_index, bool v) {
    Track* t = find_track(seq_id, track_index, TrackType::VIDEO);
    if (!t) return false;
    t->visible = v;
    return true;
}

bool TimelineEngine::set_track_locked(const std::string& seq_id,
                                       int track_index, bool v) {
    Track* t = find_track(seq_id, track_index, TrackType::VIDEO);
    if (!t) return false;
    t->locked = v;
    return true;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

emscripten::val TimelineEngine::resolve_frame(const std::string& seq_id,
                                               int64_t timeline_pts) {
    auto sit = sequences_.find(seq_id);
    if (sit == sequences_.end()) return emscripten::val::null();

    const Sequence& seq = sit->second;

    // Search from highest track index (topmost) downward
    for (int i = static_cast<int>(seq.video_tracks.size()) - 1; i >= 0; --i) {
        const Track& track = seq.video_tracks[static_cast<size_t>(i)];
        if (!track.visible || track.muted) continue;

        for (const auto& clip : track.clips) {
            if (timeline_pts >= clip.timeline_in_pts &&
                timeline_pts <  clip.timeline_out_pts) {
                int64_t offset_seq  = timeline_pts - clip.timeline_in_pts;
                int64_t offset_clip = av_rescale_q(
                    offset_seq,
                    AVRational{1, 1000000},
                    AVRational{clip.tb_num, clip.tb_den}
                );
                int64_t source_pts  = clip.source_in_pts + offset_clip;

                emscripten::val result = emscripten::val::object();
                result.set("source_path", emscripten::val(clip.source_path));
                result.set("source_pts",  emscripten::val(static_cast<double>(source_pts)));
                result.set("colorspace",  emscripten::val(clip.colorspace));
                return result;
            }
        }
    }
    return emscripten::val::null();
}

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

int64_t TimelineEngine::get_sequence_duration(const std::string& seq_id) {
    auto sit = sequences_.find(seq_id);
    if (sit == sequences_.end()) return 0;

    const Sequence& seq = sit->second;
    int64_t max_out = 0;

    auto scan = [&](const std::vector<Track>& tracks) {
        for (const auto& t : tracks)
            for (const auto& c : t.clips)
                if (c.timeline_out_pts > max_out) max_out = c.timeline_out_pts;
    };
    scan(seq.video_tracks);
    scan(seq.audio_tracks);
    return max_out;
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

nlohmann::json TimelineEngine::clip_to_json(const ClipRef& c) const {
    return {
        {"clip_id",          c.clip_id},
        {"source_path",      c.source_path},
        {"source_in_pts",    c.source_in_pts},
        {"source_out_pts",   c.source_out_pts},
        {"timeline_in_pts",  c.timeline_in_pts},
        {"timeline_out_pts", c.timeline_out_pts},
        {"track_index",      c.track_index},
        {"fps_num",          c.fps_num},
        {"fps_den",          c.fps_den},
        {"tb_num",           c.tb_num},
        {"tb_den",           c.tb_den},
        {"color_primaries",  c.color_primaries},
        {"color_trc",        c.color_trc},
        {"colorspace",       c.colorspace}
    };
}

nlohmann::json TimelineEngine::track_to_json(const Track& t) const {
    json clips_arr = json::array();
    for (const auto& c : t.clips) clips_arr.push_back(clip_to_json(c));
    return {
        {"id",      t.id},
        {"name",    t.name},
        {"muted",   t.muted},
        {"locked",  t.locked},
        {"visible", t.visible},
        {"clips",   clips_arr}
    };
}

ClipRef TimelineEngine::json_to_clip(const nlohmann::json& j) const {
    ClipRef c;
    c.clip_id          = j.at("clip_id").get<std::string>();
    c.source_path      = j.at("source_path").get<std::string>();
    c.source_in_pts    = j.at("source_in_pts").get<int64_t>();
    c.source_out_pts   = j.at("source_out_pts").get<int64_t>();
    c.timeline_in_pts  = j.at("timeline_in_pts").get<int64_t>();
    c.timeline_out_pts = j.at("timeline_out_pts").get<int64_t>();
    c.track_index      = j.at("track_index").get<int>();
    c.fps_num          = j.value("fps_num", 30);
    c.fps_den          = j.value("fps_den", 1);
    c.tb_num           = j.value("tb_num",  1);
    c.tb_den           = j.value("tb_den",  1000000);
    c.color_primaries  = j.value("color_primaries", 1);
    c.color_trc        = j.value("color_trc", 1);
    c.colorspace       = j.value("colorspace", 5);
    return c;
}

Track TimelineEngine::json_to_track(const nlohmann::json& j, TrackType type) const {
    Track t;
    t.id      = j.at("id").get<std::string>();
    t.name    = j.at("name").get<std::string>();
    t.type    = type;
    t.muted   = j.value("muted",   false);
    t.locked  = j.value("locked",  false);
    t.visible = j.value("visible", true);
    for (const auto& cj : j.at("clips"))
        t.clips.push_back(json_to_clip(cj));
    return t;
}

// ---------------------------------------------------------------------------
// Serialisation public API
// ---------------------------------------------------------------------------

std::string TimelineEngine::get_sequence_json(const std::string& seq_id) {
    auto sit = sequences_.find(seq_id);
    if (sit == sequences_.end()) return "{}";

    const Sequence& seq = sit->second;

    json vt_arr = json::array();
    for (const auto& t : seq.video_tracks) vt_arr.push_back(track_to_json(t));

    json at_arr = json::array();
    for (const auto& t : seq.audio_tracks) at_arr.push_back(track_to_json(t));

    json obj = {
        {"id",           seq.id},
        {"name",         seq.name},
        {"width",        seq.width},
        {"height",       seq.height},
        {"fps_num",      seq.fps_num},
        {"fps_den",      seq.fps_den},
        {"video_tracks", vt_arr},
        {"audio_tracks", at_arr}
    };
    return obj.dump();
}

bool TimelineEngine::load_sequence_json(const std::string& json_str) {
    try {
        json j = json::parse(json_str);

        Sequence seq;
        seq.id      = j.at("id").get<std::string>();
        seq.name    = j.at("name").get<std::string>();
        seq.width   = j.value("width",   1920);
        seq.height  = j.value("height",  1080);
        seq.fps_num = j.value("fps_num", 24);
        seq.fps_den = j.value("fps_den", 1);

        // Clear existing clip index entries for this sequence
        for (auto it = clip_index_.begin(); it != clip_index_.end(); ) {
            if (it->second.seq_id == seq.id)
                it = clip_index_.erase(it);
            else
                ++it;
        }

        for (const auto& tj : j.value("video_tracks", json::array())) {
            Track t = json_to_track(tj, TrackType::VIDEO);
            const size_t tidx = seq.video_tracks.size();
            for (const auto& c : t.clips)
                clip_index_[c.clip_id] = { seq.id, true, tidx };
            seq.video_tracks.push_back(std::move(t));
        }
        for (const auto& tj : j.value("audio_tracks", json::array())) {
            Track t = json_to_track(tj, TrackType::AUDIO);
            const size_t tidx = seq.audio_tracks.size();
            for (const auto& c : t.clips)
                clip_index_[c.clip_id] = { seq.id, false, tidx };
            seq.audio_tracks.push_back(std::move(t));
        }

        sequences_[seq.id] = std::move(seq);
        return true;
    } catch (const std::exception& e) {
        fprintf(stderr, "TimelineEngine::load_sequence_json: %s\n", e.what());
        return false;
    }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

int64_t TimelineEngine::pts_from_frame(int frame_number, int fps_num, int fps_den) {
    if (fps_num <= 0) return 0;
    return llround((double)frame_number * NLE_TIME_BASE * fps_den / fps_num);
}

int TimelineEngine::frame_from_pts(int64_t pts, int fps_num, int fps_den) {
    if (fps_den <= 0) return 0;
    // Add half a frame period to compensate for µs rounding in pts_from_frame.
    const int64_t half = (static_cast<int64_t>(NLE_TIME_BASE) * fps_den) / 2;
    return static_cast<int>((pts * fps_num + half) / (NLE_TIME_BASE * fps_den));
}
