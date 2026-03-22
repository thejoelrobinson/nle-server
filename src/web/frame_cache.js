export class FrameCache {
    constructor(maxSize = 30) {
        this._cache = new Map(); // key: `${path}:${pts}` → { frame, insertedAt }
        this._maxSize = maxSize;
    }

    set(path, pts, frame) {
        const key = `${path}:${pts}`;
        this._cache.set(key, { frame, insertedAt: performance.now() });
        if (this._cache.size > this._maxSize) this._evictOldest();
    }

    get(path, pts) {
        return this._cache.get(`${path}:${pts}`)?.frame ?? null;
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
            if (entry.insertedAt < oldestTime) {
                oldestTime = entry.insertedAt;
                oldestKey = key;
            }
        }
        if (oldestKey) this._cache.delete(oldestKey);
    }

    get size() { return this._cache.size; }
}
