/**
 * wasm_bridge.js – JS bridge around the Emscripten WASM FrameServer module
 *
 * Responsibilities:
 *  - Load and instantiate the WASM module
 *  - Copy file bytes into WASM heap via alloc_buffer / free_buffer
 *  - Drive playback via requestAnimationFrame
 *  - Expose openFile / play / pause / seekTo to main.js
 *
 * Naming note: this file is intentionally NOT called frame_server.js.
 * The Emscripten-generated loader is also called frame_server.js (served at
 * /wasm/frame_server.js via Vite's publicDir).  Sharing the base name caused
 * Vite to serve the Emscripten file when the bridge was imported, breaking
 * the module graph.  Different base names eliminate the collision permanently.
 */

// Emscripten artifacts are in build/wasm/, served by Vite's publicDir at /wasm/.
// We load via fetch() + blob URL rather than dynamic import() to keep this file
// out of Vite's module resolver path for that URL.
const WASM_JS_URL = '/wasm/frame_server.js';

export class FrameServerBridge {
  constructor({ onFrame, onEnd, onError, onMetadata }) {
    this._mod    = null;   // Emscripten module instance
    this._server = null;   // FrameServer C++ object (Embind wrapper)

    // Decode state
    this._pts      = 0;    // current decode position in seconds
    this._fps      = 0;
    this._duration = 0;
    this._width    = 0;
    this._height   = 0;

    // Callbacks
    this._onFrame    = onFrame;    // (frame, pts) => void
    this._onEnd      = onEnd;      // () => void
    this._onError    = onError;    // (msg) => void
    this._onMetadata = onMetadata; // ({width,height,fps,duration,frameCount}) => void

    this._loadPromise = this._loadWasm();
  }

  // ── WASM loading ──────────────────────────────────────────────────────────

  async _loadWasm() {
    try {
      // 1. Fetch the Emscripten JS loader as plain text.
      //    fetch() bypasses Vite's module resolver entirely.
      const res = await fetch(WASM_JS_URL);
      if (!res.ok) {
        throw new Error(
          `GET ${WASM_JS_URL} → HTTP ${res.status}. ` +
          'Have you run scripts/build_wasm.sh? (see README.md)'
        );
      }
      const src = await res.text();

      // 2. Wrap in a blob URL so import() treats it as an external module.
      //    A blob URL is same-origin, compatible with COEP, and invisible to
      //    Vite's module graph — no circular-import risk.
      const blobUrl = URL.createObjectURL(
        new Blob([src], { type: 'application/javascript' })
      );
      let createModule;
      try {
        ({ default: createModule } = await import(/* @vite-ignore */ blobUrl));
      } finally {
        // Release the blob immediately; the module is already parsed.
        URL.revokeObjectURL(blobUrl);
      }

      // 3. Instantiate.  Pass locateFile so Emscripten fetches the .wasm from
      //    the right URL rather than resolving relative to the blob URL.
      let swscaleWarned = false;
      this._mod = await createModule({
        locateFile: (name) => `/wasm/${name}`,
        print:    () => {},
        printErr: (msg) => {
          if (msg.includes('No accelerated colorspace conversion')) {
            if (!swscaleWarned) {
              console.info('[FrameServer] Using software YUV→RGBA conversion (normal in WASM)'); // eslint-disable-line no-console
              swscaleWarned = true;
            }
            return;
          }
          console.warn('[FrameServer]', msg); // eslint-disable-line no-console
        },
      });
    } catch (err) {
      const msg = `WASM init failed: ${err.message}`;
      console.error('[FrameServerBridge]', err); // eslint-disable-line no-console
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
    if (this._server) { this._server.close(); this._server.delete(); this._server = null; }

    // Read file into a Uint8Array and pass it directly to the C++ open() via
    // Embind — no manual WASM heap management needed.
    const bytes = new Uint8Array(await file.arrayBuffer());

    this._server = new this._mod.FrameServer();
    const ok = this._server.open(file.name, bytes);
    if (!ok) {
      this._server.delete();
      this._server = null;
      throw new Error('FrameServer.open() failed – unsupported format or corrupt file');
    }

    const w = this._server.get_width();
    const h = this._server.get_height();
    if (w === 0 || h === 0) {
      this._server.close();
      this._server.delete();
      this._server = null;
      throw new Error(`Invalid video dimensions: ${w}×${h}`);
    }

    this._width    = w;
    this._height   = h;
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

  /**
   * Seek to a position (seconds) and decode the exact frame at that position.
   * Uses decode_frame_at() which seeks to the preceding keyframe, flushes the
   * codec, then decodes forward until reaching the target PTS — giving accurate
   * frame-level seek for long-GOP codecs like MPEG-2.
   * @param {number} seconds
   */
  seekTo(seconds) {
    if (!this._server) return;
    this._pts = Math.max(0, Math.min(seconds, this._duration));
    const frame = this._server.decode_frame_at(this._pts);
    if (frame) this._onFrame(frame, this._pts);
  }

  /**
   * Decode and return the frame at `seconds` without firing onFrame callback.
   * Used by FrameServerPool to decode a specific source clip frame for the
   * Program Monitor's timeline playback.
   * @param {number} seconds
   * @returns {object|null} YUV frame object, or null on error
   */
  decodeFrameAt(seconds) {
    if (!this._server) return null;
    this._pts = Math.max(0, seconds);
    return this._server.decode_frame_at(this._pts) || null;
  }

  /**
   * Return stream metadata from the currently open file.
   * Must be called after openFile() succeeds.
   * @returns {object|null}
   */
  getStreamInfo() {
    if (!this._server) return null;
    return this._server.get_stream_info();
  }

  get currentPts() { return this._pts; }
  get duration()   { return this._duration; }
  get fps()        { return this._fps; }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    if (this._server) { this._server.close(); this._server.delete(); this._server = null; }
  }
}

// ── FrameServerPool ───────────────────────────────────────────────────────
//
// Maintains a cache of source_path → FrameServerBridge so the Program Monitor
// can decode any clip frame without re-opening the file on every seek.
//
// Usage:
//   const pool = new FrameServerPool();
//   await pool.addFile(file);                    // adds by file.name as key
//   const frame = pool.decodeFrameAt(path, sec); // null if path not loaded

export class FrameServerPool {
  constructor() {
    this._bridges = new Map();  // source_path → FrameServerBridge
    this._infos   = new Map();  // source_path → stream info object
  }

  /**
   * Open a File and add it to the pool, keyed by file.name.
   * No-op if already loaded.
   * @param {File} file
   */
  async addFile(file) {
    if (this._bridges.has(file.name)) return;

    const bridge = new FrameServerBridge({
      onFrame:    () => {},
      onEnd:      () => {},
      onError:    () => {},
      onMetadata: () => {},
    });

    await bridge.ready();
    await bridge.openFile(file);
    this._bridges.set(file.name, bridge);
    this._infos.set(file.name, bridge.getStreamInfo());
  }

  /**
   * Return stored stream info for a loaded source path.
   * @param {string} sourcePath
   * @returns {object|null}
   */
  getInfo(sourcePath) {
    return this._infos.get(sourcePath) ?? null;
  }

  /**
   * Check if a source path is loaded.
   * @param {string} sourcePath
   * @returns {boolean}
   */
  has(sourcePath) {
    return this._bridges.has(sourcePath);
  }

  /**
   * Decode the frame at `seconds` from the given source.
   * Returns the YUV frame object, or null if source is not loaded.
   * @param {string} sourcePath
   * @param {number} seconds
   * @returns {object|null}
   */
  decodeFrameAt(sourcePath, seconds) {
    const bridge = this._bridges.get(sourcePath);
    if (!bridge) return null;
    return bridge.decodeFrameAt(seconds);
  }

  /**
   * Remove all bridges from the pool.
   */
  destroy() {
    for (const bridge of this._bridges.values()) bridge.destroy();
    this._bridges.clear();
    this._infos.clear();
  }
}
