export class FrameCache {
    constructor(maxSize = 30) {
        this._cache = new Map(); // key: `${path}:${pts}` → { frame, lastAccessed }
        this._maxSize = maxSize;
    }

    set(path, pts, frame) {
        const key = `${path}:${pts}`;
        this._cache.set(key, { frame, lastAccessed: performance.now() });
        if (this._cache.size > this._maxSize) this._evictOldest();
    }

    get(path, pts) {
        const key = `${path}:${pts}`;
        const entry = this._cache.get(key);
        if (!entry) return null;
        entry.lastAccessed = performance.now(); // true LRU: update on access
        return entry.frame;
    }

    has(path, pts) {
        return this._cache.has(`${path}:${pts}`);
    }

    clear() {
        this._cache.clear();
    }

    _evictOldest() {
        let oldestKey = null, oldestTime = Infinity;
        for (const [key, entry] of this._cache) {
            if (entry.lastAccessed < oldestTime) {
                oldestTime = entry.lastAccessed;
                oldestKey = key;
            }
        }
        if (oldestKey) this._cache.delete(oldestKey);
    }

    get size() { return this._cache.size; }
}
