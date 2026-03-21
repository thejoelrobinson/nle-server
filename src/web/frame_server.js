/**
 * frame_server.js – JS bridge around the WASM FrameServer module
 *
 * Responsibilities:
 *  - Load and instantiate the WASM module
 *  - Copy file bytes into WASM heap via alloc_buffer / free_buffer
 *  - Drive playback via requestAnimationFrame
 *  - Expose openFile / play / pause / seekTo to main.js
 */

// Path to the generated Emscripten JS loader (placed in /build/ by CMake).
// Vite serves the entire project root, so /build/frame_server.js is reachable.
const WASM_JS_URL = '/build/frame_server.js';

export class FrameServerBridge {
  constructor({ onFrame, onEnd, onError, onMetadata }) {
    this._mod        = null;   // Emscripten module instance
    this._server     = null;   // FrameServer C++ object (Embind wrapper)
    this._heapPtr    = 0;      // pointer into WASM heap for file data
    this._heapSize   = 0;

    // Playback state
    this._playing    = false;
    this._rafId      = null;
    this._lastWallMs = null;   // wall-clock time of previous rAF tick
    this._pts        = 0;      // current playback time in seconds
    this._fps        = 0;
    this._duration   = 0;
    this._width      = 0;
    this._height     = 0;

    // Callbacks
    this._onFrame    = onFrame;    // (rgba, width, height, pts) => void
    this._onEnd      = onEnd;      // () => void
    this._onError    = onError;    // (msg) => void
    this._onMetadata = onMetadata; // ({width,height,fps,duration,frameCount}) => void

    this._loadPromise = this._loadWasm();
  }

  // ── WASM loading ──────────────────────────────────────────────────────────

  async _loadWasm() {
    try {
      // Dynamically import the Emscripten ES6 module
      const { default: createModule } = await import(/* @vite-ignore */ WASM_JS_URL);
      this._mod = await createModule();
    } catch (err) {
      const msg = `Failed to load WASM module: ${err.message}\n\n` +
                  'Have you built the WASM module? See README.md for instructions.\n' +
                  'Running the dev server without a built WASM is expected during setup.';
      this._onError(msg);
      throw err;
    }
  }

  /** Wait for WASM to be ready before any operation. */
  async ready() {
    await this._loadPromise;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Open a video File object.
   * @param {File} file
   */
  async openFile(file) {
    await this.ready();
    this.pause();
    this._freeHeap();
    if (this._server) { this._server.close(); this._server.delete(); this._server = null; }

    // Read the entire file into a JS ArrayBuffer
    const arrayBuf = await file.arrayBuffer();
    const bytes    = new Uint8Array(arrayBuf);

    // Allocate WASM heap and copy bytes
    this._heapSize = bytes.byteLength;
    this._heapPtr  = this._mod.alloc_buffer(this._heapSize);
    if (!this._heapPtr) throw new Error('WASM heap allocation failed');

    // Write into WASM linear memory
    this._mod.HEAPU8.set(bytes, this._heapPtr);

    // Create and open the FrameServer
    this._server = new this._mod.FrameServer();
    const ok = this._server.open(file.name, this._heapPtr, this._heapSize);
    if (!ok) {
      this._freeHeap();
      this._server.delete();
      this._server = null;
      throw new Error('FrameServer.open() failed – unsupported format or corrupt file');
    }

    // We no longer need the heap copy (FrameServer::open() copied it internally)
    this._freeHeap();

    this._width    = this._server.get_width();
    this._height   = this._server.get_height();
    this._fps      = this._server.get_fps() || 24;
    this._duration = this._server.get_duration();
    const frameCount = this._server.get_frame_count();
    this._pts      = 0;

    this._onMetadata({
      width:      this._width,
      height:     this._height,
      fps:        this._fps,
      duration:   this._duration,
      frameCount,
    });
  }

  play() {
    if (this._playing || !this._server) return;
    this._playing    = true;
    this._lastWallMs = null;
    this._scheduleRaf();
  }

  pause() {
    this._playing = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * Seek to a position (seconds) and decode the nearest frame.
   * @param {number} seconds
   */
  seekTo(seconds) {
    if (!this._server) return;
    const wasPlaing = this._playing;
    this.pause();
    this._pts = Math.max(0, Math.min(seconds, this._duration));
    this._server.seek(this._pts);
    this._decodeSingleFrame();
    if (wasPlaing) this.play();
  }

  get isPlaying()  { return this._playing; }
  get currentPts() { return this._pts; }
  get duration()   { return this._duration; }
  get fps()        { return this._fps; }

  // ── Internal playback loop ────────────────────────────────────────────────

  _scheduleRaf() {
    this._rafId = requestAnimationFrame((now) => this._tick(now));
  }

  _tick(nowMs) {
    if (!this._playing) return;

    if (this._lastWallMs === null) this._lastWallMs = nowMs;
    const elapsed = (nowMs - this._lastWallMs) / 1000;   // seconds elapsed
    this._lastWallMs = nowMs;
    this._pts += elapsed;

    if (this._duration > 0 && this._pts >= this._duration) {
      this._pts = this._duration;
      this.pause();
      this._onEnd();
      return;
    }

    const frameData = this._server.decode_next_frame();
    if (frameData === null || frameData === undefined) {
      // Decoder returned nothing – either EOF or decode error
      this.pause();
      this._onEnd();
      return;
    }

    // decode_next_frame() returns a typed_memory_view – copy it before the
    // next call could invalidate it (the backing buffer is reused each frame).
    const copy = new Uint8ClampedArray(frameData.length);
    copy.set(frameData);

    this._onFrame(copy, this._width, this._height, this._pts);
    this._scheduleRaf();
  }

  /** Decode and display exactly one frame at the current position. */
  _decodeSingleFrame() {
    if (!this._server) return;
    const frameData = this._server.decode_next_frame();
    if (!frameData) return;
    const copy = new Uint8ClampedArray(frameData.length);
    copy.set(frameData);
    this._onFrame(copy, this._width, this._height, this._pts);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  _freeHeap() {
    if (this._heapPtr) {
      this._mod.free_buffer(this._heapPtr);
      this._heapPtr  = 0;
      this._heapSize = 0;
    }
  }

  destroy() {
    this.pause();
    if (this._server) { this._server.close(); this._server.delete(); this._server = null; }
    this._freeHeap();
  }
}
