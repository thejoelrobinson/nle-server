/**
 * timeline.js – Canvas-based NLE timeline component.
 *
 * Renders:
 *  - Time ruler (30 px, SMPTE timecodes at adaptive intervals)
 *  - Track headers (200 px left gutter: eye / mute / lock icons)
 *  - Clip blocks (video = #1e6e8e, audio = #1e7a3c)
 *  - Playhead (2 px red line + triangle indicator)
 *
 * Tools: select | razor | hand
 * Interactions: scroll, Ctrl+wheel zoom, snap to frame/clip edges
 *
 * Public API:
 *   new Timeline(canvas, engine, seqId, fps_num, fps_den)
 *   .setPlayhead(pts)           → moves playhead, emits 'playhead-change'
 *   .setTool(name)              → 'select' | 'razor' | 'hand'
 *   .render()                   → force redraw
 *   .destroy()                  → remove listeners
 *   .setPool(pool)              → provide FrameServerPool for drag-drop duration lookup
 *
 * Events dispatched on the canvas element:
 *   'playhead-change'  { detail: { pts } }
 *   'clip-selected'    { detail: { clipId } }
 *   'clip-deselected'
 */

// ── Constants ──────────────────────────────────────────────────────────────
const RULER_H       = 30;     // px — time ruler height
const HEADER_W      = 180;    // px — track header gutter width
const TRACK_H       = 42;     // px — height of each track row
const MIN_ZOOM      = 10;     // px per second (fully zoomed out)
const MAX_ZOOM      = 2000;   // px per second (fully zoomed in)
const SNAP_PX       = 8;      // px — snap threshold
const PLAYHEAD_COLOR= '#e84040';
const TRACK_GAP     = 1;      // px between tracks
const VIDEO_COLOR   = '#1e6e8e';
const AUDIO_COLOR   = '#1e7a3c';
const CLIP_LABEL_CLAMP = 6;   // min px width before label is hidden

// ── Timeline class ─────────────────────────────────────────────────────────
export class Timeline {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} engine   — JS TimelineEngine mirror (or real WASM proxy)
   * @param {string} seqId
   * @param {number} fps_num
   * @param {number} fps_den
   */
  constructor(canvas, engine, seqId, fps_num, fps_den) {
    this._canvas  = canvas;
    this._ctx     = canvas.getContext('2d');
    this._engine  = engine;
    this._seqId   = seqId;
    this._fps_num = fps_num;
    this._fps_den = fps_den;
    this._pool    = null;   // set via setPool() once available

    // View state
    this._zoom      = 100;   // px per second
    this._scrollX   = 0;     // horizontal scroll in px (content offset)
    this._scrollY   = 0;     // vertical scroll in px
    this._playhead  = 0;     // current playhead in pts (µs)
    this._tool      = 'select';
    this._selectedClip = null;

    // Interaction state
    this._drag      = null;   // active drag descriptor
    this._trimDrag  = null;
    this._handDrag  = null;

    // Resize observer keeps canvas pixel-perfect
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas);
    this._resize();

    // Bind and register events
    this._onWheel     = this._onWheel.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp   = this._onMouseUp.bind(this);
    this._onDblClick  = this._onDblClick.bind(this);

    canvas.addEventListener('wheel',     this._onWheel,     { passive: false });
    canvas.addEventListener('mousedown', this._onMouseDown);
    canvas.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('mouseup',   this._onMouseUp);
    canvas.addEventListener('dblclick',  this._onDblClick);

    // Drag-and-drop from Media Bin
    this._onDragOver  = this._onDragOver.bind(this);
    this._onDragLeave = this._onDragLeave.bind(this);
    this._onDrop      = this._onDrop.bind(this);
    canvas.addEventListener('dragover',  this._onDragOver);
    canvas.addEventListener('dragleave', this._onDragLeave);
    canvas.addEventListener('drop',      this._onDrop);

    // Tool shortcut events from main.js
    this._onTool = (e) => this.setTool(e.detail);
    this._onDeleteSelected = () => this._deleteSelected();
    window.addEventListener('nle:tool',            this._onTool);
    window.addEventListener('nle:delete-selected', this._onDeleteSelected);

    this.render();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  setPlayhead(pts) {
    this._playhead = pts;
    this.render();
    this._canvas.dispatchEvent(new CustomEvent('playhead-change', {
      bubbles: true, detail: { pts },
    }));
  }

  /** Provide the FrameServerPool so drop can look up clip durations */
  setPool(pool) { this._pool = pool; }

  setTool(name) {
    this._tool = name;
    this._canvas.style.cursor = name === 'hand'  ? 'grab'
                               : name === 'razor' ? 'crosshair'
                               :                    'default';
    // Update toolbar buttons
    ['select', 'razor', 'hand'].forEach((t) => {
      document.getElementById('tool-' + t)?.classList.toggle('active', t === name);
    });
  }

  render() { this._draw(); }

  destroy() {
    this._ro.disconnect();
    this._canvas.removeEventListener('wheel',     this._onWheel);
    this._canvas.removeEventListener('mousedown', this._onMouseDown);
    this._canvas.removeEventListener('mousemove', this._onMouseMove);
    this._canvas.removeEventListener('mouseup',   this._onMouseUp);
    this._canvas.removeEventListener('dblclick',  this._onDblClick);
    this._canvas.removeEventListener('dragover',  this._onDragOver);
    this._canvas.removeEventListener('dragleave', this._onDragLeave);
    this._canvas.removeEventListener('drop',      this._onDrop);
    window.removeEventListener('nle:tool',            this._onTool);
    window.removeEventListener('nle:delete-selected', this._onDeleteSelected);
  }

  // ── Coordinate helpers ──────────────────────────────────────────────────

  /** pts (µs) → canvas x */
  _ptsToX(pts) {
    return HEADER_W + (pts / 1e6) * this._zoom - this._scrollX;
  }

  /** canvas x → pts (µs) */
  _xToPts(x) {
    return ((x - HEADER_W + this._scrollX) / this._zoom) * 1e6;
  }

  /** track array index → canvas y (top of track body) */
  _trackY(idx) {
    return RULER_H + idx * (TRACK_H + TRACK_GAP) - this._scrollY;
  }

  /** Get all tracks with video tracks reversed (V1 at bottom) */
  _getAllTracks(seq) {
    if (!seq) return [];
    const videoTracks = (seq.video_tracks || []).map((t) => ({ ...t, isVideo: true }));
    const audioTracks = (seq.audio_tracks || []).map((t) => ({ ...t, isVideo: false }));
    return [...videoTracks.reverse(), ...audioTracks];
  }

  /** canvas y → track index (or -1 if in ruler/header) */
  _yToTrackIdx(y) {
    if (y < RULER_H) return -1;
    const rel = y - RULER_H + this._scrollY;
    return Math.floor(rel / (TRACK_H + TRACK_GAP));
  }

  /** Snap a pts value to frame grid and nearby clip edges */
  _snap(pts, excludeClipId = '') {
    const framePts = this._frameSnapPts(pts);
    const edgePts  = this._edgeSnapPts(pts, excludeClipId);
    const frameDist = Math.abs(pts - framePts);
    const edgeDist  = edgePts !== null ? Math.abs(pts - edgePts) : Infinity;
    const snapPts   = (edgeDist < this._snapThresholdPts() && edgeDist < frameDist)
                      ? edgePts : framePts;
    return snapPts;
  }

  _snapThresholdPts() {
    return (SNAP_PX / this._zoom) * 1e6;
  }

  _frameSnapPts(pts) {
    const frameDur = (this._fps_den / this._fps_num) * 1e6;
    return Math.round(pts / frameDur) * frameDur;
  }

  _edgeSnapPts(pts, excludeId) {
    const seq = this._engine._sequences?.get(this._seqId);
    if (!seq) return null;
    let best = null, bestDist = this._snapThresholdPts();
    const check = (edgePts) => {
      const d = Math.abs(pts - edgePts);
      if (d < bestDist) { bestDist = d; best = edgePts; }
    };
    for (const tracks of [seq.video_tracks, seq.audio_tracks]) {
      if (!tracks) continue;
      for (const t of tracks) {
        for (const c of t.clips) {
          if (c.clip_id === excludeId) continue;
          check(c.timeline_in_pts);
          check(c.timeline_out_pts);
        }
      }
    }
    return best;
  }

  // ── Resize ──────────────────────────────────────────────────────────────

  _resize() {
    const r = this._canvas.getBoundingClientRect();
    this._canvas.width  = Math.max(1, Math.round(r.width  * devicePixelRatio));
    this._canvas.height = Math.max(1, Math.round(r.height * devicePixelRatio));
    this._W = r.width;
    this._H = r.height;
    this._draw();
  }

  // ── Draw ────────────────────────────────────────────────────────────────

  _draw() {
    const ctx  = this._ctx;
    const dpr  = devicePixelRatio;
    const W    = this._canvas.width;
    const H    = this._canvas.height;

    ctx.save();
    ctx.scale(dpr, dpr);
    const w = W / dpr;
    const h = H / dpr;

    // Background
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, w, h);

    const seq = this._engine._sequences?.get(this._seqId);

    this._drawRuler(ctx, w);
    if (seq) {
      this._drawTracks(ctx, seq, w, h);
    } else {
      this._drawEmptyHint(ctx, w, h);
    }
    this._drawHeader(ctx, seq, h);
    this._drawPlayhead(ctx, h);
    if (this._dropHint) this._drawDropHint(ctx, h);

    ctx.restore();
  }

  _drawRuler(ctx, w) {
    // Background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(w, RULER_H - 0.5);
    ctx.stroke();

    // Tick interval: choose a "nice" interval so ticks are ≥20px apart
    const minTickSec = 20 / this._zoom;
    const intervals  = [0.04167, 0.08333, 0.1667, 0.5, 1, 2, 5, 10, 30, 60, 300];
    const interval   = intervals.find((v) => v >= minTickSec) ?? 300;

    const fps        = this._fps_num / this._fps_den;
    const startSec   = Math.max(0, Math.floor((this._scrollX / this._zoom) / interval) * interval);
    const endSec     = (this._scrollX + w - HEADER_W) / this._zoom;

    ctx.fillStyle  = '#666';
    ctx.font       = '10px -apple-system, sans-serif';
    ctx.textAlign  = 'left';
    ctx.textBaseline = 'middle';

    for (let t = startSec; t <= endSec + interval; t += interval) {
      const x = this._ptsToX(t * 1e6);
      if (x < HEADER_W || x > w) continue;

      ctx.strokeStyle = '#333';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 8);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();

      const label = _formatRulerTime(t, fps);
      ctx.fillText(label, x + 3, RULER_H / 2);
    }

    // FPS badge at right edge of ruler
    const fpsLabel = _formatFpsLabel(this._fps_num, this._fps_den);
    ctx.font      = '9px -apple-system, sans-serif';
    ctx.fillStyle = '#444';
    ctx.textAlign = 'right';
    ctx.fillText(fpsLabel, w - 6, RULER_H / 2);
    ctx.textAlign = 'left';
  }

  _drawTracks(ctx, seq, w, h) {
    const allTracks = this._getAllTracks(seq);

    allTracks.forEach((track, idx) => {
      const y = this._trackY(idx);
      if (y > h || y + TRACK_H < 0) return;  // culling

      // Track row background
      ctx.fillStyle = idx % 2 === 0 ? '#1c1c1c' : '#191919';
      ctx.fillRect(HEADER_W, y, w - HEADER_W, TRACK_H);

      // Clips
      for (const clip of track.clips) {
        this._drawClip(ctx, clip, track.isVideo, y);
      }
    });
  }

  _drawClip(ctx, clip, isVideo, trackY) {
    const x1 = this._ptsToX(clip.timeline_in_pts);
    const x2 = this._ptsToX(clip.timeline_out_pts);
    const pw  = x2 - x1;
    if (pw < 0.5) return;

    const isSelected = clip.clip_id === this._selectedClip;
    const baseColor  = isVideo ? VIDEO_COLOR : AUDIO_COLOR;

    // Body
    ctx.fillStyle = isSelected ? _lighten(baseColor, 0.3) : baseColor;
    const radius  = Math.min(3, pw / 2);
    _roundRect(ctx, x1 + 1, trackY + 2, pw - 2, TRACK_H - 4, radius);
    ctx.fill();

    // Selected outline
    if (isSelected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1.5;
      _roundRect(ctx, x1 + 1, trackY + 2, pw - 2, TRACK_H - 4, radius);
      ctx.stroke();
    }

    // Label
    if (pw > CLIP_LABEL_CLAMP) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1 + 1, trackY + 2, pw - 2, TRACK_H - 4);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const name = clip.source_path.split('/').pop().split('\\').pop();
      ctx.fillText(name, x1 + 5, trackY + TRACK_H / 2);
      ctx.restore();
    }

    // Trim handles (shown when selected)
    if (isSelected && pw > 12) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(x1 + 1,      trackY + 4, 4, TRACK_H - 8);
      ctx.fillRect(x2 - 5,      trackY + 4, 4, TRACK_H - 8);
    }
  }

  _drawHeader(ctx, seq, h) {
    // Header background
    ctx.fillStyle = '#171717';
    ctx.fillRect(0, 0, HEADER_W, h);
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(HEADER_W - 0.5, 0); ctx.lineTo(HEADER_W - 0.5, h);
    ctx.stroke();

    if (!seq) return;

    const allTracks = this._getAllTracks(seq);

    allTracks.forEach((track, idx) => {
      const y = this._trackY(idx);
      if (y > h || y + TRACK_H < 0) return;

      // Row bg
      ctx.fillStyle = idx % 2 === 0 ? '#1c1c1c' : '#191919';
      ctx.fillRect(0, y, HEADER_W - 1, TRACK_H);

      // Track name
      ctx.fillStyle  = '#aaa';
      ctx.font       = '11px -apple-system, sans-serif';
      ctx.textAlign  = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(track.name || (track.isVideo ? 'V' : 'A') + (idx + 1), 8, y + TRACK_H / 2);

      // Icons: eye (visible), mute, lock
      const icons = [
        { icon: track.visible ? '👁' : '🚫', active: track.visible,  x: HEADER_W - 52 },
        { icon: track.muted   ? '🔇' : '🔊', active: !track.muted,   x: HEADER_W - 34 },
        { icon: track.locked  ? '🔒' : '🔓', active: !track.locked,  x: HEADER_W - 16 },
      ];
      ctx.font = '11px sans-serif';
      icons.forEach(({ icon, x }) => {
        ctx.fillText(icon, x, y + TRACK_H / 2);
      });

      // Row separator
      ctx.strokeStyle = '#222';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + TRACK_H - 0.5);
      ctx.lineTo(HEADER_W, y + TRACK_H - 0.5);
      ctx.stroke();
    });
  }

  _drawPlayhead(ctx, h) {
    const x = this._ptsToX(this._playhead);
    if (x < HEADER_W || x > this._W) return;

    ctx.strokeStyle = PLAYHEAD_COLOR;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, h);
    ctx.stroke();

    // Triangle at top
    ctx.fillStyle = PLAYHEAD_COLOR;
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x,     RULER_H - 2);
    ctx.closePath();
    ctx.fill();
  }

  _drawDropHint(ctx, h) {
    const { mx, trackIdx } = this._dropHint;
    const x = mx;
    // Vertical drop line
    ctx.save();
    ctx.strokeStyle = 'rgba(79,143,255,0.9)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);
    // Track highlight
    if (trackIdx >= 0) {
      const ty = this._trackY(trackIdx);
      ctx.fillStyle = 'rgba(79,143,255,0.1)';
      ctx.fillRect(HEADER_W, ty, this._W - HEADER_W, TRACK_H);
    }
    ctx.restore();
  }

  _drawEmptyHint(ctx, w, h) {
    ctx.fillStyle   = '#333';
    ctx.font        = '13px -apple-system, sans-serif';
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Add clips from the Media Bin', (w + HEADER_W) / 2, h / 2);
  }

  // ── Drag-and-drop (clips from Media Bin) ─────────────────────────────

  _onDragOver(e) {
    if (!e.dataTransfer.types.includes('application/nle-clips')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    // Draw a drop indicator line at current cursor position
    const rect    = this._canvas.getBoundingClientRect();
    const mx      = e.clientX - rect.left;
    const trackIdx = this._yToTrackIdx(e.clientY - rect.top);
    this._dropHint = { mx, trackIdx };
    this._draw();
  }

  _onDragLeave() {
    this._dropHint = null;
    this._draw();
  }

  _onDrop(e) {
    this._dropHint = null;
    if (!e.dataTransfer.types.includes('application/nle-clips')) return;
    e.preventDefault();

    let paths;
    try { paths = JSON.parse(e.dataTransfer.getData('application/nle-clips')); }
    catch { return; }
    if (!Array.isArray(paths) || paths.length === 0) return;

    const rect     = this._canvas.getBoundingClientRect();
    const mx       = e.clientX - rect.left;
    const my       = e.clientY - rect.top;
    const trackIdx = Math.max(0, this._yToTrackIdx(my) >= 0 ? this._yToTrackIdx(my) : 0);
    const dropPts  = Math.max(0, this._snap(this._xToPts(mx)));

    // Fire event so main.js can call add_clip (it owns the sequence state)
    this._canvas.dispatchEvent(new CustomEvent('nle:drop-clips', {
      bubbles: true,
      detail: { paths, trackIndex: trackIdx, dropPts },
    }));

    this._draw();
  }

  // ── Mouse events ────────────────────────────────────────────────────────

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Zoom around cursor
      const rect = this._canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const ptsBefore = this._xToPts(mouseX);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this._zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._zoom * factor));
      const ptsAfter = this._xToPts(mouseX);
      this._scrollX += (ptsBefore - ptsAfter) / 1e6 * this._zoom;
      this._scrollX  = Math.max(0, this._scrollX);
    } else if (e.shiftKey) {
      this._scrollX = Math.max(0, this._scrollX + e.deltaY * 0.5);
    } else {
      this._scrollX = Math.max(0, this._scrollX + e.deltaX * 0.5);
      this._scrollY = Math.max(0, this._scrollY + e.deltaY * 0.5);
    }
    this._draw();
  }

  _onMouseDown(e) {
    const rect = this._canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    if (this._tool === 'hand') {
      this._handDrag = { startX: e.clientX, startY: e.clientY,
                         scrollX: this._scrollX, scrollY: this._scrollY };
      this._canvas.style.cursor = 'grabbing';
      return;
    }

    // Click in ruler → move playhead
    if (my < RULER_H && mx >= HEADER_W) {
      const pts = this._snap(this._xToPts(mx));
      this.setPlayhead(Math.max(0, pts));
      this._drag = { type: 'playhead' };
      return;
    }

    const trackIdx = this._yToTrackIdx(my);
    if (trackIdx < 0 || mx < HEADER_W) return;

    // Hit-test clips
    const hit = this._hitTestClip(trackIdx, mx, my);

    if (this._tool === 'razor' && hit) {
      const splitPts = this._snap(this._xToPts(mx), hit.clip.clip_id);
      const ok = this._engine.split_clip(hit.clip.clip_id, Math.round(splitPts));
      if (ok) this._draw();
      return;
    }

    if (this._tool === 'select') {
      if (!hit) {
        this._selectedClip = null;
        this._canvas.dispatchEvent(new CustomEvent('clip-deselected', { bubbles: true }));
        this._draw();
        return;
      }

      this._selectedClip = hit.clip.clip_id;
      this._canvas.dispatchEvent(new CustomEvent('clip-selected', {
        bubbles: true, detail: { clipId: hit.clip.clip_id },
      }));

      // Trim handle?
      if (hit.trimEdge) {
        this._trimDrag = {
          clipId:    hit.clip.clip_id,
          edge:      hit.trimEdge,  // 'in' | 'out'
          origIn:    hit.clip.source_in_pts,
          origOut:   hit.clip.source_out_pts,
          origTlIn:  hit.clip.timeline_in_pts,
          origTlOut: hit.clip.timeline_out_pts,
          startX:    mx,
        };
      } else {
        // Move drag
        this._drag = {
          type:      'move',
          clipId:    hit.clip.clip_id,
          origTlIn:  hit.clip.timeline_in_pts,
          origTrack: hit.trackIdx,
          offsetPts: this._xToPts(mx) - hit.clip.timeline_in_pts,
          startX:    mx,
        };
      }
      this._draw();
    }
  }

  _onMouseMove(e) {
    const rect = this._canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    if (this._handDrag) {
      this._scrollX = Math.max(0, this._handDrag.scrollX - (e.clientX - this._handDrag.startX));
      this._scrollY = Math.max(0, this._handDrag.scrollY - (e.clientY - this._handDrag.startY));
      this._draw();
      return;
    }

    if (this._drag?.type === 'playhead') {
      const pts = this._snap(this._xToPts(mx));
      this.setPlayhead(Math.max(0, pts));
      return;
    }

    if (this._drag?.type === 'move') {
      const d       = this._drag;
      const rawPts  = this._xToPts(mx) - d.offsetPts;
      const newPts  = this._snap(rawPts, d.clipId);
      const trackIdx = this._yToTrackIdx(my);
      const targetTrack = trackIdx >= 0 ? trackIdx : d.origTrack;
      this._engine.move_clip(d.clipId, Math.round(Math.max(0, newPts)), targetTrack);
      this._draw();
      return;
    }

    if (this._trimDrag) {
      const td    = this._trimDrag;
      const delta = ((mx - td.startX) / this._zoom) * 1e6;
      let newIn   = td.origIn;
      let newOut  = td.origOut;
      if (td.edge === 'out') {
        newOut = Math.round(td.origOut + delta);
        if (newOut <= newIn + 1) newOut = newIn + 1;
      } else {
        newIn  = Math.round(td.origIn  + delta);
        if (newIn >= newOut - 1) newIn = newOut - 1;
        if (newIn < 0) newIn = 0;
      }
      this._engine.trim_clip(td.clipId, newIn, newOut);
      this._draw();
      return;
    }

    // Cursor feedback
    if (this._tool === 'select') {
      const trackIdx = this._yToTrackIdx(my);
      const hit = trackIdx >= 0 ? this._hitTestClip(trackIdx, mx, my) : null;
      if (hit?.trimEdge) {
        this._canvas.style.cursor = 'ew-resize';
      } else if (hit) {
        this._canvas.style.cursor = 'grab';
      } else {
        this._canvas.style.cursor = 'default';
      }
    }
  }

  _onMouseUp() {
    this._drag     = null;
    this._trimDrag = null;
    if (this._handDrag) {
      this._handDrag = null;
      this._canvas.style.cursor = 'grab';
    }
    this._draw();
  }

  _onDblClick(e) {
    const rect     = this._canvas.getBoundingClientRect();
    const mx       = e.clientX - rect.left;
    const my       = e.clientY - rect.top;
    const trackIdx = this._yToTrackIdx(my);
    if (trackIdx < 0 || mx < HEADER_W) return;
    const hit = this._hitTestClip(trackIdx, mx, my);
    if (hit) {
      window.dispatchEvent(new CustomEvent('nle:open-source', {
        detail: { sourcePath: hit.clip.source_path },
      }));
    }
  }

  // ── Hit testing ─────────────────────────────────────────────────────────

  _hitTestClip(trackIdx, mx) {
    const seq = this._engine._sequences?.get(this._seqId);
    if (!seq) return null;

    const allTracks = this._getAllTracks(seq);
    if (trackIdx >= allTracks.length) return null;

    const track = allTracks[trackIdx];
    for (const clip of track.clips) {
      const x1 = this._ptsToX(clip.timeline_in_pts);
      const x2 = this._ptsToX(clip.timeline_out_pts);
      if (mx >= x1 && mx <= x2) {
        let trimEdge = null;
        if (clip.clip_id === this._selectedClip && x2 - x1 > 12) {
          if (mx <= x1 + 6) trimEdge = 'in';
          if (mx >= x2 - 6) trimEdge = 'out';
        }
        return { clip, trackIdx, trimEdge };
      }
    }
    return null;
  }

  // ── Delete ───────────────────────────────────────────────────────────────

  _deleteSelected() {
    if (!this._selectedClip) return;
    this._engine.remove_clip(this._selectedClip);
    this._selectedClip = null;
    this._canvas.dispatchEvent(new CustomEvent('clip-deselected', { bubbles: true }));
    this._draw();
  }
}

// ── Private helpers ────────────────────────────────────────────────────────

function _roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function _lighten(hex, amount) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + Math.round(255 * amount));
  const g = Math.min(255, ((n >> 8)  & 0xff) + Math.round(255 * amount));
  const b = Math.min(255, ( n        & 0xff) + Math.round(255 * amount));
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

function _formatFpsLabel(num, den) {
  if (!den || den === 1) return `${num}fps`;
  const val = num / den;
  if (Math.abs(val - 23.976) < 0.01) return '23.976fps';
  if (Math.abs(val - 29.97)  < 0.01) return '29.97fps';
  if (Math.abs(val - 59.94)  < 0.01) return '59.94fps';
  return val.toFixed(2).replace(/\.?0+$/, '') + 'fps';
}

function _formatRulerTime(sec, fps) {
  if (sec < 60) {
    // Show as seconds + frame if sub-second interval
    const frames = Math.round((sec % 1) * fps);
    const s      = Math.floor(sec);
    return frames > 0 ? `${s}:${String(frames).padStart(2,'0')}` : `${s}s`;
  }
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
