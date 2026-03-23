/**
 * main.js – Application entry point for the NLE Studio.
 *
 * Wires together:
 *  - layout.js     → draggable panel dividers
 *  - timeline.js   → canvas timeline (2c)
 *  - wasm_bridge   → FrameServerBridge + FrameServerPool
 *  - player.js     → WebGL YUV renderer (Program Monitor)
 *  - media_bin.js  → Media Bin + Source Monitor (2f, lazy-imported)
 *  - project.js    → save / load (2g, lazy-imported)
 */

import { FrameServerBridge, FrameServerPool } from './wasm_bridge.js';
import { Player }                              from './player.js';
import { formatTimecode }                      from './timecode.js';
import { initLayout }                          from './layout.js';
import { Timeline }                            from './timeline.js';
import { Playback }                            from './playback.js';
import { initMediaBin }                        from './media_bin.js';
import { initProject, saveProject, loadProject } from './project.js';
import { initSequenceCreator }                 from './sequence_creator.js';
import { initSequenceSettings }                from './sequence_settings.js';

// ── Init layout (draggable dividers) ──────────────────────────────────────
initLayout();
_syncSecondDivider();

// ── Timeline engine (JS mirror — real WASM proxy added in 2d once WASM ready)
// For now the JS mirror lives entirely in the TimelineEngine defined inline
// so that the UI works without a compiled WASM build.

let _engine = null;
let _seqId  = null;
let _timeline = null;

function _getOrCreateEngineAndSeq() {
  if (_engine && _seqId) return;

  _engine = _buildJsMirrorEngine();
  _seqId  = _engine.create_sequence('Sequence 01', 1920, 1080, 24, 1);

  // Set program monitor badge immediately
  requestAnimationFrame(() => {
    const badge = document.getElementById('program-seq-name');
    if (badge) badge.textContent = 'Sequence 01';
  });
}

// ── Player (Program Monitor canvas) ──────────────────────────────────────
const glCanvas       = document.getElementById('gl-canvas');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText    = document.getElementById('loading-text');
const btnPlayPause   = document.getElementById('btn-play-pause');
const btnStepBack    = document.getElementById('btn-step-back');
const btnStepFwd     = document.getElementById('btn-step-fwd');
const timecodeEl     = document.getElementById('timecode');
const durationEl     = document.getElementById('duration-display');
const programEmpty   = document.getElementById('program-empty');
const timelineTc     = document.getElementById('timeline-timecode');
const statusBar      = document.getElementById('status');

let player    = null;
const pool    = new FrameServerPool();
let seqFps    = 24;
let playback  = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  statusBar.textContent = msg;
  statusBar.className   = 'status-bar' + (isError ? ' error' : '');
}

function setLoading(visible, text = 'Loading…') {
  loadingText.textContent = text;
  loadingOverlay.classList.toggle('visible', visible);
}

function setProgramEmpty(empty) {
  if (programEmpty) programEmpty.classList.toggle('hidden', !empty);
}

function initPlayer() {
  if (!player) {
    try {
      player = new Player(glCanvas);
      playback?.setProgramPlayer(player);
    }
    catch (err) { setStatus('WebGL init failed: ' + err.message, true); return false; }
  }
  return true;
}

function updatePlayButton(isPlaying) {
  btnPlayPause.textContent = isPlaying ? '⏸' : '▶';
}

// ── Timeline playback ──────────────────────────────────────────────────────

function updateTimecodeDisplay() {
  const pts = playback?.playheadPts ?? 0;
  const tc  = formatTimecode(pts / 1e6, seqFps);
  if (timecodeEl)  timecodeEl.textContent  = tc;
  if (timelineTc)  timelineTc.textContent  = tc;
}

// ── Init timeline component ────────────────────────────────────────────────

function initTimeline() {
  _getOrCreateEngineAndSeq();
  const canvas = document.getElementById('timeline-canvas');
  if (!canvas || _timeline) return;

  _timeline = new Timeline(canvas, _engine, _seqId, 24, 1);
  _timeline.setPool(pool);

  playback = new Playback({
    timeline:          _timeline,
    engine:            _engine,
    pool,
    sequenceId:        _seqId,
    fps:               seqFps,
    duration:          _engine.get_sequence_duration?.(_seqId) ?? 0,
    onPlayStateChange: updatePlayButton,
    onTimecodeUpdate:  updateTimecodeDisplay,
    onFrameState:      (hasFrame) => setProgramEmpty(!hasFrame),
  });

  // When the user scrubs the playhead, pause and sync the Playback engine.
  canvas.addEventListener('playhead-change', (e) => {
    playback.pause();
    playback.syncPlayheadPts(e.detail.pts);
  });

  // Drop clips from Media Bin onto the timeline canvas
  canvas.addEventListener('nle:drop-clips', async (e) => {
    const { paths, trackIndex, dropPts } = e.detail;
    let currentPts = dropPts;
    for (const path of paths) {
      // Ensure file is in the pool
      if (!pool.has(path)) continue;
      const bridge = pool.getBridge(path);
      const dur    = bridge?.duration ?? 10;
      const fps    = bridge?.fps      ?? 24;
      const durPts = Math.round(dur * 1e6);

      const clipId = _engine.add_clip(_seqId, path, trackIndex, currentPts, 0, durPts);
      if (clipId) {
        currentPts += durPts;
        seqFps = fps;
        if (_timeline) _timeline._fps_num = Math.round(fps);
        playback?.setFps(fps);
      }
    }

    const totalDur = _engine.get_sequence_duration?.(_seqId) ?? 0;
    if (durationEl) durationEl.textContent = formatTimecode(totalDur / 1e6, seqFps);
    playback?.setDuration(totalDur);
    _timeline?.render();

    btnPlayPause.disabled = false;
    btnStepBack.disabled  = false;
    btnStepFwd.disabled   = false;

    initPlayer();
    playback?.syncPlayheadPts(playback?.playheadPts ?? 0);
    setProgramEmpty(false);
    setStatus(`Added ${paths.length} clip${paths.length > 1 ? 's' : ''} to timeline.`);

    // Notify sequence settings bar to refresh
    window.dispatchEvent(new CustomEvent('nle:sequence-changed'));
  });

  // Tool buttons
  ['select', 'razor', 'hand'].forEach((name) => {
    document.getElementById('tool-' + name)?.addEventListener('click', () => {
      _timeline.setTool(name);
    });
  });
}

// ── Open a file into the pool, then add it to the timeline ────────────────

async function importFileToTimeline(file, trackIndex = 0, srcInPts = 0, srcOutPts = null) {
  _getOrCreateEngineAndSeq();
  setStatus('Importing ' + file.name + '…');

  try {
    setLoading(true, 'Opening ' + file.name + '…');
    await pool.addFile(file);
    setLoading(false);
  } catch (err) {
    setLoading(false);
    setStatus('Failed to open ' + file.name + ': ' + err.message, true);
    return;
  }

  // Determine source duration from the bridge
  const bridge = pool.getBridge(file.name);
  const dur    = bridge?.duration ?? 10;
  const fps    = bridge?.fps      ?? 24;

  // Place clip at end of last clip on the track
  const seq      = _engine._sequences?.get(_seqId);
  const track    = seq?.video_tracks?.[trackIndex];
  const lastOut  = track?.clips?.reduce((max, c) => Math.max(max, c.timeline_out_pts), 0) ?? 0;
  const resolvedSrcIn  = srcInPts ?? 0;
  const resolvedSrcOut = srcOutPts ?? Math.round(dur * 1e6);

  const clipId = _engine.add_clip(_seqId, file.name, trackIndex, lastOut,
                                  resolvedSrcIn, resolvedSrcOut);
  if (!clipId) {
    setStatus('Could not place clip — overlaps existing content.', true);
    return;
  }

  seqFps = fps;
  if (_timeline) _timeline._fps_num = Math.round(fps);
  playback?.setFps(fps);

  btnPlayPause.disabled = false;
  btnStepBack.disabled  = false;
  btnStepFwd.disabled   = false;

  // Update duration display and playback engine
  const totalDur = _engine.get_sequence_duration?.(_seqId) ?? 0;
  if (durationEl) durationEl.textContent = formatTimecode(totalDur / 1e6, fps);
  playback?.setDuration(totalDur);

  setStatus('Added ' + file.name + ' to timeline.');
  _timeline?.render();
  // Re-decode the current frame so the program monitor shows content immediately
  initPlayer();
  playback?.syncPlayheadPts(playback?.playheadPts ?? 0);
  setProgramEmpty(false);

  window.dispatchEvent(new CustomEvent('nle:clip-added', { detail: { file, clipId } }));
  window.dispatchEvent(new CustomEvent('nle:sequence-changed'));
}

// ── Transport buttons ──────────────────────────────────────────────────────

btnPlayPause.addEventListener('click', () => { playback?.toggle(); });
btnStepBack.addEventListener('click',  () => { playback?.stepBack(); });
btnStepFwd.addEventListener('click',   () => { playback?.stepForward(); });

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.code === 'Space') { e.preventDefault(); playback?.toggle(); }
  if (e.code === 'ArrowRight') { e.preventDefault(); playback?.stepForward(); }
  if (e.code === 'ArrowLeft')  { e.preventDefault(); playback?.stepBack(); }
  if (e.code === 'KeyV') window.dispatchEvent(new CustomEvent('nle:tool', { detail: 'select' }));
  if (e.code === 'KeyC') window.dispatchEvent(new CustomEvent('nle:tool', { detail: 'razor' }));
  if (e.code === 'KeyH') window.dispatchEvent(new CustomEvent('nle:tool', { detail: 'hand' }));
  if (e.code === 'Delete' || e.code === 'Backspace') {
    window.dispatchEvent(new CustomEvent('nle:delete-selected'));
  }
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('nle:save-project'));
  }
});

// ── Cross-module events ────────────────────────────────────────────────────

// Drag files onto Program Monitor
const programMonitor = document.getElementById('program-monitor');
programMonitor.addEventListener('dragover', (e) => e.preventDefault());
programMonitor.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) importFileToTimeline(file);
});

// Source monitor open (from timeline double-click or bin double-click)
window.addEventListener('nle:open-source', async (e) => {
  const path = e.detail?.sourcePath;
  if (!path || !pool.has(path)) return;
  window.dispatchEvent(new CustomEvent('nle:show-in-source', { detail: { sourcePath: path, pool } }));
});

// Expose engine + pool + seqId for MediaBin, SourceMonitor, ProjectManager, and Phase-4 modules
window._nle = {
  get engine() { return _engine; },
  get seqId()  { return _seqId; },
  get pool()   { return pool; },
  importFileToTimeline,

  /** Switch the active sequence to a newly-created one */
  switchSequence(newSeqId, fps_num, fps_den) {
    _seqId = newSeqId;
    seqFps = fps_num / (fps_den || 1);
    if (_timeline) {
      _timeline._seqId   = newSeqId;
      _timeline._fps_num = fps_num;
      _timeline._fps_den = fps_den;
      _timeline.render();
    }
    playback?.setSequenceId(newSeqId);
    playback?.setFps(seqFps);
    playback?.setDuration(_engine.get_sequence_duration?.(newSeqId) ?? 0);
    playback?.syncPlayheadPts(0);
    window.dispatchEvent(new CustomEvent('nle:sequence-changed'));
  },
};

// ── WASM pre-warm + timeline init ──────────────────────────────────────────

setStatus('Loading WASM module…');

const _warmup = new FrameServerBridge({
  onFrame: () => {}, onEnd: () => {}, onMetadata: () => {},
  onError: (msg) => {
    setStatus('WASM error: ' + msg, true);
    console.error('[warmup]', msg); // eslint-disable-line no-console
  },
});

_warmup.ready()
  .then(() => setStatus('Ready — drag video files here or use Import.'))
  .catch(() => {});

// Init timeline canvas, media bin, project manager, and Phase-4 modules after first paint
requestAnimationFrame(() => {
  initTimeline();
  initMediaBin();
  initProject();
  initSequenceCreator();
  initSequenceSettings();
});

// Save / Load project buttons
document.getElementById('btn-save-project')?.addEventListener('click', saveProject);
document.getElementById('btn-load-project')?.addEventListener('click', loadProject);

// Re-render timeline when a project is loaded
window.addEventListener('nle:project-loaded', () => {
  _timeline?.render();
  playback?.syncPlayheadPts(playback.playheadPts);
});

// ── Second vertical divider sync ───────────────────────────────────────────

function _syncSecondDivider() {
  const app      = document.getElementById('app');
  const divider2 = document.getElementById('divider-col-2');
  if (!divider2 || !app) return;

  let startX = 0, startW = 0;
  divider2.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    const val = getComputedStyle(app).getPropertyValue('--col-w').trim();
    startW = val.endsWith('px') ? parseFloat(val) : app.getBoundingClientRect().width * 0.5;
    divider2.classList.add('dragging');
    const onMove = (mv) => {
      const delta = mv.clientX - startX;
      const newW  = Math.max(120, Math.min(startW + delta, app.getBoundingClientRect().width - 120 - 4));
      app.style.setProperty('--col-w', newW + 'px');
    };
    const onUp = () => {
      divider2.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── JS mirror TimelineEngine (for UI without a WASM build) ────────────────
//
// A minimal subset of TimelineEngine sufficient for the app.
// The real WASM implementation is API-compatible with this.

function _buildJsMirrorEngine() {
  const NLE_TIME_BASE = 1_000_000;

  class Engine {
    constructor() {
      this._sequences = new Map();
      this._clipIndex = new Map();
      this._nextId = 1;
    }
    _makeId(prefix) { return prefix + '_' + (this._nextId++); }

    create_sequence(name, w, h, fps_num, fps_den) {
      const id = this._makeId('seq');
      this._sequences.set(id, {
        id, name, width: w, height: h, fps_num, fps_den,
        video_tracks: [], audio_tracks: [],
      });
      return id;
    }

    _getTrack(seqId, idx, isVideo) {
      const seq = this._sequences.get(seqId);
      if (!seq) return null;
      const arr = isVideo ? seq.video_tracks : seq.audio_tracks;
      while (arr.length <= idx) {
        const i = arr.length;
        arr.push({ id: this._makeId(isVideo ? 'vt' : 'at'),
                   name: (isVideo ? 'V' : 'A') + (i + 1),
                   type: isVideo ? 'video' : 'audio',
                   muted: false, locked: false, visible: true, clips: [] });
      }
      return arr[idx];
    }

    _hasOverlap(clips, inPts, outPts, excludeId = '') {
      return clips.some((c) => c.clip_id !== excludeId &&
                               inPts < c.timeline_out_pts && outPts > c.timeline_in_pts);
    }

    _findClip(clipId) {
      const loc = this._clipIndex.get(clipId);
      if (!loc) return {};
      const seq = this._sequences.get(loc.seqId);
      if (!seq) return {};
      const arr = loc.isVideo ? seq.video_tracks : seq.audio_tracks;
      const track = arr[loc.trackIdx];
      if (!track) return {};
      const clip = track.clips.find((c) => c.clip_id === clipId);
      return { clip, track, loc };
    }

    add_clip(seqId, source_path, track_index, timeline_in_pts, source_in_pts, source_out_pts) {
      if (source_out_pts <= source_in_pts) return '';
      const dur  = source_out_pts - source_in_pts;
      const tlOut = timeline_in_pts + dur;
      const track = this._getTrack(seqId, track_index, true);
      if (!track) return '';
      if (this._hasOverlap(track.clips, timeline_in_pts, tlOut)) return '';
      const id = this._makeId('c');
      track.clips.push({ clip_id: id, source_path, source_in_pts, source_out_pts,
                         timeline_in_pts, timeline_out_pts: tlOut, track_index });
      track.clips.sort((a, b) => a.timeline_in_pts - b.timeline_in_pts);
      const seq = this._sequences.get(seqId);
      const arr = seq.video_tracks;
      const tidx = arr.indexOf(track);
      this._clipIndex.set(id, { seqId, isVideo: true, trackIdx: tidx });
      return id;
    }

    move_clip(clipId, newTlIn, newTrackIdx) {
      const { clip, track, loc } = this._findClip(clipId);
      if (!clip) return false;
      const dur    = clip.source_out_pts - clip.source_in_pts;
      const newOut = newTlIn + dur;
      const seq    = this._sequences.get(loc.seqId);
      const newTrack = this._getTrack(loc.seqId, newTrackIdx, true);
      const excl   = newTrack === track ? clipId : '';
      if (this._hasOverlap(newTrack.clips, newTlIn, newOut, excl)) return false;
      if (newTrack !== track) {
        track.clips = track.clips.filter((c) => c.clip_id !== clipId);
        clip.timeline_in_pts  = newTlIn;
        clip.timeline_out_pts = newOut;
        clip.track_index      = newTrackIdx;
        newTrack.clips.push(clip);
        newTrack.clips.sort((a, b) => a.timeline_in_pts - b.timeline_in_pts);
        const arr = seq.video_tracks;
        loc.trackIdx = arr.indexOf(newTrack);
      } else {
        clip.timeline_in_pts  = newTlIn;
        clip.timeline_out_pts = newOut;
        clip.track_index      = newTrackIdx;
        track.clips.sort((a, b) => a.timeline_in_pts - b.timeline_in_pts);
      }
      return true;
    }

    trim_clip(clipId, newSrcIn, newSrcOut) {
      if (newSrcOut <= newSrcIn) return false;
      const { clip, track } = this._findClip(clipId);
      if (!clip) return false;
      const newDur = newSrcOut - newSrcIn;
      const newOut = clip.timeline_in_pts + newDur;
      if (this._hasOverlap(track.clips, clip.timeline_in_pts, newOut, clipId)) return false;
      clip.source_in_pts    = newSrcIn;
      clip.source_out_pts   = newSrcOut;
      clip.timeline_out_pts = newOut;
      return true;
    }

    split_clip(clipId, splitPts) {
      const { clip, track, loc } = this._findClip(clipId);
      if (!clip) return false;
      if (splitPts <= clip.timeline_in_pts || splitPts >= clip.timeline_out_pts) return false;
      const offset   = splitPts - clip.timeline_in_pts;
      const splitSrc = clip.source_in_pts + offset;
      const secondId = this._makeId('c');
      const second   = { clip_id: secondId, source_path: clip.source_path,
                         source_in_pts: splitSrc, source_out_pts: clip.source_out_pts,
                         timeline_in_pts: splitPts, timeline_out_pts: clip.timeline_out_pts,
                         track_index: clip.track_index };
      clip.source_out_pts   = splitSrc;
      clip.timeline_out_pts = splitPts;
      track.clips.push(second);
      track.clips.sort((a, b) => a.timeline_in_pts - b.timeline_in_pts);
      this._clipIndex.set(secondId, { ...loc });
      return true;
    }

    remove_clip(clipId) {
      const { clip, track } = this._findClip(clipId);
      if (!clip) return false;
      track.clips = track.clips.filter((c) => c.clip_id !== clipId);
      this._clipIndex.delete(clipId);
      return true;
    }

    resolve_frame(seqId, pts) {
      const seq = this._sequences.get(seqId);
      if (!seq) return null;
      for (let i = seq.video_tracks.length - 1; i >= 0; i--) {
        const t = seq.video_tracks[i];
        if (!t.visible || t.muted) continue;
        for (const c of t.clips) {
          if (pts >= c.timeline_in_pts && pts < c.timeline_out_pts) {
            return { source_path: c.source_path,
                     source_pts: c.source_in_pts + (pts - c.timeline_in_pts),
                     colorspace: c.colorspace ?? 5 };
          }
        }
      }
      return null;
    }

    get_sequence_duration(seqId) {
      const seq = this._sequences.get(seqId);
      if (!seq) return 0;
      let max = 0;
      for (const arr of [seq.video_tracks, seq.audio_tracks])
        for (const t of arr)
          for (const c of t.clips)
            if (c.timeline_out_pts > max) max = c.timeline_out_pts;
      return max;
    }

    get_sequence_json(seqId) {
      const seq = this._sequences.get(seqId);
      if (!seq) return '{}';
      return JSON.stringify(seq);
    }

    load_sequence_json(jsonStr) {
      try {
        const obj = JSON.parse(jsonStr);
        for (const [k, v] of this._clipIndex)
          if (v.seqId === obj.id) this._clipIndex.delete(k);
        const parseTrack = (tj) => ({
          id: tj.id, name: tj.name, muted: tj.muted ?? false,
          locked: tj.locked ?? false, visible: tj.visible ?? true,
          clips: (tj.clips ?? []).map((c) => ({ ...c })),
        });
        const seq = {
          ...obj,
          video_tracks: (obj.video_tracks ?? []).map((t, idx) => {
            const tr = parseTrack(t);
            for (const c of tr.clips) this._clipIndex.set(c.clip_id, { seqId: obj.id, isVideo: true, trackIdx: idx });
            return tr;
          }),
          audio_tracks: (obj.audio_tracks ?? []).map((t) => parseTrack(t)),
        };
        this._sequences.set(obj.id, seq);
        return true;
      } catch { return false; }
    }

    pts_from_frame(n, fps_num, fps_den) {
      if (fps_num <= 0) return 0;
      return Math.round(n * NLE_TIME_BASE * fps_den / fps_num);
    }

    frame_from_pts(pts, fps_num, fps_den) {
      if (fps_den <= 0) return 0;
      const half = Math.floor(NLE_TIME_BASE * fps_den / 2);
      return Math.floor((pts * fps_num + half) / (NLE_TIME_BASE * fps_den));
    }

    set_track_muted(seqId, trackIdx, v) {
      const t = this._getTrack(seqId, trackIdx, true);
      if (!t) return false; t.muted = v; return true;
    }
    set_track_visible(seqId, trackIdx, v) {
      const t = this._getTrack(seqId, trackIdx, true);
      if (!t) return false; t.visible = v; return true;
    }
    set_track_locked(seqId, trackIdx, v) {
      const t = this._getTrack(seqId, trackIdx, true);
      if (!t) return false; t.locked = v; return true;
    }
  }

  return new Engine();
}
