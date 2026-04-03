import assert from 'assert';
import { findNearestFrame, selectEvictionTarget, computeFrameDurationUs, clampElapsed } from '../web/playback_utils.js';

export async function run() {
    const results = [];
    function test(name, fn) {
        try { fn(); results.push({ ok: true, name }); }
        catch (e) { results.push({ ok: false, name, error: e.message }); }
    }

    test('30fps in 23.976fps sequence - 28s decode sim: <5% miss rate', () => {
        const seqFps = 24000 / 1001;
        const srcFrameDur = computeFrameDurationUs(30);
        const seqFrameDur = computeFrameDurationUs(seqFps);
        const durationUs = 28_000_000;
        const cache = new Map();
        const path = '/test/clip.mxf';
        const frameMap = new Map();
        for (let pts = 0; pts < durationUs; pts += srcFrameDur) {
            frameMap.set(pts, { pts });
        }
        cache.set(path, frameMap);
        let misses = 0;
        let total = 0;
        for (let pts = 0; pts < durationUs; pts += seqFrameDur) {
            total++;
            if (!findNearestFrame(cache, pts, path, seqFrameDur * 2)) misses++;
        }
        assert.ok(misses < total * 0.05, `${misses}/${total} misses (${(misses/total*100).toFixed(1)}%)`);
    });

    test('eviction keeps cache at MAX_FRAMES during 28s fill', () => {
        const MAX = 90;
        const frameDur = computeFrameDurationUs(30);
        const frameMap = new Map();
        let evictions = 0;
        for (let pts = 0; pts < 28_000_000; pts += frameDur) {
            frameMap.set(pts, { pts });
            if (frameMap.size > MAX) {
                const key = selectEvictionTarget(frameMap, pts - frameDur * 10);
                if (key !== null) { frameMap.delete(key); evictions++; }
            }
        }
        assert.ok(evictions > 0, 'expected evictions');
        assert.ok(frameMap.size <= MAX + 1, `cache too large: ${frameMap.size}`);
    });

    test('clampElapsed prevents multi-frame skips at 23.976fps', () => {
        const seqFrameDurMs = computeFrameDurationUs(24000 / 1001) / 1000;
        const clamped = clampElapsed(500, seqFrameDurMs * 2);
        assert.ok(clamped <= seqFrameDurMs * 2);
        assert.ok(clamped < 500);
    });

    return results;
}
