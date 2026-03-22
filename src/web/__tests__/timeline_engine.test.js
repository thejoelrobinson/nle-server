/**
 * timeline_engine.test.js
 *
 * Tests for the TimelineEngine data model.
 *
 * Because the WASM module cannot run in jsdom, we test a pure-JS mirror of the
 * C++ TimelineEngine.  This mirror replicates every rule from the spec so the
 * tests serve as executable documentation and catch regressions without
 * requiring a WASM rebuild.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// JS mirror of the C++ TimelineEngine
// ---------------------------------------------------------------------------

const NLE_TIME_BASE = 1_000_000; // microseconds — mirrors AV_TIME_BASE

class TimelineEngine {
  constructor() {
    this._sequences  = new Map();  // seq_id → Sequence
    this._clipIndex  = new Map();  // clip_id → { seqId, trackIdx }
    this._nextId     = 1;
  }

  _makeId(prefix) { return `${prefix}_${this._nextId++}`; }

  _hasOverlap(clips, inPts, outPts, excludeId = '') {
    for (const c of clips) {
      if (c.clip_id === excludeId) continue;
      if (inPts < c.timeline_out_pts && outPts > c.timeline_in_pts) return true;
    }
    return false;
  }

  _getTrack(seqId, trackIndex) {
    const seq = this._sequences.get(seqId);
    if (!seq) return null;
    while (seq.video_tracks.length <= trackIndex) {
      const i = seq.video_tracks.length;
      seq.video_tracks.push({
        id: this._makeId('vt'), name: `V${i + 1}`,
        muted: false, locked: false, visible: true, clips: [],
      });
    }
    return seq.video_tracks[trackIndex];
  }

  _sortTrack(track) {
    track.clips.sort((a, b) => a.timeline_in_pts - b.timeline_in_pts);
  }

  _findClip(clipId) {
    const loc = this._clipIndex.get(clipId);
    if (!loc) return { clip: null, track: null, seq: null };
    const seq = this._sequences.get(loc.seqId);
    if (!seq) return { clip: null, track: null, seq: null };
    const track = seq.video_tracks[loc.trackIdx];
    if (!track) return { clip: null, track: null, seq };
    const clip = track.clips.find((c) => c.clip_id === clipId) ?? null;
    return { clip, track, seq, loc };
  }

  // ── Sequence ────────────────────────────────────────────────────────────

  create_sequence(name, w, h, fps_num, fps_den) {
    const id = this._makeId('seq');
    this._sequences.set(id, {
      id, name, width: w, height: h, fps_num, fps_den,
      video_tracks: [], audio_tracks: [],
    });
    return id;
  }

  // ── Clip CRUD ────────────────────────────────────────────────────────────

  add_clip(seqId, sourcePath, trackIndex, timelineInPts, sourceInPts, sourceOutPts) {
    if (sourceOutPts <= sourceInPts) return '';
    const dur = sourceOutPts - sourceInPts;
    const timelineOutPts = timelineInPts + dur;

    const track = this._getTrack(seqId, trackIndex);
    if (!track) return '';

    if (this._hasOverlap(track.clips, timelineInPts, timelineOutPts)) return '';

    const clipId = this._makeId('c');
    const clip = {
      clip_id: clipId, source_path: sourcePath,
      source_in_pts: sourceInPts, source_out_pts: sourceOutPts,
      timeline_in_pts: timelineInPts, timeline_out_pts: timelineOutPts,
      track_index: trackIndex,
    };
    track.clips.push(clip);
    this._sortTrack(track);
    this._clipIndex.set(clipId, { seqId, trackIdx: trackIndex });
    return clipId;
  }

  move_clip(clipId, newTimelineInPts, newTrackIndex) {
    const { clip, track: oldTrack, seq, loc } = this._findClip(clipId);
    if (!clip || !oldTrack || !seq) return false;

    const dur    = clip.source_out_pts - clip.source_in_pts;
    const newOut = newTimelineInPts + dur;

    const newTrack = this._getTrack(loc.seqId, newTrackIndex);
    if (!newTrack) return false;

    const excl = (oldTrack === newTrack) ? clipId : '';
    if (this._hasOverlap(newTrack.clips, newTimelineInPts, newOut, excl)) return false;

    if (oldTrack !== newTrack) {
      oldTrack.clips = oldTrack.clips.filter((c) => c.clip_id !== clipId);
      clip.timeline_in_pts  = newTimelineInPts;
      clip.timeline_out_pts = newOut;
      clip.track_index      = newTrackIndex;
      newTrack.clips.push(clip);
      this._sortTrack(newTrack);
      this._clipIndex.set(clipId, { seqId: loc.seqId, trackIdx: newTrackIndex });
    } else {
      clip.timeline_in_pts  = newTimelineInPts;
      clip.timeline_out_pts = newOut;
      this._sortTrack(oldTrack);
    }
    return true;
  }

  trim_clip(clipId, newSourceInPts, newSourceOutPts) {
    if (newSourceOutPts <= newSourceInPts) return false;
    const { clip, track } = this._findClip(clipId);
    if (!clip || !track) return false;

    const newDur = newSourceOutPts - newSourceInPts;
    const newOut = clip.timeline_in_pts + newDur;
    if (this._hasOverlap(track.clips, clip.timeline_in_pts, newOut, clipId)) return false;

    clip.source_in_pts    = newSourceInPts;
    clip.source_out_pts   = newSourceOutPts;
    clip.timeline_out_pts = newOut;
    return true;
  }

  split_clip(clipId, splitTimelinePts) {
    const { clip, track, loc } = this._findClip(clipId);
    if (!clip || !track) return false;
    if (splitTimelinePts <= clip.timeline_in_pts ||
        splitTimelinePts >= clip.timeline_out_pts) return false;

    const offset   = splitTimelinePts - clip.timeline_in_pts;
    const splitSrc = clip.source_in_pts + offset;

    const secondId = this._makeId('c');
    const second   = {
      clip_id:          secondId,
      source_path:      clip.source_path,
      source_in_pts:    splitSrc,
      source_out_pts:   clip.source_out_pts,
      timeline_in_pts:  splitTimelinePts,
      timeline_out_pts: clip.timeline_out_pts,
      track_index:      clip.track_index,
    };

    clip.source_out_pts   = splitSrc;
    clip.timeline_out_pts = splitTimelinePts;

    track.clips.push(second);
    this._sortTrack(track);
    this._clipIndex.set(secondId, { seqId: loc.seqId, trackIdx: loc.trackIdx });
    return true;
  }

  remove_clip(clipId) {
    const { clip, track } = this._findClip(clipId);
    if (!clip || !track) return false;
    track.clips = track.clips.filter((c) => c.clip_id !== clipId);
    this._clipIndex.delete(clipId);
    return true;
  }

  // ── Track management ─────────────────────────────────────────────────────

  set_track_muted  (seqId, idx, v) { const t = this._getTrack(seqId, idx); if (!t) return false; t.muted   = v; return true; }
  set_track_visible(seqId, idx, v) { const t = this._getTrack(seqId, idx); if (!t) return false; t.visible = v; return true; }
  set_track_locked (seqId, idx, v) { const t = this._getTrack(seqId, idx); if (!t) return false; t.locked  = v; return true; }

  // ── Resolution ───────────────────────────────────────────────────────────

  resolve_frame(seqId, timelinePts) {
    const seq = this._sequences.get(seqId);
    if (!seq) return null;
    // Topmost visible track (highest index)
    for (let i = seq.video_tracks.length - 1; i >= 0; i--) {
      const track = seq.video_tracks[i];
      if (!track.visible || track.muted) continue;
      for (const clip of track.clips) {
        if (timelinePts >= clip.timeline_in_pts &&
            timelinePts <  clip.timeline_out_pts) {
          const offset    = timelinePts - clip.timeline_in_pts;
          const sourcePts = clip.source_in_pts + offset;
          return {
            source_path: clip.source_path,
            source_pts:  sourcePts,
            colorspace:  clip.colorspace ?? 5,
          };
        }
      }
    }
    return null;
  }

  // ── Duration ─────────────────────────────────────────────────────────────

  get_sequence_duration(seqId) {
    const seq = this._sequences.get(seqId);
    if (!seq) return 0;
    let max = 0;
    for (const t of [...seq.video_tracks, ...seq.audio_tracks])
      for (const c of t.clips)
        if (c.timeline_out_pts > max) max = c.timeline_out_pts;
    return max;
  }

  // ── Serialisation ────────────────────────────────────────────────────────

  get_sequence_json(seqId) {
    const seq = this._sequences.get(seqId);
    if (!seq) return '{}';

    const serTrack = (t) => ({
      id: t.id, name: t.name, muted: t.muted, locked: t.locked, visible: t.visible,
      clips: t.clips.map((c) => ({ ...c })),
    });

    return JSON.stringify({
      id: seq.id, name: seq.name,
      width: seq.width, height: seq.height,
      fps_num: seq.fps_num, fps_den: seq.fps_den,
      video_tracks: seq.video_tracks.map(serTrack),
      audio_tracks: seq.audio_tracks.map(serTrack),
    });
  }

  load_sequence_json(jsonStr) {
    try {
      const obj = JSON.parse(jsonStr);
      // Remove existing clip-index entries for this seq
      for (const [k, v] of this._clipIndex)
        if (v.seqId === obj.id) this._clipIndex.delete(k);

      const parseTrack = (tj) => {
        const t = {
          id: tj.id, name: tj.name, muted: tj.muted ?? false,
          locked: tj.locked ?? false, visible: tj.visible ?? true,
          clips: tj.clips.map((c) => ({ ...c })),
        };
        return t;
      };

      const seq = {
        id: obj.id, name: obj.name,
        width: obj.width ?? 1920, height: obj.height ?? 1080,
        fps_num: obj.fps_num ?? 24, fps_den: obj.fps_den ?? 1,
        video_tracks: (obj.video_tracks ?? []).map((t, idx) => {
          const tr = parseTrack(t);
          for (const c of tr.clips)
            this._clipIndex.set(c.clip_id, { seqId: obj.id, trackIdx: idx });
          return tr;
        }),
        audio_tracks: (obj.audio_tracks ?? []).map((t) => parseTrack(t)),
      };
      this._sequences.set(obj.id, seq);
      return true;
    } catch { return false; }
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  pts_from_frame(n, fps_num, fps_den) {
    if (fps_num <= 0) return 0;
    return Math.round(n * NLE_TIME_BASE * fps_den / fps_num);
  }

  frame_from_pts(pts, fps_num, fps_den) {
    if (fps_den <= 0) return 0;
    // Add half a frame period to compensate for µs rounding in pts_from_frame,
    // ensuring pts_from_frame(n) → frame_from_pts → n round-trips correctly.
    const half = Math.floor(NLE_TIME_BASE * fps_den / 2);
    return Math.floor((pts * fps_num + half) / (NLE_TIME_BASE * fps_den));
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEC = NLE_TIME_BASE;  // 1 second in pts units

let engine;
let seqId;

beforeEach(() => {
  engine = new TimelineEngine();
  seqId  = engine.create_sequence('Test Sequence', 1920, 1080, 24, 1);
});

// ---------------------------------------------------------------------------
// add_clip
// ---------------------------------------------------------------------------

describe('add_clip()', () => {
  it('returns a non-empty clip_id on success', () => {
    const id = engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 10 * SEC);
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('places the clip at the correct timeline position', () => {
    const id = engine.add_clip(seqId, 'a.mp4', 0, 5 * SEC, 0, 3 * SEC);
    const seq = engine._sequences.get(seqId);
    const clip = seq.video_tracks[0].clips.find((c) => c.clip_id === id);
    expect(clip.timeline_in_pts).toBe(5 * SEC);
    expect(clip.timeline_out_pts).toBe(8 * SEC);
  });

  it('rejects a clip that overlaps an existing clip on the same track', () => {
    engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 10 * SEC);
    const id2 = engine.add_clip(seqId, 'b.mp4', 0, 5 * SEC, 0, 10 * SEC);
    expect(id2).toBe('');
  });

  it('allows adjacent clips (out == in of next)', () => {
    engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 5 * SEC);
    const id2 = engine.add_clip(seqId, 'b.mp4', 0, 5 * SEC, 0, 5 * SEC);
    expect(id2).toBeTruthy();
  });

  it('allows clips on different tracks to overlap in time', () => {
    engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 10 * SEC);
    const id2 = engine.add_clip(seqId, 'b.mp4', 1, 0, 0, 10 * SEC);
    expect(id2).toBeTruthy();
  });

  it('returns "" for an unknown sequence id', () => {
    const id = engine.add_clip('no_such_seq', 'a.mp4', 0, 0, 0, 5 * SEC);
    expect(id).toBe('');
  });

  it('returns "" when source_out <= source_in', () => {
    const id = engine.add_clip(seqId, 'a.mp4', 0, 0, 5 * SEC, 5 * SEC);
    expect(id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// move_clip
// ---------------------------------------------------------------------------

describe('move_clip()', () => {
  it('updates timeline position correctly', () => {
    const id = engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 5 * SEC);
    expect(engine.move_clip(id, 10 * SEC, 0)).toBe(true);
    const { clip } = engine._findClip(id);
    expect(clip.timeline_in_pts).toBe(10 * SEC);
    expect(clip.timeline_out_pts).toBe(15 * SEC);
  });

  it('rejects a move that would overlap another clip on the same track', () => {
    const a = engine.add_clip(seqId, 'a.mp4', 0, 0,         0, 5 * SEC);
    engine.add_clip(seqId, 'b.mp4', 0, 10 * SEC,  0, 5 * SEC);
    expect(engine.move_clip(a, 8 * SEC, 0)).toBe(false);
    const { clip } = engine._findClip(a);
    expect(clip.timeline_in_pts).toBe(0); // unchanged
  });

  it('allows moving a clip to a gap on its own track', () => {
    const a = engine.add_clip(seqId, 'a.mp4', 0, 0,        0, 5 * SEC);
    engine.add_clip(seqId, 'b.mp4', 0, 10 * SEC, 0, 5 * SEC);
    expect(engine.move_clip(a, 20 * SEC, 0)).toBe(true);
  });

  it('allows moving a clip to a different track', () => {
    const a = engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 5 * SEC);
    engine.add_clip(seqId, 'b.mp4', 0, 5 * SEC, 0, 5 * SEC); // fills track 0
    expect(engine.move_clip(a, 0, 1)).toBe(true);
    const { clip } = engine._findClip(a);
    expect(clip.track_index).toBe(1);
  });

  it('returns false for an unknown clip_id', () => {
    expect(engine.move_clip('no_such_clip', 0, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// trim_clip
// ---------------------------------------------------------------------------

describe('trim_clip()', () => {
  it('updates source and timeline out pts', () => {
    const id = engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 10 * SEC);
    expect(engine.trim_clip(id, 1 * SEC, 8 * SEC)).toBe(true);
    const { clip } = engine._findClip(id);
    expect(clip.source_in_pts).toBe(1 * SEC);
    expect(clip.source_out_pts).toBe(8 * SEC);
    expect(clip.timeline_out_pts).toBe(7 * SEC);  // dur = 7s
  });

  it('rejects when trim would overlap a neighbour', () => {
    engine.add_clip(seqId, 'a.mp4', 0, 0,       0, 5 * SEC);          // [0, 5s)
    const b = engine.add_clip(seqId, 'b.mp4', 0, 5 * SEC, 0, 3 * SEC); // [5s, 8s)
    engine.add_clip(seqId, 'c.mp4', 0, 8 * SEC, 0, 5 * SEC);          // [8s, 13s)
    // Extending b's duration would push timeline_out into c at [8s, 13s)
    expect(engine.trim_clip(b, 0, 5 * SEC)).toBe(false);  // new out = 10s, overlaps c
  });
});

// ---------------------------------------------------------------------------
// split_clip
// ---------------------------------------------------------------------------

describe('split_clip()', () => {
  it('produces two clips at correct pts values', () => {
    const id = engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 10 * SEC);
    expect(engine.split_clip(id, 4 * SEC)).toBe(true);

    const seq   = engine._sequences.get(seqId);
    const clips = seq.video_tracks[0].clips;
    expect(clips).toHaveLength(2);

    const [first, second] = clips.sort((a, b) => a.timeline_in_pts - b.timeline_in_pts);
    expect(first.timeline_in_pts).toBe(0);
    expect(first.timeline_out_pts).toBe(4 * SEC);
    expect(first.source_in_pts).toBe(0);
    expect(first.source_out_pts).toBe(4 * SEC);

    expect(second.timeline_in_pts).toBe(4 * SEC);
    expect(second.timeline_out_pts).toBe(10 * SEC);
    expect(second.source_in_pts).toBe(4 * SEC);
    expect(second.source_out_pts).toBe(10 * SEC);
  });

  it('rejects split at the start or end of the clip', () => {
    const id = engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 10 * SEC);
    expect(engine.split_clip(id, 0)).toBe(false);
    expect(engine.split_clip(id, 10 * SEC)).toBe(false);
  });

  it('split with source offset (non-zero source_in_pts)', () => {
    const id = engine.add_clip(seqId, 'a.mp4', 0, 2 * SEC, 5 * SEC, 15 * SEC);
    expect(engine.split_clip(id, 5 * SEC)).toBe(true); // 3s into the clip

    const seq   = engine._sequences.get(seqId);
    const clips = seq.video_tracks[0].clips.sort((a, b) => a.timeline_in_pts - b.timeline_in_pts);
    expect(clips[0].source_in_pts).toBe(5 * SEC);
    expect(clips[0].source_out_pts).toBe(8 * SEC);   // 5+3
    expect(clips[1].source_in_pts).toBe(8 * SEC);
    expect(clips[1].source_out_pts).toBe(15 * SEC);
  });
});

// ---------------------------------------------------------------------------
// remove_clip
// ---------------------------------------------------------------------------

describe('remove_clip()', () => {
  it('removes the clip from the track', () => {
    const id = engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 5 * SEC);
    expect(engine.remove_clip(id)).toBe(true);
    const seq = engine._sequences.get(seqId);
    expect(seq.video_tracks[0].clips).toHaveLength(0);
  });

  it('returns false for an unknown clip_id', () => {
    expect(engine.remove_clip('ghost')).toBe(false);
  });

  it('allows a new clip in the same gap after removal', () => {
    const id = engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 5 * SEC);
    engine.remove_clip(id);
    const id2 = engine.add_clip(seqId, 'b.mp4', 0, 0, 0, 5 * SEC);
    expect(id2).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// resolve_frame
// ---------------------------------------------------------------------------

describe('resolve_frame()', () => {
  it('returns correct source_path and source_pts for a position inside a clip', () => {
    engine.add_clip(seqId, 'hero.mp4', 0, 10 * SEC, 5 * SEC, 20 * SEC);
    const result = engine.resolve_frame(seqId, 12 * SEC);
    expect(result).not.toBeNull();
    expect(result.source_path).toBe('hero.mp4');
    // 12s into timeline = 2s into clip = source 5+2 = 7s → 7 * SEC µs
    expect(result.source_pts).toBe(7 * SEC);
  });

  it('returns null for a gap between clips', () => {
    engine.add_clip(seqId, 'a.mp4', 0, 0,        0, 5 * SEC);
    engine.add_clip(seqId, 'b.mp4', 0, 10 * SEC, 0, 5 * SEC);
    expect(engine.resolve_frame(seqId, 7 * SEC)).toBeNull();
  });

  it('returns null at the exact out point (half-open interval)', () => {
    engine.add_clip(seqId, 'a.mp4', 0, 0, 0, 5 * SEC);
    expect(engine.resolve_frame(seqId, 5 * SEC)).toBeNull();
  });

  it('picks the topmost visible track when two clips overlap in time', () => {
    engine.add_clip(seqId, 'lower.mp4', 0, 0, 0, 10 * SEC);  // V1
    engine.add_clip(seqId, 'upper.mp4', 1, 0, 0, 10 * SEC);  // V2 (on top)
    const result = engine.resolve_frame(seqId, 5 * SEC);
    expect(result.source_path).toBe('upper.mp4');
  });

  it('falls through to a lower track when upper track is hidden', () => {
    engine.add_clip(seqId, 'lower.mp4', 0, 0, 0, 10 * SEC);
    engine.add_clip(seqId, 'upper.mp4', 1, 0, 0, 10 * SEC);
    engine.set_track_visible(seqId, 1, false);
    const result = engine.resolve_frame(seqId, 5 * SEC);
    expect(result.source_path).toBe('lower.mp4');
  });

  it('falls through to a lower track when upper track is muted', () => {
    engine.add_clip(seqId, 'lower.mp4', 0, 0, 0, 10 * SEC);
    engine.add_clip(seqId, 'upper.mp4', 1, 0, 0, 10 * SEC);
    engine.set_track_muted(seqId, 1, true);
    const result = engine.resolve_frame(seqId, 5 * SEC);
    expect(result.source_path).toBe('lower.mp4');
  });
});

// ---------------------------------------------------------------------------
// get_sequence_duration
// ---------------------------------------------------------------------------

describe('get_sequence_duration()', () => {
  it('returns the max timeline_out_pts across all tracks', () => {
    engine.add_clip(seqId, 'a.mp4', 0, 0,        0, 5 * SEC);
    engine.add_clip(seqId, 'b.mp4', 0, 10 * SEC, 0, 8 * SEC);  // ends at 18s
    engine.add_clip(seqId, 'c.mp4', 1, 5 * SEC,  0, 3 * SEC);  // ends at 8s
    expect(engine.get_sequence_duration(seqId)).toBe(18 * SEC);
  });

  it('returns 0 for an empty sequence', () => {
    expect(engine.get_sequence_duration(seqId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// JSON roundtrip
// ---------------------------------------------------------------------------

describe('JSON roundtrip', () => {
  it('serialise → deserialise → re-serialise produces identical output', () => {
    engine.add_clip(seqId, 'a.mp4', 0, 0,        0, 5 * SEC);
    engine.add_clip(seqId, 'b.mp4', 0, 5 * SEC,  0, 5 * SEC);
    engine.add_clip(seqId, 'c.mp4', 1, 0,        0, 10 * SEC);

    const json1 = engine.get_sequence_json(seqId);
    expect(json1).not.toBe('{}');

    const engine2 = new TimelineEngine();
    expect(engine2.load_sequence_json(json1)).toBe(true);
    const json2 = engine2.get_sequence_json(seqId);

    // Parse and compare as objects to avoid key-order sensitivity
    expect(JSON.parse(json1)).toEqual(JSON.parse(json2));
  });

  it('roundtrip preserves track metadata (muted, visible, locked)', () => {
    engine._getTrack(seqId, 0);  // ensure track exists
    engine.set_track_muted  (seqId, 0, true);
    engine.set_track_visible(seqId, 0, false);
    engine.set_track_locked (seqId, 0, true);

    const json1   = engine.get_sequence_json(seqId);
    const engine2 = new TimelineEngine();
    engine2.load_sequence_json(json1);

    const track = engine2._sequences.get(seqId).video_tracks[0];
    expect(track.muted).toBe(true);
    expect(track.visible).toBe(false);
    expect(track.locked).toBe(true);
  });

  it('returns false for invalid JSON', () => {
    expect(engine.load_sequence_json('{not valid json')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

describe('pts_from_frame / frame_from_pts', () => {
  it('converts frame 0 to pts 0', () => {
    expect(engine.pts_from_frame(0, 24, 1)).toBe(0);
  });

  it('converts frame 24 to 1 second at 24fps', () => {
    expect(engine.pts_from_frame(24, 24, 1)).toBe(NLE_TIME_BASE);
  });

  it('round-trips frame number through pts', () => {
    for (let f = 0; f < 100; f++) {
      const pts   = engine.pts_from_frame(f, 24, 1);
      const back  = engine.frame_from_pts(pts, 24, 1);
      expect(back).toBe(f);
    }
  });

  it('handles non-integer fps (23.976 = 24000/1001)', () => {
    const fps_num = 24000, fps_den = 1001;
    const pts = engine.pts_from_frame(1, fps_num, fps_den);
    // 1001/24000 seconds ≈ 41708 µs
    expect(pts).toBeCloseTo(41708, 0);
    expect(engine.frame_from_pts(pts, fps_num, fps_den)).toBe(1);
  });
});
