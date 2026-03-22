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
 *  - decodeAndDisplay is synchronous (FrameServerPool.decodeFrameAt is
 *    a synchronous WASM call). If decode is slow the next tick's larger
 *    elapsed value naturally skips frames to stay in sync.
 */

/**
 * Map FFmpeg AVCOL_SPC_* value to player colorspace index.
 * 0 = BT.601, 1 = BT.709, 2 = BT.2020
 * @param {number} avcol_spc
 * @returns {number}
 */
function mapFFmpegColorspace(avcol_spc) {
  if (avcol_spc === 1) return 1;   // AVCOL_SPC_BT709
  if (avcol_spc === 9) return 2;   // AVCOL_SPC_BT2020_NCL
  return 0;                         // BT.601 default
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

    this._isPlaying   = false;
    this._rafId       = null;
    this._lastFrameMs = null;
    this._playheadPts = 0;          // µs

    this._onStateChange = onPlayStateChange;
    this._onTimecode    = onTimecodeUpdate;
    this._onFrameState  = onFrameState;
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get isPlaying()   { return this._isPlaying; }
  get playheadPts() { return this._playheadPts; }

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
    this._rafId = requestAnimationFrame((now) => this._tick(now));
    this._onStateChange?.(true);
  }

  pause() {
    if (!this._isPlaying) return;
    this._isPlaying   = false;
    this._lastFrameMs = null;
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._onStateChange?.(false);
  }

  toggle() {
    this._isPlaying ? this.pause() : this.play();
  }

  stepForward() {
    this.pause();
    const step = Math.round((1 / this._fps) * 1e6);
    this.syncPlayheadPts(Math.min(
      this._playheadPts + step,
      this._duration > 0 ? this._duration : this._playheadPts + step,
    ));
  }

  stepBack() {
    this.pause();
    const step = Math.round((1 / this._fps) * 1e6);
    this.syncPlayheadPts(Math.max(this._playheadPts - step, 0));
  }

  /**
   * Sync playhead from an external source (user scrub, project load, etc.).
   * Updates internal state and decodes the frame at pts immediately.
   * Does NOT fire the timeline's 'playhead-change' event, preventing loops.
   *
   * @param {number} pts — target position in µs
   */
  syncPlayheadPts(pts) {
    this._playheadPts = pts;
    if (this._timeline) { this._timeline._playhead = pts; this._timeline.render(); }
    this._onTimecode?.(pts);
    this._decodeAndDisplay(pts);
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

    // Update timeline display without firing 'playhead-change'
    if (this._timeline) { this._timeline._playhead = this._playheadPts; this._timeline.render(); }
    this._onTimecode?.(this._playheadPts);
    this._decodeAndDisplay(this._playheadPts);

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

  _decodeAndDisplay(pts) {
    if (!this._engine || !this._seqId || !this._pool) return;
    const resolved = this._engine.resolve_frame(this._seqId, pts);
    if (!resolved) { this._onFrameState?.(false); return; }
    const info = this._pool.getInfo(resolved.source_path);
    const sourceSecs = resolved.source_pts / (info?.tb_den ?? 1000000);
    const frame = this._pool.decodeFrameAt(resolved.source_path, sourceSecs);
    if (frame && this._player) {
      const colorspace = mapFFmpegColorspace(info?.colorspace ?? 5);
      this._player.drawFrame({ ...frame, colorspace });
      this._onFrameState?.(true);
    }
  }
}
