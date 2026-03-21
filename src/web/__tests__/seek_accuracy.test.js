/**
 * seek_accuracy.test.js
 *
 * Tests for frame-accurate seeking via FrameServerBridge.seekTo().
 *
 * The core correctness guarantee: seekTo(t) must call decode_frame_at(t)
 * (not seek() + decode_next_frame()), so that long-GOP codecs like MPEG-2
 * correctly advance past the keyframe to the actual target frame.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { FrameServerBridge } from '../wasm_bridge.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function noop() {}

function makeBridge(overrides = {}) {
  const bridge = new FrameServerBridge({
    onFrame:    noop,
    onEnd:      noop,
    onError:    noop,
    onMetadata: noop,
    ...overrides,
  });
  bridge._loadPromise.catch(() => {});  // suppress background WASM rejection
  return bridge;
}

/** Build a minimal fake YUV frame with a given pts. */
function fakeFrame(pts, pixelSeed = 0) {
  const y = new Uint8Array(4);
  y[0] = pixelSeed & 0xff;  // make each frame distinguishable
  return {
    y, u: new Uint8Array(1), v: new Uint8Array(1),
    width: 4, height: 2, strideY: 4, strideU: 2, strideV: 2,
    pts,
  };
}

/**
 * Create a mock FrameServer whose decode_frame_at() returns frames from a
 * pre-defined sequence, keyed by timestamp. Simulates a decoder that holds
 * a GOP of frames and returns the right one for each seek target.
 */
function makeSequenceServer(frames, fps = 24) {
  const halfFrame = 0.5 / fps;
  return {
    seek: vi.fn(),
    decode_frame_at: vi.fn((target) => {
      // Mimic C++: return the frame whose pts is closest to target (>= threshold)
      const threshold = target - halfFrame;
      const match = frames.find((f) => f.pts >= threshold);
      return match ?? null;
    }),
    decode_next_frame: vi.fn(() => null),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Core contract ─────────────────────────────────────────────────────────

describe('seekTo() → decode_frame_at contract', () => {

  it('calls decode_frame_at (not seek + decode_next_frame) when seeking', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no fetch')));
    const bridge = makeBridge();
    const server = {
      seek:             vi.fn(),
      decode_frame_at:  vi.fn().mockReturnValue(null),
      decode_next_frame: vi.fn(),
    };
    bridge._duration = 30;
    bridge._server   = server;

    bridge.seekTo(5);

    expect(server.decode_frame_at).toHaveBeenCalledOnce();
    expect(server.decode_frame_at).toHaveBeenCalledWith(5);
    // The old seek() path must NOT be used
    expect(server.seek).not.toHaveBeenCalled();
    expect(server.decode_next_frame).not.toHaveBeenCalled();
  });

  it('passes the returned frame directly to onFrame', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no fetch')));
    const frame   = fakeFrame(5.0);
    const onFrame = vi.fn();
    const bridge  = makeBridge({ onFrame });
    bridge._duration = 10;
    bridge._server   = { decode_frame_at: vi.fn().mockReturnValue(frame) };

    bridge.seekTo(5);

    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame.mock.calls[0][0]).toBe(frame);
    expect(onFrame.mock.calls[0][1]).toBe(5);  // pts arg
  });

  it('does not call onFrame when decode_frame_at returns null', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no fetch')));
    const onFrame = vi.fn();
    const bridge  = makeBridge({ onFrame });
    bridge._duration = 10;
    bridge._server   = { decode_frame_at: vi.fn().mockReturnValue(null) };

    bridge.seekTo(5);

    expect(onFrame).not.toHaveBeenCalled();
  });

});

// ── Frame accuracy ────────────────────────────────────────────────────────

describe('frame accuracy', () => {

  it('sequential frame-by-frame advances call decode_frame_at with strictly increasing timestamps', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no fetch')));
    const fps = 24;
    const bridge = makeBridge();
    bridge._duration = 10;
    bridge._fps      = fps;
    bridge._server   = { decode_frame_at: vi.fn().mockReturnValue(null) };

    const step = 1 / fps;
    bridge.seekTo(1.0);
    bridge.seekTo(1.0 + step);
    bridge.seekTo(1.0 + step * 2);

    const calls = bridge._server.decode_frame_at.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBeLessThan(calls[1]);
    expect(calls[1]).toBeLessThan(calls[2]);
  });

  it('returns different frames for consecutive timestamps (frame-by-frame scrub)', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no fetch')));
    const fps    = 24;
    const frames = Array.from({ length: 48 }, (_, i) => fakeFrame(i / fps, i));
    const bridge = makeBridge();
    bridge._duration = 2;
    bridge._fps      = fps;
    bridge._server   = makeSequenceServer(frames, fps);

    const received = [];
    bridge._onFrame = (f) => received.push(f.pts);

    const step = 1 / fps;
    for (let i = 0; i < 5; i++) {
      bridge.seekTo(i * step);
    }

    // Each seek should return a distinct, non-decreasing pts
    for (let i = 1; i < received.length; i++) {
      expect(received[i]).toBeGreaterThanOrEqual(received[i - 1]);
    }
    // First and last must differ
    expect(received[received.length - 1]).toBeGreaterThan(received[0]);
  });

  it('seeking backward then forward returns correct frames (not cached/stale)', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no fetch')));
    const fps    = 24;
    const frames = Array.from({ length: 240 }, (_, i) => fakeFrame(i / fps, i));
    const bridge = makeBridge();
    bridge._duration = 10;
    bridge._fps      = fps;
    bridge._server   = makeSequenceServer(frames, fps);

    const received = [];
    bridge._onFrame = (f) => received.push({ pts: f.pts, seed: f.y[0] });

    bridge.seekTo(5.0);   // forward into GOP
    bridge.seekTo(2.0);   // backward across keyframe boundary
    bridge.seekTo(5.0);   // forward again

    expect(received).toHaveLength(3);
    expect(received[0].pts).toBeCloseTo(5.0, 2);
    expect(received[1].pts).toBeCloseTo(2.0, 2);
    expect(received[2].pts).toBeCloseTo(5.0, 2);
    // Verify it's the same frame data for both seeks to 5.0 (not a stale earlier frame)
    expect(received[0].seed).toBe(received[2].seed);
    // And the backward seek landed at a genuinely different frame
    expect(received[1].seed).not.toBe(received[0].seed);
  });

});

// ── MPEG-2 / B-frame simulation ───────────────────────────────────────────

describe('long-GOP / B-frame simulation', () => {

  /**
   * Simulate an MPEG-2 decoder's decode_frame_at behaviour:
   * - GOP = 15 frames (I at 0, 15, 30…)
   * - B-frames arrive out of DTS order but best_effort_timestamp is correct
   * - The C++ implementation loops past inter frames to land on the target
   * The JS bridge must pass whatever decode_frame_at returns unchanged.
   */
  it('bridge passes B-frame-reordered pts unchanged to onFrame', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no fetch')));
    const fps    = 24;
    // Simulate: seek to 1.0 s → C++ returns frame with pts=1.000 (correctly past I-frame at 0)
    const expectedPts = 1.0;
    const frame  = fakeFrame(expectedPts);
    const onFrame = vi.fn();
    const bridge  = makeBridge({ onFrame });
    bridge._duration = 10;
    bridge._fps      = fps;
    bridge._server   = { decode_frame_at: vi.fn().mockReturnValue(frame) };

    bridge.seekTo(1.0);

    expect(onFrame).toHaveBeenCalledOnce();
    // pts in the returned frame reflects actual decoded position, not clamped input
    expect(onFrame.mock.calls[0][0].pts).toBe(expectedPts);
  });

  it('frame-by-frame through a GOP boundary returns frames from the new GOP', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no fetch')));
    const fps    = 24;
    const gopSize = 15;
    // GOP boundary at frame 15 = 15/24 ≈ 0.625 s
    const frames = Array.from({ length: 60 }, (_, i) => fakeFrame(i / fps, i));
    const bridge = makeBridge();
    bridge._duration = 2.5;
    bridge._fps      = fps;
    bridge._server   = makeSequenceServer(frames, fps);

    const received = [];
    bridge._onFrame = (f) => received.push(f.pts);

    // Step through the GOP boundary one frame at a time
    const step = 1 / fps;
    for (let f = gopSize - 2; f <= gopSize + 2; f++) {
      bridge.seekTo(f * step);
    }

    expect(received).toHaveLength(5);
    // All pts values must be strictly increasing across the boundary
    for (let i = 1; i < received.length; i++) {
      expect(received[i]).toBeGreaterThan(received[i - 1]);
    }
    // The post-boundary frames must be past the GOP boundary
    const boundaryPts = gopSize * step;
    expect(received[received.length - 1]).toBeGreaterThan(boundaryPts);
  });

  it('each decode_frame_at call is independent (no stale state between seeks)', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no fetch')));
    const fps  = 24;
    const bridge = makeBridge();
    bridge._duration = 10;
    bridge._fps      = fps;

    let callCount = 0;
    bridge._server = {
      decode_frame_at: vi.fn((t) => {
        callCount++;
        // Each call returns a frame at exactly the requested timestamp
        return fakeFrame(t, callCount);
      }),
    };

    const pts1 = vi.fn();
    bridge._onFrame = (f) => pts1(f.pts);

    bridge.seekTo(1.0);
    bridge.seekTo(1.0);  // same timestamp twice — must call decode_frame_at again

    expect(bridge._server.decode_frame_at).toHaveBeenCalledTimes(2);
    expect(callCount).toBe(2);
  });

});
