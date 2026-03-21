/**
 * main.js – Application entry point
 *
 * Wires DOM events → FrameServerBridge → Player
 */

import { FrameServerBridge } from './frame_server.js';
import { Player }            from './player.js';

// ── DOM refs ──────────────────────────────────────────────────────────────
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const btnOpen       = document.getElementById('btn-open');
const canvasWrap    = document.getElementById('canvas-wrap');
const glCanvas      = document.getElementById('gl-canvas');
const loadingOverlay= document.getElementById('loading-overlay');
const loadingText   = document.getElementById('loading-text');
const transport     = document.getElementById('transport');
const scrubber      = document.getElementById('scrubber');
const btnPlayPause  = document.getElementById('btn-play-pause');
const timecode      = document.getElementById('timecode');
const metaPanel     = document.getElementById('meta');
const metaRes       = document.getElementById('meta-res');
const metaFps       = document.getElementById('meta-fps');
const metaDur       = document.getElementById('meta-dur');
const metaFrames    = document.getElementById('meta-frames');
const metaFrameCur  = document.getElementById('meta-frame-cur');
const statusBar     = document.getElementById('status');

// ── Helpers ───────────────────────────────────────────────────────────────

/** Format seconds as HH:MM:SS:FF (SMPTE-ish) */
function formatTimecode(secs, fps) {
  const f = Math.max(1, Math.round(fps));
  const totalFrames = Math.floor(secs * f);
  const ff = totalFrames % f;
  const totalSec = Math.floor(totalFrames / f);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return [hh, mm, ss, ff].map(n => String(n).padStart(2, '0')).join(':');
}

function setStatus(msg, isError = false) {
  statusBar.textContent = msg;
  statusBar.className   = isError ? 'error' : '';
}

function setLoading(visible, text = 'Opening…') {
  loadingText.textContent = text;
  loadingOverlay.classList.toggle('visible', visible);
}

// ── Player + Bridge ───────────────────────────────────────────────────────

let player   = null;
let bridge   = null;
let duration = 0;
let fps      = 24;
let frameCount = 0;
let isScrubbing = false;

function initPlayer() {
  if (!player) {
    try {
      player = new Player(glCanvas);
    } catch (err) {
      setStatus('WebGL init failed: ' + err.message, true);
      return false;
    }
  }
  return true;
}

function createBridge() {
  if (bridge) { bridge.destroy(); bridge = null; }

  bridge = new FrameServerBridge({
    onFrame(rgba, w, h, pts) {
      player.drawFrame(rgba, w, h);
      if (!isScrubbing) {
        const progress = duration > 0 ? pts / duration : 0;
        scrubber.value = Math.round(progress * 1000);
      }
      const curFrame = Math.floor(pts * fps);
      timecode.textContent =
        formatTimecode(pts, fps) + ' / ' + formatTimecode(duration, fps);
      metaFrameCur.textContent = String(curFrame);
    },

    onEnd() {
      btnPlayPause.textContent = 'Play';
      setStatus('Playback ended.');
    },

    onError(msg) {
      setLoading(false);
      setStatus(msg, true);
      console.error('[FrameServer]', msg);
    },

    onMetadata(meta) {
      duration   = meta.duration;
      fps        = meta.fps;
      frameCount = meta.frameCount;

      setLoading(false);
      canvasWrap.classList.add('visible');
      transport.classList.add('visible');
      metaPanel.classList.add('visible');
      dropZone.style.display = 'none';
      btnPlayPause.disabled  = false;

      metaRes.textContent    = `${meta.width} × ${meta.height}`;
      metaFps.textContent    = meta.fps.toFixed(3);
      metaDur.textContent    = formatTimecode(meta.duration, meta.fps);
      metaFrames.textContent = String(meta.frameCount);
      timecode.textContent   =
        formatTimecode(0, meta.fps) + ' / ' + formatTimecode(meta.duration, meta.fps);

      setStatus('Ready. Press Play or drag the scrubber.');
    },
  });
}

// ── Open file ─────────────────────────────────────────────────────────────

async function openFile(file) {
  if (!file) return;
  if (!initPlayer()) return;

  setLoading(true, 'Opening ' + file.name + '…');
  setStatus('');
  btnPlayPause.textContent = 'Play';
  scrubber.value = 0;

  createBridge();

  try {
    setLoading(true, 'Loading WASM…');
    await bridge.ready();
    setLoading(true, 'Decoding ' + file.name + '…');
    await bridge.openFile(file);
  } catch (err) {
    setLoading(false);
    setStatus('Error: ' + err.message, true);
  }
}

// ── File System Access API with <input> fallback ──────────────────────────

async function handleOpenClick() {
  // Try File System Access API first (Chrome 86+)
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'Video files',
          accept: { 'video/*': ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.ts', '.m4v'] },
        }],
        multiple: false,
      });
      const file = await handle.getFile();
      await openFile(file);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;  // user cancelled
      // Fall through to <input> on other errors
    }
  }
  // Fallback
  fileInput.click();
}

btnOpen.addEventListener('click', handleOpenClick);
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) openFile(fileInput.files[0]);
});

// ── Drag and drop ─────────────────────────────────────────────────────────

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) openFile(file);
});

// Also allow dropping anywhere on the canvas wrap
canvasWrap.addEventListener('dragover',  (e) => e.preventDefault());
canvasWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) openFile(file);
});

// ── Transport controls ────────────────────────────────────────────────────

btnPlayPause.addEventListener('click', () => {
  if (!bridge) return;
  if (bridge.isPlaying) {
    bridge.pause();
    btnPlayPause.textContent = 'Play';
  } else {
    bridge.play();
    btnPlayPause.textContent = 'Pause';
  }
});

scrubber.addEventListener('mousedown', () => { isScrubbing = true; });
scrubber.addEventListener('touchstart', () => { isScrubbing = true; });

scrubber.addEventListener('input', () => {
  if (!bridge || duration === 0) return;
  const t = (Number(scrubber.value) / 1000) * duration;
  timecode.textContent =
    formatTimecode(t, fps) + ' / ' + formatTimecode(duration, fps);
});

scrubber.addEventListener('change', () => {
  isScrubbing = false;
  if (!bridge || duration === 0) return;
  const t = (Number(scrubber.value) / 1000) * duration;
  bridge.seekTo(t);
  if (bridge.isPlaying) {
    btnPlayPause.textContent = 'Pause';
  }
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (!bridge) return;
  // Space = play/pause
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    btnPlayPause.click();
  }
  // Arrow keys = step ±1 frame
  if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    const step = fps > 0 ? 1 / fps : 1 / 24;
    const dir  = e.code === 'ArrowRight' ? 1 : -1;
    bridge.seekTo(bridge.currentPts + dir * step);
    if (!bridge.isPlaying)
      scrubber.value = Math.round((bridge.currentPts / duration) * 1000);
  }
});

// ── Init status ───────────────────────────────────────────────────────────

// Pre-warm the WASM bridge so the module starts loading immediately.
// We create a silent bridge just to trigger the WASM fetch.
const _warmup = new FrameServerBridge({
  onFrame:    () => {},
  onEnd:      () => {},
  onError:    (msg) => setStatus(msg, true),
  onMetadata: () => {},
});
_warmup.ready().then(() => {
  setStatus('Ready – open a video file to begin.');
}).catch(() => {
  // Error already reported via onError callback
});
