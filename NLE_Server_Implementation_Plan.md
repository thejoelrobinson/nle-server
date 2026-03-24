# NLE Server — Phase 3+ Implementation Plan
*Engineering spec for mixed-codec, mixed-framerate, mixed-colorspace timeline playback*

---

## Executive Summary

NLE Server currently works as a single-format prototype: clips are assumed to share the sequence framerate and colorspace, frame decoding is always done on-demand from full-resolution source, and the BT.601 color matrix is hardcoded for every clip. This plan extends the engine across six phases to become a production-capable multi-format NLE — starting with the foundational PTS remapping needed for mixed-framerate timelines (Phase 3A), adding per-clip colorspace awareness (3B), a proxy workflow to make long-GOP editing responsive (3C), a frame prefetch cache for smooth playback (3D), an audio engine (3E), and finally an export pipeline (3F). Phases 3A–3C form the critical path; they must be completed in order. 3D–3F can be parallelized once 3A–3C are stable.

---

## Current Architecture Baseline

```
Sequence (30fps, 1920×1080)
  └─ Track V1
       └─ ClipRef { source_path, source_in_pts, source_out_pts, timeline_in_pts, timeline_out_pts }

resolve_frame(seq_pts)
  → offset = seq_pts - timeline_in_pts
  → source_pts = source_in_pts + offset   ← direct µs addition, NO timebase conversion
  → FrameServerPool.decodeFrameAt(path, source_pts)
  → player.drawFrame(yuv)                 ← BT.601 hardcoded
```

**Critical gap:** `source_in_pts + offset` works only when the clip's native timebase happens to equal the sequence timebase. Any 24fps clip on a 30fps sequence will play at the wrong speed and seek to wrong frames.

---

## Phase 3A — Frame Rate Remapping
**Complexity:** M | **Prerequisite:** none | **Estimated time:** 1–2 days

### What it fixes
A 24fps clip placed on a 30fps sequence currently seeks to the wrong source frame on every decode call. This phase adds proper timebase-aware PTS remapping using FFmpeg's `av_rescale_q`.

### New data in `ClipRef`

**`src/core/timeline_engine.cpp` and `timeline_engine.h`:**

```cpp
struct ClipRef {
    std::string clip_id;
    std::string source_path;
    int64_t source_in_pts;
    int64_t source_out_pts;
    int64_t timeline_in_pts;
    int64_t timeline_out_pts;
    int track_index;

    // ADD THESE:
    int fps_num = 30;           // clip's native frame rate numerator
    int fps_den = 1;            // clip's native frame rate denominator
    int tb_num = 1;             // clip's native timebase numerator
    int tb_den = 90000;         // clip's native timebase denominator (e.g. 90000 for MPEG, 12800 for ProRes)
};
```

### New function in `frame_server.cpp`

```cpp
// Add to FrameServer public interface:
emscripten::val get_stream_info();
```

Implementation: after `avcodec_open2()` succeeds, return:
```cpp
emscripten::val info = emscripten::val::object();
info.set("fps_num",    (int)_video_stream->r_frame_rate.num);
info.set("fps_den",    (int)_video_stream->r_frame_rate.den);
info.set("tb_num",     (int)_video_stream->time_base.num);
info.set("tb_den",     (int)_video_stream->time_base.den);
info.set("width",      _codec_ctx->width);
info.set("height",     _codec_ctx->height);
info.set("color_primaries",           (int)_codec_ctx->color_primaries);
info.set("color_trc",                 (int)_codec_ctx->color_trc);
info.set("colorspace",                (int)_codec_ctx->colorspace);
return info;
```

Register in `bindings.cpp`:
```cpp
.function("get_stream_info", &FrameServer::get_stream_info)
```

### Update `wasm_bridge.js`

```js
// In WasmBridge, add after open():
async getStreamInfo() {
    return this._server.get_stream_info();
}

// In FrameServerPool.register():
async register(path, file) {
    const bridge = new WasmBridge();
    await bridge.open(file);
    const info = await bridge.getStreamInfo();
    this._pool.set(path, { bridge, file, info });   // store info alongside bridge
}

// New accessor:
getInfo(path) {
    return this._pool.get(path)?.info ?? null;
}
```

### Fix `resolve_frame()` in `timeline_engine.cpp`

Current (broken for mixed framerates):
```cpp
int64_t offset = seq_pts - clip.timeline_in_pts;
int64_t source_pts = clip.source_in_pts + offset;
```

Replace with:
```cpp
// seq_pts is in sequence timebase: {1, 1_000_000} (microseconds)
// clip.tb_num / clip.tb_den is the clip's native timebase
int64_t seq_tb_num = 1, seq_tb_den = 1000000;

// Step 1: offset in sequence timebase (µs)
int64_t offset_seq = seq_pts - clip.timeline_in_pts;

// Step 2: rescale offset to clip timebase
int64_t offset_clip = av_rescale_q(
    offset_seq,
    AVRational{(int)seq_tb_num, (int)seq_tb_den},  // from: sequence timebase
    AVRational{clip.tb_num, clip.tb_den}            // to:   clip timebase
);

// Step 3: add to clip's in-point (already in clip timebase)
int64_t source_pts = clip.source_in_pts + offset_clip;
```

> **Why av_rescale_q?** It uses 128-bit intermediate arithmetic to avoid overflow on large PTS values, and correctly handles rational timebases like `{1, 12800}` (ProRes) or `{1, 90000}` (MPEG-2).

### JS-side update in `playback.js`

`_decodeAndDisplay(pts)` already calls `engine.resolve_frame()` and gets back `{source_path, source_pts}`. No changes needed here — the remapping happens inside `resolve_frame()`. The returned `source_pts` is now correctly in the clip's native timebase.

The C++ `decode_frame_at(target_seconds)` takes seconds (double), so:
```js
const sourceSecs = sourcePts / pool.getInfo(path).tb_den;
await bridge.decodeFrameAt(sourceSecs);
```

Update `decodeFrameAt` in `wasm_bridge.js` to accept seconds directly (it already does — `double target_seconds` in C++) ✓

### JSON serialization update

In `timeline_engine.cpp`, update `ClipRef` to/from JSON:
```cpp
j["fps_num"] = clip.fps_num;
j["fps_den"] = clip.fps_den;
j["tb_num"]  = clip.tb_num;
j["tb_den"]  = clip.tb_den;

// from JSON (with defaults for old project files):
clip.fps_num = j.value("fps_num", 30);
clip.fps_den = j.value("fps_den", 1);
clip.tb_num  = j.value("tb_num",  1);
clip.tb_den  = j.value("tb_den",  1000000);
```

### Test criteria
1. Import a 24fps clip into a 30fps sequence. Scrub through it — frames should advance at the correct rate (every 1/24s of source content = 1/30s of timeline time).
2. Import a 60fps clip. Fast-motion content should play back in slow motion on the 30fps timeline (correct behavior — the clip is "slower" than the sequence).
3. Existing MOV/MXF files that previously worked must continue to work.

---

## Phase 3B — Colorspace Pipeline
**Complexity:** M | **Prerequisite:** Phase 3A (for `get_stream_info`) | **Estimated time:** 1–2 days

### What it fixes
All clips currently use BT.601 matrix regardless of source. HD content (1080p+) should use BT.709. 4K HDR content needs BT.2020. Wrong matrix = washed-out or oversaturated color.

### New data in `ClipRef`

```cpp
struct ClipRef {
    // ... existing fields ...
    // ADD:
    int color_primaries = 1;     // AVCOL_PRI_BT709 = 1, BT601=5, BT2020=9
    int color_trc = 1;           // Transfer characteristics (AVCOL_TRC_*)
    int colorspace = 1;          // Matrix coefficients (AVCOL_SPC_BT709=1, BT601=5)
};
```

Populate from `get_stream_info()` at import time in `FrameServerPool.register()`.

### WebGL shader rewrite in `player.js`

Current fragment shader (BT.601 hardcoded):
```glsl
float r = y + 1.402 * v;
float g = y - 0.344 * u - 0.714 * v;
float b = y + 1.772 * u;
```

New shader with `uColorspace` uniform:
```glsl
precision mediump float;
uniform sampler2D uTexY;
uniform sampler2D uTexU;
uniform sampler2D uTexV;
uniform int uColorspace;   // 0=BT601, 1=BT709, 2=BT2020
varying vec2 vTexCoord;

void main() {
    float y = texture2D(uTexY, vTexCoord).r - 0.0625;
    float u = texture2D(uTexU, vTexCoord).r - 0.5;
    float v = texture2D(uTexV, vTexCoord).r - 0.5;

    float r, g, b;

    if (uColorspace == 1) {
        // BT.709 (HD)
        r = 1.164 * y + 1.793 * v;
        g = 1.164 * y - 0.213 * u - 0.533 * v;
        b = 1.164 * y + 2.112 * u;
    } else if (uColorspace == 2) {
        // BT.2020 (UHD/HDR)
        r = 1.164 * y + 1.678 * v;
        g = 1.164 * y - 0.188 * u - 0.652 * v;
        b = 1.164 * y + 2.163 * u;
    } else {
        // BT.601 (SD, default)
        r = 1.164 * y + 1.596 * v;
        g = 1.164 * y - 0.392 * u - 0.813 * v;
        b = 1.164 * y + 2.017 * u;
    }

    gl_FragColor = vec4(clamp(r, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(b, 0.0, 1.0), 1.0);
}
```

### Update `drawFrame()` in `player.js`

```js
// Add colorspace parameter:
drawFrame({ y, u, v, width, height, strideY, strideU, strideV, colorspace = 0 }) {
    // ... existing texture upload code ...

    // Set colorspace uniform before draw:
    const uColorspace = this._gl.getUniformLocation(this._program, 'uColorspace');
    this._gl.uniform1i(uColorspace, colorspace);

    // ... existing drawArrays call ...
}
```

Cache the uniform location in `_initGL()` to avoid repeated lookups per frame.

### Wire colorspace through `playback.js`

`_decodeAndDisplay(pts)`:
```js
const resolved = this._engine.resolve_frame(this._sequenceId, pts);
if (!resolved) return;

const info = this._pool.getInfo(resolved.source_path);
const colorspace = mapFFmpegColorspace(info?.colorspace ?? 5); // default BT.601

const frame = await bridge.decodeFrameAt(sourceSecs);
this._player.drawFrame({ ...frame, colorspace });
```

```js
function mapFFmpegColorspace(avcol_spc) {
    // AVCOL_SPC_BT709 = 1, AVCOL_SPC_SMPTE170M = 5 (BT.601), AVCOL_SPC_BT2020_NCL = 9
    if (avcol_spc === 1) return 1;   // BT.709
    if (avcol_spc === 9) return 2;   // BT.2020
    return 0;                         // BT.601 default
}
```

### Test criteria
1. Import a 1080p H.264 clip. Colors should render with BT.709 matrix (slightly more saturated than before on skin tones).
2. Import an SD clip (480p/576p). Should use BT.601 — no visible regression from current behavior.
3. Shader compiles and runs on both Firefox and Chrome WebGL1.

---

## Phase 3C — Proxy Workflow
**Complexity:** XL | **Prerequisite:** Phase 3A | **Estimated time:** 3–5 days

### What it fixes
Long-GOP codecs (H.264, HEVC, MPEG-2) require decoding from the nearest keyframe on every seek. At 30fps on a typical H.264 file with GOP size 60–120, every frame seek decodes 30–120 frames just to reach the target. This is why scrubbing feels sluggish. Proxies replace the source with an intra-frame codec (MJPEG) so every frame is a keyframe — seek is O(1).

### Architecture

```
Import time:
  File → FrameServer.open() → check codec_id → if long-GOP:
    → generate_proxy() → MJPEG Blob → store in IndexedDB

Playback time:
  resolve_frame() → path → FrameServerPool:
    → if proxy exists: use ProxyBridge.decodeFrameAt()
    → else: use SourceBridge.decodeFrameAt()

Export time:
  Always: SourceBridge.decodeFrameAt() (full resolution, lossless source)
```

### New C++ function in `frame_server.cpp`

```cpp
// Returns MJPEG data as a JS Uint8Array, or null on failure
emscripten::val generate_proxy(int target_width, int target_height, int quality);
```

Implementation outline:
1. Seek to beginning (`av_seek_frame(..., 0, AVSEEK_FLAG_BACKWARD)`)
2. Allocate output `AVFormatContext` with MJPEG muxer in memory buffer
3. For each decoded YUV frame: scale to `target_width × target_height` via `sws_scale`; encode as MJPEG; write to buffer
4. Return accumulated buffer as `emscripten::val` typed array

This will be slow (minutes for long clips) — must run in a background task with progress reporting.

### Progress callback via Embind

```cpp
// In FrameServer:
void set_progress_callback(emscripten::val cb);

// During generate_proxy():
if (_progress_cb.typeOf().as<std::string>() != "undefined") {
    _progress_cb(frame_index, total_frames);
}
```

```js
bridge.server.set_progress_callback((current, total) => {
    const pct = Math.round((current / total) * 100);
    document.querySelector('#proxy-progress').textContent = `Generating proxy: ${pct}%`;
});
```

### IndexedDB proxy storage in `project.js`

```js
const PROXY_STORE = 'proxies';

async function storeProxy(fileHash, mjpegBlob) {
    const db = await openDB();
    const tx = db.transaction(PROXY_STORE, 'readwrite');
    await tx.objectStore(PROXY_STORE).put(mjpegBlob, fileHash);
}

async function loadProxy(fileHash) {
    const db = await openDB();
    return db.transaction(PROXY_STORE).objectStore(PROXY_STORE).get(fileHash);
}
```

File hash: SHA-256 of first 64KB of source file (fast, sufficient for identity). Use `crypto.subtle.digest('SHA-256', slice)`.

### `FrameServerPool` dual-bridge support

```js
// In FrameServerPool:
async register(path, file) {
    const sourceBridge = new WasmBridge();
    await sourceBridge.open(file);
    const info = await sourceBridge.getStreamInfo();

    let proxyBridge = null;
    if (isLongGOP(info.codec_id)) {
        const hash = await hashFile(file);
        const proxyBlob = await loadProxy(hash);
        if (proxyBlob) {
            proxyBridge = new WasmBridge();
            await proxyBridge.open(new File([proxyBlob], 'proxy.mjpeg'));
        } else {
            // Queue background proxy generation
            this._proxyQueue.push({ path, file, hash, sourceBridge });
        }
    }

    this._pool.set(path, { sourceBridge, proxyBridge, file, info });
}

// During playback:
async decodeFrameAt(path, sourceSecs, useProxy = true) {
    const entry = this._pool.get(path);
    const bridge = (useProxy && entry.proxyBridge) ? entry.proxyBridge : entry.sourceBridge;
    return bridge.decodeFrameAt(sourceSecs);
}
```

### Long-GOP detection helper

```js
// codec_id values from FFmpeg's AVCodecID enum
const LONG_GOP_CODECS = new Set([
    27,   // AV_CODEC_ID_H264
    173,  // AV_CODEC_ID_HEVC
    4,    // AV_CODEC_ID_MPEG2VIDEO
    13,   // AV_CODEC_ID_MPEG4
]);

function isLongGOP(codec_id) {
    return LONG_GOP_CODECS.has(codec_id);
}
```

Add `codec_id` to `get_stream_info()` in C++:
```cpp
info.set("codec_id", (int)_codec_ctx->codec_id);
```

### Proxy resolution table

| Source resolution | Proxy resolution |
|-------------------|-----------------|
| 4K (3840×2160)    | 960×540         |
| 2K (2048×1152)    | 512×288         |
| 1080p             | 480×270         |
| 720p              | 360×202         |

Preserve aspect ratio. Round to nearest even number (required by most YUV formats).

### Test criteria
1. Import an H.264 MOV. Proxy generation progress bar appears. After completion, scrubbing is visibly faster.
2. Export a sequence — verify source frames are used (not proxy) by checking output resolution.
3. Re-open project with same file — proxy loads from IndexedDB without re-generating.
4. Import a ProRes file — no proxy generated (it's already intra-frame).

---

## Phase 3D — Frame Prefetch Cache
**Complexity:** M | **Prerequisite:** Phase 3A, 3C | **Estimated time:** 1–2 days

### What it fixes
Even with proxies, the decode → display path is synchronous per frame. At 30fps, each frame has ~33ms budget. With prefetch, frames are decoded speculatively 4–8 frames ahead, so the display callback just does a cache lookup.

### `FrameCache` class (new file: `src/web/frame_cache.js`)

```js
export class FrameCache {
    constructor(maxSize = 30) {
        this._cache = new Map();   // key: `${path}:${pts}` → {frame, pts, insertedAt}
        this._maxSize = maxSize;
    }

    set(path, pts, frame) {
        const key = `${path}:${pts}`;
        this._cache.set(key, { frame, pts, insertedAt: performance.now() });
        if (this._cache.size > this._maxSize) this._evictOldest();
    }

    get(path, pts) {
        return this._cache.get(`${path}:${pts}`)?.frame ?? null;
    }

    _evictOldest() {
        let oldestKey = null, oldestTime = Infinity;
        for (const [key, entry] of this._cache) {
            if (entry.insertedAt < oldestTime) {
                oldestTime = entry.insertedAt;
                oldestKey = key;
            }
        }
        if (oldestKey) this._cache.delete(oldestKey);
    }

    clear() { this._cache.clear(); }
}
```

### Prefetch logic in `playback.js`

```js
// Add to Playback constructor:
this._cache = new FrameCache(30);
this._prefetchQueue = [];
this._prefetchInflight = false;

// In _tick():
await this._decodeAndDisplay(this._playheadPts);
this._schedulePrefetch(this._playheadPts, 6);  // prefetch 6 frames ahead

// New method:
_schedulePrefetch(currentPts, lookahead) {
    if (this._prefetchInflight) return;
    const frameDuration = 1_000_000 / this._fps;

    this._prefetchInflight = true;
    (async () => {
        for (let i = 1; i <= lookahead; i++) {
            const futurePts = currentPts + i * frameDuration;
            if (futurePts > this._duration) break;

            const resolved = this._engine.resolve_frame(this._sequenceId, futurePts);
            if (!resolved) continue;

            const cached = this._cache.get(resolved.source_path, resolved.source_pts);
            if (cached) continue;  // already have it

            const frame = await this._pool.decodeFrameAt(resolved.source_path, resolved.source_pts / 1e6);
            this._cache.set(resolved.source_path, resolved.source_pts, frame);
        }
        this._prefetchInflight = false;
    })();
}
```

### Updated `_decodeAndDisplay()` with cache check

```js
async _decodeAndDisplay(pts) {
    try {
        const resolved = this._engine.resolve_frame(this._sequenceId, pts);
        if (!resolved) return;

        const info = this._pool.getInfo(resolved.source_path);
        const colorspace = mapFFmpegColorspace(info?.colorspace ?? 5);

        // Cache hit path (fast):
        let frame = this._cache.get(resolved.source_path, resolved.source_pts);

        // Cache miss path (decode):
        if (!frame) {
            const sourceSecs = resolved.source_pts / (info?.tb_den ?? 1_000_000);
            frame = await this._pool.decodeFrameAt(resolved.source_path, sourceSecs);
            this._cache.set(resolved.source_path, resolved.source_pts, frame);
        }

        this._player.drawFrame({ ...frame, colorspace });
    } catch (e) {
        console.warn('[Playback] decode error:', e);
    }
}
```

### Cache invalidation

Clear cache on:
- Seek/scrub: `this._cache.clear()` in `setPlayheadPts()`
- File re-import
- Proxy generation complete (proxies may yield different frame data)

### Test criteria
1. Press play on a sequence — after first few frames, CPU usage drops as cache hits replace decodes.
2. Seek to a new position — no stale frames from old position are displayed.
3. Cache size stays bounded at 30 frames (verify via `console.log(cache._cache.size)`).

---

## Phase 3E — Audio Engine
**Complexity:** XL | **Prerequisite:** Phase 3A | **Estimated time:** 3–5 days

### Architecture

```
timeline_engine.resolve_audio(seq_pts) → {source_path, source_pts, gain}
  → FrameServerPool.decodeAudioAt(path, pts, numSamples)
  → returns Float32Array (interleaved stereo)
  → AudioWorklet pushes to ring buffer
  → AudioContext master clock drives video sync
```

### New C++ in `frame_server.cpp`

```cpp
struct AudioFrame {
    std::vector<float> samples;  // interleaved stereo, float32
    int sample_rate;
    int channels;
    int num_samples;
};

emscripten::val decode_audio_at(double target_seconds, int num_samples);
```

Key implementation points:
- Seek to `target_seconds` on the audio stream (separate seek from video)
- Decode `AVFrame` via `avcodec_receive_frame()` on audio decoder
- Convert to float planar via `swr_convert` (libswresample, already in WASM build if `--enable-swresample` was included)
- Return as `Float32Array` via `emscripten::typed_memory_view`

Add `--enable-swresample --enable-decoder=pcm_s16le,pcm_s24le,aac,mp3,ac3` to `build_ffmpeg.sh`.

### Audio track in `timeline_engine.cpp`

Add to `ClipRef`:
```cpp
float gain = 1.0f;    // 0.0 to 2.0
bool muted = false;
```

Add `resolve_audio(seq_id, seq_pts)` analogous to `resolve_frame()`.

### AudioWorklet (`src/web/audio_engine.js`)

```js
export class AudioEngine {
    constructor() {
        this._ctx = null;
        this._worklet = null;
    }

    async init() {
        this._ctx = new AudioContext({ sampleRate: 48000 });
        await this._ctx.audioWorklet.addModule('/audio_processor.js');
        this._worklet = new AudioWorkletNode(this._ctx, 'nle-processor');
        this._worklet.connect(this._ctx.destination);
    }

    // Called from playback _tick():
    pushSamples(float32Array) {
        this._worklet.port.postMessage({ samples: float32Array }, [float32Array.buffer]);
    }

    get currentTime() { return this._ctx?.currentTime ?? 0; }
}
```

### A/V Sync

Replace `performance.now()` as master clock with `AudioContext.currentTime`:

In `playback.js`:
```js
_tick(now) {
    const audioTime = this._audioEngine.currentTime;
    // Drift correction: if video is >2 frames behind audio, skip ahead
    const drift = audioTime - this._playheadPts / 1_000_000;
    if (drift > 2 * this._frameDuration / 1_000_000) {
        this._playheadPts += drift * 1_000_000;
    }
    // ... rest of tick
}
```

### Test criteria
1. Play a clip with audio — audio plays in sync with video.
2. Mute A1 track — audio goes silent, video continues.
3. Seek while playing — audio and video both jump to correct position without glitching.

---

## Phase 3F — Export Pipeline
**Complexity:** XL | **Prerequisite:** All previous phases | **Estimated time:** 4–7 days

### Architecture

```
JS: exportSequence(sequenceId, outputFormat)
  → C++: render_sequence(seq_id, frame_callback)
       → for each frame in sequence:
            → resolve_frame() → decode (always source, not proxy)
            → composite (future: multiple video tracks)
            → return RGBA frame to JS via callback
  → JS: encode frames via MediaRecorder or WebCodecs (future)
  → JS: download resulting file
```

### New C++ function

```cpp
// Calls JS callback for each rendered frame
void render_sequence(const std::string& seq_id,
                     emscripten::val frame_callback,
                     emscripten::val progress_callback);
```

For each frame:
1. Walk all video tracks in track order (V3 bottom, V1 top — Premiere compositing order)
2. `resolve_frame()` for each track at this PTS
3. Decode via `FrameServerPool` (JS callback into C++ — use `emscripten::val::call`)
4. Composite (for now: only top non-null clip rendered — no alpha compositing yet)
5. Call `frame_callback` with YUV data

### JS export controller (`src/web/export.js`)

```js
export async function exportSequence(engine, pool, player, sequenceId) {
    const seq = JSON.parse(engine.get_sequence_json(sequenceId));
    const fps = seq.fps_num / seq.fps_den;
    const totalFrames = Math.ceil((seq.duration_pts / 1_000_000) * fps);

    const canvas = document.createElement('canvas');
    canvas.width = seq.width; canvas.height = seq.height;
    const offscreenPlayer = new Player(canvas);

    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 20_000_000 });
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);

    recorder.start();

    for (let f = 0; f < totalFrames; f++) {
        const pts = (f / fps) * 1_000_000;
        const resolved = engine.resolve_frame(sequenceId, pts);
        if (resolved) {
            const frame = await pool.decodeFrameAt(resolved.source_path, resolved.source_pts / 1e6, false); // useProxy=false
            offscreenPlayer.drawFrame(frame);
        }
        if (f % 30 === 0) updateExportProgress(f, totalFrames);
        await new Promise(r => setTimeout(r, 0)); // yield to browser
    }

    recorder.stop();
    await new Promise(r => recorder.onstop = r);

    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${seq.name}.webm`; a.click();
}
```

### Future: WebCodecs encode path

Once the WebCodecs API matures, replace `MediaRecorder` with:
```js
const encoder = new VideoEncoder({
    output: (chunk) => muxer.addChunk(chunk),
    error: console.error
});
encoder.configure({ codec: 'avc1.640028', width: seq.width, height: seq.height, bitrate: 20_000_000 });
```

This will be ~3–5× faster than MediaRecorder for H.264 export.

### Test criteria
1. Export a 10-second sequence → downloads a `.webm` file that plays in VLC.
2. Export uses source resolution (not proxy) — verify via `ffprobe` on output.
3. Export progress bar updates smoothly.

---

## Implementation Order and Dependencies

```
3A (framerate remapping)
 └─ 3B (colorspace)     ← can start in parallel with 3C
 └─ 3C (proxy)
      └─ 3D (cache)
           └─ 3E (audio)
                └─ 3F (export)
```

Recommended sequence: **3A → 3C → 3B → 3D → 3E → 3F**

3C before 3B because proxy generation dramatically improves the feedback loop while testing colorspace changes.

---

## Quick Wins (do alongside Phase 3A)

These are small changes that don't require a full phase:

1. **Favicon** — Add `public/favicon.ico` to eliminate the console 404 error.
2. **Error toast UI** — Currently decode errors go to `console.warn`. Add a visible toast in the UI so users know when a clip fails to decode.
3. **Clip color-coding** — Color-code clips in the timeline by codec: green=ProRes/DNxHD, blue=H.264/HEVC, orange=MPEG-2. Pull from `info.codec_id` in the pool.
4. **Stream info panel** — On clip selection, show codec, resolution, fps, colorspace in the inspector panel. Data already available from `getInfo()` after Phase 3A.

---

*Plan version 1.0 — generated March 2026*
