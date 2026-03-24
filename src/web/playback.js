import { FrameCache } from './frame_cache.js';
import { CompositionCache } from './composition_cache.js';
import { DiskFrameCache } from './disk_cache.js';
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
 *  - _tick() ONLY reads from the frame cache and draws — it never calls the
 *    WASM decoder synchronously, which was causing [Violation] rAF handler
 *    took <N>ms on 4K frames.
 *  - _decodeLoop() runs as a fire-and-forget async loop alongside the rAF,
 *    prefetching frames into the cache between rAF ticks using setTimeout(4)
 *    yields so the main thread stays responsive.
 *  - Timeline canvas is repainted every other rAF tick (~30 fps) rather than
 *    every tick (~60 fps), halving canvas 2D overdraw cost.
 *  - Timeline is updated directly (_timeline._playhead + render()) during the
 *    rAF tick to avoid dispatching 'playhead-change', which would trigger the
 *    scrub listener and kill playback.
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

/**
 * Compute how many decoded frames to hold in the cache, bounded by a 256 MB
 * memory budget.  For 4K (3840×2160 YUV420p ≈ 12 MB/frame) this yields ~21
 * frames; for 1080p (~3 MB/frame) the cap of 30 applies.
 *
 * @param {number} width
 * @param {number} height
 * @returns {number} cache capacity in frames
 */
function computeCacheSize(width, height) {
  const frameMB  = (width * height * 1.5) / (1024 * 1024); // YUV420p bytes → MB
  const budgetMB = 256;
  return Math.max(4, Math.min(30, Math.floor(budgetMB / frameMB)));
}

export class Playback {
  /**
   * @param {object}   opts.timeline            — Timeline instance
   * @param {object}   opts.engine              — TimelineEngine (JS mirror or WASM)
   * @param {object}   opts.pool                — FrameServerPool
   * @param {string}   opts.sequenceId          — current sequence ID
   * @param {number}   [opts.fps=24]            — frames per second
   * @param {number}   [opts.duration=0]        — sequence duration in µs
   * @param {number}   [opts.width=1920]        — sequence width (for cache sizing)
   * @param {number}   [opts.height=1080]       — sequence height (for cache sizing)
   * @param {function} [opts.onPlayStateChange] — called with (isPlaying: bool)
   * @param {function} [opts.onTimecodeUpdate]  — called with (pts: µs) each tick
   * @param {function} [opts.onFrameState]      — called with (hasFrame: bool)
   */
  constructor({
    timeline, engine, pool, sequenceId,
    fps = 24, duration = 0,
    width = 1920, height = 1080,
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

    // Sequence dimensions for true-size rendering
    this._seqW        = width;
    this._seqH        = height;

    this._cache = new FrameCache(computeCacheSize(width, height));
    this._compositionCache = new CompositionCache(5);
    this._diskCache = new DiskFrameCache();
    this._diskCache._openDB().catch(() => {}); // warm up IDB connection on startup

    this._isPlaying   = false;
    this._rafId       = null;
    this._lastFrameMs = null;
    this._playheadPts = 0;          // µs
    this._tickCount   = 0;          // for timeline render throttle

    this._onStateChange = onPlayStateChange;
    this._onTimecode    = onTimecodeUpdate;
    this._onFrameState  = onFrameState;

    // Audio
    this._audio            = new AudioEngine();
    this._audioInitialized = false;
    this._lastAudioPts     = -1;

    // Cache colorspace lookup: only re-query when source file changes
    this._lastResolvedSourcePath = null;
    this._lastColorspace         = 0;
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
  setSequenceSize(w, h)  { this._seqW = w; this._seqH = h; this._player?.setSequenceMode(w, h); }
  setProgramPlayer(p)    {
    this._player   = p;
    if (p) p.setSequenceMode(this._seqW, this._seqH);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  play() {
    if (this._isPlaying) return;
    if (!this._player) {
      console.warn('[Playback] play() called but _player is null — frames will not draw until setProgramPlayer() is called'); // eslint-disable-line no-console
    }
    this._isPlaying   = true;
    this._lastFrameMs = null;
    this._tickCount   = 0;
    // Audio init must happen inside a user-gesture handler; play() is one.
    if (!this._audioInitialized) {
      this._audio.init().then(() => { this._audio.start(); });
      this._audioInitialized = true;
    } else {
      this._audio.start();
    }
    this._rafId = requestAnimationFrame((now) => this._tick(now));
    this._decodeLoop(); // fire-and-forget async prefetch loop
    this._onStateChange?.(true);
  }

  pause() {
    if (!this._isPlaying) return;
    this._isPlaying   = false;   // also stops _decodeLoop
    this._lastFrameMs = null;
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
    this._playheadPts            = pts;
    this._lastResolvedSourcePath = null;  // invalidate colorspace cache on seek
    this._updateTimelineDisplay(pts);
    this._onTimecode?.(pts);
    // _decodeAndDisplay is async; fire-and-forget is fine — the frame draws
    // when ready and the UI stays responsive throughout.
    this._decodeAndDisplay(pts);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Compute transform (scale + offset) for a clip based on its native dimensions.
   * @param {string} sourcePath
   * @param {object} resolved — result from resolve_all_frames with posX, posY, userScale
   * @returns {object} { scaleX, scaleY, offsetX, offsetY }
   */
  _computeTransform(sourcePath, resolved) {
    const info   = this._pool.getInfo(sourcePath);
    const clipW  = info?.width  ?? this._seqW;
    const clipH  = info?.height ?? this._seqH;
    const scaleX = (clipW / this._seqW) * (resolved.userScale ?? 1.0);
    const scaleY = (clipH / this._seqH) * (resolved.userScale ?? 1.0);
    // Position in NDC (posX/posY are pixels from sequence center; NDC Y is inverted)
    const offsetX =  (resolved.posX ?? 0) / (this._seqW / 2);
    const offsetY = -(resolved.posY ?? 0) / (this._seqH / 2);
    return { scaleX, scaleY, offsetX, offsetY };
  }

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

  // ── rAF tick — ONLY cache lookup + draw, NO decode ───────────────────────

  _tick(now) {
    if (!this._isPlaying) return;

    // Elapsed since last tick. Cap at 2× frame duration so a backgrounded
    // tab can't jump the playhead by seconds when it comes back.
    const elapsed = this._lastFrameMs !== null
      ? Math.min(now - this._lastFrameMs, this._frameDurMs * 2)
      : 0;
    this._lastFrameMs = now;

    // Advance playhead (ms → µs conversion)
    this._playheadPts += elapsed * 1000;
    if (this._duration > 0) this._playheadPts = Math.min(this._playheadPts, this._duration);

    // Resolve all clips under the playhead (bottom-to-top compositing order)
    const allResolved = this._engine && this._seqId
      ? this._engine.resolve_all_frames(this._seqId, this._playheadPts)
      : [];

    // ── L1 Composition Cache check ────────────────────────────────────────
    if (this._engine && this._seqId && this._player) {
      const editGen = this._engine.get_edit_generation?.(this._seqId) ?? 0;
      const frameDuration = frameDurationUs(this._fps);
      const frameIndex = Math.round(this._playheadPts / frameDuration);
      const l1Hit = this._compositionCache.get(this._seqId, editGen, frameIndex);
      if (l1Hit) {
        this._player.drawFrameFull(l1Hit);
        this._onFrameState?.(true);
        this._onTimecode?.(this._playheadPts);
        // Still update timeline and audio on L1 hit
        this._tickCount++;
        if (this._tickCount % 2 === 0) {
          this._updateTimelineDisplay(this._playheadPts);
        } else {
          if (this._timeline) this._timeline._playhead = this._playheadPts;
        }
        const topClip = this._engine.resolve_frame(this._seqId, this._playheadPts);
        setTimeout(() => this._decodeAndPushAudio(this._playheadPts, topClip), 0);
        if (this._duration > 0 && this._playheadPts >= this._duration) {
          this._isPlaying   = false;
          this._rafId       = null;
          this._lastFrameMs = null;
          this._onStateChange?.(false);
          return;
        }
        this._rafId = requestAnimationFrame((now2) => this._tick(now2));
        return; // Skip L2 cache path
      }
    }

    // ── Draw (cache-first; trigger async decode on miss) ──────────────────
    if (allResolved.length === 0) {
      // No clips under playhead — clear canvas to black
      if (this._player) this._player.clear();
      this._onFrameState?.(false);
    } else if (this._player) {
      // Check if all clips are in cache
      const allCached = allResolved.every((resolved) => {
        const sourcePts = Math.round(resolved.source_pts);
        return this._cache.get(resolved.source_path, sourcePts) !== null;
      });

      if (allCached) {
        // All clips cached — composite them
        this._player.clear();
        allResolved.forEach((resolved) => {
          const sourcePts = Math.round(resolved.source_pts);
          const frame = this._cache.get(resolved.source_path, sourcePts);
          if (frame) {
            const transform = this._computeTransform(resolved.source_path, resolved);
            this._player.drawFrameAt({ ...frame, colorspace: mapFFmpegColorspace(this._pool.getInfo(resolved.source_path)?.colorspace ?? AVCOL_SPC_BT709) }, { ...transform, opacity: resolved.opacity ?? 1.0 });
          }
        });
        this._onFrameState?.(true);

        // ── Capture composited canvas for L1 cache (async, non-blocking) ────
        if (this._engine && this._seqId) {
          const editGen = this._engine.get_edit_generation?.(this._seqId) ?? 0;
          const frameDuration = frameDurationUs(this._fps);
          const frameIndex = Math.round(this._playheadPts / frameDuration);
          const w = this._seqW, h = this._seqH;
          createImageBitmap(this._player.canvas).then((bm) => {
            this._compositionCache.set(this._seqId, editGen, frameIndex, { bitmap: bm, width: w, height: h });
          }).catch(() => {}); // Non-fatal if capture fails
        }
      } else {
        // Cache miss — fire async decode
        this._decodeAndDisplay(this._playheadPts, allResolved);
      }
    }

    // ── Timeline: repaint every other tick (~30 fps) ──────────────────────
    this._tickCount++;
    if (this._tickCount % 2 === 0) {
      this._updateTimelineDisplay(this._playheadPts);
    } else {
      // Still advance the internal playhead so the next full repaint is right.
      if (this._timeline) this._timeline._playhead = this._playheadPts;
    }
    this._onTimecode?.(this._playheadPts);

    // ── Audio (throttled inside _decodeAndPushAudio) ──────────────────────
    // Use the top-priority clip for audio (first entry when resolve_frame is called)
    const topClip = this._engine && this._seqId
      ? this._engine.resolve_frame(this._seqId, this._playheadPts)
      : null;
    setTimeout(() => this._decodeAndPushAudio(this._playheadPts, topClip), 0);

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

  // ── Async decode loop — runs between rAF ticks ───────────────────────────

  /**
   * Continuously prefetch frames ahead of the playhead into the cache.
   * Runs as a fire-and-forget async loop alongside the rAF loop.  Yields
   * every 4 ms via setTimeout so the main thread stays unblocked between
   * rAF callbacks.
   *
   * When the hardware WebCodecs path is active, decodeFrameAt() returns
   * { videoFrame, width, height }.  We convert VideoFrame → ImageBitmap here
   * so the rAF tick can draw it synchronously from cache without holding an
   * open VideoFrame reference.
   *
   * The loop terminates as soon as _isPlaying becomes false.
   */
  async _decodeLoop() {
    const lookahead = 5;

    while (this._isPlaying) {
      const pts           = this._playheadPts;
      const frameDuration = frameDurationUs(this._fps);

      for (let i = 0; i <= lookahead; i++) {
        if (!this._isPlaying) break;

        const targetPts = pts + i * frameDuration;
        if (this._duration > 0 && targetPts > this._duration) break;

        // Decode all clips at this pts
        const allResolved = this._engine?.resolve_all_frames(this._seqId, targetPts) ?? [];
        for (const resolved of allResolved) {
          const sourcePts = Math.round(resolved.source_pts);
          if (this._cache.has(resolved.source_path, sourcePts)) continue;

          // ── L3 check on L2 miss ────────────────────────────────────────────
          let cached = await this._diskCache.lookup(resolved.source_path, sourcePts);
          if (cached) {
            this._cache.set(resolved.source_path, sourcePts, cached);
            continue; // L3 hit — skip WASM decode
          }

          // decodeFrameAt is async on both the WebCodecs and WASM paths.
          // Wrap in try/catch: any decode error must NOT kill the loop — a
          // single bad frame should be skipped, not crash the entire prefetch.
          let frameData;
          try {
            frameData = await this._pool.decodeFrameAt(
              resolved.source_path,
              usToSecs(resolved.source_pts)
            );
          } catch (e) {
            console.warn('[Playback] _decodeLoop decode error (skipping frame):', e); // eslint-disable-line no-console
            continue;
          }
          if (!frameData) continue;

          try {
            cached = await _toImageBitmapIfNeeded(frameData);
          } catch (e) {
            console.warn('[Playback] _decodeLoop bitmap conversion error (skipping frame):', e); // eslint-disable-line no-console
            continue;
          }
          if (cached) {
            this._cache.set(resolved.source_path, sourcePts, cached);
            // Store in L3 async (fire-and-forget, only for bitmap frames)
            if (cached.bitmap) {
              this._diskCache.store(resolved.source_path, sourcePts, cached.bitmap, cached.width, cached.height)
                .catch(() => {}); // non-fatal
            }
          }
        }
      }

      // Yield to the event loop between decode rounds so rAF callbacks
      // and other microtasks are not starved.
      await new Promise((r) => setTimeout(r, 4));
    }
  }

  // ── Audio decode (throttled, stays in tick for low latency) ──────────────

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

  // ── Async decode used for scrub / step (not in rAF) ─────────────────────

  async _decodeAndDisplay(pts, allResolved = null) {
    if (!this._pool) return;
    try {
      if (!allResolved) {
        if (!this._engine || !this._seqId) return;
        allResolved = this._engine.resolve_all_frames(this._seqId, pts);
      }
      if (!Array.isArray(allResolved) || allResolved.length === 0) {
        if (this._player) this._player.clear();
        this._onFrameState?.(false);
        return;
      }

      // ── L1 Composition Cache check before decode ──────────────────────────
      if (this._engine && this._seqId && this._player) {
        const editGen = this._engine.get_edit_generation?.(this._seqId) ?? 0;
        const frameDuration = frameDurationUs(this._fps);
        const frameIndex = Math.round(pts / frameDuration);
        const l1Hit = this._compositionCache.get(this._seqId, editGen, frameIndex);
        if (l1Hit) {
          this._player.drawFrameFull(l1Hit);
          this._onFrameState?.(true);
          return; // Skip decode and composite
        }
      }

      // Decode and composite all clips
      if (this._player) this._player.clear();

      for (const resolved of allResolved) {
        const sourcePts = Math.round(resolved.source_pts);
        let frame = this._cache.get(resolved.source_path, sourcePts);
        if (!frame) {
          // ── L3 check on L2 miss ────────────────────────────────────────────
          frame = await this._diskCache.lookup(resolved.source_path, sourcePts);
          if (frame) {
            this._cache.set(resolved.source_path, sourcePts, frame);
          } else {
            // L2 + L3 miss → WASM decode
            const frameData = await this._pool.decodeFrameAt(
              resolved.source_path,
              usToSecs(resolved.source_pts)
            );
            frame = await _toImageBitmapIfNeeded(frameData);
            if (frame) {
              this._cache.set(resolved.source_path, sourcePts, frame);
              // Store in L3 async (fire-and-forget, only for bitmap frames)
              if (frame.bitmap) {
                this._diskCache.store(resolved.source_path, sourcePts, frame.bitmap, frame.width, frame.height)
                  .catch(() => {}); // non-fatal
              }
            }
          }
        }

        if (frame && this._player) {
          const info = this._pool.getInfo(resolved.source_path);
          const colorspace = mapFFmpegColorspace(info?.colorspace ?? AVCOL_SPC_BT709);
          const transform = this._computeTransform(resolved.source_path, resolved);
          this._player.drawFrameAt({ ...frame, colorspace }, { ...transform, opacity: resolved.opacity ?? 1.0 });
        }
      }

      // ── Capture composited canvas for L1 cache (async, non-blocking) ────
      if (this._engine && this._seqId && this._player) {
        const editGen = this._engine.get_edit_generation?.(this._seqId) ?? 0;
        const frameDuration = frameDurationUs(this._fps);
        const frameIndex = Math.round(pts / frameDuration);
        const w = this._seqW, h = this._seqH;
        createImageBitmap(this._player.canvas).then((bm) => {
          this._compositionCache.set(this._seqId, editGen, frameIndex, { bitmap: bm, width: w, height: h });
        }).catch(() => {}); // Non-fatal if capture fails
      }

      this._onFrameState?.(true);
    } catch (e) {
      console.warn('[Playback] decode error:', e); // eslint-disable-line no-console
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helper
// ---------------------------------------------------------------------------

/**
 * If frameData is a WebCodecs result ({ videoFrame, width, height }), convert
 * the VideoFrame to an ImageBitmap (closes the VideoFrame to free GPU memory)
 * and return { bitmap, width, height } suitable for Player._drawBitmap().
 *
 * If frameData is already a plain YUV frame object, return it unchanged.
 *
 * @param {object|null} frameData
 * @returns {Promise<object|null>}
 */
async function _toImageBitmapIfNeeded(frameData) {
  if (!frameData?.videoFrame) return frameData;   // YUV path — no conversion needed
  const { videoFrame, width, height } = frameData;
  try {
    const bitmap = await createImageBitmap(videoFrame);
    return { bitmap, width, height };
  } finally {
    // Always free the VideoFrame regardless of whether createImageBitmap succeeded.
    videoFrame.close();
  }
}
