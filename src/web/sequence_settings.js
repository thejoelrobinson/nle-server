/**
 * sequence_settings.js – Persistent sequence info bar
 *
 * Renders a slim info bar below the Timeline panel header showing:
 *   - Sequence name (editable inline)
 *   - Resolution (from engine sequence data)
 *   - Frame rate
 *   - Duration (computed from clips, read-only)
 *
 * Updates whenever 'nle:sequence-changed' is dispatched.
 */

import { formatTimecode } from './timecode.js';

export function initSequenceSettings() {
  // ── Find the timeline panel header to insert our bar after it ──────────
  const timelinePanel = document.getElementById('timeline-panel');
  if (!timelinePanel) return;

  const bar = document.createElement('div');
  bar.id = 'seq-settings-bar';
  bar.className = 'seq-settings-bar';
  bar.innerHTML = `
    <span class="seq-settings-label">Sequence:</span>
    <input type="text" id="seq-settings-name" class="seq-settings-name" title="Sequence name (click to edit)" />
    <span class="seq-settings-sep">·</span>
    <span id="seq-settings-res" class="seq-settings-info"></span>
    <span class="seq-settings-sep">·</span>
    <span id="seq-settings-fps" class="seq-settings-info"></span>
    <span class="seq-settings-sep">·</span>
    <span class="seq-settings-label">Duration:</span>
    <span id="seq-settings-dur" class="seq-settings-info">—</span>`;

  // Insert bar between the panel-header and the timeline canvas
  const canvas = document.getElementById('timeline-canvas');
  if (canvas) {
    timelinePanel.insertBefore(bar, canvas);
  } else {
    timelinePanel.appendChild(bar);
  }

  // ── Element refs ────────────────────────────────────────────────────────
  const nameInput = document.getElementById('seq-settings-name');
  const resEl     = document.getElementById('seq-settings-res');
  const fpsEl     = document.getElementById('seq-settings-fps');
  const durEl     = document.getElementById('seq-settings-dur');

  // ── Render current sequence info ────────────────────────────────────────
  function refresh() {
    const { engine, seqId } = window._nle ?? {};
    if (!engine || !seqId) return;

    const seq = engine._sequences?.get(seqId);
    if (!seq) return;

    const fps     = seq.fps_num / (seq.fps_den || 1);
    const fpsStr  = _formatFps(seq.fps_num, seq.fps_den);
    const durUs   = engine.get_sequence_duration?.(seqId) ?? 0;
    const durStr  = durUs > 0 ? formatTimecode(durUs / 1e6, fps) : '—';

    if (nameInput.value !== seq.name) nameInput.value = seq.name || '';
    if (resEl) resEl.textContent = `${seq.width}×${seq.height}`;
    if (fpsEl) fpsEl.textContent = `${fpsStr} fps`;
    if (durEl) durEl.textContent = durStr;

    // Update program monitor header badges
    const badge = document.getElementById('program-seq-name');
    if (badge) badge.textContent = seq.name || '';
    const meta = document.getElementById('program-seq-meta');
    if (meta) meta.textContent = `${seq.width}×${seq.height} · ${fpsStr}fps`;
  }

  // ── Name editing ────────────────────────────────────────────────────────
  nameInput.addEventListener('change', () => {
    const { engine, seqId } = window._nle ?? {};
    const seq = engine?._sequences?.get(seqId);
    if (seq) {
      seq.name = nameInput.value.trim() || seq.name;
      // Update program monitor badge
      const badge = document.getElementById('program-seq-name');
      if (badge) badge.textContent = seq.name;
    }
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Escape') nameInput.blur();
  });

  // ── Listen for sequence changes ──────────────────────────────────────────
  window.addEventListener('nle:sequence-changed', refresh);
  window.addEventListener('nle:project-loaded',   refresh);
  window.addEventListener('nle:clip-added',        refresh);

  // Initial render (deferred slightly so engine has initialised)
  setTimeout(refresh, 50);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _formatFps(num, den) {
  if (!den || den === 1) return String(num);
  const val = num / den;
  // Common drop-frame rates
  if (Math.abs(val - 23.976) < 0.01) return '23.976';
  if (Math.abs(val - 29.97)  < 0.01) return '29.97';
  if (Math.abs(val - 59.94)  < 0.01) return '59.94';
  return val.toFixed(3).replace(/\.?0+$/, '');
}
