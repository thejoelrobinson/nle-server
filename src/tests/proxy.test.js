import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function run() {
    const results = [];
    function test(name, fn) {
        try { fn(); results.push({ ok: true, name }); }
        catch (e) { results.push({ ok: false, name, error: e.message }); }
    }

    const src = readFileSync(resolve(__dirname, '../web/wasm_bridge.js'), 'utf-8');

    test("PROXY_CACHE_VERSION is 'avi3-'", () => {
        assert.ok(src.includes("'avi3-'") || src.includes('"avi3-"'), 'expected avi3-');
    });

    test('proxyEof exists in wasm_bridge.js', () => {
        assert.ok(src.includes('proxyEof'), 'proxyEof should exist');
    });

    test('_proxyNullCount exists in wasm_bridge.js', () => {
        assert.ok(src.includes('_proxyNullCount') || src.includes('proxyNullCount'), '_proxyNullCount should exist');
    });

    test('decodeNextFrame exists in wasm_bridge.js', () => {
        assert.ok(src.includes('decodeNextFrame'), 'decodeNextFrame should exist');
    });

    return results;
}
