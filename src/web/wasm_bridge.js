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

import { WebCodecsDecoder } from './webcodecs_decoder.js';

// Emscripten artifacts are in build/wasm/, served by Vite's publicDir at /wasm/.
// We load via fetch() + blob URL rather than dynamic import() to keep this file
// out of Vite's module resolver path for that URL.
const WASM_JS_URL = '/wasm/frame_server.js';

export class FrameServerBridge {
  constructor({ onFrame, onEnd, onError, onMetadata } = {}) {
    this._mod    = null;   // Emscripten module instance
    this._server = null;   // FrameServer C++ object (Embind wrapper)

    // Decode state
    this._pts      = 0;    // current decode position in seconds
    this._fps      = 0;
    this._duration = 0;
    this._width    = 0;
    this._height   = 0;

    // WebCodecs hardware decoder (null = WASM fallback)
    this._webcodecs = null;

    // Callbacks (all optional — default to noops)
    this._onFrame    = onFrame    ?? (() => {});
    this._onEnd      = onEnd      ?? (() => {});
    this._onError    = onError    ?? (() => {});
    this._onMetadata = onMetadata ?? (() => {});

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

    // Attempt to wire up a hardware WebCodecs decoder.  Non-fatal on failure.
    await this._initWebCodecs();
  }

  // ── WebCodecs hardware-decode path ───────────────────────────────────────

  async _initWebCodecs() {
    this._webcodecs = null;   // reset on each open()
    try {
      if (!WebCodecsDecoder.isSupported()) return;

      const info = this._server.get_stream_info();
      if (!info) return;

      const codecStr = WebCodecsDecoder.codecStringFromId(info.codec_id);
      if (!codecStr) return;

      const supported = await WebCodecsDecoder.isCodecSupported(codecStr);
      if (!supported) return;

      const extradata = this._server.get_extradata();   // Uint8Array or null

      const decoder = new WebCodecsDecoder();
      try {
        await decoder.init({
          codec:        codecStr,
          codedWidth:   info.width,
          codedHeight:  info.height,
          description:  extradata ?? undefined,
        });
        this._webcodecs = decoder;
        console.log(`[Bridge] WebCodecs active for codec ${codecStr} (hardware)`); // eslint-disable-line no-console
      } catch (e) {
        console.warn('[Bridge] WebCodecs init failed, falling back to WASM:', e); // eslint-disable-line no-console
        decoder.destroy();
      }
    } catch (e) {
      console.warn('[Bridge] WebCodecs init failed, using WASM fallback:', e.message); // eslint-disable-line no-console
      this._webcodecs = null;
    }
  }

  async _decodeFrameWebCodecs(targetSecs) {
    const pktData = this._server.get_encoded_packet_at(targetSecs);
    if (!pktData) return null;

    const videoFrame = await this._webcodecs.decodeChunk({
      data:      pktData.data,
      timestamp: pktData.timestamp,
      type:      pktData.is_keyframe ? 'key' : 'delta',
    });
    if (!videoFrame) return null;

    // Return a thin wrapper; caller converts to ImageBitmap before caching.
    return { videoFrame, width: videoFrame.codedWidth, height: videoFrame.codedHeight };
  }

  /**
   * Seek to a position (seconds) and decode the exact frame at that position.
   * Uses the WebCodecs hardware path when available, WASM otherwise.
   * Fires the onFrame callback when the frame is ready.
   * @param {number} seconds
   */
  async seekTo(seconds) {
    if (!this._server) return;
    this._pts = Math.max(0, Math.min(seconds, this._duration));
    const frame = await this.decodeFrameAt(this._pts);
    if (frame) this._onFrame(frame, this._pts);
  }

  /**
   * Decode and return the frame at `seconds` without firing onFrame callback.
   * Returns { videoFrame, width, height } on the hardware path (caller must
   * convert to ImageBitmap and close the VideoFrame), or a YUV frame object
   * on the WASM path.
   * @param {number} seconds
   * @returns {Promise<object|null>}
   */
  async decodeFrameAt(seconds) {
    if (!this._server) return null;
    this._pts = Math.max(0, seconds);
    if (this._webcodecs?.ready) {
      return this._decodeFrameWebCodecs(this._pts);
    }
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

  /**
   * Generate an MJPEG proxy for the open file.
   * Blocks the main thread until complete; progressCb is called synchronously
   * from within C++ with (currentFrame, totalFrames).
   * @param {number} targetWidth
   * @param {number} targetHeight
   * @param {function} [progressCb]
   * @returns {Uint8Array|null}
   */
  async generateProxy(targetWidth, targetHeight, progressCb) {
    if (!this._server) return null;
    if (progressCb) {
      this._server.set_proxy_progress_callback(progressCb);
    }
    return this._server.generate_proxy(targetWidth, targetHeight);
  }

  /** @returns {boolean} */
  hasAudio() {
    return this._server ? this._server.has_audio() : false;
  }

  /**
   * Decode ~numSamples stereo float32 samples starting at targetSecs.
   * Returns a Float32Array (interleaved L/R), or null if no audio.
   * @param {number} targetSecs
   * @param {number} [numSamples=8192]
   * @returns {Float32Array|null}
   */
  decodeAudioAt(targetSecs, numSamples = 8192) {
    if (!this._server) return null;
    return this._server.decode_audio_at(targetSecs, numSamples) || null;
  }

  get currentPts() { return this._pts; }
  get duration()   { return this._duration; }
  get fps()        { return this._fps; }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    this._webcodecs?.destroy();
    this._webcodecs = null;
    if (this._server) { this._server.close(); this._server.delete(); this._server = null; }
  }
}

// ── FrameServerPool ───────────────────────────────────────────────────────
//
// Maintains a cache of source_path → pool entry so the Program Monitor
// can decode any clip frame without re-opening the file on every seek.
// For long-GOP sources (H.264, HEVC, MPEG-2 …) a background proxy is
// generated at import time and stored in IndexedDB; subsequent imports of
// the same file load the proxy instantly.
//
// Pool entry shape:  { bridge, proxyBridge, file, info, proxyHash }

export class FrameServerPool {
  constructor() {
    this._pool          = new Map();  // source_path → entry
    this._onProxyProgress = null;
  }

  // ── Long-GOP detection ────────────────────────────────────────────────────

  /**
   * Returns true if the codec produces long-GOP or intra-only video that
   * benefits from a proxy.  Codec IDs are from the FFmpeg AVCodecID enum.
   * H264=27, HEVC=173, MPEG2VIDEO=2, MPEG4=13, MPEG1VIDEO=1, DNxHD=144, ProRes=147
   */
  static isLongGOP(codecId) {
    return [27, 173, 2, 13, 1, 144, 147].includes(codecId);
  }

  // ── File hashing for proxy cache key ─────────────────────────────────────

  /** SHA-256 of first 64 KB of file, returned as hex string. */
  static async hashFile(file) {
    const slice = file.slice(0, 65536);
    const buf   = await slice.arrayBuffer();
    const hash  = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ── IndexedDB helpers ─────────────────────────────────────────────────────

  static async _openProxyDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('nle-proxies', 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore('proxies');
      req.onsuccess       = (e) => resolve(e.target.result);
      req.onerror         = reject;
    });
  }

  static async _loadProxy(hash) {
    const db = await FrameServerPool._openProxyDB();
    return new Promise((resolve) => {
      const tx  = db.transaction('proxies', 'readonly');
      const req = tx.objectStore('proxies').get(hash);
      req.onsuccess = (e) => resolve(e.target.result ?? null);
      req.onerror   = () => resolve(null);
    });
  }

  static async _storeProxy(hash, blob) {
    const db = await FrameServerPool._openProxyDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('proxies', 'readwrite');
      tx.objectStore('proxies').put(blob, hash);
      tx.oncomplete = resolve;
      tx.onerror    = reject;
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Open a File and add it to the pool, keyed by file.name.
   * For long-GOP sources: checks IndexedDB for a cached proxy, then either
   * loads it immediately or queues background generation.
   * No-op if already loaded.
   * @param {File} file
   */
  async addFile(file) {
    if (this._pool.has(file.name)) return;

    const bridge = new FrameServerBridge();
    await bridge.ready();
    await bridge.openFile(file);

    const info = bridge.getStreamInfo();
    const entry = { bridge, proxyBridge: null, file, info, proxyHash: null };
    this._pool.set(file.name, entry);

    // MXF always gets a proxy regardless of codec (MPEG-2, DNxHD, ProRes all need it).
    const isMxf = file.name.toLowerCase().endsWith('.mxf');
    if (info && (FrameServerPool.isLongGOP(info.codec_id) || isMxf)) {
      const hash = await FrameServerPool.hashFile(file);
      entry.proxyHash = hash;

      // 5-second timeout on IDB lookup — a hung IDB should not block proxy generation.
      let proxyBlob = null;
      try {
        proxyBlob = await Promise.race([
          FrameServerPool._loadProxy(hash),
          new Promise((_, reject) => setTimeout(() => reject(new Error('IDB timeout')), 5000)),
        ]);
      } catch (err) {
        if (err.message !== 'IDB timeout') {
          console.warn('[FrameServerPool] IDB lookup error:', err); // eslint-disable-line no-console
        }
        proxyBlob = null;
      }
      if (proxyBlob) {
        // Proxy already in cache — open it immediately
        try {
          const proxyBridge = new FrameServerBridge();
          await proxyBridge.ready();
          await proxyBridge.openFile(
            new File([proxyBlob], 'proxy.mjpeg', { type: 'video/x-mjpeg' })
          );
          entry.proxyBridge = proxyBridge;
        } catch (err) {
          console.warn('[FrameServerPool] Failed to open cached proxy:', err); // eslint-disable-line no-console
        }
      } else {
        // Generate proxy in the background
        this._generateProxyBackground(file.name);
      }
    }
  }

  /**
   * Background proxy generation for a long-GOP source.
   * Scales to at most 960 px wide, preserving aspect ratio.
   * @param {string} path  key in this._pool
   */
  async _generateProxyBackground(path) {
    const entry = this._pool.get(path);
    if (!entry) return;

    const { info } = entry;
    const scale  = Math.min(1, 960 / info.width);
    const proxyW = Math.round(info.width  * scale / 2) * 2;
    const proxyH = Math.round(info.height * scale / 2) * 2;

    this._onProxyProgress?.(path, 0, 1);

    let proxyData;
    try {
      proxyData = await entry.bridge.generateProxy(proxyW, proxyH, (cur, total) => {
        this._onProxyProgress?.(path, cur, total);
      });
    } catch (err) {
      console.warn('[FrameServerPool] Proxy generation error:', err); // eslint-disable-line no-console
      return;
    }

    if (!proxyData || proxyData.length === 0) return;

    const proxyBlob = new Blob([proxyData], { type: 'video/x-mjpeg' });

    try {
      await FrameServerPool._storeProxy(entry.proxyHash, proxyBlob);
    } catch (err) {
      console.warn('[FrameServerPool] Failed to store proxy in IndexedDB:', err); // eslint-disable-line no-console
    }

    // Open the proxy bridge
    try {
      const proxyBridge = new FrameServerBridge();
      await proxyBridge.ready();
      await proxyBridge.openFile(
        new File([proxyBlob], 'proxy.mjpeg', { type: 'video/x-mjpeg' })
      );
      entry.proxyBridge = proxyBridge;
    } catch (err) {
      console.warn('[FrameServerPool] Failed to open generated proxy:', err); // eslint-disable-line no-console
      return;
    }

    this._onProxyProgress?.(path, 1, 1);
  }

  /**
   * Setter for the proxy-progress callback.
   * Called with (path, currentFrame, totalFrames).
   */
  set onProxyProgress(cb) { this._onProxyProgress = cb; }

  /**
   * Return stored stream info for a loaded source path.
   * @param {string} sourcePath
   * @returns {object|null}
   */
  getInfo(sourcePath) {
    return this._pool.get(sourcePath)?.info ?? null;
  }

  /**
   * Check if a source path is loaded.
   * @param {string} sourcePath
   * @returns {boolean}
   */
  has(sourcePath) {
    return this._pool.has(sourcePath);
  }

  /**
   * Decode the frame at `seconds` from the given source.
   * Uses the proxy bridge when available (and useProxy is true).
   * On the WebCodecs hardware path returns { videoFrame, width, height };
   * on the WASM path returns a YUV frame object.
   * Returns null if the source is not loaded.
   * @param {string} sourcePath
   * @param {number} seconds
   * @param {boolean} [useProxy=true]
   * @returns {Promise<object|null>}
   */
  async decodeFrameAt(sourcePath, seconds, useProxy = true) {
    const entry = this._pool.get(sourcePath);
    if (!entry) return null;
    const bridge = (useProxy && entry.proxyBridge) ? entry.proxyBridge : entry.bridge;
    return bridge.decodeFrameAt(seconds);
  }

  /**
   * Get the FrameServerBridge for a loaded source (for reading metadata).
   * @param {string} sourcePath
   * @returns {FrameServerBridge|null}
   */
  getBridge(sourcePath) {
    return this._pool.get(sourcePath)?.bridge ?? null;
  }

  /**
   * Decode audio samples from a loaded source at targetSecs.
   * @param {string} sourcePath
   * @param {number} targetSecs
   * @param {number} [numSamples=8192]
   * @returns {Float32Array|null}
   */
  decodeAudioAt(sourcePath, targetSecs, numSamples = 8192) {
    const bridge = this._pool.get(sourcePath)?.bridge;
    if (!bridge) return null;
    return bridge.decodeAudioAt(targetSecs, numSamples);
  }

  /**
   * Remove all bridges from the pool.
   */
  destroy() {
    for (const entry of this._pool.values()) {
      entry.bridge?.destroy();
      entry.proxyBridge?.destroy();
    }
    this._pool.clear();
  }
}
