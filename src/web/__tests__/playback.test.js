/**
 * playback.test.js – Unit tests for the Playback engine.
 *
 * requestAnimationFrame and cancelAnimationFrame are stubbed so we can
 * drive the rAF loop synchronously inside tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Playback } from '../playback.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const SEC = 1_000_000;  // 1 second in µs

function makeTimeline() {
  return { _playhead: 0, render: vi.fn() };
}

function makeEngine(resolveResult = null) {
  return { resolve_frame: vi.fn().mockReturnValue(resolveResult) };
}

function makePool(frame = null) {
  return { decodeFrameAt: vi.fn().mockReturnValue(frame), getInfo: vi.fn().mockReturnValue(null) };
}

function makePlayer() {
  return { drawFrame: vi.fn() };
}

/**
 * Build a Playback instance with sensible defaults.
 * Any field can be overridden via the `overrides` object.
 */
function makePlayback(overrides = {}) {
  return new Playback({
    timeline:   makeTimeline(),
    engine:     makeEngine(),
    pool:       makePool(),
    sequenceId: 'seq_1',
    fps:        24,
    duration:   10 * SEC,
    ...overrides,
  });
}

// ── RAF stub helpers ───────────────────────────────────────────────────────
//
// We maintain a registry of pending callbacks indexed by ID.
// Each call to the stubbed requestAnimationFrame stores the callback.
// Tests drive the loop by pulling the latest callback and calling it manually.

let _rafRegistry = new Map();
let _rafNextId   = 1;

function setupRafStubs() {
  _rafRegistry = new Map();
  _rafNextId   = 1;

  vi.stubGlobal('requestAnimationFrame', vi.fn((cb) => {
    const id = _rafNextId++;
    _rafRegistry.set(id, cb);
    return id;
  }));

  vi.stubGlobal('cancelAnimationFrame', vi.fn((id) => {
    _rafRegistry.delete(id);
  }));
}

/** Fire the most recently scheduled rAF callback with the given timestamp. */
function fireLatestRaf(timestampMs) {
  // Find the highest registered id (most recent)
  let maxId = -1;
  for (const id of _rafRegistry.keys()) if (id > maxId) maxId = id;
  if (maxId === -1) return;
  const cb = _rafRegistry.get(maxId);
  _rafRegistry.delete(maxId);
  cb(timestampMs);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Playback', () => {
  beforeEach(() => { setupRafStubs(); });
  afterEach(()  => { vi.restoreAllMocks(); });

  // ── play() ──────────────────────────────────────────────────────────────

  describe('play()', () => {
    it('sets isPlaying to true', () => {
      const pb = makePlayback();
      pb.play();
      expect(pb.isPlaying).toBe(true);
    });

    it('schedules exactly one requestAnimationFrame', () => {
      const pb = makePlayback();
      pb.play();
      expect(requestAnimationFrame).toHaveBeenCalledOnce();
    });

    it('fires onPlayStateChange(true)', () => {
      const cb = vi.fn();
      const pb = makePlayback({ onPlayStateChange: cb });
      pb.play();
      expect(cb).toHaveBeenCalledWith(true);
    });

    it('is idempotent — second play() call is a no-op', () => {
      const pb = makePlayback();
      pb.play();
      pb.play();
      expect(requestAnimationFrame).toHaveBeenCalledOnce();
    });
  });

  // ── pause() ─────────────────────────────────────────────────────────────

  describe('pause()', () => {
    it('sets isPlaying to false', () => {
      const pb = makePlayback();
      pb.play();
      pb.pause();
      expect(pb.isPlaying).toBe(false);
    });

    it('cancels the pending rAF', () => {
      const pb = makePlayback();
      pb.play();
      pb.pause();
      expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    });

    it('fires onPlayStateChange(false)', () => {
      const cb = vi.fn();
      const pb = makePlayback({ onPlayStateChange: cb });
      pb.play();
      cb.mockClear();
      pb.pause();
      expect(cb).toHaveBeenCalledWith(false);
    });

    it('is idempotent — calling pause() when already paused is a no-op', () => {
      const pb = makePlayback();
      pb.pause();  // never started
      expect(cancelAnimationFrame).not.toHaveBeenCalled();
    });
  });

  // ── toggle() ────────────────────────────────────────────────────────────

  describe('toggle()', () => {
    it('starts playback when paused', () => {
      const pb = makePlayback();
      pb.toggle();
      expect(pb.isPlaying).toBe(true);
    });

    it('pauses playback when playing', () => {
      const pb = makePlayback();
      pb.toggle();
      pb.toggle();
      expect(pb.isPlaying).toBe(false);
    });

    it('alternates state on repeated calls', () => {
      const pb     = makePlayback();
      const states = [];
      for (let i = 0; i < 4; i++) { pb.toggle(); states.push(pb.isPlaying); }
      expect(states).toEqual([true, false, true, false]);
    });
  });

  // ── _tick() — wall-clock timing ─────────────────────────────────────────

  describe('_tick()', () => {
    it('first tick sets lastFrameMs but advances playhead by zero', () => {
      const pb = makePlayback({ fps: 24, duration: 10 * SEC });
      pb.play();
      fireLatestRaf(1000);   // first tick
      expect(pb.playheadPts).toBe(0);
    });

    it('advances playheadPts by elapsed ms × 1000 (ms → µs)', () => {
      // Use fps=10 so frame duration = 100ms and 2× cap = 200ms.
      // A 50ms elapsed is below the cap, so no clamping occurs.
      const pb = makePlayback({ fps: 10, duration: 10 * SEC });
      pb.play();
      fireLatestRaf(1000);    // first tick — no advance (sets lastFrameMs)
      fireLatestRaf(1050);    // second tick — 50 ms elapsed → 50 000 µs
      expect(pb.playheadPts).toBeCloseTo(50_000, 0);
    });

    it('clamps delta to 2× frame duration on a large gap', () => {
      const fps = 24;
      const pb  = makePlayback({ fps, duration: 10 * SEC });
      pb.play();
      fireLatestRaf(0);          // first tick: sets lastFrameMs = 0, zero advance
      fireLatestRaf(999_999);    // huge gap — should clamp to 2 * (1000/24) ms
      const maxAdvance = (1000 / fps) * 2 * 1000;  // µs
      expect(pb.playheadPts).toBeLessThanOrEqual(maxAdvance + 1);
    });

    it('stops playback when playheadPts reaches duration', () => {
      const pb = makePlayback({ fps: 24, duration: 1 * SEC });
      pb._playheadPts = 999_900;   // just under 1 s
      pb.play();
      fireLatestRaf(0);       // first tick
      fireLatestRaf(1000);    // 1000 ms elapsed → will overshoot duration
      expect(pb.isPlaying).toBe(false);
    });

    it('fires onPlayStateChange(false) when stopping at end', () => {
      const onStateChange = vi.fn();
      const pb = makePlayback({ fps: 24, duration: 1 * SEC, onPlayStateChange: onStateChange });
      pb._playheadPts = 999_900;
      pb.play();
      onStateChange.mockClear();
      fireLatestRaf(0);
      fireLatestRaf(1000);
      expect(onStateChange).toHaveBeenCalledWith(false);
    });

    it('does NOT schedule another rAF after stopping at end', () => {
      const pb = makePlayback({ fps: 24, duration: 1 * SEC });
      pb._playheadPts = 999_900;
      pb.play();
      fireLatestRaf(0);    // first tick: no advance, schedules tick 2
      const countAfterTick1 = requestAnimationFrame.mock.calls.length;
      fireLatestRaf(1000); // second tick: overshoots duration → stops, no new rAF
      expect(requestAnimationFrame.mock.calls.length).toBe(countAfterTick1);
    });

    it('calls timeline.render() on each tick', () => {
      const timeline = makeTimeline();
      const pb = makePlayback({ timeline });
      pb.play();
      fireLatestRaf(0);
      fireLatestRaf(50);
      expect(timeline.render.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('updates timeline._playhead to match playheadPts', () => {
      const timeline = makeTimeline();
      const pb = makePlayback({ timeline });
      pb.play();
      fireLatestRaf(0);
      fireLatestRaf(100);   // 100 ms → 100 000 µs
      expect(timeline._playhead).toBeCloseTo(pb.playheadPts, 0);
    });

    it('calls onTimecodeUpdate with current pts', () => {
      const onTc = vi.fn();
      const pb   = makePlayback({ onTimecodeUpdate: onTc });
      pb.play();
      fireLatestRaf(0);
      expect(onTc).toHaveBeenCalled();
    });
  });

  // ── syncPlayheadPts() ───────────────────────────────────────────────────

  describe('syncPlayheadPts()', () => {
    it('updates internal playheadPts', () => {
      const pb = makePlayback();
      pb.syncPlayheadPts(5 * SEC);
      expect(pb.playheadPts).toBe(5 * SEC);
    });

    it('updates timeline._playhead', () => {
      const timeline = makeTimeline();
      const pb = makePlayback({ timeline });
      pb.syncPlayheadPts(3 * SEC);
      expect(timeline._playhead).toBe(3 * SEC);
    });

    it('calls timeline.render()', () => {
      const timeline = makeTimeline();
      const pb = makePlayback({ timeline });
      pb.syncPlayheadPts(3 * SEC);
      expect(timeline.render).toHaveBeenCalled();
    });

    it('calls onTimecodeUpdate with the new pts', () => {
      const onTc = vi.fn();
      const pb   = makePlayback({ onTimecodeUpdate: onTc });
      pb.syncPlayheadPts(7 * SEC);
      expect(onTc).toHaveBeenCalledWith(7 * SEC);
    });

    it('calls engine.resolve_frame with the new pts', () => {
      const engine = makeEngine();
      const pb     = makePlayback({ engine });
      pb.syncPlayheadPts(4 * SEC);
      expect(engine.resolve_frame).toHaveBeenCalledWith('seq_1', 4 * SEC);
    });
  });

  // ── stepForward / stepBack ───────────────────────────────────────────────

  describe('stepForward() / stepBack()', () => {
    it('stepForward advances by exactly one frame at 24 fps', () => {
      const pb = makePlayback({ fps: 24 });
      pb.syncPlayheadPts(0);
      pb.stepForward();
      const oneFrame = Math.round((1 / 24) * 1e6);
      expect(pb.playheadPts).toBe(oneFrame);
    });

    it('stepBack retreats by exactly one frame at 24 fps', () => {
      const pb = makePlayback({ fps: 24 });
      const oneFrame = Math.round((1 / 24) * 1e6);
      pb.syncPlayheadPts(oneFrame * 3);
      pb.stepBack();
      expect(pb.playheadPts).toBe(oneFrame * 2);
    });

    it('stepBack clamps at 0', () => {
      const pb = makePlayback({ fps: 24 });
      pb.syncPlayheadPts(0);
      pb.stepBack();
      expect(pb.playheadPts).toBe(0);
    });

    it('stepForward/Back call pause() first', () => {
      const pb  = makePlayback();
      const spy = vi.spyOn(pb, 'pause');
      pb.stepForward();
      expect(spy).toHaveBeenCalledOnce();
      spy.mockClear();
      pb.stepBack();
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  // ── Spacebar integration ─────────────────────────────────────────────────
  //
  // These tests simulate the keydown wiring in main.js rather than importing
  // main.js itself (which has DOM dependencies).  The logic is: Space fires
  // toggle() unless the target is INPUT or TEXTAREA.

  describe('spacebar wiring (simulated)', () => {
    it('toggle() is called on Space keydown outside inputs', () => {
      const pb  = makePlayback();
      const spy = vi.spyOn(pb, 'toggle');

      const handler = (e) => {
        if (e.code === 'Space' &&
            e.target.tagName !== 'INPUT' &&
            e.target.tagName !== 'TEXTAREA') {
          pb.toggle();
        }
      };
      document.addEventListener('keydown', handler);
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      expect(spy).toHaveBeenCalledOnce();
      document.removeEventListener('keydown', handler);
    });

    it('toggle() is NOT called when Space is pressed inside an INPUT', () => {
      const pb  = makePlayback();
      const spy = vi.spyOn(pb, 'toggle');

      const handler = (e) => {
        if (e.code === 'Space' &&
            e.target.tagName !== 'INPUT' &&
            e.target.tagName !== 'TEXTAREA') {
          pb.toggle();
        }
      };
      document.addEventListener('keydown', handler);

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      expect(spy).not.toHaveBeenCalled();

      document.body.removeChild(input);
      document.removeEventListener('keydown', handler);
    });

    it('toggle() is NOT called when Space is pressed inside a TEXTAREA', () => {
      const pb  = makePlayback();
      const spy = vi.spyOn(pb, 'toggle');

      const handler = (e) => {
        if (e.code === 'Space' &&
            e.target.tagName !== 'INPUT' &&
            e.target.tagName !== 'TEXTAREA') {
          pb.toggle();
        }
      };
      document.addEventListener('keydown', handler);

      const ta = document.createElement('textarea');
      document.body.appendChild(ta);
      ta.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      expect(spy).not.toHaveBeenCalled();

      document.body.removeChild(ta);
      document.removeEventListener('keydown', handler);
    });
  });

  // ── _decodeAndDisplay via resolve_frame ──────────────────────────────────

  describe('_decodeAndDisplay()', () => {
    it('calls engine.resolve_frame with seqId and pts', () => {
      const engine = makeEngine();
      const pb     = makePlayback({ engine });
      pb._decodeAndDisplay(5 * SEC);
      expect(engine.resolve_frame).toHaveBeenCalledWith('seq_1', 5 * SEC);
    });

    it('calls onFrameState(false) when resolve_frame returns null', () => {
      const onFrameState = vi.fn();
      const pb = makePlayback({ engine: makeEngine(null), onFrameState });
      pb._decodeAndDisplay(5 * SEC);
      expect(onFrameState).toHaveBeenCalledWith(false);
    });

    it('calls pool.decodeFrameAt when resolve_frame returns a result', () => {
      const engine = makeEngine({ source_path: 'clip.mp4', source_pts: 2500000 });
      const pool   = makePool();
      const pb     = makePlayback({ engine, pool });
      pb._decodeAndDisplay(5 * SEC);
      expect(pool.decodeFrameAt).toHaveBeenCalledWith('clip.mp4', 2.5);
    });

    it('calls player.drawFrame when a frame is decoded', () => {
      const fakeFrame = { y: new Uint8Array(4), width: 2, height: 2 };
      const engine    = makeEngine({ source_path: 'clip.mp4', source_pts: 1000000});
      const pool      = makePool(fakeFrame);
      const player    = makePlayer();
      const pb        = makePlayback({ engine, pool });
      pb.setProgramPlayer(player);
      pb._decodeAndDisplay(1 * SEC);
      expect(player.drawFrame).toHaveBeenCalledWith(expect.objectContaining(fakeFrame));
    });

    it('calls onFrameState(true) when a frame is decoded and drawn', () => {
      const fakeFrame    = { y: new Uint8Array(4), width: 2, height: 2 };
      const engine       = makeEngine({ source_path: 'clip.mp4', source_pts: 1000000});
      const pool         = makePool(fakeFrame);
      const player       = makePlayer();
      const onFrameState = vi.fn();
      const pb           = makePlayback({ engine, pool, onFrameState });
      pb.setProgramPlayer(player);
      pb._decodeAndDisplay(1 * SEC);
      expect(onFrameState).toHaveBeenCalledWith(true);
    });

    it('does not call player.drawFrame when player is not set', () => {
      const fakeFrame = { y: new Uint8Array(4), width: 2, height: 2 };
      const engine    = makeEngine({ source_path: 'clip.mp4', source_pts: 1000000});
      const pool      = makePool(fakeFrame);
      const pb        = makePlayback({ engine, pool });
      // _player is null — should not throw
      expect(() => pb._decodeAndDisplay(1 * SEC)).not.toThrow();
    });
  });
});
