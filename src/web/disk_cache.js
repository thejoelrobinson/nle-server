/**
 * disk_cache.js – L3 Disk Cache (IndexedDB)
 *
 * Persists decoded ImageBitmap frames across page reloads.
 * Uses IndexedDB with a separate 'nle-frames' database.
 *
 * Key: SHA-256 of "${clipPath}:${roundedPts}"
 * Value: JPEG-compressed frame blob (85% quality, MVP for ImageBitmap frames only)
 *
 * MVP note: Only stores ImageBitmap frames (WebCodecs path). YUV frames from WASM
 * are skipped because rasterization requires WebGL draw (deferred to future phase).
 *
 * Lookup on L2 miss triggers async decode from JPEG blob.
 * After WASM decode, frames are stored asynchronously (fire-and-forget).
 */

export class DiskFrameCache {
  constructor() {
    this._db = null;   // memoized IDBDatabase
    this._supported = typeof OffscreenCanvas !== 'undefined';
  }

  /**
   * Open 'nle-frames' database lazily, memoizing the connection.
   * Returns a Promise that resolves to IDBDatabase.
   */
  async _openDB() {
    if (this._db) return this._db;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open('nle-frames', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        this._db = req.result;
        resolve(this._db);
      };
      req.onupgradeneeded = (evt) => {
        const db = evt.target.result;
        if (!db.objectStoreNames.contains('frames')) {
          db.createObjectStore('frames', { keyPath: 'key' });
        }
      };
    });
  }

  /**
   * Compute SHA-256 key from "${clipPath}:${roundedPts}".
   * Rounds pts to 1ms boundary to avoid floating-point drift.
   */
  static async _makeKey(clipPath, pts) {
    const rounded = Math.round(pts / 1000) * 1000; // snap to 1ms
    const str = `${clipPath}:${rounded}`;
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Look up a frame from L3. Returns { bitmap, width, height } or null.
   * Returns null if not found or OffscreenCanvas unsupported.
   */
  async lookup(clipPath, pts) {
    if (!this._supported) return null;
    try {
      const db = await this._openDB();
      const key = await DiskFrameCache._makeKey(clipPath, pts);
      return new Promise((resolve, reject) => {
        const req = db.transaction('frames', 'readonly')
          .objectStore('frames')
          .get(key);
        req.onerror = () => resolve(null);
        req.onsuccess = async () => {
          const record = req.result;
          if (!record || !record.blob) return resolve(null);
          try {
            const bitmap = await createImageBitmap(record.blob);
            resolve({ bitmap, width: record.width, height: record.height });
          } catch {
            resolve(null); // Failed to decode blob
          }
        };
      });
    } catch {
      return null; // DB error or other failure
    }
  }

  /**
   * Store a frame as JPEG blob in L3. Fire-and-forget, non-blocking.
   * Only stores ImageBitmap frames (MVP). Silently skips YUV frames.
   * Quota exceeded errors are swallowed (non-fatal).
   */
  async store(clipPath, pts, bitmap, width, height) {
    if (!this._supported || !bitmap) return;
    try {
      const oc = new OffscreenCanvas(width, height);
      const ctx = oc.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      const key = await DiskFrameCache._makeKey(clipPath, pts);

      const db = await this._openDB();
      const record = { key, blob, width, height, clipPath, pts, timestamp: Date.now() };
      return new Promise((resolve) => {
        const req = db.transaction('frames', 'readwrite')
          .objectStore('frames')
          .put(record);
        req.onerror = () => resolve(); // Quota error or other failure — non-fatal
        req.onsuccess = () => resolve();
      });
    } catch {
      // OffscreenCanvas error, hash error, or other exception — silent failure
    }
  }
}
