export function showExportDialog(engine, pool, sequenceId) {
    // Remove any existing dialog
    document.querySelector('#export-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'export-modal';
    modal.innerHTML = `
        <div class="export-backdrop"></div>
        <div class="export-dialog">
            <h2>Export Sequence</h2>
            <p id="export-status">Ready to export.</p>
            <div class="export-progress-track">
                <div class="export-progress-bar" id="export-progress-bar" style="width:0%"></div>
            </div>
            <p id="export-pct">0%</p>
            <div class="export-actions">
                <button id="btn-export-start">Export</button>
                <button id="btn-export-cancel" disabled>Cancel</button>
                <button id="btn-export-close">Close</button>
            </div>
        </div>
    `;

    // Inline styles so no separate CSS file needed
    const style = document.createElement('style');
    style.textContent = `
        #export-modal .export-backdrop {
            position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:999;
        }
        #export-modal .export-dialog {
            position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
            background:#1e1e1e; color:#eee; padding:24px 32px; border-radius:8px;
            z-index:1000; min-width:360px; font-family:sans-serif;
        }
        #export-modal h2 { margin:0 0 12px; font-size:16px; }
        #export-modal .export-progress-track {
            background:#333; border-radius:4px; height:8px; margin:12px 0 4px;
        }
        #export-modal .export-progress-bar {
            background:#4a9eff; height:8px; border-radius:4px; transition:width 0.1s;
        }
        #export-modal #export-pct { font-size:12px; color:#aaa; margin:0 0 16px; }
        #export-modal .export-actions { display:flex; gap:8px; }
        #export-modal button {
            padding:6px 16px; border-radius:4px; border:none; cursor:pointer;
            background:#333; color:#eee; font-size:13px;
        }
        #export-modal #btn-export-start { background:#4a9eff; color:#fff; }
        #export-modal button:disabled { opacity:0.4; cursor:not-allowed; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(modal);

    let exporter = null;

    document.getElementById('btn-export-start').onclick = async () => {
        const { Exporter } = await import('./export.js');
        exporter = new Exporter(engine, pool);

        document.getElementById('btn-export-start').disabled = true;
        document.getElementById('btn-export-cancel').disabled = false;
        document.getElementById('export-status').textContent = 'Exporting\u2026';

        try {
            const blob = await exporter.export(sequenceId, (cur, total) => {
                const pct = Math.round((cur / total) * 100);
                document.getElementById('export-progress-bar').style.width = `${pct}%`;
                document.getElementById('export-pct').textContent = `${pct}% (frame ${cur} / ${total})`;
            });

            if (blob) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'export.webm';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 60000);
                document.getElementById('export-status').textContent = '\u2713 Export complete \u2014 downloading\u2026';
            } else {
                document.getElementById('export-status').textContent = 'Export cancelled.';
            }
        } catch (err) {
            document.getElementById('export-status').textContent = `Error: ${err.message}`;
        }

        document.getElementById('btn-export-start').disabled = false;
        document.getElementById('btn-export-cancel').disabled = true;
    };

    document.getElementById('btn-export-cancel').onclick = () => {
        exporter?.cancel();
        document.getElementById('export-status').textContent = 'Cancelling\u2026';
    };

    document.getElementById('btn-export-close').onclick = () => modal.remove();
}
