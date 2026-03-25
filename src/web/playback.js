import { CompositionCache } from './composition_cache.js';
import { frameDurationUs, usToSecs } from './timecode.js';

/**
 * playback.js – Timeline playback engine (professional NLE architecture).
 *
 * Architecture:
 *  - _decodeLoop() is the ONLY path that calls decode. It runs as an
 *    independent async loop, staying _prefetchAheadMs ahead of the playhead.
 *    It NEVER synchronises with _tick().
 *  - _tick() (rAF) ONLY reads from the frame cache. On a cache miss it holds
 *    the last displayed frame — no black canvas, no clear(), no decode.
 *  - play() awaits a pre-roll of PRE_ROLL_FRAMES before starting the rAF
 *    loop so the cache is warm on the very first tick.
 *  - Frame cache lookup uses nearest-frame selection: find the cached entry
 *    whose key is closest to the target pts (within ±1 frame duration).
 *  - decodeLoop uses decodeNextFrame (sequential) for the prefetch path;
 *    decodeFrameAt (random access) is only used for pre-roll / seek.
 *  - LRU eviction: max 30 frames per source; evict furthest behind playhead.
 */

import { AudioEngine } from './audio_engine.js';

// FFmpeg AVCOL_SPC_* values
const AVCOL_SPC_BT709    = 1;
const AVCOL_SPC_BT2020_NCL = 9;

// Player colorspace indices: 0=BT.601, 1=BT.709, 2=BT.2020
const COLORSPACE_BT601   = 0;
const COLORSPACE_BT709   = 1;
const COLORSPACE_BT2020  = 2;
const COLORSPACE_DEFAULT = COLORSPACE_BT601;

function mapFFmpegColorspace(avcol_spc) {
  if (avcol_spc === AVCOL_SPC_BT709)    return COLORSPACE_BT709;
  if (avcol_spc === AVCOL_SPC_BT2020_NCL) return COLORSPACE_BT2020;
  return COLORSPACE_DEFAULT;
}

const MAX_CACHE_FRAMES  = 30;     // per-source LRU cap
const PREFETCH_AHEAD_MS = 3000;  // how far ahead _decodeLoop stays (ms)
const PRE_ROLL_FRAMES   = 8;      // frames decoded before rAF starts

export class Playback {
  /**
   * @param {object}   opts.timeline            — Timeline instance
   * @param {object}   opts.engine              — TimelineEngine (JS mirror or WASM)
   * @param {object}   opts.pool                — FrameServerPool
   * @param {string}   opts.sequenceId          — current sequence ID
   * @param {number}   [opts.fps=24]            — frames per second
   * @param {number}   [opts.duration=0]        — sequence duration in µs
   * @param {number}   [opts.width=1920]        — sequence width
   * @param {number}   [opts.height=1080]       — sequence height
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
    this._timeline = timeline;
    this._engine   = engine;
    this._pool     = pool;
    this._player   = null;       // set via setProgramPlayer() when GL is ready
    this._seqId    = sequenceId;

    this._fps        = fps > 0 ? fps : 24;
    this._frameDurMs = 1000 / this._fps;
    this._duration   = duration;   // µs

    this._seqW = width;
    this._seqH = height;

    // L1: composited frame cache (sequence + edit_gen + frame_index → bitmap)
    this._compositionCache = new CompositionCache(5);

    // L2: per-source frame cache.
    // Map<sourcePath, Map<roundedPts, {bitmap, pts, addedAt}>>
    // Keyed by Math.round(source_pts µs). Lookup uses nearest-frame selection.
    this._frameCache = new Map();

    // Last successfully drawn frame — held on cache miss to suppress black flash.
    this._lastDisplayedBitmap = null;

    this._isPlaying   = false;
    this._rafId       = null;
    this._lastFrameMs = null;
    this._playheadPts = 0;   // µs
    this._tickCount   = 0;   // for timeline render throttle

    // Decode loop state
    this._nextDecodePts   = 0;               // µs — next position to decode
    this._prefetchAheadMs = PREFETCH_AHEAD_MS;

    this._onStateChange = onPlayStateChange;
    this._onTimecode    = onTimecodeUpdate;
    this._onFrameState  = onFrameState;

    // Audio
    this._audio            = new AudioEngine();
    this._audioInitialized = false;
    this._lastAudioPts     = -1;
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get isPlaying()        { return this._isPlaying; }
  get playheadPts()      { return this._playheadPts; }
  get _frameDurationUs() { return Math.round((1 / this._fps) * 1e6); }

  // ── Configuration ─────────────────────────────────────────────────────────

  setFps(fps) {
    this._fps        = fps > 0 ? fps : 24;
    this._frameDurMs = 1000 / this._fps;
  }

  setDuration(durMicros) { this._duration = durMicros; }
  setSequenceId(id)      { this._seqId    = id; }

  setSequenceSize(w, h) {
    this._seqW = w;
    this._seqH = h;
    this._player?.setSequenceMode(w, h);
  }

  setProgramPlayer(p) {
    this._player = p;
    if (p) p.setSequenceMode(this._seqW, this._seqH);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /**
   * Start playback. Awaits a pre-roll before the rAF loop begins so the
   * cache is warm on the very first tick. Returns a Promise.
   */
  async play() {
    if (this._isPlaying) return;
    if (!this._player) {
      console.warn('[Playback] play() called but _player is null — frames will not draw until setProgramPlayer() is called'); // eslint-disable-line no-console
    }

    this._isPlaying = true;
    this._onStateChange?.(true);

    // Audio init must happen inside a user-gesture handler; play() is one.
    if (!this._audioInitialized) {
      this._audio.init().then(() => { this._audio.start(); });
      this._audioInitialized = true;
    } else {
      this._audio.start();
    }

    // Flush stale frames and fill the cache before the rAF loop starts.
    this._flushCache();
    await this._preRoll(this._playheadPts, PRE_ROLL_FRAMES);

    // Guard: user may have paused during pre-roll.
    if (!this._isPlaying) return;

    this._lastFrameMs = null;
    this._tickCount   = 0;
    this._rafId = requestAnimationFrame((now) => this._tick(now));
    this._decodeLoop();  // fire-and-forget async prefetch loop
  }

  pause() {
    if (!this._isPlaying) return;
    this._isPlaying   = false;
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
   * @param {number} pts — target position in µs
   */
  syncPlayheadPts(pts) {
    this._playheadPts   = pts;
    this._nextDecodePts = pts;
    this._updateTimelineDisplay(pts);
    this._onTimecode?.(pts);
    // Fire-and-forget: old frame stays visible until new one is ready.
    this._decodeAndDisplay(pts);
  }

  /**
   * Release all resources. Call when the Playback instance is no longer needed.
   */
  dispose() {
    this.pause();
    this._flushCache();
    this._lastDisplayedBitmap = null;
  }

  // ── Frame cache ───────────────────────────────────────────────────────────

  /** Close all cached bitmaps and clear all source maps. */
  _flushCache() {
    for (const map of this._frameCache.values()) {
      for (const entry of map.values()) {
        entry?.bitmap?.close?.();
      }
    }
    this._frameCache.clear();
    this._lastDisplayedBitmap = null;
  }

  _getCacheMap(sourcePath) {
    if (!this._frameCache.has(sourcePath)) {
      this._frameCache.set(sourcePath, new Map());
    }
    return this._frameCache.get(sourcePath);
  }

  _setCacheEntry(sourcePath, roundedPts, frameData) {
    const map = this._getCacheMap(sourcePath);
    map.set(roundedPts, { ...frameData, pts: roundedPts, addedAt: Date.now() });
    this._evictOldFrames(sourcePath, map);
  }

  /**
   * Find the nearest cached frame to targetPts, within ±1 frame duration.
   * @param {string} sourcePath
   * @param {number} targetPts — µs
   * @returns {object|null}
   */
  _findNearestFrame(sourcePath, targetPts) {
    const map = this._frameCache.get(sourcePath);
    if (!map || map.size === 0) return null;
    const tolerance = this._frameDurationUs;
    let bestEntry = null, bestDist = Infinity;
    for (const [key, entry] of map.entries()) {
      const dist = Math.abs(key - targetPts);
      if (dist < bestDist) { bestDist = dist; bestEntry = entry; }
    }
    return bestDist <= tolerance ? bestEntry : null;
  }

  /**
   * LRU eviction: keep at most MAX_CACHE_FRAMES per source.
   * Evicts the frame furthest behind the playhead; if all are ahead, evicts oldest.
   */
  _evictOldFrames(sourcePath, map) {
    if (map.size <= MAX_CACHE_FRAMES) return;
    // Prefer evicting frames behind the playhead (they won't be needed again).
    let worstKey = null, worstDist = -1;
    for (const key of map.keys()) {
      if (key < this._playheadPts) {
        const dist = this._playheadPts - key;
        if (dist > worstDist) { worstDist = dist; worstKey = key; }
      }
    }
    if (worstKey === null) {
      // All frames are ahead — evict the oldest by insertion time.
      let oldestTime = Infinity;
      for (const [key, entry] of map.entries()) {
        if (entry.addedAt < oldestTime) { oldestTime = entry.addedAt; worstKey = key; }
      }
    }
    if (worstKey !== null) {
      map.get(worstKey)?.bitmap?.close?.();
      map.delete(worstKey);
    }
  }

  // ── Pre-roll ──────────────────────────────────────────────────────────────

  /**
   * Decode frameCount frames starting at startPts and fill the frame cache.
   * Uses decodeFrameAt for the first frame (positions the decoder) and
   * decodeNextFrame for subsequent frames (sequential, no seek overhead).
   * Does NOT start _tick — caller must do that after this resolves.
   * @param {number} startPts   — µs
   * @param {number} frameCount
   */
  async _preRoll(startPts, frameCount = PRE_ROLL_FRAMES) {
    if (!this._pool || !this._engine || !this._seqId) return;
    const frameDur = this._frameDurationUs;
    let firstFrame = true;

    for (let i = 0; i < frameCount; i++) {
      if (!this._isPlaying) break;   // aborted by pause()

      const targetPts = startPts + i * frameDur;
      if (this._duration > 0 && targetPts > this._duration) break;

      const allResolved = this._engine.resolve_all_frames(this._seqId, targetPts) ?? [];
      for (const resolved of allResolved) {
        if (!this._isPlaying) break;
        const sourcePts = Math.round(resolved.source_pts);
        if (this._findNearestFrame(resolved.source_path, sourcePts)) continue;

        let frameData;
        try {
          if (firstFrame) {
            // Random access: seeks the decoder to the right position.
            frameData = await this._pool.decodeFrameAt(
              resolved.source_path,
              usToSecs(resolved.source_pts)
            );
          } else {
            // Sequential: no seek overhead; falls back internally if needed.
            frameData = await this._pool.decodeNextFrame(
              resolved.source_path,
              usToSecs(resolved.source_pts)
            );
          }
        } catch (e) {
          console.warn('[Playback] _preRoll decode error (skipping):', e); // eslint-disable-line no-console
          continue;
        }

        const cached = await _toImageBitmapIfNeeded(frameData);
        if (cached) this._setCacheEntry(resolved.source_path, sourcePts, cached);
      }

      firstFrame = false;
    }

    // Position decode loop to continue from where pre-roll left off.
    this._nextDecodePts = startPts + frameCount * frameDur;
  }

  // ── rAF tick — cache read + draw only, NEVER decode ──────────────────────

  _tick(now) {
    if (!this._isPlaying) return;

    // Elapsed since last tick, clamped to 2× frame duration so a backgrounded
    // tab can't jump the playhead by seconds when it resumes.
    const elapsed = this._lastFrameMs !== null
      ? Math.min(now - this._lastFrameMs, this._frameDurMs * 2)
      : 0;
    this._lastFrameMs = now;

    this._playheadPts += elapsed * 1000;   // ms → µs
    if (this._duration > 0) this._playheadPts = Math.min(this._playheadPts, this._duration);

    // ── L1 Composition Cache check ─────────────────────────────────────────
    if (this._engine && this._seqId && this._player) {
      const editGen      = this._engine.get_edit_generation?.(this._seqId) ?? 0;
      const frameDur     = frameDurationUs(this._fps);
      const frameIndex   = Math.round(this._playheadPts / frameDur);
      const l1Hit        = this._compositionCache.get(this._seqId, editGen, frameIndex);
      if (l1Hit) {
        this._player.drawFrameFull(l1Hit);
        this._lastDisplayedBitmap = l1Hit;
        this._onFrameState?.(true);
        this._onTimecode?.(this._playheadPts);
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
        return;
      }
    }

    // ── L2 Frame Cache lookup — nearest-frame selection ────────────────────
    const allResolved = (this._engine && this._seqId
      ? this._engine.resolve_all_frames(this._seqId, this._playheadPts)
      : null) ?? [];

    if (allResolved.length === 0) {
      // No clips under playhead.
      if (this._lastDisplayedBitmap && this._player) {
        this._player.drawFrameFull(this._lastDisplayedBitmap);
      } else if (this._player) {
        this._player.clear();
      }
      this._onFrameState?.(false);
    } else if (this._player) {
      const allCached = allResolved.every((resolved) => {
        const sourcePts = Math.round(resolved.source_pts);
        return this._findNearestFrame(resolved.source_path, sourcePts) !== null;
      });

      if (allCached) {
        // All clips in cache — composite and draw.
        this._player.clear();
        for (const resolved of allResolved) {
          const sourcePts  = Math.round(resolved.source_pts);
          const frame      = this._findNearestFrame(resolved.source_path, sourcePts);
          if (frame) {
            const transform  = this._computeTransform(resolved.source_path, resolved);
            const colorspace = mapFFmpegColorspace(
              this._pool.getInfo(resolved.source_path)?.colorspace ?? AVCOL_SPC_BT709
            );
            this._player.drawFrameAt(
              { ...frame, colorspace },
              { ...transform, opacity: resolved.opacity ?? 1.0 }
            );
          }
        }
        this._onFrameState?.(true);

        // Capture composited canvas → L1 cache (async, non-blocking).
        if (this._engine && this._seqId) {
          const editGen    = this._engine.get_edit_generation?.(this._seqId) ?? 0;
          const frameDur   = frameDurationUs(this._fps);
          const frameIndex = Math.round(this._playheadPts / frameDur);
          const w = this._seqW, h = this._seqH;
          const gl = this._player.getGLContext?.();
          if (gl) gl.finish();
          createImageBitmap(this._player.canvas).then((bm) => {
            const entry = { bitmap: bm, width: w, height: h };
            this._compositionCache.set(this._seqId, editGen, frameIndex, entry);
            this._lastDisplayedBitmap = entry;
          }).catch(() => {});
        }
      } else {
        // Cache miss — hold the last drawn frame. _decodeLoop will fill
        // the cache; we'll pick up the new frames on the next tick.
        // NEVER call clear() here — that causes the black-flash bug.
        if (this._lastDisplayedBitmap) {
          this._player.drawFrameFull(this._lastDisplayedBitmap);
        }
      }
    }

    // ── Timeline: repaint every other tick (~30 fps) ───────────────────────
    this._tickCount++;
    if (this._tickCount % 2 === 0) {
      this._updateTimelineDisplay(this._playheadPts);
    } else {
      if (this._timeline) this._timeline._playhead = this._playheadPts;
    }
    this._onTimecode?.(this._playheadPts);

    // ── Audio ──────────────────────────────────────────────────────────────
    const topClip = this._engine && this._seqId
      ? this._engine.resolve_frame(this._seqId, this._playheadPts)
      : null;
    setTimeout(() => this._decodeAndPushAudio(this._playheadPts, topClip), 0);

    // Stop at end of sequence.
    if (this._duration > 0 && this._playheadPts >= this._duration) {
      this._isPlaying   = false;
      this._rafId       = null;
      this._lastFrameMs = null;
      this._onStateChange?.(false);
      return;
    }

    this._rafId = requestAnimationFrame((now2) => this._tick(now2));
  }

  // ── Async decode loop — independent of rAF ───────────────────────────────

  /**
   * Continuously prefetch frames ahead of the playhead.
   * Runs as a fire-and-forget async loop alongside the rAF loop.
   * Uses decodeNextFrame (sequential, no seek) for the hot path.
   * Yields via setTimeout(0) between frames so the main thread stays free.
   * Terminates when _isPlaying becomes false.
   */
  async _decodeLoop() {
    while (this._isPlaying) {
      try {
        const prefetchAheadUs = this._prefetchAheadMs * 1000;

        if ((this._nextDecodePts - this._playheadPts) < prefetchAheadUs) {
          const targetPts = this._nextDecodePts;

          // Don't decode past end of sequence.
          if (this._duration > 0 && targetPts > this._duration) {
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }

          const allResolved = this._engine?.resolve_all_frames(this._seqId, targetPts) ?? [];

          for (const resolved of allResolved) {
            if (!this._isPlaying) break;

            const sourcePts = Math.round(resolved.source_pts);
            // Use exact-match check so we never treat an adjacent cached frame as
            // covering this position — that would cause every other frame to be
            // skipped, leaving half the cache empty and causing a freeze.
            const cacheMap = this._getCacheMap(resolved.source_path);
            if (cacheMap.has(sourcePts)) continue;

            let frameData;
            try {
              // Sequential path: no seek overhead.
              // Pool falls back to decodeFrameAt internally if the decoded
              // frame's pts is too far from the expected position.
              frameData = await this._pool.decodeNextFrame(
                resolved.source_path,
                usToSecs(resolved.source_pts)
              );
            } catch (e) {
              console.warn('[Playback] _decodeLoop decode error (skipping frame):', e); // eslint-disable-line no-console
              frameData = null;
            }

            if (!frameData) continue;

            try {
              const cached = await _toImageBitmapIfNeeded(frameData);
              if (cached) this._setCacheEntry(resolved.source_path, sourcePts, cached);
            } catch (e) {
              console.warn('[Playback] _decodeLoop bitmap error (skipping frame):', e); // eslint-disable-line no-console
            }
          }

          this._nextDecodePts += this._frameDurationUs;
        }
      } catch (e) {
        // Catch any unexpected error so the loop never silently exits.
        console.warn('[Playback] _decodeLoop unexpected error (continuing):', e); // eslint-disable-line no-console
      }

      // Yield to the event loop so rAF callbacks and microtasks are not starved.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // ── Audio decode ──────────────────────────────────────────────────────────

  _decodeAndPushAudio(pts, resolved = null) {
    try {
      if (!this._pool) return;
      if (!resolved) {
        if (!this._engine || !this._seqId) return;
        resolved = this._engine.resolve_frame(this._seqId, pts);
      }
      if (!resolved?.source_path) return;
      const targetSecs = usToSecs(pts);
      // Skip if we already decoded audio very recently (< 80 ms lookahead gap).
      if (Math.abs(targetSecs - this._lastAudioPts) < 0.08) return;
      this._lastAudioPts = targetSecs;
      const samples = this._pool.decodeAudioAt(resolved.source_path, targetSecs, 8192);
      if (samples?.length > 0) this._audio.pushSamples(samples);
    } catch (_e) { /* non-fatal — video keeps playing */ }
  }

  // ── Scrub / step decode ───────────────────────────────────────────────────

  /**
   * Decode and display the frame at pts (used for scrub, step, project load).
   * Old frame stays visible until new one is ready — no clear() before awaits.
   * @param {number} pts — µs
   */
  async _decodeAndDisplay(pts) {
    if (!this._pool || !this._engine || !this._seqId) return;
    try {
      // L1 check.
      if (this._player) {
        const editGen    = this._engine.get_edit_generation?.(this._seqId) ?? 0;
        const frameIndex = Math.round(pts / frameDurationUs(this._fps));
        const l1Hit      = this._compositionCache.get(this._seqId, editGen, frameIndex);
        if (l1Hit) {
          this._player.drawFrameFull(l1Hit);
          this._lastDisplayedBitmap = l1Hit;
          this._onFrameState?.(true);
          return;
        }
      }

      const allResolved = this._engine.resolve_all_frames(this._seqId, pts);
      if (!Array.isArray(allResolved) || allResolved.length === 0) {
        if (this._player) this._player.clear();
        this._onFrameState?.(false);
        return;
      }

      for (const resolved of allResolved) {
        const sourcePts = Math.round(resolved.source_pts);
        let frame = this._findNearestFrame(resolved.source_path, sourcePts);

        if (!frame) {
          let frameData;
          try {
            frameData = await this._pool.decodeFrameAt(
              resolved.source_path,
              usToSecs(resolved.source_pts)
            );
          } catch (e) {
            console.warn('[Playback] _decodeAndDisplay decode error:', e); // eslint-disable-line no-console
            continue;
          }
          frame = await _toImageBitmapIfNeeded(frameData);
          if (frame) this._setCacheEntry(resolved.source_path, sourcePts, frame);
        }

        if (frame && this._player) {
          const info       = this._pool.getInfo(resolved.source_path);
          const colorspace = mapFFmpegColorspace(info?.colorspace ?? AVCOL_SPC_BT709);
          const transform  = this._computeTransform(resolved.source_path, resolved);
          this._player.drawFrameAt(
            { ...frame, colorspace },
            { ...transform, opacity: resolved.opacity ?? 1.0 }
          );
        }
      }

      // Capture composited canvas → L1 cache.
      if (this._engine && this._seqId && this._player) {
        const editGen    = this._engine.get_edit_generation?.(this._seqId) ?? 0;
        const frameIndex = Math.round(pts / frameDurationUs(this._fps));
        const w = this._seqW, h = this._seqH;
        const gl = this._player.getGLContext?.();
        if (gl) gl.finish();
        createImageBitmap(this._player.canvas).then((bm) => {
          const entry = { bitmap: bm, width: w, height: h };
          this._compositionCache.set(this._seqId, editGen, frameIndex, entry);
          this._lastDisplayedBitmap = entry;
        }).catch(() => {});
      }

      this._onFrameState?.(true);
    } catch (e) {
      console.warn('[Playback] _decodeAndDisplay error:', e); // eslint-disable-line no-console
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _computeTransform(sourcePath, resolved) {
    const info   = this._pool.getInfo(sourcePath);
    const clipW  = info?.width  ?? this._seqW;
    const clipH  = info?.height ?? this._seqH;
    const scaleX = (clipW / this._seqW) * (resolved.userScale ?? 1.0);
    const scaleY = (clipH / this._seqH) * (resolved.userScale ?? 1.0);
    const offsetX =  (resolved.posX ?? 0) / (this._seqW / 2);
    const offsetY = -(resolved.posY ?? 0) / (this._seqH / 2);
    return { scaleX, scaleY, offsetX, offsetY };
  }

  _updateTimelineDisplay(pts) {
    if (this._timeline) {
      this._timeline._playhead = pts;
      this._timeline.render();
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
  if (!frameData?.videoFrame) return frameData;  // YUV path — no conversion needed
  const { videoFrame, width, height } = frameData;
  try {
    const bitmap = await createImageBitmap(videoFrame);
    return { bitmap, width, height };
  } finally {
    // Always free the VideoFrame regardless of whether createImageBitmap succeeded.
    videoFrame.close();
  }
}
