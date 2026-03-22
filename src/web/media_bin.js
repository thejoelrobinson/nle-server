/**
 * media_bin.js – Media Bin + Source Monitor
 *
 * Handles:
 *  - Import button (File System Access API + <input> fallback)
 *  - Drag-and-drop onto the Media Bin panel
 *  - Clip list rendering with thumbnail icon, name, duration
 *  - Double-click / single-click → load clip into Source Monitor
 *  - I/O point marking (keys I / O)
 *  - Insert / Overwrite buttons → emits 'nle:insert-clip'
 *  - Source Monitor playback (via FrameServerPool from window._nle.pool)
 *
 * Integration:
 *  Reads  window._nle.pool, window._nle.importFileToTimeline
 *  Emits  CustomEvent 'nle:insert-clip'  { file, trackIndex, inPts, outPts }
 *         CustomEvent 'nle:open-in-program'  (drag-drop handled by main.js)
 */

import { Player }         from './player.js';
import { formatTimecode } from './timecode.js';

export function initMediaBin() {
  const btnImport     = document.getElementById('btn-import');
  const fileInput     = document.getElementById('file-input-import');
  const binList       = document.getElementById('media-bin-list');
  const binEmptyMsg   = document.getElementById('bin-empty-msg');
  const binPanel      = document.getElementById('media-bin');

  // Source Monitor elements
  const sourceCanvas  = document.getElementById('source-canvas');
  const sourceEmpty   = document.getElementById('source-empty');
  const sourceClipName= document.getElementById('source-clip-name');
  const sourceTc      = document.getElementById('source-timecode');
  const sourceDur     = document.getElementById('source-dur');
  const btnSrcPlay    = document.getElementById('source-btn-play');
  const btnSrcBack    = document.getElementById('source-btn-step-back');
  const btnSrcFwd     = document.getElementById('source-btn-step-fwd');
  const btnSrcMarkIn  = document.getElementById('source-btn-mark-in');
  const btnSrcMarkOut = document.getElementById('source-btn-mark-out');
  const btnInsert     = document.getElementById('source-btn-insert');
  const btnOverwrite  = document.getElementById('source-btn-overwrite');

  // ── State ──────────────────────────────────────────────────────────────
  const clips      = [];  // [{ file, duration, fps, inPts, outPts }]
  let   activeIdx  = -1;  // index of clip in Source Monitor
  let   srcPlayer  = null;
  let   srcPts     = 0;   // current source pts in seconds
  let   srcDur     = 0;
  let   srcFps     = 24;
  let   srcInPts   = 0;   // I-point (seconds)
  let   srcOutPts  = 0;   // O-point (seconds)
  let   srcPlaying = false;
  let   srcRafId   = null;
  let   srcLastMs  = null;

  // ── Source Monitor WebGL player ────────────────────────────────────────

  function ensureSrcPlayer() {
    if (!srcPlayer && sourceCanvas) {
      try { srcPlayer = new Player(sourceCanvas); } catch { /* WebGL unavailable */ }
    }
    return srcPlayer;
  }

  function renderSourceFrame(pts) {
    const { pool } = window._nle ?? {};
    if (!pool) return;
    const clip = clips[activeIdx];
    if (!clip) return;
    const frame = pool.decodeFrameAt(clip.file.name, pts);
    if (frame && ensureSrcPlayer()) srcPlayer.drawFrame(frame);
    if (sourceTc) sourceTc.textContent = formatTimecode(pts, srcFps);
  }

  function startSrcPlay() {
    if (srcPlaying) return;
    srcPlaying = true;
    if (btnSrcPlay) btnSrcPlay.textContent = '⏸';
    srcLastMs = null;
    function tick(now) {
      if (!srcPlaying) return;
      if (srcLastMs !== null) {
        srcPts = Math.min(srcDur, srcPts + (now - srcLastMs) / 1000);
        if (srcPts >= srcDur) { stopSrcPlay(); renderSourceFrame(srcPts); return; }
      }
      srcLastMs = now;
      renderSourceFrame(srcPts);
      srcRafId = requestAnimationFrame(tick);
    }
    srcRafId = requestAnimationFrame(tick);
  }

  function stopSrcPlay() {
    srcPlaying = false;
    srcLastMs  = null;
    if (btnSrcPlay) btnSrcPlay.textContent = '▶';
    if (srcRafId !== null) { cancelAnimationFrame(srcRafId); srcRafId = null; }
  }

  // ── Open a clip in Source Monitor ──────────────────────────────────────

  async function openInSource(idx) {
    const clip = clips[idx];
    if (!clip) return;
    const { pool } = window._nle ?? {};
    if (!pool) return;

    // Ensure file is loaded into pool
    if (!pool.has(clip.file.name)) {
      try { await pool.addFile(clip.file); } catch { return; }
    }

    activeIdx = idx;
    stopSrcPlay();
    srcPts    = 0;
    srcDur    = clip.duration;
    srcFps    = clip.fps;
    srcInPts  = 0;
    srcOutPts = clip.duration;

    if (sourceEmpty)   sourceEmpty.classList.add('hidden');
    if (sourceClipName) sourceClipName.textContent = clip.file.name;
    if (sourceDur)  sourceDur.textContent  = formatTimecode(srcDur, srcFps);
    if (sourceTc)   sourceTc.textContent   = formatTimecode(0, srcFps);

    [btnSrcPlay, btnSrcBack, btnSrcFwd, btnSrcMarkIn, btnSrcMarkOut, btnInsert, btnOverwrite]
      .forEach((b) => { if (b) b.disabled = false; });

    // Update visual selection in bin
    document.querySelectorAll('.bin-item').forEach((el, i) => {
      el.classList.toggle('selected', i === idx);
    });

    renderSourceFrame(0);
  }

  // ── Clip list rendering ────────────────────────────────────────────────

  function renderBinList() {
    if (!binList) return;
    if (clips.length === 0) {
      binList.innerHTML = '';
      if (binEmptyMsg) { binEmptyMsg.style.display = ''; binList.appendChild(binEmptyMsg); }
      return;
    }
    if (binEmptyMsg) binEmptyMsg.style.display = 'none';

    // Rebuild only changed items (simple full rebuild for now)
    binList.innerHTML = '';
    clips.forEach((clip, idx) => {
      const item = document.createElement('div');
      item.className = 'bin-item' + (idx === activeIdx ? ' selected' : '');
      item.dataset.idx  = idx;
      item.dataset.path = clip.file.name;
      item.innerHTML = `
        <div class="bin-item-icon">▶</div>
        <div class="bin-item-info">
          <div class="bin-item-name" title="${_esc(clip.file.name)}">${_esc(clip.file.name)}</div>
          <div class="bin-item-meta">${formatTimecode(clip.duration, clip.fps)}  ${clip.fps.toFixed(2)} fps  ${clip.width}×${clip.height}</div>
          <div class="proxy-status"></div>
        </div>`;
      item.addEventListener('click',    () => openInSource(idx));
      item.addEventListener('dblclick', () => openInSource(idx));
      binList.appendChild(item);
    });
  }

  // ── Import files ───────────────────────────────────────────────────────

  async function importFiles(fileList) {
    const { pool } = window._nle ?? {};
    if (!pool) return;

    // Wire up proxy progress display once (idempotent)
    pool.onProxyProgress = (path, cur, total) => {
      const pct = total > 0 ? Math.round((cur / total) * 100) : 0;
      const el  = document.querySelector(
        `[data-path="${CSS.escape(path)}"] .proxy-status`
      );
      if (el) el.textContent = cur >= total ? '✓ proxy' : `proxy ${pct}%`;
    };

    for (const file of fileList) {
      if (clips.some((c) => c.file.name === file.name)) continue;
      try {
        await pool.addFile(file);
        const bridge = pool.getBridge(file.name);
        clips.push({
          file,
          duration: bridge?.duration ?? 0,
          fps:      bridge?.fps      ?? 24,
          width:    bridge?._width   ?? 1920,
          height:   bridge?._height  ?? 1080,
          inPts:    0,
          outPts:   bridge?.duration ?? 0,
        });
      } catch { /* skip unreadable files */ }
    }
    renderBinList();
  }

  // ── File System Access API / <input> ──────────────────────────────────

  async function handleImportClick() {
    if ('showOpenFilePicker' in window) {
      try {
        const handles = await window.showOpenFilePicker({
          types: [{ description: 'Video files',
                    accept: { 'video/*': ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.ts', '.mxf', '.m4v'] } }],
          multiple: true,
        });
        const files = await Promise.all(handles.map((h) => h.getFile()));
        await importFiles(files);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    if (fileInput) fileInput.click();
  }

  if (btnImport) btnImport.addEventListener('click', handleImportClick);
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      if (fileInput.files.length) await importFiles(Array.from(fileInput.files));
    });
  }

  // ── Drag-and-drop onto Media Bin ──────────────────────────────────────

  if (binPanel) {
    binPanel.addEventListener('dragover', (e) => {
      e.preventDefault();
      const overlay = document.getElementById('bin-drop-overlay');
      if (overlay) overlay.style.display = 'flex';
    });
    binPanel.addEventListener('dragleave', () => {
      const overlay = document.getElementById('bin-drop-overlay');
      if (overlay) overlay.style.display = 'none';
    });
    binPanel.addEventListener('drop', async (e) => {
      e.preventDefault();
      const overlay = document.getElementById('bin-drop-overlay');
      if (overlay) overlay.style.display = 'none';
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) await importFiles(files);
    });
  }

  // ── Source Monitor transport ───────────────────────────────────────────

  if (btnSrcPlay) btnSrcPlay.addEventListener('click', () => {
    if (srcPlaying) stopSrcPlay(); else startSrcPlay();
  });

  if (btnSrcBack) btnSrcBack.addEventListener('click', () => {
    stopSrcPlay();
    srcPts = Math.max(0, srcPts - (srcFps > 0 ? 1 / srcFps : 1 / 24));
    renderSourceFrame(srcPts);
  });

  if (btnSrcFwd) btnSrcFwd.addEventListener('click', () => {
    stopSrcPlay();
    srcPts = Math.min(srcDur, srcPts + (srcFps > 0 ? 1 / srcFps : 1 / 24));
    renderSourceFrame(srcPts);
  });

  if (btnSrcMarkIn) btnSrcMarkIn.addEventListener('click', () => {
    srcInPts = srcPts;
  });

  if (btnSrcMarkOut) btnSrcMarkOut.addEventListener('click', () => {
    srcOutPts = srcPts;
  });

  // ── Insert / Overwrite ────────────────────────────────────────────────

  function emitInsert(overwrite) {
    const clip = clips[activeIdx];
    if (!clip) return;
    window.dispatchEvent(new CustomEvent('nle:insert-clip', {
      detail: {
        file:       clip.file,
        trackIndex: 0,
        inPts:      Math.round(srcInPts  * 1e6),
        outPts:     Math.round(srcOutPts * 1e6),
        overwrite,
      },
    }));
  }

  if (btnInsert)    btnInsert.addEventListener('click',    () => emitInsert(false));
  if (btnOverwrite) btnOverwrite.addEventListener('click', () => emitInsert(true));

  // ── Keyboard I/O shortcuts (when Source Monitor is focused) ──────────
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (activeIdx < 0) return;
    if (e.code === 'KeyI') { srcInPts = srcPts; }
    if (e.code === 'KeyO') { srcOutPts = srcPts; }
  });

  // ── Cross-module: show clip in source from timeline dblclick ──────────
  window.addEventListener('nle:show-in-source', (e) => {
    const path = e.detail?.sourcePath;
    if (!path) return;
    const idx = clips.findIndex((c) => c.file.name === path);
    if (idx >= 0) openInSource(idx);
  });

  // ── nle:insert-clip carries I/O into main.js importFileToTimeline ─────
  window.addEventListener('nle:insert-clip', async (e) => {
    const { file, trackIndex, inPts, outPts } = e.detail ?? {};
    if (!file) return;
    const { importFileToTimeline } = window._nle ?? {};
    if (!importFileToTimeline) return;
    // Pass with custom source in/out — main.js already handles add_clip
    await importFileToTimeline(file, trackIndex ?? 0, inPts ?? 0, outPts ?? null);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
