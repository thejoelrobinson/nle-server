import { describe, it, expect, vi, afterEach } from 'vitest';
import { FrameServerBridge } from '../wasm_bridge.js';
import { formatTimecode }    from '../timecode.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function noop() {}

function makeBridge(overrides = {}) {
  return new FrameServerBridge({
    onFrame:    noop,
    onEnd:      noop,
    onError:    noop,
    onMetadata: noop,
    ...overrides,
  });
}

/**
 * Create a bridge whose background WASM load is suppressed.
 * Use this whenever the test doesn't exercise the loading path itself —
 * without suppression, the rejected _loadPromise becomes an unhandled rejection.
 */
function makeBridgeSuppressed(overrides = {}) {
  const bridge = makeBridge(overrides);
  bridge._loadPromise.catch(() => {}); // suppress background rejection
  return bridge;
}

// Minimal fetch mock that returns a bad HTTP status so WASM load fails fast.
function mockFetchFail(status = 404) {
  return vi.fn().mockResolvedValue({ ok: false, status });
}

// Minimal fetch mock that rejects entirely (network error).
function mockFetchNetworkError() {
  return vi.fn().mockRejectedValue(new Error('Network error'));
}

// ── FrameServerBridge ─────────────────────────────────────────────────────

describe('FrameServerBridge', () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── WASM loading ──────────────────────────────────────────────────────

  describe('ready()', () => {
    it('rejects and calls onError when the WASM fetch returns a non-OK status', async () => {
      vi.stubGlobal('fetch', mockFetchFail(404));

      const onError = vi.fn();
      const bridge  = makeBridge({ onError });

      await expect(bridge.ready()).rejects.toThrow(/HTTP 404/);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toMatch(/HTTP 404/);
    });

    it('rejects and calls onError on a network-level fetch failure', async () => {
      vi.stubGlobal('fetch', mockFetchNetworkError());

      const onError = vi.fn();
      const bridge  = makeBridge({ onError });

      await expect(bridge.ready()).rejects.toThrow('Network error');
      expect(onError).toHaveBeenCalledOnce();
    });
  });

  // ── openFile() ────────────────────────────────────────────────────────

  describe('openFile()', () => {
    it('throws if called when WASM failed to load', async () => {
      vi.stubGlobal('fetch', mockFetchFail(500));

      const bridge   = makeBridge();
      const fakeFile = {
        name:        'test.mp4',
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
      };

      // openFile() calls ready() first, which will reject because WASM load failed
      await expect(bridge.openFile(fakeFile)).rejects.toThrow();
    });

    it('throws with a descriptive error when get_width() returns 0', async () => {
      vi.stubGlobal('fetch', mockFetchFail());

      const bridge = makeBridgeSuppressed();
      // Bypass the WASM load: inject a mock module whose FrameServer reports 0×0
      bridge._loadPromise = Promise.resolve();
      bridge._mod = {
        FrameServer: class {
          open()            { return true; }
          get_width()       { return 0; }
          get_height()      { return 0; }
          get_fps()         { return 24; }
          get_duration()    { return 10; }
          get_frame_count() { return 240; }
          close()           {}
          delete()          {}
        },
      };

      const fakeFile = {
        name:        'broken.mov',
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      };

      await expect(bridge.openFile(fakeFile)).rejects.toThrow(/dimensions/);
    });

    it('throws with a descriptive error when get_height() returns 0', async () => {
      vi.stubGlobal('fetch', mockFetchFail());

      const bridge = makeBridgeSuppressed();
      bridge._loadPromise = Promise.resolve();
      bridge._mod = {
        FrameServer: class {
          open()            { return true; }
          get_width()       { return 1920; }
          get_height()      { return 0; }   // height zero
          get_fps()         { return 24; }
          get_duration()    { return 10; }
          get_frame_count() { return 240; }
          close()           {}
          delete()          {}
        },
      };

      const fakeFile = {
        name:        'broken.mov',
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      };

      await expect(bridge.openFile(fakeFile)).rejects.toThrow(/dimensions/);
    });
  });

  // ── seekTo() ─────────────────────────────────────────────────────────

  describe('seekTo()', () => {
    function makeServer(frameOrNull = null) {
      return { decode_frame_at: vi.fn().mockReturnValue(frameOrNull) };
    }

    it('clamps pts to 0 when given a negative timestamp', () => {
      vi.stubGlobal('fetch', mockFetchFail());
      const bridge = makeBridgeSuppressed();
      bridge._duration = 10;
      bridge._server   = makeServer();

      bridge.seekTo(-5);
      expect(bridge._pts).toBe(0);
    });

    it('clamps pts to duration when given a timestamp beyond the end', () => {
      vi.stubGlobal('fetch', mockFetchFail());
      const bridge = makeBridgeSuppressed();
      bridge._duration = 10;
      bridge._server   = makeServer();

      bridge.seekTo(999);
      expect(bridge._pts).toBe(10);
    });

    it('sets pts to the exact value when within valid range', () => {
      vi.stubGlobal('fetch', mockFetchFail());
      const bridge = makeBridgeSuppressed();
      bridge._duration = 10;
      bridge._server   = makeServer();

      bridge.seekTo(7.5);
      expect(bridge._pts).toBe(7.5);
    });

    it('calls server.decode_frame_at() with the clamped timestamp', () => {
      vi.stubGlobal('fetch', mockFetchFail());
      const bridge = makeBridgeSuppressed();
      bridge._duration = 10;
      bridge._server   = makeServer();

      bridge.seekTo(-1);
      expect(bridge._server.decode_frame_at).toHaveBeenCalledWith(0);

      bridge.seekTo(20);
      expect(bridge._server.decode_frame_at).toHaveBeenCalledWith(10);
    });

    it('calls onFrame with the frame returned by decode_frame_at', () => {
      vi.stubGlobal('fetch', mockFetchFail());
      const fakeFrame = { y: new Uint8Array(1), u: new Uint8Array(1), v: new Uint8Array(1),
                          width: 4, height: 4, strideY: 4, strideU: 2, strideV: 2, pts: 5.0 };
      const onFrame = vi.fn();
      const bridge  = makeBridgeSuppressed({ onFrame });
      bridge._duration = 10;
      bridge._server   = makeServer(fakeFrame);

      bridge.seekTo(5);
      expect(onFrame).toHaveBeenCalledOnce();
      expect(onFrame.mock.calls[0][0]).toBe(fakeFrame);
    });

    it('does not call onFrame when decode_frame_at returns null', () => {
      vi.stubGlobal('fetch', mockFetchFail());
      const onFrame = vi.fn();
      const bridge  = makeBridgeSuppressed({ onFrame });
      bridge._duration = 10;
      bridge._server   = makeServer(null);

      bridge.seekTo(5);
      expect(onFrame).not.toHaveBeenCalled();
    });

    it('does nothing if _server is not initialised', () => {
      vi.stubGlobal('fetch', mockFetchFail());
      const bridge = makeBridgeSuppressed();
      // _server is null by default; seekTo should be a no-op
      expect(() => bridge.seekTo(5)).not.toThrow();
      expect(bridge._pts).toBe(0);
    });
  });

});

// ── formatTimecode ────────────────────────────────────────────────────────

describe('formatTimecode()', () => {
  it('formats zero as 00:00:00:00', () => {
    expect(formatTimecode(0, 24)).toBe('00:00:00:00');
  });

  it('formats 1 second correctly at 24 fps', () => {
    expect(formatTimecode(1, 24)).toBe('00:00:01:00');
  });

  it('rolls over seconds into minutes', () => {
    expect(formatTimecode(60, 24)).toBe('00:01:00:00');
  });

  it('rolls over minutes into hours', () => {
    expect(formatTimecode(3600, 24)).toBe('01:00:00:00');
  });

  it('includes the frame component at 30 fps', () => {
    // 1.5 s at 30 fps = 45 frames total → 1 s + 15 frames
    expect(formatTimecode(1.5, 30)).toBe('00:00:01:15');
  });

  it('pads all components to two digits', () => {
    // 1 h 2 m 3 s 4 f at 24 fps
    const secs = 3600 + 2 * 60 + 3 + 4 / 24;
    expect(formatTimecode(secs, 24)).toBe('01:02:03:04');
  });

  it('treats fps < 1 as 1 to avoid division by zero', () => {
    expect(() => formatTimecode(5, 0)).not.toThrow();
  });
});
