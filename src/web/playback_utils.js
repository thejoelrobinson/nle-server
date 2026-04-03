// src/web/playback_utils.js
// Pure utility functions — no DOM, no browser APIs, fully testable in Node.js

/**
 * Find the nearest cached frame to targetPts within maxDist microseconds.
 * @param {Map} cacheMap - Map<sourcePath, Map<roundedPts, frameEntry>>
 * @param {number} targetPts - target timestamp in microseconds
 * @param {string} sourcePath - source file path key
 * @param {number} maxDist - max allowed distance in µs (default: Infinity)
 * @returns {object|null} frame entry or null
 */
export function findNearestFrame(cacheMap, targetPts, sourcePath, maxDist = Infinity) {
    const map = cacheMap.get(sourcePath);
    if (!map || map.size === 0) return null;
    let best = null;
    let bestDist = maxDist;
    for (const [key, entry] of map.entries()) {
        const dist = Math.abs(key - targetPts);
        if (dist <= bestDist) {
            bestDist = dist;
            best = entry;
        }
    }
    return best;
}

/**
 * Whether the cache needs eviction.
 */
export function shouldEvict(cacheSize, maxFrames) {
    return cacheSize >= maxFrames;
}

/**
 * Select which frame key to evict from a source's frame map.
 * If all frames are ahead of playhead, evict the FURTHEST future frame (largest key).
 * Otherwise evict the frame farthest behind the playhead (smallest key < playheadPts).
 */
export function selectEvictionTarget(frameMap, playheadPts) {
    if (!frameMap || frameMap.size === 0) return null;
    let worstKey = null;
    let worstPts = Infinity;
    for (const [key] of frameMap.entries()) {
        if (key < playheadPts && key < worstPts) {
            worstPts = key;
            worstKey = key;
        }
    }
    if (worstKey === null) {
        let furthestKey = -Infinity;
        for (const [key] of frameMap.entries()) {
            if (key > furthestKey) { furthestKey = key; worstKey = key; }
        }
    }
    return worstKey;
}

/**
 * Compute frame duration in microseconds from fps.
 */
export function computeFrameDurationUs(fps) {
    return Math.round(1_000_000 / fps);
}

/**
 * Clamp elapsed time so a single tick doesn't skip more than maxMs.
 */
export function clampElapsed(elapsedMs, maxMs) {
    return Math.min(elapsedMs, maxMs);
}
