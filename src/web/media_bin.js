/**
 * media_bin.js – Media Bin + Source Monitor
 *
 * Handles:
 *  - Import button (File System Access API + <input> fallback)
 *  - Drag-and-drop onto the Media Bin panel (file import from OS)
 *  - Clip list rendering with codec badge, resolution badge, duration
 *  - Multi-select: click = single, Cmd/Ctrl+click = toggle, Shift+click = range
 *  - Dragging selected clips to timeline (sets dataTransfer 'application/nle-clips')
 *  - Double-click → load clip into Source Monitor
 *  - I/O point marking (keys I / O)
 *  - Insert / Overwrite buttons → emits 'nle:insert-clip'
 *  - Source Monitor playback (via FrameServerPool from window._nle.pool)
 *
 * Integration:
 *  Reads  window._nle.pool, window._nle.importFileToTimeline
 *  Emits  CustomEvent 'nle:insert-clip'  { file, trackIndex, inPts, outPts }
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
  const clips           = [];   // [{ file, duration, fps, width, height, codec, inPts, outPts }]
  let   activeIdx       = -1;   // index of clip open in Source Monitor
  const selectedIndices = new Set();  // multi-select
  let   lastClickIdx    = -1;   // for shift-range anchor

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

  async function renderSourceFrame(pts) {
    const { pool } = window._nle ?? {};
    if (!pool) return;
    const clip = clips[activeIdx];
    if (!clip) return;
    const frame = await pool.decodeFrameAt(clip.file.name, pts);
    if (frame && ensureSrcPlayer()) srcPlayer.drawFrameFull(frame);
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

    if (sourceEmpty)    sourceEmpty.classList.add('hidden');
    if (sourceClipName) sourceClipName.textContent = clip.file.name;
    if (sourceDur)      sourceDur.textContent  = formatTimecode(srcDur, srcFps);
    if (sourceTc)       sourceTc.textContent   = formatTimecode(0, srcFps);

    [btnSrcPlay, btnSrcBack, btnSrcFwd, btnSrcMarkIn, btnSrcMarkOut, btnInsert, btnOverwrite]
      .forEach((b) => { if (b) b.disabled = false; });

    renderBinList();
    await renderSourceFrame(0);
  }

  // ── Codec + resolution badge helpers ──────────────────────────────────

  function _codecLabel(codec) {
    if (!codec) return '';
    const s = String(codec).toLowerCase();
    if (s.includes('h264') || s === '27')                    return 'H.264';
    if (s.includes('hevc') || s.includes('h265') || s === '173') return 'HEVC';
    if (s.includes('prores') || s === '147')                 return 'ProRes';
    if (s.includes('mpeg2') || s === '2')                    return 'MPEG2';
    if (s.includes('vp9')   || s === '167')                  return 'VP9';
    if (s.includes('av1')   || s === '226')                  return 'AV1';
    if (s.includes('dnxhd') || s === '99')                   return 'DNxHD';
    return '';
  }

  function _resLabel(w, h) {
    if (!w || !h) return '';
    if (h >= 2160) return '4K';
    if (h >= 1080) return '1080p';
    if (h >= 720)  return '720p';
    if (h >= 480)  return '480p';
    return `${w}×${h}`;
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

    binList.innerHTML = '';

    // Selection count badge (shown when 2+ are selected)
    if (selectedIndices.size > 1) {
      const badge = document.createElement('div');
      badge.className = 'bin-selection-badge';
      badge.textContent = `${selectedIndices.size} clips selected`;
      binList.appendChild(badge);
    }

    clips.forEach((clip, idx) => {
      const isActive   = idx === activeIdx;
      const isSelected = selectedIndices.has(idx);
      const codec      = _codecLabel(clip.codec);
      const res        = _resLabel(clip.width, clip.height);
      const dur        = formatTimecode(clip.duration, clip.fps);

      const item = document.createElement('div');
      item.className = 'bin-item'
        + (isActive   ? ' active-source' : '')
        + (isSelected ? ' selected'      : '');
      item.dataset.idx  = idx;
      item.dataset.path = clip.file.name;
      item.draggable    = true;

      const badgesHtml = [
        codec ? `<span class="bin-badge bin-badge-codec">${_esc(codec)}</span>` : '',
        res   ? `<span class="bin-badge bin-badge-res">${_esc(res)}</span>`     : '',
      ].join('');

      item.innerHTML = `
        <div class="bin-item-icon">▶</div>
        <div class="bin-item-info">
          <div class="bin-item-name" title="${_esc(clip.file.name)}">${_esc(clip.file.name)}</div>
          <div class="bin-item-meta">${badgesHtml}<span class="bin-item-dur">${_esc(dur)}</span></div>
          <div class="proxy-status"></div>
        </div>`;

      // ── Click: single / toggle / range ──────────────────────────────
      item.addEventListener('click', (e) => {
        if (e.shiftKey && lastClickIdx >= 0) {
          const lo = Math.min(lastClickIdx, idx);
          const hi = Math.max(lastClickIdx, idx);
          for (let i = lo; i <= hi; i++) selectedIndices.add(i);
        } else if (e.metaKey || e.ctrlKey) {
          if (selectedIndices.has(idx)) selectedIndices.delete(idx);
          else selectedIndices.add(idx);
          lastClickIdx = idx;
        } else {
          selectedIndices.clear();
          selectedIndices.add(idx);
          lastClickIdx = idx;
        }
        renderBinList();
      });

      // ── Double-click: open in source monitor ─────────────────────────
      item.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        selectedIndices.clear();
        selectedIndices.add(idx);
        lastClickIdx = idx;
        openInSource(idx);
      });

      // ── Drag start: carry all selected paths ─────────────────────────
      item.addEventListener('dragstart', (e) => {
        // If the dragged item isn't selected, replace selection with just it
        if (!selectedIndices.has(idx)) {
          selectedIndices.clear();
          selectedIndices.add(idx);
          lastClickIdx = idx;
          renderBinList();
        }

        const paths = Array.from(selectedIndices).map((i) => clips[i].file.name);
        e.dataTransfer.setData('application/nle-clips', JSON.stringify(paths));
        e.dataTransfer.effectAllowed = 'copy';

        // Custom drag ghost
        const ghost = document.createElement('div');
        ghost.textContent = paths.length === 1
          ? clips[Array.from(selectedIndices)[0]].file.name.split(/[\\/]/).pop()
          : `${paths.length} clips`;
        Object.assign(ghost.style, {
          position: 'fixed', top: '-100px', left: '0',
          background: '#1e6e8e', color: '#fff',
          padding: '4px 10px', borderRadius: '4px',
          fontSize: '11px', pointerEvents: 'none', whiteSpace: 'nowrap',
          zIndex: '9999',
        });
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 20, 12);
        setTimeout(() => document.body.removeChild(ghost), 0);
      });

      binList.appendChild(item);
    });
  }

  // ── Import files ───────────────────────────────────────────────────────

  async function importFiles(fileList) {
    const { pool } = window._nle ?? {};
    if (!pool) return;

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
        // Add placeholder clip to UI immediately so user sees loading progress
        const placeholderIdx = clips.length;
        const escapedName = CSS.escape(file.name);
        clips.push({
          file,
          duration: 0,
          fps:      24,
          width:    1920,
          height:   1080,
          codec:    '',
          inPts:    0,
          outPts:   0,
        });
        renderBinList();

        // Cache element reference to avoid repeated DOM queries during import
        let statusEl = document.querySelector(
          `[data-path="${escapedName}"] .proxy-status`
        );

        // Show import progress
        const importProgressCb = (bytesRead, totalBytes) => {
          if (!statusEl) return; // Element not found (shouldn't happen but be safe)
          const pct = totalBytes > 0 ? Math.round(Math.min(bytesRead, totalBytes) / totalBytes * 100) : 0;
          statusEl.textContent = pct >= 100 ? 'opening…' : `reading ${pct}%`;
        };

        await pool.addFile(file, importProgressCb);
        const bridge = pool.getBridge(file.name);

        // Try to get codec info
        let codec = '';
        try {
          const info = pool.getInfo?.(file.name);
          codec = info?.codec_name ?? info?.codec_id ?? '';
        } catch { /* best-effort */ }

        // Update placeholder with actual data
        clips[placeholderIdx] = {
          file,
          duration: bridge?.duration ?? 0,
          fps:      bridge?.fps      ?? 24,
          width:    bridge?._width   ?? 1920,
          height:   bridge?._height  ?? 1080,
          codec,
          inPts:    0,
          outPts:   bridge?.duration ?? 0,
        };
        renderBinList();
      } catch {
        // Remove placeholder on failure
        clips.splice(placeholderIdx, 1);
        renderBinList();
      }
    }
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

  // ── Drag-and-drop onto Media Bin (OS file import only) ────────────────

  if (binPanel) {
    binPanel.addEventListener('dragover', (e) => {
      // Only accept external file drags, not internal clip-to-timeline drags
      if (!e.dataTransfer.types.includes('application/nle-clips')) {
        e.preventDefault();
        const overlay = document.getElementById('bin-drop-overlay');
        if (overlay) overlay.style.display = 'flex';
      }
    });
    binPanel.addEventListener('dragleave', () => {
      const overlay = document.getElementById('bin-drop-overlay');
      if (overlay) overlay.style.display = 'none';
    });
    binPanel.addEventListener('drop', async (e) => {
      if (e.dataTransfer.types.includes('application/nle-clips')) return;
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
  if (btnSrcMarkIn)  btnSrcMarkIn.addEventListener('click',  () => { srcInPts  = srcPts; });
  if (btnSrcMarkOut) btnSrcMarkOut.addEventListener('click', () => { srcOutPts = srcPts; });

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

  // ── Keyboard I/O shortcuts ────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (activeIdx < 0) return;
    if (e.code === 'KeyI') { srcInPts  = srcPts; }
    if (e.code === 'KeyO') { srcOutPts = srcPts; }
  });

  // ── Cross-module: show clip in source from timeline dblclick ──────────

  window.addEventListener('nle:show-in-source', (e) => {
    const path = e.detail?.sourcePath;
    if (!path) return;
    const idx = clips.findIndex((c) => c.file.name === path);
    if (idx >= 0) openInSource(idx);
  });

  // ── nle:insert-clip → main.js importFileToTimeline ───────────────────

  window.addEventListener('nle:insert-clip', async (e) => {
    const { file, trackIndex, inPts, outPts } = e.detail ?? {};
    if (!file) return;
    const { importFileToTimeline } = window._nle ?? {};
    if (!importFileToTimeline) return;
    await importFileToTimeline(file, trackIndex ?? 0, inPts ?? 0, outPts ?? null);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
