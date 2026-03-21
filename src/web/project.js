/**
 * project.js – NLE project save / load / autosave
 *
 * Responsibilities:
 *  - saveProject()      → serialize sequence JSON to a .nleproj file download
 *  - loadProject()      → open a .nleproj file and restore the sequence
 *  - autosave (IndexedDB, every 30 s)
 *  - Cmd/Ctrl+S → saveProject()
 *  - Exposes initProject() to wire all of the above
 *
 * .nleproj format (JSON):
 *  {
 *    "version": 1,
 *    "savedAt": "<ISO timestamp>",
 *    "sequence": <TimelineEngine.get_sequence_json() output>
 *  }
 *
 * Integration:
 *  Reads   window._nle.engine, window._nle.seqId
 *  Emits   CustomEvent 'nle:project-loaded'
 */

const DB_NAME      = 'nle-studio';
const DB_VERSION   = 1;
const STORE_NAME   = 'autosave';
const AUTOSAVE_KEY = 'latest';
const AUTOSAVE_MS  = 30_000;

// ── Public init ──────────────────────────────────────────────────────────

export function initProject() {
  // Cmd/Ctrl+S
  window.addEventListener('nle:save-project', () => saveProject());

  // Autosave every 30s
  setInterval(() => autosave(), AUTOSAVE_MS);

  // Restore last autosave on load
  restoreAutosave();
}

// ── Save (download .nleproj) ──────────────────────────────────────────────

export function saveProject() {
  const { engine, seqId } = window._nle ?? {};
  if (!engine || !seqId) return;

  const seqJson = engine.get_sequence_json(seqId);
  const payload = JSON.stringify({
    version:  1,
    savedAt:  new Date().toISOString(),
    sequence: JSON.parse(seqJson),
  }, null, 2);

  const blob = new Blob([payload], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = _projectFileName();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  _setStatus('Project saved.');
}

// ── Load (open .nleproj) ──────────────────────────────────────────────────

export async function loadProject() {
  let file;
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'NLE Project', accept: { 'application/json': ['.nleproj', '.json'] } }],
        multiple: false,
      });
      file = await handle.getFile();
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  if (!file) {
    // Fallback: hidden <input>
    file = await _pickFileViaInput('.nleproj,.json');
    if (!file) return;
  }
  await _applyProjectFile(file);
}

// ── Autosave (IndexedDB) ──────────────────────────────────────────────────

async function autosave() {
  const { engine, seqId } = window._nle ?? {};
  if (!engine || !seqId) return;

  try {
    const seqJson = engine.get_sequence_json(seqId);
    const payload = { version: 1, savedAt: new Date().toISOString(),
                      sequence: JSON.parse(seqJson) };
    const db = await _openDb();
    await _idbPut(db, STORE_NAME, AUTOSAVE_KEY, payload);
  } catch { /* autosave is best-effort */ }
}

async function restoreAutosave() {
  try {
    const db   = await _openDb();
    const data = await _idbGet(db, STORE_NAME, AUTOSAVE_KEY);
    if (!data) return;
    _applySequence(data.sequence);
  } catch { /* no autosave */ }
}

// ── Internal helpers ──────────────────────────────────────────────────────

async function _applyProjectFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.version !== 1 || !data.sequence) {
      throw new Error('Unrecognised project file format (expected version 1).');
    }
    _applySequence(data.sequence);
    _setStatus('Project loaded: ' + file.name);
  } catch (err) {
    _setStatus('Load failed: ' + err.message, true);
  }
}

function _applySequence(sequenceObj) {
  const { engine } = window._nle ?? {};
  if (!engine) return;

  const jsonStr = JSON.stringify(sequenceObj);
  const ok = engine.load_sequence_json(jsonStr);
  if (!ok) { _setStatus('Failed to restore sequence.', true); return; }

  window.dispatchEvent(new CustomEvent('nle:project-loaded', {
    detail: { seqId: sequenceObj.id },
  }));
}

function _projectFileName() {
  const { engine, seqId } = window._nle ?? {};
  const seq = engine?._sequences?.get(seqId);
  const name = (seq?.name ?? 'project').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${name}_${ts}.nleproj`;
}

function _setStatus(msg, isError = false) {
  const bar = document.getElementById('status');
  if (!bar) return;
  bar.textContent = msg;
  bar.className   = 'status-bar' + (isError ? ' error' : '');
}

function _pickFileViaInput(accept) {
  return new Promise((resolve) => {
    const input    = document.createElement('input');
    input.type     = 'file';
    input.accept   = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      document.body.removeChild(input);
      resolve(input.files[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve(null);
    });
    input.click();
  });
}

// ── IndexedDB thin wrappers ───────────────────────────────────────────────

function _openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function _idbPut(db, store, key, value) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

function _idbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror   = (e) => reject(e.target.error);
  });
}
