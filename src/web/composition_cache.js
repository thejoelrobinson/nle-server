/**
 * composition_cache.js – L1 Composition Cache
 *
 * Caches fully-composited WebGL canvas output as ImageBitmap.
 * Keyed by ${seqId}:${editGeneration}:${frameIndex}.
 * Max 5 entries with true LRU eviction.
 *
 * On cache hit: draw the cached bitmap directly, skipping all decode and compositing.
 * On cache miss: compose normally, then capture canvas asynchronously for future hits.
 *
 * Critical: Must call .close() on evicted bitmaps to free GPU memory immediately.
 */

export class CompositionCache {
  constructor(maxSize = 5) {
    this._cache = new Map(); // key → { bitmap, width, height, lastAccessed }
    this._maxSize = maxSize;
  }

  /**
   * Store a composited frame.
   * key is composed of: seqId, editGen, frameIndex
   */
  set(seqId, editGen, frameIndex, bitmapFrame) {
    const key = this._key(seqId, editGen, frameIndex);
    // Close any existing entry with this key
    const existing = this._cache.get(key);
    if (existing?.bitmap?.close) {
      existing.bitmap.close();
    }
    this._cache.set(key, { ...bitmapFrame, lastAccessed: performance.now() });
    if (this._cache.size > this._maxSize) {
      this._evictOldest();
    }
  }

  /**
   * Retrieve a composited frame.
   * Returns { bitmap, width, height } or null.
   */
  get(seqId, editGen, frameIndex) {
    const key = this._key(seqId, editGen, frameIndex);
    const entry = this._cache.get(key);
    if (!entry) return null;
    entry.lastAccessed = performance.now(); // true LRU
    return { bitmap: entry.bitmap, width: entry.width, height: entry.height };
  }

  /**
   * Clear all cached frames and close their bitmaps.
   */
  clear() {
    for (const entry of this._cache.values()) {
      if (entry.bitmap?.close) {
        entry.bitmap.close();
      }
    }
    this._cache.clear();
  }

  _key(seqId, editGen, frameIndex) {
    return `${seqId}:${editGen}:${frameIndex}`;
  }

  _evictOldest() {
    let oldestKey = null, oldestTime = Infinity;
    for (const [key, entry] of this._cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = this._cache.get(oldestKey);
      if (entry?.bitmap?.close) {
        entry.bitmap.close();
      }
      this._cache.delete(oldestKey);
    }
  }

  get size() {
    return this._cache.size;
  }
}
