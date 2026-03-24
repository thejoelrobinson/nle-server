# Plan: NLE CLI

## Context

The NLE is a pure browser app (Vite + WASM) with no server-side code or CLI. Every major feature (sequence CRUD, clip editing, track management, project I/O) lives in browser JS. The goal is a Node.js CLI — `nle` — that gives full control over projects from the terminal and can launch the web UI.

The canonical timeline engine already exists as a standalone JS class in `src/web/__tests__/timeline_engine.test.js` (lines 20–292). We extract it to `src/cli/engine.js` so both the CLI and the test file import from one place. No WASM needed for project/timeline operations.

---

## Files to Create

```
src/cli/
  index.js            ← entry point, commander program
  engine.js           ← extracted TimelineEngine class (from test file)
  project.js          ← .nleproj file I/O (load/save/validate)
  output.js           ← ok/err/table/warn, --json mode, picocolors
  timecode.js         ← re-export web/timecode.js + parseTimecodeOrPts()
  commands/
    sequence.js       ← nle sequence <create|list|info|delete>
    clip.js           ← nle clip <add|move|trim|split|remove|list|info>
    track.js          ← nle track <list|mute|unmute|show|hide|lock|unlock>
    project.js        ← nle project <info|validate>
    serve.js          ← nle serve (spawns vite)
    resolve.js        ← nle resolve <pts>
```

## Files to Modify

- `src/web/__tests__/timeline_engine.test.js` — replace inline class with `import { TimelineEngine } from '../../cli/engine.js'`
- `package.json` — add `bin`, `dependencies`, update `scripts` and `lint`
- `eslint.config.js` — add `src/cli/**` block with `globals.node`
- `vitest.config.js` — add `src/cli/__tests__/**` to include (future tests)

---

## Command Tree

```
nle serve [--port 5173] [--host localhost] [--open]

nle project info    -p <file>
nle project validate -p <file>

nle sequence list   -p <file>
nle sequence create <name>  -p <file> [--width 1920] [--height 1080] [--fps 24]
nle sequence info   [seqId] -p <file>
nle sequence delete <seqId> -p <file> [--yes]

nle clip list   [seqId] -p <file> [--track <n>]
nle clip info   <clipId> -p <file>
nle clip add    <source_path> -p <file> [--seq <id>] --track <n>
                [--at <pts|TC>] [--src-in <pts|TC>] [--src-out <pts|TC>] [--duration <secs>]
nle clip move   <clipId> -p <file> --to <pts|TC> [--track <n>]
nle clip trim   <clipId> -p <file> [--src-in <pts|TC>] [--src-out <pts|TC>]
nle clip split  <clipId> -p <file> --at <pts|TC>
nle clip remove <clipId> -p <file>

nle track list   [seqId] -p <file>
nle track mute   <idx>   -p <file> [--seq <id>]
nle track unmute <idx>   -p <file> [--seq <id>]
nle track show   <idx>   -p <file> [--seq <id>]
nle track hide   <idx>   -p <file> [--seq <id>]
nle track lock   <idx>   -p <file> [--seq <id>]
nle track unlock <idx>   -p <file> [--seq <id>]

nle resolve <pts> -p <file> [--seq <id>] [--timecode]

Global: -p/--project <file>  (or NLE_PROJECT env var)
        -j/--json             machine-readable JSON output
```

---

## Key Implementation Details

### `src/cli/engine.js`
Copy lines 18–292 of `src/web/__tests__/timeline_engine.test.js` verbatim (the `NLE_TIME_BASE` const + `TimelineEngine` class). Add `export`:
```js
export const NLE_TIME_BASE = 1_000_000;
export class TimelineEngine { … }
```

### `src/cli/project.js`
```js
// loadProject(filePath) → { version, savedAt, sequence }   throws ProjectError
// saveProject(filePath, sequenceObj)  → writes { version:1, savedAt: new Date().toISOString(), sequence }
// validateProject(filePath) → { valid, errors[] }
```
Read-modify-write pattern: every mutating CLI command does `loadProject → engine.load_sequence_json → [op] → engine.get_sequence_json → saveProject`.

### `src/cli/timecode.js`
```js
export { usToSecs, secsToUs, frameDurationUs, formatTimecode } from '../web/timecode.js';
// + new helper:
export function parseTimecodeOrPts(input, fps_num, fps_den)
  // accepts "1500000" (µs int string) OR "HH:MM:SS:FF" → returns µs number
```

### `src/cli/output.js`
Single module read by all commands. Checks `--json` flag set once at startup via `setJsonMode(bool)`. Uses `picocolors` (already a transitive dep of Vite — no new install needed).
```js
export function ok(data, humanText)   // --json: stdout JSON; else: colored text
export function err(msg, code = 1)    // stderr, process.exit(code)
export function table(rows, cols)     // ASCII table or JSON array
export function warn(msg)             // yellow stderr
```

### `src/cli/commands/serve.js`
```js
spawn('npx', ['vite', '--port', port, '--host', host, ...(open ? ['--open'] : [])],
  { stdio: 'inherit', cwd: process.cwd() })
```

### `package.json` changes
```json
"bin": { "nle": "./src/cli/index.js" },
"dependencies": {
  "commander": "^12.1.0",
  "picocolors": "^1.1.1"
},
"scripts": {
  ...existing...,
  "lint": "eslint src/web src/cli",
  "nle":  "node src/cli/index.js"
}
```

### `eslint.config.js` — add third block
```js
{
  files: ['src/cli/**/*.js'],
  languageOptions: {
    ecmaVersion: 2022, sourceType: 'module',
    globals: { ...globals.node },
  },
  rules: { 'no-undef': 'error', 'no-unused-vars': 'error',
           'no-console': 'off', 'eqeqeq': 'error', 'prefer-const': 'error' },
}
```

### `vitest.config.js`
```js
include: [
  'src/web/__tests__/**/*.test.js',
  'src/cli/__tests__/**/*.test.js',
],
```
CLI tests get `// @vitest-environment node` since they don't need jsdom.

---

## Exit Codes
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (file not found, bad arg) |
| 2 | Project validation failure |
| 3 | Engine operation rejected (overlap, clip not found) |

---

## Critical Files
- `src/web/__tests__/timeline_engine.test.js` — engine class to extract (lines 18–292)
- `src/web/timecode.js` — re-exported by `src/cli/timecode.js`
- `src/web/project.js` — reference for .nleproj format
- `package.json` — needs bin + dependencies
- `eslint.config.js` — needs Node globals block
- `vitest.config.js` — needs CLI include path

---

## Verification

1. `npm install` — installs commander
2. `node src/cli/index.js --help` — prints usage tree
3. `node src/cli/index.js serve` — starts Vite dev server
4. Create a project file, then run:
   - `nle sequence create "My Seq" -p test.nleproj`
   - `nle clip add video.mp4 --track 0 --at 0 --src-in 0 --duration 10 -p test.nleproj`
   - `nle clip list -p test.nleproj --json`
   - `nle project info -p test.nleproj`
5. `npm test` — all existing tests still pass (timeline_engine.test.js now imports from engine.js)
6. `npm run lint` — no errors in src/cli/
