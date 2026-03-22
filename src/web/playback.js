import { FrameCache } from './frame_cache.js';
import { frameDurationUs, usToSecs } from './timecode.js';

/**
 * playback.js – Timeline playback engine.
 *
 * Drives the Program Monitor playhead using wall-clock timing via
 * requestAnimationFrame. Decoupled from transport UI — callers receive
 * state changes via callbacks.
 *
 * Design:
 *  - Wall-clock elapsed time (rAF timestamp) drives playhead advancement.
 *  - Delta is clamped to 2× frame duration so a backgrounded tab can't
 *    jump the playhead by seconds when it resumes.
 *  - Timeline is updated directly (_timeline._playhead + render()) during
 *    the rAF tick to avoid dispatching 'playhead-change', which would
 *    trigger the scrub listener and kill playback.
 *  - decodeAndDisplay is fire-and-forget (async internally but caller doesn't wait).
 *    If decode is slow the next tick's larger elapsed value naturally skips frames
 *    to stay in sync.
 */

import { AudioEngine } from './audio_engine.js';

// FFmpeg AVCOL_SPC_* values
const AVCOL_SPC_BT709 = 1;
const AVCOL_SPC_BT2020_NCL = 9;

// Player colorspace indices: 0=BT.601, 1=BT.709, 2=BT.2020
const COLORSPACE_BT601 = 0;
const COLORSPACE_BT709 = 1;
const COLORSPACE_BT2020 = 2;
const COLORSPACE_DEFAULT = COLORSPACE_BT601;

/**
 * Map FFmpeg AVCOL_SPC_* value to player colorspace index.
 * @param {number} avcol_spc
 * @returns {number}
 */
function mapFFmpegColorspace(avcol_spc) {
  if (avcol_spc === AVCOL_SPC_BT709) return COLORSPACE_BT709;
  if (avcol_spc === AVCOL_SPC_BT2020_NCL) return COLORSPACE_BT2020;
  return COLORSPACE_DEFAULT;
}

export class Playback {
  /**
   * @param {object}   opts.timeline            — Timeline instance
   * @param {object}   opts.engine              — TimelineEngine (JS mirror or WASM)
   * @param {object}   opts.pool                — FrameServerPool
   * @param {string}   opts.sequenceId          — current sequence ID
   * @param {number}   [opts.fps=24]            — frames per second
   * @param {number}   [opts.duration=0]        — sequence duration in µs
   * @param {function} [opts.onPlayStateChange] — called with (isPlaying: bool)
   * @param {function} [opts.onTimecodeUpdate]  — called with (pts: µs) each tick
   * @param {function} [opts.onFrameState]      — called with (hasFrame: bool)
   */
  constructor({
    timeline, engine, pool, sequenceId,
    fps = 24, duration = 0,
    onPlayStateChange = null,
    onTimecodeUpdate  = null,
    onFrameState      = null,
  }) {
    this._timeline    = timeline;
    this._engine      = engine;
    this._pool        = pool;
    this._player      = null;       // set via setProgramPlayer() when GL is ready
    this._seqId       = sequenceId;

    this._fps         = fps > 0 ? fps : 24;
    this._frameDurMs  = 1000 / this._fps;  // ms per frame
    this._duration    = duration;           // µs

    this._cache           = new FrameCache(30);
    this._prefetchInflight = false;

    this._isPlaying   = false;
    this._rafId       = null;
    this._lastFrameMs = null;
    this._playheadPts = 0;          // µs

    this._onStateChange = onPlayStateChange;
    this._onTimecode    = onTimecodeUpdate;
    this._onFrameState  = onFrameState;

    // Audio
    this._audio            = new AudioEngine();
    this._audioInitialized = false;
    this._lastAudioPts     = -1;

    // Caches to reduce per-tick resolve_frame() calls and colorspace lookups
    this._lastResolvedSourcePath = null;  // cached source_path for colorspace lookup
    this._lastColorspace         = 0;     // cached colorspace value
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get isPlaying()       { return this._isPlaying; }
  get playheadPts()     { return this._playheadPts; }
  get _frameDurationUs() { return Math.round((1 / this._fps) * 1e6); }

  // ── Configuration (call when sequence settings change) ────────────────────

  setFps(fps) {
    this._fps        = fps > 0 ? fps : 24;
    this._frameDurMs = 1000 / this._fps;
  }

  setDuration(durMicros) { this._duration = durMicros; }
  setSequenceId(id)      { this._seqId    = id; }
  setProgramPlayer(p)    { this._player   = p; }

  // ── Transport ─────────────────────────────────────────────────────────────

  play() {
    if (this._isPlaying) return;
    this._isPlaying   = true;
    this._lastFrameMs = null;
    // Audio init must happen inside a user-gesture handler; play() is one.
    if (!this._audioInitialized) {
      this._audio.init().then(() => { this._audio.start(); });
      this._audioInitialized = true;
    } else {
      this._audio.start();
    }
    this._rafId = requestAnimationFrame((now) => this._tick(now));
    this._onStateChange?.(true);
  }

  pause() {
    if (!this._isPlaying) return;
    this._isPlaying        = false;
    this._lastFrameMs      = null;
    this._prefetchInflight = false;
    this._cache.clear();
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._audio.stop();
    this._onStateChange?.(false);
  }

  toggle() {
    this._isPlaying ? this.pause() : this.play();
  }

  stepForward() {
    this.pause();
    this.syncPlayheadPts(Math.min(
      this._playheadPts + this._frameDurationUs,
      this._duration > 0 ? this._duration : this._playheadPts + this._frameDurationUs,
    ));
  }

  stepBack() {
    this.pause();
    this.syncPlayheadPts(Math.max(this._playheadPts - this._frameDurationUs, 0));
  }

  /**
   * Sync playhead from an external source (user scrub, project load, etc.).
   * Updates internal state and decodes the frame at pts immediately.
   * Does NOT fire the timeline's 'playhead-change' event, preventing loops.
   *
   * @param {number} pts — target position in µs
   */
  syncPlayheadPts(pts) {
    this._playheadPts      = pts;
    this._prefetchInflight = false;
    this._cache.clear();
    this._lastResolvedSourcePath = null;  // invalidate colorspace cache on external seek
    this._updateTimelineDisplay(pts);
    this._onTimecode?.(pts);
    this._decodeAndDisplay(pts);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Update timeline display without firing 'playhead-change' event.
   * Directly mutates timeline internal state to avoid triggering scrub listener.
   * @param {number} pts — playhead position in µs
   */
  _updateTimelineDisplay(pts) {
    if (this._timeline) {
      this._timeline._playhead = pts;
      this._timeline.render();
    }
  }

  // ── Internal rAF loop ─────────────────────────────────────────────────────

  _tick(now) {
    if (!this._isPlaying) return;

    // Elapsed since last tick.  Cap at 2× frame duration so a backgrounded
    // tab can't jump the playhead by seconds when it comes back.
    const elapsed = this._lastFrameMs !== null
      ? Math.min(now - this._lastFrameMs, this._frameDurMs * 2)
      : 0;
    this._lastFrameMs = now;

    // Advance playhead (ms → µs conversion)
    this._playheadPts += elapsed * 1000;
    if (this._duration > 0) this._playheadPts = Math.min(this._playheadPts, this._duration);

    // Resolve frame once per tick and reuse for both display and audio.
    // This eliminates 2 redundant resolve_frame() tree walks.
    const resolved = this._engine && this._seqId
      ? this._engine.resolve_frame(this._seqId, this._playheadPts)
      : null;

    // Update timeline display without firing 'playhead-change'
    this._updateTimelineDisplay(this._playheadPts);
    this._onTimecode?.(this._playheadPts);
    this._decodeAndDisplay(this._playheadPts, resolved);
    this._schedulePrefetch(this._playheadPts);
    this._decodeAndPushAudio(this._playheadPts, resolved);

    // Stop at end of sequence
    if (this._duration > 0 && this._playheadPts >= this._duration) {
      this._isPlaying   = false;
      this._rafId       = null;
      this._lastFrameMs = null;
      this._onStateChange?.(false);
      return;
    }

    this._rafId = requestAnimationFrame((now2) => this._tick(now2));
  }

  _decodeAndPushAudio(pts, resolved = null) {
    try {
      if (!this._pool) return;
      if (!resolved) {
        if (!this._engine || !this._seqId) return;
        resolved = this._engine.resolve_frame(this._seqId, pts);
      }
      if (!resolved?.source_path) return;
      const targetSecs = usToSecs(pts);
      // Skip if we already decoded audio very recently (< 80 ms lookahead gap)
      if (Math.abs(targetSecs - this._lastAudioPts) < 0.08) return;
      this._lastAudioPts = targetSecs;
      const samples = this._pool.decodeAudioAt(resolved.source_path, targetSecs, 8192);
      if (samples?.length > 0) this._audio.pushSamples(samples);
    } catch (_e) { /* non-fatal — video keeps playing */ }
  }

  _decodeAndDisplay(pts, resolved = null) {
    if (!this._pool) return;
    try {
      if (!resolved) {
        if (!this._engine || !this._seqId) return;
        resolved = this._engine.resolve_frame(this._seqId, pts);
      }
      if (!resolved || !resolved.source_path) { this._onFrameState?.(false); return; }

      // Cache colorspace lookup: only look up when source changes
      let colorspace = this._lastColorspace;
      if (resolved.source_path !== this._lastResolvedSourcePath) {
        this._lastResolvedSourcePath = resolved.source_path;
        const info = this._pool.getInfo(resolved.source_path);
        colorspace = mapFFmpegColorspace(info?.colorspace ?? AVCOL_SPC_BT709);
        this._lastColorspace = colorspace;
      }

      let frame = this._cache.get(resolved.source_path, resolved.source_pts);
      if (!frame) {
        // source_pts is always in NLE timebase (µs) — both the JS mirror and the
        // C++ engine (which defaults to tb_den=1000000) store clip PTS in µs.
        frame = this._pool.decodeFrameAt(resolved.source_path, usToSecs(resolved.source_pts));
        if (frame) this._cache.set(resolved.source_path, resolved.source_pts, frame);
      }

      if (frame && this._player) {
        this._player.drawFrame({ ...frame, colorspace });
        this._onFrameState?.(true);
      }
    } catch (e) {
      console.warn('[Playback] decode error:', e); // eslint-disable-line no-console
    }
  }

  _schedulePrefetch(currentPts, lookahead = 5) {
    if (this._prefetchInflight) return;
    this._prefetchInflight = true;

    const frameDuration = frameDurationUs(this._fps);

    (async () => {
      try {
        for (let i = 1; i <= lookahead; i++) {
          if (!this._isPlaying) break;
          const futurePts = currentPts + i * frameDuration;
          if (futurePts > this._duration) break;

          const resolved = this._engine.resolve_frame(this._seqId, futurePts);
          if (!resolved || !resolved.source_path) continue;
          if (this._cache.has(resolved.source_path, resolved.source_pts)) continue;

          const frame = await this._pool.decodeFrameAt(
            resolved.source_path,
            usToSecs(resolved.source_pts)
          );
          if (frame) this._cache.set(resolved.source_path, resolved.source_pts, frame);
        }
      } catch (e) {
        console.warn('[Prefetch] error:', e); // eslint-disable-line no-console
      } finally {
        this._prefetchInflight = false;
      }
    })();
  }
}
