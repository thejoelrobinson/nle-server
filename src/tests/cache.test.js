import { findNearestFrame, shouldEvict, selectEvictionTarget } from '../web/playback_utils.js';
import assert from 'assert';

export async function run() {
    const results = [];
    function test(name, fn) {
        try { fn(); results.push({ ok: true, name }); }
        catch (e) { results.push({ ok: false, name, error: e.message }); }
    }

    test('findNearestFrame - exact match', () => {
        const cache = new Map();
        cache.set('/src/clip.mxf', new Map([[1000, { pts: 1000 }]]));
        const r = findNearestFrame(cache, 1000, '/src/clip.mxf');
        assert.ok(r !== null); assert.strictEqual(r.pts, 1000);
    });

    test('findNearestFrame - nearest within tolerance', () => {
        const cache = new Map();
        cache.set('/src/clip.mxf', new Map([[1000, { pts: 1000 }], [2000, { pts: 2000 }]]));
        const r = findNearestFrame(cache, 1200, '/src/clip.mxf', 500);
        assert.ok(r !== null); assert.strictEqual(r.pts, 1000);
    });

    test('findNearestFrame - miss beyond maxDist', () => {
        const cache = new Map();
        cache.set('/src/clip.mxf', new Map([[1000, { pts: 1000 }]]));
        const r = findNearestFrame(cache, 5000, '/src/clip.mxf', 100);
        assert.strictEqual(r, null);
    });

    test('findNearestFrame - empty cache returns null', () => {
        const r = findNearestFrame(new Map(), 1000, '/src/clip.mxf');
        assert.strictEqual(r, null);
    });

    test('findNearestFrame - unknown source returns null', () => {
        const cache = new Map();
        cache.set('/src/other.mxf', new Map([[1000, { pts: 1000 }]]));
        const r = findNearestFrame(cache, 1000, '/src/clip.mxf');
        assert.strictEqual(r, null);
    });

    test('shouldEvict - true at max', () => { assert.ok(shouldEvict(90, 90)); });
    test('shouldEvict - true over max', () => { assert.ok(shouldEvict(91, 90)); });
    test('shouldEvict - false under max', () => { assert.ok(!shouldEvict(89, 90)); });

    test('selectEvictionTarget - evicts smallest key behind playhead', () => {
        const map = new Map([[1000, {}], [2000, {}], [3000, {}]]);
        assert.strictEqual(selectEvictionTarget(map, 3500), 1000);
    });

    test('selectEvictionTarget - all ahead: evicts LARGEST (furthest future)', () => {
        const map = new Map([[5000, {}], [6000, {}], [7000, {}]]);
        assert.strictEqual(selectEvictionTarget(map, 1000), 7000);
    });

    test('selectEvictionTarget - empty map returns null', () => {
        assert.strictEqual(selectEvictionTarget(new Map(), 1000), null);
    });

    return results;
}
