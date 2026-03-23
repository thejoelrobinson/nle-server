/**
 * sequence_creator.js – New Sequence dialog
 *
 * Triggered by clicking the "New Sequence" button in the toolbar.
 * Creates a modal dialog with:
 *   - Sequence name (text input)
 *   - Resolution preset dropdown (including Custom)
 *   - Frame rate dropdown
 *   - Width / Height number inputs (linked to preset)
 *   - Cancel / Create buttons
 *
 * On Create: calls engine.create_sequence() and window._nle.switchSequence().
 */

const PRESETS = [
  { label: '4K UHD (3840×2160)', w: 3840, h: 2160 },
  { label: '2K (2048×1080)',     w: 2048, h: 1080 },
  { label: '1080p HD (1920×1080)', w: 1920, h: 1080 },
  { label: '720p HD (1280×720)', w: 1280, h: 720  },
  { label: 'Custom',             w: 0,    h: 0    },
];

const FPS_OPTIONS = [
  { label: '23.976', num: 24000, den: 1001 },
  { label: '24',     num: 24,    den: 1    },
  { label: '25',     num: 25,    den: 1    },
  { label: '29.97',  num: 30000, den: 1001 },
  { label: '30',     num: 30,    den: 1    },
  { label: '50',     num: 50,    den: 1    },
  { label: '59.94',  num: 60000, den: 1001 },
  { label: '60',     num: 60,    den: 1    },
];

let _seqCount = 1;

export function initSequenceCreator() {
  // ── Inject modal HTML ──────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'seq-creator-overlay';
  overlay.className = 'modal-overlay hidden';
  overlay.innerHTML = `
    <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="seq-creator-title">
      <div class="modal-header">
        <span id="seq-creator-title" class="modal-title">New Sequence</span>
      </div>
      <div class="modal-body">
        <label class="field-label">Sequence name
          <input type="text" id="seq-name-input" class="field-input" value="Sequence 01" />
        </label>

        <label class="field-label">Resolution
          <select id="seq-preset-select" class="field-select">
            ${PRESETS.map((p, i) => `<option value="${i}">${p.label}</option>`).join('')}
          </select>
        </label>

        <div id="seq-custom-dims" class="field-row hidden">
          <label class="field-label field-label-sm">Width
            <input type="number" id="seq-width-input" class="field-input field-input-sm" value="1920" min="1" max="16384" />
          </label>
          <label class="field-label field-label-sm">Height
            <input type="number" id="seq-height-input" class="field-input field-input-sm" value="1080" min="1" max="16384" />
          </label>
        </div>

        <label class="field-label">Frame rate
          <select id="seq-fps-select" class="field-select">
            ${FPS_OPTIONS.map((f, i) => `<option value="${i}"${i === 1 ? ' selected' : ''}>${f.label} fps</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="modal-footer">
        <button id="seq-cancel-btn" class="btn-sm">Cancel</button>
        <button id="seq-create-btn" class="btn-sm btn-primary">Create</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // ── References ─────────────────────────────────────────────────────────
  const nameInput    = document.getElementById('seq-name-input');
  const presetSelect = document.getElementById('seq-preset-select');
  const customDims   = document.getElementById('seq-custom-dims');
  const widthInput   = document.getElementById('seq-width-input');
  const heightInput  = document.getElementById('seq-height-input');
  const fpsSelect    = document.getElementById('seq-fps-select');
  const cancelBtn    = document.getElementById('seq-cancel-btn');
  const createBtn    = document.getElementById('seq-create-btn');

  // Default to 1080p (index 2)
  presetSelect.value = '2';

  // ── Preset change ──────────────────────────────────────────────────────
  presetSelect.addEventListener('change', () => {
    const idx    = parseInt(presetSelect.value, 10);
    const preset = PRESETS[idx];
    const isCustom = preset.label === 'Custom';
    customDims.classList.toggle('hidden', !isCustom);
    if (!isCustom) {
      widthInput.value  = preset.w;
      heightInput.value = preset.h;
    }
  });
  // Init dims to match default preset
  widthInput.value  = PRESETS[2].w;
  heightInput.value = PRESETS[2].h;

  // ── Open / Close ───────────────────────────────────────────────────────
  function open() {
    _seqCount++;
    nameInput.value = `Sequence ${String(_seqCount).padStart(2, '0')}`;
    overlay.classList.remove('hidden');
    nameInput.select();
    nameInput.focus();
  }

  function close() {
    overlay.classList.add('hidden');
  }

  // Close on overlay background click
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !overlay.classList.contains('hidden')) close();
  });

  cancelBtn.addEventListener('click', close);

  // ── Create ─────────────────────────────────────────────────────────────
  createBtn.addEventListener('click', () => {
    const { engine } = window._nle ?? {};
    if (!engine) { close(); return; }

    const name    = nameInput.value.trim() || `Sequence ${_seqCount}`;
    const w       = Math.max(1, parseInt(widthInput.value,  10) || 1920);
    const h       = Math.max(1, parseInt(heightInput.value, 10) || 1080);
    const fpsOpt  = FPS_OPTIONS[parseInt(fpsSelect.value, 10)];
    const fps_num = fpsOpt.num;
    const fps_den = fpsOpt.den;

    const newSeqId = engine.create_sequence(name, w, h, fps_num, fps_den);
    if (!newSeqId) { close(); return; }

    window._nle?.switchSequence(newSeqId, fps_num, fps_den);

    // Update program monitor badges
    const badge = document.getElementById('program-seq-name');
    if (badge) badge.textContent = name;
    const meta = document.getElementById('program-seq-meta');
    if (meta) meta.textContent = `${w}×${h} · ${fpsOpt.label}fps`;

    close();
    setStatus(`Created sequence "${name}" (${w}×${h} @ ${fpsOpt.label} fps)`);
  });

  // ── "New Sequence" toolbar button ─────────────────────────────────────
  const newSeqBtn = document.getElementById('btn-new-sequence');
  if (newSeqBtn) newSeqBtn.addEventListener('click', open);

  // Allow other modules to open it programmatically
  window.addEventListener('nle:new-sequence', open);
}

// tiny helper — only available if called from same module scope via closure,
// but we need it in the create handler
function setStatus(msg) {
  const bar = document.getElementById('status');
  if (bar) bar.textContent = msg;
}
