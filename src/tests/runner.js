#!/usr/bin/env node
// Minimal test runner — discovers and runs *.test.js files in this directory
import { readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();

let passed = 0;
let failed = 0;
const failures = [];

for (const file of files) {
    const filePath = resolve(__dirname, file);
    try {
        const mod = await import(filePath);
        if (typeof mod.run === 'function') {
            const results = await mod.run();
            for (const r of results) {
                if (r.ok) {
                    console.log(`  \u2713 ${file}: ${r.name}`);
                    passed++;
                } else {
                    console.error(`  \u2717 ${file}: ${r.name}`);
                    if (r.error) console.error(`    ${r.error}`);
                    failed++;
                    failures.push(`${file}: ${r.name}`);
                }
            }
        }
    } catch (e) {
        console.error(`  \u2717 ${file}: CRASHED \u2014 ${e.message}`);
        failed++;
        failures.push(`${file}: CRASHED`);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('Failed tests:\n' + failures.map(f => '  - ' + f).join('\n'));
    process.exit(1);
}
