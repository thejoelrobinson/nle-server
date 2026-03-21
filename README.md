# NLE Server – Phase 1: WASM Frame Server

A client-side, browser-based video frame server. Video files are opened locally
in the browser, decoded via a WebAssembly module that wraps FFmpeg, and
displayed on a WebGL canvas — no server required.

## Architecture

```
File API → JS (frame_server.js) → WASM (FrameServer C++) → libavformat/libavcodec/libswscale
                                                                        ↓
                                  WebGL (player.js) ← RGBA frame bytes ←┘
```

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) | ≥ 3.1.50 | `emsdk install latest && emsdk activate latest` |
| CMake | ≥ 3.20 | |
| Git | any | For cloning FFmpeg |
| Node.js + npm | ≥ 18 | For Vite dev server |

## Step 1 – Install JS dependencies

```bash
npm install
```

## Step 2 – Build FFmpeg to WASM

This clones FFmpeg 6.1 and cross-compiles the demuxers, decoders, and
pixel-format converter to `.a` static libs targeting WASM.

```bash
# Activate Emscripten first
source /path/to/emsdk/emsdk_env.sh

./scripts/build_ffmpeg.sh
```

Output: `deps/ffmpeg_wasm/{include,lib}`

**Supported codecs** (Phase 1): H.264, HEVC, VP9, AV1, ProRes, DNxHD, MPEG-4,
MJPEG
**Supported containers**: MOV/MP4, Matroska/MKV, AVI, MPEG-TS

> The FFmpeg build takes 5–15 minutes depending on hardware.

## Step 3 – Build the WASM module

```bash
./scripts/build_wasm.sh
```

Output: `build/frame_server.js` + `build/frame_server.wasm`

Alternatively, run CMake manually:

```bash
mkdir build_wasm && cd build_wasm
emcmake cmake ..
emmake make -j$(nproc)
```

## Step 4 – Run the dev server

```bash
npm run dev
```

Open `http://localhost:5173` in a browser that supports:
- WebAssembly
- WebGL
- File System Access API (Chrome 86+ / Edge 86+) or `<input type="file">` fallback

## Production build

```bash
npm run build
# Output: dist/
```

> **Note:** The WASM binary must be copied to `dist/build/` manually after
> `npm run build`, as Vite does not bundle WASM files built externally.
> A future CI script can automate this.

## Test video

A sample video is not bundled. Download any H.264 MP4, for example:

```bash
# Using yt-dlp (educational / public-domain content)
yt-dlp -f "bestvideo[ext=mp4][vcodec^=avc]+bestaudio" -o test.mp4 <URL>

# Or generate a synthetic test clip with ffmpeg:
ffmpeg -f lavfi -i testsrc=duration=10:size=1280x720:rate=24 \
       -c:v libx264 -preset fast test.mp4
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| → | Step forward one frame |
| ← | Step backward one frame |

## Project structure

```
NLE Server/
├── src/
│   ├── core/
│   │   ├── frame_server.h        C++ FrameServer declaration
│   │   ├── frame_server.cpp      AVIO + AVCodec + swscale implementation
│   │   └── bindings.cpp          Embind JS bindings + heap helpers
│   └── web/
│       ├── index.html            UI
│       ├── main.js               App entry – wires DOM ↔ bridge
│       ├── player.js             WebGL1 RGBA texture renderer
│       └── frame_server.js       JS wrapper around WASM module
├── build/                        WASM build output (gitignored)
├── deps/                         FFmpeg source + WASM libs (gitignored)
├── scripts/
│   ├── build_ffmpeg.sh           Build FFmpeg → WASM static libs
│   └── build_wasm.sh             Build NLE WASM module via CMake
├── CMakeLists.txt
├── vite.config.js
└── package.json
```

## Phase 2 roadmap

- **Worker threads**: Move decode loop to a Web Worker + SharedArrayBuffer
  ring buffer so the UI thread is never blocked
- **Audio decoding**: swresample → Web Audio API
- **Timeline**: Multi-clip sequence with in/out points
- **Proxy generation**: Offline WASM transcode to low-res proxy for smooth
  scrubbing of 4K+ material
