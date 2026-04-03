import { computeFrameDurationUs, clampElapsed } from '../web/playback_utils.js';
import assert from 'assert';

export async function run() {
    const results = [];
    function test(name, fn) {
        try { fn(); results.push({ ok: true, name }); }
        catch (e) { results.push({ ok: false, name, error: e.message }); }
    }

    test('23.976fps = ~41708us', () => {
        const d = computeFrameDurationUs(24000/1001);
        assert.ok(Math.abs(d - 41708) <= 1, `got ${d}`);
    });
    test('30fps = ~33333us', () => {
        const d = computeFrameDurationUs(30);
        assert.ok(Math.abs(d - 33333) <= 1, `got ${d}`);
    });
    test('25fps = 40000us', () => {
        assert.strictEqual(computeFrameDurationUs(25), 40000);
    });
    test('24fps = ~41667us', () => {
        const d = computeFrameDurationUs(24);
        assert.ok(Math.abs(d - 41667) <= 1, `got ${d}`);
    });
    test('clampElapsed - clamps large value', () => {
        assert.strictEqual(clampElapsed(200, 50), 50);
    });
    test('clampElapsed - passes small value', () => {
        assert.strictEqual(clampElapsed(30, 50), 30);
    });
    test('clampElapsed - passes exact max', () => {
        assert.strictEqual(clampElapsed(50, 50), 50);
    });

    return results;
}
