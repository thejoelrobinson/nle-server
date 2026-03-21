/**
 * layout.js — Draggable panel dividers for the 4-panel NLE shell.
 *
 * Reads/writes two CSS custom properties on #app:
 *   --col-w   : left-column width (px)
 *   --top-h   : top-row height (px)
 */

const MIN_PANEL_PX = 120;  // minimum panel size in either axis

/**
 * Initialise both divider drag handlers.
 * Call once after DOMContentLoaded.
 */
export function initLayout() {
  const app       = document.getElementById('app');
  const dividerV  = document.getElementById('divider-col');
  const dividerH  = document.getElementById('divider-row');
  const topRow    = document.getElementById('top-row');

  if (dividerV) _initColDrag(app, dividerV);
  if (dividerH) _initRowDrag(app, topRow, dividerH);
}

// ── Vertical (column) divider ──────────────────────────────────────────────

function _initColDrag(app, divider) {
  let startX = 0;
  let startW = 0;

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = _getComputedPx(app, '--col-w') ?? app.getBoundingClientRect().width * 0.5;

    divider.classList.add('dragging');

    const onMove = (mv) => {
      const delta = mv.clientX - startX;
      const appW  = app.getBoundingClientRect().width;
      const newW  = Math.max(MIN_PANEL_PX, Math.min(startW + delta, appW - MIN_PANEL_PX - 4));
      app.style.setProperty('--col-w', newW + 'px');
    };

    const onUp = () => {
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Horizontal (row) divider ───────────────────────────────────────────────

function _initRowDrag(app, topRow, divider) {
  let startY = 0;
  let startH = 0;

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = topRow.getBoundingClientRect().height;

    divider.classList.add('dragging');

    const onMove = (mv) => {
      const delta = mv.clientY - startY;
      const appH  = app.getBoundingClientRect().height;
      const newH  = Math.max(MIN_PANEL_PX, Math.min(startH + delta, appH - MIN_PANEL_PX - 4));
      app.style.setProperty('--top-h', newH + 'px');
    };

    const onUp = () => {
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _getComputedPx(el, varName) {
  const val = getComputedStyle(el).getPropertyValue(varName).trim();
  if (val.endsWith('px')) return parseFloat(val);
  if (val.endsWith('%')) {
    const rect = el.getBoundingClientRect();
    return parseFloat(val) / 100 * rect.width;
  }
  return null;
}
