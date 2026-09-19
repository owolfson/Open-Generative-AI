# ogai-local Service Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dependency Node service (`ogai-local`) that runs upstream's Electron engine modules behind a stand-in, gates every GPU job through gpu-arbiter with a single-flight queue, and exposes REST + SSE + MCP (local tools plus an allowlisted Muapi pass-through) - with GPU work disabled until explicitly enabled.

**Architecture:** `standin.js` fakes `require('electron')` so `electron/lib/*` runs unmodified and its IPC handlers become callable functions. `queue.js` (single-flight FIFO) + `runner.js` (device choice, arbiter lease, artifact persistence) execute jobs; `service.js` is the shared core used by `server.js` (HTTP/SSE) and `mcp.js` (JSON-RPC).

**Tech Stack:** Node >= 20 (host has 22.18), CommonJS, `node:test`, no npm dependencies.

**Spec:** `custom/docs/specs/2026-09-19-ogai-local-design.md`

## Global Constraints

- Zero npm dependencies; only Node builtins. (Host is memory-starved: no `npm install`.)
- CommonJS with `'use strict'`. Tests run with `node --test test/*.test.js` from `custom/local-service/` - never pass a directory to `--test` (it falsely fails).
- Upstream engine code is loaded unmodified from `OGAI_UPSTREAM_DIR`; never edit files under `electron/`.
- No secrets, tokens, or LAN addresses in committed files; host values come from env vars.
- GPU jobs are refused unless `OGAI_GPU_ENABLED=1`; V100 jobs are refused without `OGAI_ARBITER_URL`. No task in this plan performs a real GPU job.
- Every endpoint except `GET /health` requires `Authorization: Bearer <OGAI_TOKEN>`.
- Muapi key-management/top-up MCP tools stay blocked; the cloud allowlist is default-deny.
- Commits end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

All paths below are relative to the repo root `/mnt/user/data/Projects/UnraidDev/Open-Generative-AI`; run tests from `custom/local-service/`.

---

### Task 1: Config + Electron stand-in

**Files:**
- Create: `custom/local-service/package.json`, `custom/local-service/src/config.js`, `custom/local-service/src/standin.js`
- Test: `custom/local-service/test/config.test.js`, `custom/local-service/test/standin.test.js`

**Interfaces:**
- Produces: `loadConfig(env?) -> {port, dataDir, outputsDir, upstreamDir, resourcesPath, token, gpuEnabled, arbiterUrl, sdcppConsumer, sdcppVramGb, deviceIndexV100, deviceIndex1080, muapiKeyFile, muapiMcpUrl}`
- Produces: `createStandin({userDataPath, isPackaged?, resourcesPath?}) -> {events: EventEmitter ('send', channel, data), channels(), has(channel), invoke(channel, ...args): Promise, uninstall()}`

- [ ] **Step 1: Write the failing tests**

<!-- file: custom/local-service/test/config.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('defaults are safe: GPU off, no arbiter, no token', () => {
  const c = loadConfig({});
  assert.equal(c.gpuEnabled, false);
  assert.equal(c.arbiterUrl, '');
  assert.equal(c.token, '');
  assert.equal(c.port, 8790);
  assert.equal(c.dataDir, '/data');
  assert.equal(c.outputsDir, '/data/outputs');
  assert.equal(c.muapiKeyFile, '/data/.muapi-key');
  assert.equal(c.deviceIndexV100, 0);
  assert.equal(c.deviceIndex1080, 1);
});

test('GPU is only enabled by the literal string 1', () => {
  assert.equal(loadConfig({ OGAI_GPU_ENABLED: '1' }).gpuEnabled, true);
  for (const v of ['0', 'true', 'yes', '']) assert.equal(loadConfig({ OGAI_GPU_ENABLED: v }).gpuEnabled, false, v);
});

test('overrides are honoured and the arbiter url loses trailing slashes', () => {
  const c = loadConfig({ OGAI_ARBITER_URL: 'http://arb:6000//', OGAI_LOCAL_PORT: '9000', OGAI_DATA_DIR: '/x', OGAI_SDCPP_CONSUMER: 'MyCons', OGAI_DEVICE_INDEX_1080: '2' });
  assert.equal(c.arbiterUrl, 'http://arb:6000');
  assert.equal(c.port, 9000);
  assert.equal(c.outputsDir, '/x/outputs');
  assert.equal(c.sdcppConsumer, 'mycons');
  assert.equal(c.deviceIndex1080, 2);
});
```

<!-- file: custom/local-service/test/standin.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStandin } = require('../src/standin');

const ENGINE = `
const { ipcMain, app, BrowserWindow } = require('electron');
module.exports.register = () => {
  ipcMain.handle('t:echo', (_event, a, b) => ({ a, b, userData: app.getPath('userData'), packaged: app.isPackaged }));
  ipcMain.handle('t:progress', () => { BrowserWindow.getAllWindows()[0].webContents.send('t:tick', { n: 1 }); return 'sent'; });
};`;

function loadFakeEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-'));
  const file = path.join(dir, 'engine.js');
  fs.writeFileSync(file, ENGINE);
  require(file).register();
}

test('captures ipc handlers and passes an event object as the first argument', async () => {
  const s = createStandin({ userDataPath: '/data/ud', isPackaged: true });
  try {
    loadFakeEngine();
    assert.deepEqual(s.channels(), ['t:echo', 't:progress']);
    assert.ok(s.has('t:echo'));
    assert.deepEqual(await s.invoke('t:echo', 1, 'two'), { a: 1, b: 'two', userData: '/data/ud', packaged: true });
  } finally { s.uninstall(); }
});

test('webContents.send is re-emitted as a send event', async () => {
  const s = createStandin({ userDataPath: '/data/ud' });
  try {
    loadFakeEngine();
    const seen = [];
    s.events.on('send', (channel, data) => seen.push([channel, data]));
    assert.equal(await s.invoke('t:progress'), 'sent');
    assert.deepEqual(seen, [['t:tick', { n: 1 }]]);
  } finally { s.uninstall(); }
});

test('an unknown channel rejects with ENOCHANNEL', async () => {
  const s = createStandin({ userDataPath: '/x' });
  try { await assert.rejects(() => s.invoke('nope'), { code: 'ENOCHANNEL' }); } finally { s.uninstall(); }
});

test('uninstall removes the electron shim and restores process.resourcesPath', () => {
  const before = process.resourcesPath;
  const s = createStandin({ userDataPath: '/x', resourcesPath: '/res' });
  assert.equal(process.resourcesPath, '/res');
  assert.equal(require('electron').app.getPath(), '/x');
  s.uninstall();
  assert.equal(process.resourcesPath, before);
  // In a repo checkout the real `electron` npm package may resolve (a path string); either way the stand-in must be gone.
  let after = null;
  try { after = require('electron'); } catch { /* not installed: fine */ }
  assert.ok(!after || !after.ipcMain, 'the stand-in must no longer be served for require("electron")');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: FAIL - `Cannot find module '../src/config'`.

- [ ] **Step 3: Write the implementation**

<!-- file: custom/local-service/package.json -->
```json
{
  "name": "ogai-local",
  "version": "0.1.0",
  "private": true,
  "description": "Local inference + agent API for the Open-Generative-AI fork",
  "main": "src/index.js",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test test/*.test.js"
  }
}
```

<!-- file: custom/local-service/src/config.js -->
```js
'use strict';
const path = require('node:path');

function loadConfig(env = process.env) {
  const dataDir = env.OGAI_DATA_DIR || '/data';
  return {
    port: Number(env.OGAI_LOCAL_PORT || 8790),
    dataDir,
    outputsDir: path.join(dataDir, 'outputs'),
    upstreamDir: env.OGAI_UPSTREAM_DIR || '/app',           // repo root that contains electron/lib
    resourcesPath: env.OGAI_RESOURCES_PATH || '',           // holds local-ai/<platform>-<arch>/bin/sd-cli
    token: env.OGAI_TOKEN || '',
    gpuEnabled: env.OGAI_GPU_ENABLED === '1',               // safety switch: nothing touches a GPU unless this is exactly "1"
    arbiterUrl: (env.OGAI_ARBITER_URL || '').replace(/\/+$/, ''),
    sdcppConsumer: (env.OGAI_SDCPP_CONSUMER || 'ogai-local').toLowerCase(),
    sdcppVramGb: Number(env.OGAI_SDCPP_VRAM_GB || 10),
    deviceIndexV100: Number(env.OGAI_DEVICE_INDEX_V100 ?? 0),
    deviceIndex1080: Number(env.OGAI_DEVICE_INDEX_1080 ?? 1),
    muapiKeyFile: env.MUAPI_KEY_FILE || path.join(dataDir, '.muapi-key'),
    muapiMcpUrl: env.MUAPI_MCP_URL || 'https://api.muapi.ai/mcp',
  };
}

module.exports = { loadConfig };
```

<!-- file: custom/local-service/src/standin.js -->
```js
'use strict';
const Module = require('node:module');
const EventEmitter = require('node:events');

/**
 * Stand-in for require('electron') so upstream's Electron main-process engine modules run unmodified
 * in a plain Node server.
 *   ipcMain.handle(channel, fn)   recorded; call it with invoke(channel, ...args)
 *   webContents.send(ch, data)    re-emitted as events.emit('send', ch, data)
 *   app.getPath()                 -> userDataPath;  app.isPackaged + process.resourcesPath -> bundled sd-cli dir
 */
function createStandin({ userDataPath, isPackaged = false, resourcesPath } = {}) {
  const handlers = new Map();
  const events = new EventEmitter();
  const window = { webContents: { send: (channel, data) => events.emit('send', channel, data) } };
  const electron = {
    ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn); } },
    app: { getPath: () => userDataPath, isPackaged },
    BrowserWindow: { getAllWindows: () => [window] },
  };

  const previousResources = process.resourcesPath;
  if (resourcesPath) process.resourcesPath = resourcesPath;

  const realLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'electron') return electron;
    return realLoad.call(this, request, ...rest);
  };

  return {
    events,
    channels: () => [...handlers.keys()].sort(),
    has: (channel) => handlers.has(channel),
    async invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw Object.assign(new Error(`unknown channel: ${channel}`), { code: 'ENOCHANNEL' });
      return fn({ sender: window.webContents }, ...args);   // ipcMain handlers receive the IPC event first
    },
    uninstall() {
      Module._load = realLoad;
      process.resourcesPath = previousResources;
    },
  };
}

module.exports = { createStandin };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add custom/local-service custom/docs
git commit -m "feat(local): config + Electron stand-in for running upstream engine modules in Node

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Engine loader

**Files:**
- Create: `custom/local-service/src/engines.js`
- Test: `custom/local-service/test/engines.test.js`

**Interfaces:**
- Consumes: `createStandin` (Task 1)
- Produces: `loadEngines({upstreamDir, userDataPath, resourcesPath?, wan2gp?: 'upstream'|'none'}) -> standin` with all upstream IPC handlers registered

- [ ] **Step 1: Write the failing test**

<!-- file: custom/local-service/test/engines.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEngines } = require('../src/engines');

const REPO = path.resolve(__dirname, '..', '..', '..');   // custom/local-service/test -> repo root
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-engines-'));
const SD_IDS = ['anything-v5', 'dreamshaper-8', 'realistic-vision-v51', 'stable-diffusion-xl-base', 'z-image-base', 'z-image-turbo'];

test('loads upstream engines unmodified: 15 IPC channels and 6 sd.cpp models', async () => {
  const s = loadEngines({ upstreamDir: REPO, userDataPath: tmp() });
  try {
    assert.equal(s.channels().length, 15);
    for (const c of ['local-ai:generate', 'local-ai:list-models', 'local-ai:cancel-generation', 'wan2gp:probe']) assert.ok(s.has(c), c);
    const models = await s.invoke('local-ai:list-models');
    assert.deepEqual(models.map((m) => m.id).sort(), SD_IDS);
  } finally { s.uninstall(); }
});

test('wan2gp: none skips upstream stale Wan2GP provider', () => {
  const s = loadEngines({ upstreamDir: REPO, userDataPath: tmp(), wan2gp: 'none' });
  try {
    assert.equal(s.has('local-ai:generate'), true);
    assert.equal(s.has('wan2gp:probe'), false);
  } finally { s.uninstall(); }
});

test('a bundled sd-cli under resourcesPath is reported as installed (no upstream download)', async () => {
  const res = tmp();
  const bin = path.join(res, 'local-ai', `${process.platform}-${process.arch}`, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'sd-cli'), '#!/bin/sh\n');
  const s = loadEngines({ upstreamDir: REPO, userDataPath: tmp(), resourcesPath: res });
  try { assert.equal((await s.invoke('local-ai:binary-status')).exists, true); } finally { s.uninstall(); }
});

test('without a bundled binary the engine reports not installed', async () => {
  const s = loadEngines({ upstreamDir: REPO, userDataPath: tmp() });
  try { assert.equal((await s.invoke('local-ai:binary-status')).exists, false); } finally { s.uninstall(); }
});

test('engines can be loaded twice in one process (require cache is purged)', () => {
  loadEngines({ upstreamDir: REPO, userDataPath: tmp() }).uninstall();
  const b = loadEngines({ upstreamDir: REPO, userDataPath: tmp() });
  try { assert.equal(b.channels().length, 15); } finally { b.uninstall(); }
});

test('tripwire: upstream engine modules only require node builtins (the slim image has no node_modules)', () => {
  const builtins = new Set(require('node:module').builtinModules);
  const lib = path.join(REPO, 'electron', 'lib');
  const offenders = [];
  for (const file of fs.readdirSync(lib).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(lib, file), 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const name = m[1];
      if (name.startsWith('.') || name === 'electron' || builtins.has(name.replace(/^node:/, ''))) continue;
      offenders.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [], 'upstream added an npm dependency to electron/lib - the ogai-local image needs it too');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd custom/local-service && node --test test/engines.test.js`
Expected: FAIL - `Cannot find module '../src/engines'`.

- [ ] **Step 3: Write the implementation**

<!-- file: custom/local-service/src/engines.js -->
```js
'use strict';
const path = require('node:path');
const { createStandin } = require('./standin');

// Upstream modules destructure require('electron') once at load, so a second load in the same
// process would keep talking to the first stand-in. Drop them from the cache before loading.
function purgeEngineCache(libDir) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(libDir + path.sep)) delete require.cache[key];
  }
}

/**
 * Load upstream's sd.cpp engine (and, unless overridden, its Wan2GP provider) behind the stand-in.
 * wan2gp: 'upstream' loads upstream's provider; 'none' skips it (our own adapter replaces it).
 */
function loadEngines({ upstreamDir, userDataPath, resourcesPath, wan2gp = 'upstream' }) {
  const libDir = path.join(upstreamDir, 'electron', 'lib');
  const standin = createStandin({ userDataPath, isPackaged: Boolean(resourcesPath), resourcesPath });
  purgeEngineCache(libDir);
  require(path.join(libDir, 'localInference.js')).register();
  if (wan2gp === 'upstream') require(path.join(libDir, 'wan2gpProvider.js')).register();
  return standin;
}

module.exports = { loadEngines };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add custom/local-service
git commit -m "feat(local): engine loader with upstream-drift tripwire

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: V100 model catalog

**Files:**
- Create: `custom/local-service/src/catalog.js`
- Test: `custom/local-service/test/catalog.test.js`

**Interfaces:**
- Consumes: `loadEngines` (Task 2, test only)
- Produces: `assess(id) -> entry|undefined`; `annotate(models[]) -> models[]` (adds `kind, route, v100, star, evidence, weightsGb, note`; unknown ids get `v100: 'unknown'`); `staticCatalog() -> entry[]`; `EXCLUDED: {id, reason}[]`. `entry = {id, name, kind: 'image'|'video', route: 'sdcpp'|'wangp'|'comfyui', v100: 'recommended'|'supported', star, evidence: 'proven'|'untested', weightsGb, note}`

- [ ] **Step 1: Write the failing test**

<!-- file: custom/local-service/test/catalog.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../src/catalog');
const { loadEngines } = require('../src/engines');

const REPO = path.resolve(__dirname, '..', '..', '..');

test('drift tripwire: every model upstream ships has a V100 assessment', async () => {
  const s = loadEngines({ upstreamDir: REPO, userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'cat-')) });
  try {
    const sd = (await s.invoke('local-ai:list-models')).map((m) => m.id);
    const wan = require(path.join(REPO, 'electron/lib/wan2gpProvider.js')).WAN2GP_CATALOG.map((m) => m.id);
    const missing = [...sd, ...wan].filter((id) => !catalog.assess(id));
    assert.deepEqual(missing, [], `upstream added models that need a V100 assessment in catalog.js: ${missing}`);
  } finally { s.uninstall(); }
});

test('the starred (best) models are exactly the agreed set', () => {
  const stars = catalog.staticCatalog().filter((m) => m.star).map((m) => m.id).sort();
  assert.deepEqual(stars, ['wan2gp:flux-dev', 'wan2gp:qwen-image', 'wan2gp:wan22-i2v', 'wan2gp:wan22-t2v', 'z-image-base', 'z-image-turbo']);
});

test('every starred model is recommended and no supported model is starred', () => {
  for (const m of catalog.staticCatalog()) assert.equal(m.star, m.v100 === 'recommended', m.id);
});

test('routes: sd.cpp models -> sdcpp, Qwen -> comfyui (fp16 corrupts it in WanGP), the rest -> wangp', () => {
  assert.equal(catalog.assess('z-image-turbo').route, 'sdcpp');
  assert.equal(catalog.assess('stable-diffusion-xl-base').route, 'sdcpp');
  assert.equal(catalog.assess('wan2gp:qwen-image').route, 'comfyui');
  for (const id of ['wan2gp:flux-dev', 'wan2gp:wan22-t2v', 'wan2gp:wan22-i2v', 'wan2gp:hunyuan-video', 'wan2gp:ltx-video']) assert.equal(catalog.assess(id).route, 'wangp', id);
});

test('only Qwen-Image is marked proven on this V100', () => {
  assert.deepEqual(catalog.staticCatalog().filter((m) => m.evidence === 'proven').map((m) => m.id), ['wan2gp:qwen-image']);
});

test('annotate merges assessments onto upstream models and flags unknown ones', () => {
  const out = catalog.annotate([
    { id: 'z-image-turbo', name: 'Z-Image Turbo', type: 'z-image', state: 'not-downloaded' },
    { id: 'brand-new-model', name: 'Brand New' },
  ]);
  assert.equal(out[0].v100, 'recommended');
  assert.equal(out[0].star, true);
  assert.equal(out[0].state, 'not-downloaded');   // upstream fields survive
  assert.equal(out[0].type, 'z-image');           // ...including ones we do not override
  assert.equal(out[0].kind, 'image');
  assert.equal(out[1].v100, 'unknown');
  assert.equal(out[1].star, false);
  assert.match(out[1].note, /not yet assessed/);
});

test('excluded list documents the LTX 22B and FP4/Nunchaku exclusions and is never assessable', () => {
  const ids = catalog.EXCLUDED.map((e) => e.id);
  assert.ok(ids.includes('ltx-2.3-22b'));
  assert.ok(ids.includes('nvfp4-and-nunchaku-variants'));
  for (const id of ids) assert.equal(catalog.assess(id), undefined);
  for (const e of catalog.EXCLUDED) assert.ok(e.reason.length > 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd custom/local-service && node --test test/catalog.test.js`
Expected: FAIL - `Cannot find module '../src/catalog'`.

- [ ] **Step 3: Write the implementation**

<!-- file: custom/local-service/src/catalog.js -->
```js
'use strict';

// V100 assessments for the models in upstream's "Local Model Inference" README section.
// evidence: 'proven' = has produced correct output on THIS V100; 'untested' = supported by design, not yet run here.
// Volta (compute 7.0) facts: WanGP forces fp16 (no bf16); no FP8/FP4/Nunchaku kernels; SDPA attention only.
const SD = 'sdcpp';
const WAN = 'wangp';
const COMFY = 'comfyui';

const ENTRIES = [
  { id: 'z-image-turbo', name: 'Z-Image Turbo', kind: 'image', route: SD, v100: 'recommended', star: true, evidence: 'untested', weightsGb: 5.2, note: '8-step fast lane. Small enough that the GTX 1080 lane may fit (unverified).' },
  { id: 'z-image-base', name: 'Z-Image Base', kind: 'image', route: SD, v100: 'recommended', star: true, evidence: 'untested', weightsGb: 6.2, note: '50-step quality; same weights class as Turbo.' },
  { id: 'stable-diffusion-xl-base', name: 'SDXL Base 1.0', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', weightsGb: 6.9, note: 'Runs, but older than Z-Image/Flux/Qwen.' },
  { id: 'dreamshaper-8', name: 'Dreamshaper 8', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', weightsGb: 2.1, note: 'SD 1.5; tiny and fast, useful for style variety.' },
  { id: 'realistic-vision-v51', name: 'Realistic Vision v5.1', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', weightsGb: 2.1, note: 'SD 1.5 photorealistic.' },
  { id: 'anything-v5', name: 'Anything v5', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', weightsGb: 2.1, note: 'SD 1.5 anime/illustration.' },
  { id: 'wan2gp:flux-dev', name: 'Flux.1 Dev', kind: 'image', route: WAN, v100: 'recommended', star: true, evidence: 'untested', weightsGb: 12.0, note: 'int8 12.0GB. WanGP forces fp16 on Volta - run a black-image check before trusting it.' },
  { id: 'wan2gp:qwen-image', name: 'Qwen Image', kind: 'image', route: COMFY, v100: 'recommended', star: true, evidence: 'proven', weightsGb: 15.7, note: 'Q6_K GGUF via ComfyUI is proven here (~12 min for 40 steps at 1328x1328, ~25GB peak). Never force fp16: output goes black.' },
  { id: 'wan2gp:wan22-t2v', name: 'Wan 2.2 (Text-to-Video)', kind: 'video', route: WAN, v100: 'recommended', star: true, evidence: 'untested', weightsGb: 29.8, note: 'WanGP ships an fp16-mixed int8 build (14.9GB per expert, two experts).' },
  { id: 'wan2gp:wan22-i2v', name: 'Wan 2.2 (Image-to-Video)', kind: 'video', route: WAN, v100: 'recommended', star: true, evidence: 'untested', weightsGb: 29.8, note: 'Wan 2.1/2.2 I2V GGUFs are already on disk in the ComfyUI store.' },
  { id: 'wan2gp:hunyuan-video', name: 'Hunyuan Video', kind: 'video', route: WAN, v100: 'supported', star: false, evidence: 'untested', weightsGb: 13.2, note: 'Runs, but Wan 2.2 beats it.' },
  { id: 'wan2gp:ltx-video', name: 'LTX Video (0.9.8 13B distilled)', kind: 'video', route: WAN, v100: 'supported', star: false, evidence: 'untested', weightsGb: 13.2, note: 'Fastest video option. LTX-2.3 22B is excluded.' },
];

const EXCLUDED = [
  { id: 'ltx-2.3-22b', reason: 'LTX-2.3 22B (19.4GB int8) caused 4 host crashes on this box; never run it.' },
  { id: 'nvfp4-and-nunchaku-variants', reason: 'Volta (compute 7.0) has no FP4/FP8/Nunchaku kernels.' },
];

const BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

const assess = (id) => BY_ID.get(id);

const UNKNOWN = { kind: 'image', route: null, v100: 'unknown', star: false, evidence: 'untested', weightsGb: null, note: 'Shipped by upstream, not yet assessed for the V100.' };

function annotate(models) {
  return models.map((m) => {
    const known = BY_ID.get(m.id);
    if (!known) return { ...m, ...UNKNOWN };
    const { name, ...meta } = known;   // keep upstream's display name
    return { ...m, ...meta };
  });
}

const staticCatalog = () => ENTRIES.map((e) => ({ ...e }));

module.exports = { assess, annotate, staticCatalog, EXCLUDED };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add custom/local-service
git commit -m "feat(local): V100 model catalog with drift tripwire

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Single-flight job queue

**Files:**
- Create: `custom/local-service/src/queue.js`
- Test: `custom/local-service/test/queue.test.js`

**Interfaces:**
- Produces: `class JobQueue extends EventEmitter` - `new JobQueue({run(job, {signal}) -> Promise<result>, maxJobs?, now?})`; `submit({kind, route, params}) -> job`; `get(id)`; `list(limit?)` (newest first); `cancel(id) -> boolean`; `wait(id, timeoutMs) -> Promise<job>`; emits `'update'` with the job. `job = {id, kind, route, params, status: 'queued'|'running'|'done'|'error'|'cancelled', createdAt, startedAt, finishedAt, result, error: {code, message}|null}`

- [ ] **Step 1: Write the failing test**

<!-- file: custom/local-service/test/queue.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JobQueue } = require('../src/queue');

const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('runs a job and records the result', async () => {
  const q = new JobQueue({ run: async (job) => ({ echoed: job.params.x }) });
  const job = q.submit({ kind: 'image', route: 'sdcpp', params: { x: 1 } });
  assert.equal(job.status, 'queued');
  const done = await q.wait(job.id, 1000);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { echoed: 1 });
  assert.ok(done.startedAt && done.finishedAt);
});

test('is single-flight and FIFO', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const order = [];
  let running = 0; let maxRunning = 0;
  const q = new JobQueue({ run: async (job) => {
    running += 1; maxRunning = Math.max(maxRunning, running); order.push(job.params.n);
    await gates[job.params.n].promise;
    running -= 1;
    return job.params.n;
  } });
  const ids = [0, 1, 2].map((n) => q.submit({ kind: 'image', route: 'sdcpp', params: { n } }).id);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [0]);
  gates[0].resolve(); await q.wait(ids[0], 1000);
  gates[1].resolve(); await q.wait(ids[1], 1000);
  gates[2].resolve(); await q.wait(ids[2], 1000);
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(maxRunning, 1);
});

test('a failing job records code+message and the next job still runs', async () => {
  const q = new JobQueue({ run: async (job) => { if (job.params.fail) throw Object.assign(new Error('boom'), { code: 'GPU_DISABLED' }); return 'ok'; } });
  const a = q.submit({ kind: 'image', route: 'sdcpp', params: { fail: true } });
  const b = q.submit({ kind: 'image', route: 'sdcpp', params: {} });
  const doneA = await q.wait(a.id, 1000);
  assert.equal(doneA.status, 'error');
  assert.deepEqual(doneA.error, { code: 'GPU_DISABLED', message: 'boom' });
  assert.equal((await q.wait(b.id, 1000)).status, 'done');
});

test('cancelling a queued job removes it without running it', async () => {
  const gate = deferred();
  const ran = [];
  const q = new JobQueue({ run: async (job) => { ran.push(job.params.n); await gate.promise; } });
  const first = q.submit({ kind: 'image', route: 'sdcpp', params: { n: 1 } });
  const second = q.submit({ kind: 'image', route: 'sdcpp', params: { n: 2 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(q.cancel(second.id), true);
  assert.equal(q.get(second.id).status, 'cancelled');
  gate.resolve(); await q.wait(first.id, 1000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, [1]);
});

test('cancelling a running job aborts its signal and marks it cancelled', async () => {
  const q = new JobQueue({ run: (job, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const job = q.submit({ kind: 'image', route: 'sdcpp', params: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(q.get(job.id).status, 'running');
  assert.equal(q.cancel(job.id), true);
  assert.equal((await q.wait(job.id, 1000)).status, 'cancelled');
});

test('cancel returns false for unknown or finished jobs', async () => {
  const q = new JobQueue({ run: async () => 1 });
  const job = q.submit({ kind: 'image', route: 'sdcpp', params: {} });
  await q.wait(job.id, 1000);
  assert.equal(q.cancel(job.id), false);
  assert.equal(q.cancel('nope'), false);
});

test('wait times out and returns the current (non-terminal) job', async () => {
  const gate = deferred();
  const q = new JobQueue({ run: () => gate.promise });
  const job = q.submit({ kind: 'image', route: 'sdcpp', params: {} });
  const seen = await q.wait(job.id, 20);
  assert.ok(['queued', 'running'].includes(seen.status));
  gate.resolve();
});

test('list is newest first and old finished jobs are trimmed past maxJobs', async () => {
  const q = new JobQueue({ run: async () => 1, maxJobs: 3 });
  const ids = [];
  for (let i = 0; i < 5; i += 1) { const j = q.submit({ kind: 'image', route: 'sdcpp', params: { i } }); ids.push(j.id); await q.wait(j.id, 1000); }
  const listed = q.list();
  assert.equal(listed.length, 3);
  assert.equal(listed[0].id, ids[4]);
  assert.equal(q.get(ids[0]), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd custom/local-service && node --test test/queue.test.js`
Expected: FAIL - `Cannot find module '../src/queue'`.

- [ ] **Step 3: Write the implementation**

<!-- file: custom/local-service/src/queue.js -->
```js
'use strict';
const EventEmitter = require('node:events');
const { randomUUID } = require('node:crypto');

const TERMINAL = new Set(['done', 'error', 'cancelled']);

/** Single-flight FIFO job queue: at most one job runs at a time (one GPU job at a time, never stacked). */
class JobQueue extends EventEmitter {
  constructor({ run, maxJobs = 200, now = Date.now } = {}) {
    super();
    this.run = run;
    this.maxJobs = maxJobs;
    this.now = now;
    this.jobs = new Map();     // id -> job, insertion order = submission order
    this.pending = [];         // ids waiting to run
    this.current = null;       // { id, controller }
  }

  submit({ kind, route, params }) {
    const job = { id: randomUUID(), kind, route, params, status: 'queued', createdAt: this.now(), startedAt: null, finishedAt: null, result: null, error: null };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.#trim();
    this.emit('update', job);
    setImmediate(() => this.#pump());
    return job;
  }

  get(id) { return this.jobs.get(id) || null; }

  list(limit = 50) { return [...this.jobs.values()].slice(-limit).reverse(); }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return false;
    if (job.status === 'queued') {
      this.pending = this.pending.filter((x) => x !== id);
      this.#finish(job, 'cancelled');
      return true;
    }
    this.current.controller.abort();   // the runner observes the signal; #pump records the outcome
    return true;
  }

  wait(id, timeoutMs = 0) {
    const job = this.get(id);
    if (!job || TERMINAL.has(job.status) || timeoutMs <= 0) return Promise.resolve(job);
    return new Promise((resolve) => {
      const finish = (j) => { clearTimeout(timer); this.off('update', onUpdate); resolve(j); };
      const onUpdate = (j) => { if (j.id === id && TERMINAL.has(j.status)) finish(j); };
      const timer = setTimeout(() => finish(this.get(id)), timeoutMs);
      this.on('update', onUpdate);
    });
  }

  async #pump() {
    if (this.current || this.pending.length === 0) return;
    const job = this.jobs.get(this.pending.shift());
    const controller = new AbortController();
    this.current = { id: job.id, controller };
    job.status = 'running';
    job.startedAt = this.now();
    this.emit('update', job);
    try {
      job.result = await this.run(job, { signal: controller.signal });
      this.#finish(job, 'done');
    } catch (err) {
      job.error = { code: err.code || 'ERROR', message: err.message };
      this.#finish(job, controller.signal.aborted ? 'cancelled' : 'error');
    } finally {
      this.current = null;
      setImmediate(() => this.#pump());
    }
  }

  #finish(job, status) {
    job.status = status;
    job.finishedAt = this.now();
    this.emit('update', job);
  }

  #trim() {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.maxJobs) break;
      if (TERMINAL.has(job.status)) this.jobs.delete(id);
    }
  }
}

module.exports = { JobQueue };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS (28 tests).

- [ ] **Step 5: Commit**

```bash
git add custom/local-service
git commit -m "feat(local): single-flight job queue

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: GPU arbiter gate

**Files:**
- Create: `custom/local-service/src/gate.js`, `custom/local-service/test/helpers/fake-arbiter.js`
- Test: `custom/local-service/test/gate.test.js`

**Interfaces:**
- Produces: `withLease(cfg, {consumer, vramGb, estSeconds, note}, fn({leaseId}), {fetchImpl?, log?, acquireTimeoutMs?}) -> Promise<fn result>`; errors carry `code` in `ARBITER_UNCONFIGURED | ARBITER_REFUSED`; `codeError(code, message)`

- [ ] **Step 1: Write the fake arbiter helper and failing test**

<!-- file: custom/local-service/test/helpers/fake-arbiter.js -->
```js
'use strict';
const http = require('node:http');

// Minimal stand-in for gpu-arbiter: POST /acquire and POST /release with the real field names.
function startFakeArbiter({ grant = true, refuseStatus = 409, releaseNote = 'released after 1.0s' } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/acquire') {
        if (!grant) { res.statusCode = refuseStatus; return res.end(JSON.stringify({ detail: 'V100 not clear' })); }
        return res.end(JSON.stringify({ ok: true, status: 'ok', lease_id: 'lease-1', holder: body.consumer }));
      }
      if (req.url === '/release') return res.end(JSON.stringify({ ok: true, status: 'ok', note: releaseNote }));
      res.statusCode = 404;
      return res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { startFakeArbiter };
```

<!-- file: custom/local-service/test/gate.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withLease } = require('../src/gate');
const { startFakeArbiter } = require('./helpers/fake-arbiter');

const quiet = () => { const logs = { warn: [], error: [] }; return { logs, log: { warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) } }; };
const opts = { consumer: 'ogai-local', vramGb: 10, estSeconds: 900, note: 'job x' };

test('refuses to run without an arbiter url', async () => {
  let ran = false;
  await assert.rejects(() => withLease({ arbiterUrl: '' }, opts, async () => { ran = true; }), { code: 'ARBITER_UNCONFIGURED' });
  assert.equal(ran, false);
});

test('acquires with the real field names, runs fn with the lease id, then releases by lease_id', async () => {
  const arb = await startFakeArbiter();
  try {
    const { log } = quiet();
    const out = await withLease({ arbiterUrl: arb.url }, opts, async ({ leaseId }) => `ran:${leaseId}`, { log });
    assert.equal(out, 'ran:lease-1');
    assert.equal(arb.calls[0].path, '/acquire');
    assert.deepEqual(arb.calls[0].body, { consumer: 'ogai-local', vram_gb: 10, est_seconds: 900, wait: true, note: 'job x' });
    assert.equal(arb.calls[1].path, '/release');
    assert.deepEqual(arb.calls[1].body, { lease_id: 'lease-1', consumer: 'ogai-local' });
  } finally { await arb.close(); }
});

test('releases even when fn throws, and the original error propagates', async () => {
  const arb = await startFakeArbiter();
  try {
    await assert.rejects(() => withLease({ arbiterUrl: arb.url }, opts, async () => { throw new Error('render failed'); }, { log: quiet().log }), /render failed/);
    assert.equal(arb.calls.filter((c) => c.path === '/release').length, 1);
  } finally { await arb.close(); }
});

test('a refused acquire never runs fn and surfaces the arbiter detail', async () => {
  const arb = await startFakeArbiter({ grant: false });
  try {
    let ran = false;
    await assert.rejects(() => withLease({ arbiterUrl: arb.url }, opts, async () => { ran = true; }, { log: quiet().log }), (err) => err.code === 'ARBITER_REFUSED' && /V100 not clear/.test(err.message));
    assert.equal(ran, false);
    assert.equal(arb.calls.filter((c) => c.path === '/release').length, 0);
  } finally { await arb.close(); }
});

test('a release that silently no-ops (lease already gone) is warned about, not thrown', async () => {
  const arb = await startFakeArbiter({ releaseNote: 'not the active holder (active=hermes)' });
  try {
    const { log, logs } = quiet();
    assert.equal(await withLease({ arbiterUrl: arb.url }, opts, async () => 'done', { log }), 'done');
    assert.equal(logs.warn.length, 1);
    assert.match(logs.warn[0], /already gone/);
  } finally { await arb.close(); }
});

test('an unreachable arbiter on release is logged and does not mask the result', async () => {
  const arb = await startFakeArbiter();
  const { log, logs } = quiet();
  const realFetch = fetch;
  let calls = 0;
  const flaky = (url, init) => { calls += 1; return calls === 1 ? realFetch(url, init) : Promise.reject(new Error('ECONNREFUSED')); };
  try {
    assert.equal(await withLease({ arbiterUrl: arb.url }, opts, async () => 'result', { fetchImpl: flaky, log }), 'result');
    assert.equal(logs.error.length, 1);
  } finally { await arb.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd custom/local-service && node --test test/gate.test.js`
Expected: FAIL - `Cannot find module '../src/gate'`.

- [ ] **Step 3: Write the implementation**

<!-- file: custom/local-service/src/gate.js -->
```js
'use strict';

function codeError(code, message) { return Object.assign(new Error(message), { code }); }

async function post(url, body, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Run fn while holding a gpu-arbiter lease on the V100 (a whole-card lease evicts the Hermes brain).
 * /acquire blocks until granted. /release silently no-ops on a mismatched id, so its note is checked.
 */
async function withLease(cfg, { consumer, vramGb, estSeconds, note }, fn, { fetchImpl = fetch, log = console, acquireTimeoutMs = 30 * 60 * 1000 } = {}) {
  if (!cfg.arbiterUrl) throw codeError('ARBITER_UNCONFIGURED', 'refusing to run a V100 job without the GPU arbiter (set OGAI_ARBITER_URL)');

  const acquired = await post(`${cfg.arbiterUrl}/acquire`, { consumer, vram_gb: vramGb, est_seconds: estSeconds, wait: true, note }, fetchImpl, acquireTimeoutMs);
  if (!acquired.ok || acquired.data?.ok === false || !acquired.data?.lease_id) {
    const detail = acquired.data?.detail || acquired.data?.note || `HTTP ${acquired.status}`;
    throw codeError('ARBITER_REFUSED', `GPU arbiter did not grant a lease: ${detail}`);
  }
  const leaseId = acquired.data.lease_id;

  try {
    return await fn({ leaseId });
  } finally {
    try {
      const released = await post(`${cfg.arbiterUrl}/release`, { lease_id: leaseId, consumer }, fetchImpl, 30_000);
      const releaseNote = released.data?.note || '';
      if (!released.ok) log.error(`gate: release failed (HTTP ${released.status}) for lease ${leaseId}`);
      else if (/not the active holder|no active lease/.test(releaseNote)) log.warn(`gate: lease ${leaseId} was already gone at release (${releaseNote}) - it may have expired mid-job`);
    } catch (err) {
      log.error(`gate: release threw for lease ${leaseId}: ${err.message}`);
    }
  }
}

module.exports = { withLease, codeError };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS (34 tests).

- [ ] **Step 5: Commit**

```bash
git add custom/local-service
git commit -m "feat(local): gpu-arbiter lease gate

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Runner + service core

**Files:**
- Create: `custom/local-service/src/runner.js`, `custom/local-service/src/service.js`
- Test: `custom/local-service/test/runner.test.js`, `custom/local-service/test/service.test.js`

**Interfaces:**
- Consumes: `withLease`, `codeError` (Task 5); `assess`, `annotate`, `staticCatalog`, `EXCLUDED` (Task 3); `JobQueue` (Task 4); standin `invoke` (Task 1)
- Produces: `createRunner({config, standin, gateImpl?, log?}) -> {run(job, {signal}) -> {seed, file, url, dataUrl}}` (throws codes `GPU_DISABLED`, `ENGINE_NOT_READY`); `createService({standin, queue}) -> {submitGeneration(params) -> job, generateAndWait(params) -> doneJob, catalogPayload() -> {models, excluded}}` (throws `UNKNOWN_MODEL` / `BAD_REQUEST`, both `status: 400`)

- [ ] **Step 1: Write the failing tests**

<!-- file: custom/local-service/test/runner.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunner } = require('../src/runner');

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('PNG!').toString('base64')}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-runner-'));
const config = (over = {}) => ({ gpuEnabled: true, arbiterUrl: 'http://arb', outputsDir: tmp(), sdcppConsumer: 'ogai-local', sdcppVramGb: 10, deviceIndexV100: 0, deviceIndex1080: 1, ...over });
const job = (over = {}) => ({ id: 'job1', route: 'sdcpp', params: { model: 'z-image-turbo', prompt: 'a cat' }, ...over });
const ctx = () => ({ signal: new AbortController().signal });
const quiet = { warn() {}, error() {} };

function fakes() {
  const standin = { calls: [], envAtGenerate: null };
  standin.invoke = async (channel, ...args) => {
    standin.calls.push([channel, ...args]);
    if (channel === 'local-ai:generate') { standin.envAtGenerate = process.env.CUDA_VISIBLE_DEVICES; return { url: PNG_DATA_URL, seed: 7 }; }
    return undefined;
  };
  const gate = { calls: [] };
  gate.impl = async (cfg, opts, fn) => { gate.calls.push(opts); return fn({ leaseId: 'lease-1' }); };
  return { standin, gate };
}

test('refuses every job while GPU is disabled', async () => {
  const { standin, gate } = fakes();
  const r = createRunner({ config: config({ gpuEnabled: false }), standin, gateImpl: gate.impl, log: quiet });
  await assert.rejects(() => r.run(job(), ctx()), { code: 'GPU_DISABLED' });
  assert.equal(standin.calls.length, 0);
  assert.equal(gate.calls.length, 0);
});

test('routes other than sdcpp are not wired yet', async () => {
  const { standin, gate } = fakes();
  const r = createRunner({ config: config(), standin, gateImpl: gate.impl, log: quiet });
  await assert.rejects(() => r.run(job({ route: 'wangp' }), ctx()), { code: 'ENGINE_NOT_READY' });
});

test('V100 job: takes an arbiter lease, pins CUDA device 0, persists the PNG', async () => {
  const { standin, gate } = fakes();
  const cfg = config();
  const r = createRunner({ config: cfg, standin, gateImpl: gate.impl, log: quiet });
  const out = await r.run(job(), ctx());
  assert.deepEqual(gate.calls, [{ consumer: 'ogai-local', vramGb: 10, estSeconds: 900, note: 'ogai-local job job1' }]);
  assert.equal(standin.envAtGenerate, '0');
  assert.equal(out.seed, 7);
  assert.equal(out.file, 'job1.png');
  assert.equal(out.url, '/outputs/job1.png');
  assert.equal(out.dataUrl, PNG_DATA_URL);
  assert.equal(fs.readFileSync(path.join(cfg.outputsDir, 'job1.png'), 'utf8'), 'PNG!');
});

test('GTX 1080 job: no arbiter lease (never evicts the brain), CUDA device 1, device param not forwarded', async () => {
  const { standin, gate } = fakes();
  const r = createRunner({ config: config(), standin, gateImpl: gate.impl, log: quiet });
  await r.run(job({ params: { model: 'z-image-turbo', prompt: 'a cat', device: 'gtx1080' } }), ctx());
  assert.equal(gate.calls.length, 0);
  assert.equal(standin.envAtGenerate, '1');
  const generateCall = standin.calls.find((c) => c[0] === 'local-ai:generate');
  assert.deepEqual(generateCall[1], { model: 'z-image-turbo', prompt: 'a cat' });
});

test('aborting the signal cancels the running sd.cpp process', async () => {
  const { gate } = fakes();
  let release;
  const standin = { calls: [], invoke: async (channel) => { standin.calls.push(channel); if (channel === 'local-ai:generate') await new Promise((r) => { release = r; }); return { url: PNG_DATA_URL, seed: 1 }; } };
  const r = createRunner({ config: config(), standin, gateImpl: gate.impl, log: quiet });
  const controller = new AbortController();
  const pending = r.run(job(), { signal: controller.signal });
  await new Promise((res) => setImmediate(res));
  controller.abort();
  await new Promise((res) => setImmediate(res));
  assert.ok(standin.calls.includes('local-ai:cancel-generation'));
  release();
  await pending;
});
```

<!-- file: custom/local-service/test/service.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../src/service');
const { JobQueue } = require('../src/queue');

const SD_MODELS = [{ id: 'z-image-turbo', name: 'Z-Image Turbo', state: 'not-downloaded' }, { id: 'mystery', name: 'Mystery', state: 'not-downloaded' }];
const standin = { invoke: async (channel) => (channel === 'local-ai:list-models' ? SD_MODELS : undefined) };

test('submitGeneration validates the model and prompt', () => {
  const svc = createService({ standin, queue: new JobQueue({ run: async () => ({}) }) });
  assert.throws(() => svc.submitGeneration({ model: 'nope', prompt: 'x' }), { code: 'UNKNOWN_MODEL', status: 400 });
  assert.throws(() => svc.submitGeneration({ model: 'z-image-turbo' }), { code: 'BAD_REQUEST', status: 400 });
  assert.throws(() => svc.submitGeneration(undefined), { code: 'UNKNOWN_MODEL' });
});

test('submitGeneration queues a job with the catalog route and kind', async () => {
  const q = new JobQueue({ run: async () => ({}) });
  const job = createService({ standin, queue: q }).submitGeneration({ model: 'wan2gp:qwen-image', prompt: 'x' });
  assert.equal(job.route, 'comfyui');
  assert.equal(job.kind, 'image');
  await q.wait(job.id, 1000);
});

test('generateAndWait resolves with the done job and rejects with the runner error code', async () => {
  const ok = createService({ standin, queue: new JobQueue({ run: async () => ({ seed: 3, dataUrl: 'data:x' }) }) });
  assert.equal((await ok.generateAndWait({ model: 'z-image-turbo', prompt: 'x' })).result.seed, 3);
  const bad = createService({ standin, queue: new JobQueue({ run: async () => { throw Object.assign(new Error('GPU is off'), { code: 'GPU_DISABLED' }); } }) });
  await assert.rejects(() => bad.generateAndWait({ model: 'z-image-turbo', prompt: 'x' }), { code: 'GPU_DISABLED', message: 'GPU is off' });
});

test('catalogPayload annotates upstream sd.cpp models, flags unknown ones, adds non-sd.cpp entries and exclusions', async () => {
  const { models, excluded } = await createService({ standin, queue: new JobQueue({ run: async () => ({}) }) }).catalogPayload();
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  assert.equal(byId['z-image-turbo'].v100, 'recommended');
  assert.equal(byId['z-image-turbo'].state, 'not-downloaded');
  assert.equal(byId.mystery.v100, 'unknown');
  assert.equal(byId['wan2gp:wan22-t2v'].route, 'wangp');
  assert.equal(models.filter((m) => m.route === 'sdcpp').length, 1);   // only what the engine actually listed
  assert.ok(excluded.some((e) => e.id === 'ltx-2.3-22b'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd custom/local-service && node --test test/runner.test.js test/service.test.js`
Expected: FAIL - `Cannot find module '../src/runner'`.

- [ ] **Step 3: Write the implementation**

<!-- file: custom/local-service/src/runner.js -->
```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { withLease, codeError } = require('./gate');

/**
 * Executes one queued job. The queue guarantees single-flight, which is what makes it safe to set
 * CUDA_VISIBLE_DEVICES on process.env: upstream's spawn() copies process.env at spawn time.
 */
function createRunner({ config, standin, gateImpl = withLease, log = console }) {
  async function runSdcpp(job, { signal }) {
    const { device, ...engineParams } = job.params;
    const onGtx1080 = device === 'gtx1080';

    const call = async () => {
      process.env.CUDA_DEVICE_ORDER = 'PCI_BUS_ID';
      process.env.CUDA_VISIBLE_DEVICES = String(onGtx1080 ? config.deviceIndex1080 : config.deviceIndexV100);
      const cancel = () => { standin.invoke('local-ai:cancel-generation').catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try { return await standin.invoke('local-ai:generate', engineParams); }
      finally { signal.removeEventListener('abort', cancel); }
    };

    // The GTX 1080 is not arbiter-managed and never evicts the Hermes brain; the V100 needs a whole-card lease.
    if (onGtx1080) return call();
    return gateImpl(config, { consumer: config.sdcppConsumer, vramGb: config.sdcppVramGb, estSeconds: 900, note: `ogai-local job ${job.id}` }, call, { log });
  }

  function persist(job, raw) {
    const match = /^data:image\/png;base64,(.+)$/.exec(raw.url || '');
    if (!match) throw codeError('BAD_ENGINE_RESULT', 'sd.cpp returned no PNG data URL');
    fs.mkdirSync(config.outputsDir, { recursive: true });
    const file = `${job.id}.png`;
    fs.writeFileSync(path.join(config.outputsDir, file), Buffer.from(match[1], 'base64'));
    return { seed: raw.seed, file, url: `/outputs/${file}`, dataUrl: raw.url };
  }

  async function run(job, ctx) {
    if (!config.gpuEnabled) throw codeError('GPU_DISABLED', 'GPU jobs are disabled: set OGAI_GPU_ENABLED=1 once the GPU test window is approved');
    if (job.route !== 'sdcpp') throw codeError('ENGINE_NOT_READY', `engine route "${job.route}" is not wired yet`);
    return persist(job, await runSdcpp(job, ctx));
  }

  return { run };
}

module.exports = { createRunner };
```

<!-- file: custom/local-service/src/service.js -->
```js
'use strict';
const catalog = require('./catalog');

function failure(code, message, status) { return Object.assign(new Error(message), { code, status }); }

/** Shared core used by both the HTTP server and the MCP endpoint. */
function createService({ standin, queue }) {
  function submitGeneration(params) {
    const meta = catalog.assess(params && params.model);
    if (!meta) throw failure('UNKNOWN_MODEL', `unknown or excluded model: ${params && params.model}`, 400);
    if (typeof params.prompt !== 'string' || !params.prompt) throw failure('BAD_REQUEST', 'prompt is required', 400);
    return queue.submit({ kind: meta.kind, route: meta.route, params });
  }

  async function generateAndWait(params) {
    const job = submitGeneration(params);
    const done = await queue.wait(job.id, 6 * 60 * 60 * 1000);
    if (done.status !== 'done') {
      throw failure(done.error ? done.error.code : done.status.toUpperCase(), done.error ? done.error.message : `job ${done.status}`, 502);
    }
    return done;
  }

  async function catalogPayload() {
    const sd = await standin.invoke('local-ai:list-models');
    const other = catalog.staticCatalog().filter((m) => m.route !== 'sdcpp');
    return { models: [...catalog.annotate(sd), ...other], excluded: catalog.EXCLUDED };
  }

  return { submitGeneration, generateAndWait, catalogPayload };
}

module.exports = { createService, failure };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS (43 tests).

- [ ] **Step 5: Commit**

```bash
git add custom/local-service
git commit -m "feat(local): runner (device choice, arbiter lease, artifacts) + service core

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Auth + HTTP/SSE server

**Files:**
- Create: `custom/local-service/src/auth.js`, `custom/local-service/src/server.js`
- Test: `custom/local-service/test/auth.test.js`, `custom/local-service/test/server.test.js`

**Interfaces:**
- Consumes: `createService` (Task 6), `JobQueue` (Task 4), standin-like `{invoke, has, channels, events}`, `mcp.handle(msg) -> response|null`
- Produces: `bearerOk(header, token) -> boolean`; `createServer({config, standin, queue, service, mcp}) -> http.Server`; `publicJob(job)` (strips `result.dataUrl`). Routes: `GET /health`; `GET /api/local/catalog`; `POST /ipc/:channel` body `{args: []}` -> `{ok, result}`; `POST /api/local/jobs` -> 202 `{job}`; `GET /api/local/jobs[/:id]`; `POST /api/local/jobs/:id/cancel`; `GET /outputs/:file.png`; `GET /events` (SSE, one event per stand-in `send`); `POST /mcp`

- [ ] **Step 1: Write the failing tests**

<!-- file: custom/local-service/test/auth.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bearerOk } = require('../src/auth');

test('accepts only the exact bearer token', () => {
  assert.equal(bearerOk('Bearer secret', 'secret'), true);
  assert.equal(bearerOk('Bearer secreT', 'secret'), false);
  assert.equal(bearerOk('Bearer secret2', 'secret'), false);
  assert.equal(bearerOk('secret', 'secret'), false);
  assert.equal(bearerOk('', 'secret'), false);
  assert.equal(bearerOk(undefined, 'secret'), false);
});

test('an empty configured token never authenticates anyone', () => {
  assert.equal(bearerOk('Bearer ', ''), false);
  assert.equal(bearerOk('Bearer x', ''), false);
});
```

<!-- file: custom/local-service/test/server.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');
const { createService } = require('../src/service');
const { JobQueue } = require('../src/queue');

const DATA_URL = 'data:image/png;base64,AAAA';
const auth = { authorization: 'Bearer tok' };

async function boot({ token = 'tok', run } = {}) {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-srv-'));
  fs.writeFileSync(path.join(outputsDir, 'x.png'), 'PNGDATA');
  const standin = {
    events: new EventEmitter(),
    calls: [],
    channels: () => ['local-ai:list-models', 'local-ai:binary-status', 'local-ai:generate'],
    has: (c) => ['local-ai:list-models', 'local-ai:binary-status', 'local-ai:generate'].includes(c),
    invoke: async (channel, ...args) => {
      standin.calls.push([channel, ...args]);
      if (channel === 'local-ai:list-models') return [{ id: 'z-image-turbo', name: 'Z-Image Turbo', state: 'not-downloaded' }];
      if (channel === 'local-ai:binary-status') return { exists: false };
      return undefined;
    },
  };
  const queue = new JobQueue({ run: run || (async () => ({ seed: 5, file: 'x.png', url: '/outputs/x.png', dataUrl: DATA_URL })) });
  const service = createService({ standin, queue });
  const mcp = { handle: async (msg) => (msg.method === 'notifications/initialized' ? null : { jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method } }) };
  const server = createServer({ config: { token, gpuEnabled: true, outputsDir }, standin, queue, service, mcp });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, standin, queue, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const jsonPost = (url, body, headers = auth) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('/health is open; everything else needs the bearer token', async () => {
  const app = await boot();
  try {
    const health = await (await fetch(`${app.base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.channels, 3);
    assert.equal((await fetch(`${app.base}/api/local/catalog`)).status, 401);
    assert.equal((await fetch(`${app.base}/api/local/catalog`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${app.base}/api/local/catalog`, { headers: auth })).status, 200);
  } finally { await app.close(); }
});

test('with no token configured every protected route is 503 (safe by default)', async () => {
  const app = await boot({ token: '' });
  try {
    assert.equal((await fetch(`${app.base}/api/local/catalog`, { headers: auth })).status, 503);
    assert.equal((await fetch(`${app.base}/health`)).status, 200);
  } finally { await app.close(); }
});

test('catalog merges annotated sd.cpp models with the other engines and exclusions', async () => {
  const app = await boot();
  try {
    const { models, excluded } = await (await fetch(`${app.base}/api/local/catalog`, { headers: auth })).json();
    assert.equal(models.find((m) => m.id === 'z-image-turbo').star, true);
    assert.ok(models.find((m) => m.id === 'wan2gp:wan22-t2v'));
    assert.ok(excluded.length >= 2);
  } finally { await app.close(); }
});

test('/ipc passes non-GPU channels straight through and rejects unknown ones', async () => {
  const app = await boot();
  try {
    const ok = await (await jsonPost(`${app.base}/ipc/local-ai:binary-status`, { args: [] })).json();
    assert.deepEqual(ok, { ok: true, result: { exists: false } });
    const missing = await jsonPost(`${app.base}/ipc/nope:nothing`, { args: [] });
    assert.equal(missing.status, 404);
  } finally { await app.close(); }
});

test('/ipc generate goes through the queue and returns upstream-shaped {url, seed}', async () => {
  const app = await boot();
  try {
    const out = await (await jsonPost(`${app.base}/ipc/local-ai:generate`, { args: [{ model: 'z-image-turbo', prompt: 'a cat' }] })).json();
    assert.deepEqual(out, { ok: true, result: { url: DATA_URL, seed: 5 } });
    assert.equal(app.standin.calls.some((c) => c[0] === 'local-ai:generate'), false);   // the fake runner, not the engine, did the work
  } finally { await app.close(); }
});

test('/ipc generate surfaces runner failures with their code', async () => {
  const app = await boot({ run: async () => { throw Object.assign(new Error('GPU jobs are disabled'), { code: 'GPU_DISABLED' }); } });
  try {
    const res = await jsonPost(`${app.base}/ipc/local-ai:generate`, { args: [{ model: 'z-image-turbo', prompt: 'x' }] });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, error: 'GPU jobs are disabled', code: 'GPU_DISABLED' });
  } finally { await app.close(); }
});

test('job API: submit, poll (no data URL in status), list, unknown model -> 400', async () => {
  const app = await boot();
  try {
    const submitted = await jsonPost(`${app.base}/api/local/jobs`, { model: 'z-image-turbo', prompt: 'a cat' });
    assert.equal(submitted.status, 202);
    const { job } = await submitted.json();
    await app.queue.wait(job.id, 2000);
    const status = await (await fetch(`${app.base}/api/local/jobs/${job.id}`, { headers: auth })).json();
    assert.equal(status.job.status, 'done');
    assert.deepEqual(status.job.result, { seed: 5, file: 'x.png', url: '/outputs/x.png' });
    assert.equal(JSON.stringify(status).includes(DATA_URL), false);
    const listed = await (await fetch(`${app.base}/api/local/jobs`, { headers: auth })).json();
    assert.equal(listed.jobs.length, 1);
    const bad = await jsonPost(`${app.base}/api/local/jobs`, { model: 'nope', prompt: 'x' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'UNKNOWN_MODEL');
    assert.equal((await fetch(`${app.base}/api/local/jobs/00000000-0000-0000-0000-000000000000`, { headers: auth })).status, 404);
  } finally { await app.close(); }
});

test('cancel endpoint cancels a queued job', async () => {
  let release;
  const app = await boot({ run: () => new Promise((r) => { release = r; }) });
  try {
    await jsonPost(`${app.base}/api/local/jobs`, { model: 'z-image-turbo', prompt: 'first' });
    const second = await (await jsonPost(`${app.base}/api/local/jobs`, { model: 'z-image-turbo', prompt: 'second' })).json();
    const res = await (await jsonPost(`${app.base}/api/local/jobs/${second.job.id}/cancel`, {})).json();
    assert.deepEqual(res, { cancelled: true });
    assert.equal(app.queue.get(second.job.id).status, 'cancelled');
    release({});
  } finally { await app.close(); }
});

test('/outputs serves PNGs, needs auth, and refuses traversal', async () => {
  const app = await boot();
  try {
    assert.equal((await fetch(`${app.base}/outputs/x.png`)).status, 401);
    const ok = await fetch(`${app.base}/outputs/x.png`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(await ok.text(), 'PNGDATA');
    assert.equal((await fetch(`${app.base}/outputs/..%2F..%2Fetc%2Fpasswd`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${app.base}/outputs/missing.png`, { headers: auth })).status, 404);
  } finally { await app.close(); }
});

test('/events streams stand-in send events as SSE', async () => {
  const app = await boot();
  try {
    const chunk = await new Promise((resolve, reject) => {
      const req = http.get(`${app.base}/events`, { headers: auth }, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        let buf = '';
        res.on('data', (d) => { buf += d; if (buf.includes('local-ai:progress')) { req.destroy(); resolve(buf); } });
        setTimeout(() => app.standin.events.emit('send', 'local-ai:progress', { step: 3, totalSteps: 8 }), 50);
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
      setTimeout(() => reject(new Error('no SSE event received')), 3000);
    });
    assert.match(chunk, /event: local-ai:progress\ndata: \{"step":3,"totalSteps":8\}/);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(app.standin.events.listenerCount('send'), 0);   // listener removed when the client went away
  } finally { await app.close(); }
});

test('/mcp forwards JSON-RPC to the mcp handler; notifications get 202', async () => {
  const app = await boot();
  try {
    const out = await (await jsonPost(`${app.base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'ping' })).json();
    assert.deepEqual(out, { jsonrpc: '2.0', id: 1, result: { echoed: 'ping' } });
    assert.equal((await jsonPost(`${app.base}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await fetch(`${app.base}/mcp`, { headers: auth })).status, 405);
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd custom/local-service && node --test test/auth.test.js test/server.test.js`
Expected: FAIL - `Cannot find module '../src/auth'`.

- [ ] **Step 3: Write the implementation**

<!-- file: custom/local-service/src/auth.js -->
```js
'use strict';
const crypto = require('node:crypto');

function bearerOk(header, token) {
  if (!token) return false;
  const match = /^Bearer (.+)$/.exec(header || '');
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

module.exports = { bearerOk };
```

<!-- file: custom/local-service/src/server.js -->
```js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { bearerOk } = require('./auth');

const GATED = new Set(['local-ai:generate', 'wan2gp:generate']);   // channels that consume a GPU -> always go through the queue
const MAX_BODY = 25 * 1024 * 1024;

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { return reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Status payloads never carry the multi-MB data URL; the image is served from /outputs instead.
function publicJob(job) {
  if (!job) return null;
  const { result, ...rest } = job;
  if (result && typeof result === 'object') {
    const { dataUrl, ...clean } = result;   // eslint-disable-line no-unused-vars
    return { ...rest, result: clean };
  }
  return { ...rest, result };
}

function createServer({ config, standin, queue, service, mcp }) {
  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/health') return send(res, 200, { ok: true, gpuEnabled: config.gpuEnabled, channels: standin.channels().length });

    if (!config.token) return send(res, 503, { error: 'OGAI_TOKEN is not configured' });
    if (!bearerOk(req.headers.authorization, config.token)) return send(res, 401, { error: 'unauthorized' });

    if (method === 'GET' && pathname === '/api/local/catalog') return send(res, 200, await service.catalogPayload());

    let m = /^\/ipc\/(.+)$/.exec(pathname);
    if (method === 'POST' && m) {
      const channel = decodeURIComponent(m[1]);
      if (!standin.has(channel)) return send(res, 404, { ok: false, error: `unknown channel: ${channel}` });
      const { args = [] } = await readJson(req);
      try {
        if (GATED.has(channel)) {
          const done = await service.generateAndWait(args[0]);
          return send(res, 200, { ok: true, result: { url: done.result.dataUrl, seed: done.result.seed } });
        }
        return send(res, 200, { ok: true, result: await standin.invoke(channel, ...args) });
      } catch (err) {
        return send(res, err.status || 500, { ok: false, error: err.message, code: err.code });
      }
    }

    if (method === 'POST' && pathname === '/api/local/jobs') {
      try { return send(res, 202, { job: publicJob(service.submitGeneration(await readJson(req))) }); }
      catch (err) { return send(res, err.status || 500, { error: err.message, code: err.code }); }
    }
    if (method === 'GET' && pathname === '/api/local/jobs') return send(res, 200, { jobs: queue.list().map(publicJob) });

    m = /^\/api\/local\/jobs\/([\w-]+)$/.exec(pathname);
    if (method === 'GET' && m) {
      const job = queue.get(m[1]);
      return job ? send(res, 200, { job: publicJob(job) }) : send(res, 404, { error: 'no such job' });
    }
    m = /^\/api\/local\/jobs\/([\w-]+)\/cancel$/.exec(pathname);
    if (method === 'POST' && m) {
      return queue.get(m[1]) ? send(res, 200, { cancelled: queue.cancel(m[1]) }) : send(res, 404, { error: 'no such job' });
    }

    m = /^\/outputs\/([\w.-]+\.png)$/.exec(pathname);
    if (method === 'GET' && m) {
      const file = path.join(config.outputsDir, path.basename(m[1]));
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length });
      return res.end(data);
    }

    if (method === 'GET' && pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const onSend = (channel, data) => res.write(`event: ${channel}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => res.write(': hb\n\n'), 15000);
      standin.events.on('send', onSend);
      req.on('close', () => { clearInterval(heartbeat); standin.events.off('send', onSend); });
      return undefined;
    }

    if (pathname === '/mcp') {
      if (method !== 'POST') return send(res, 405, { error: 'POST only' });
      const out = await mcp.handle(await readJson(req));
      if (out === null) { res.writeHead(202); return res.end(); }
      return send(res, 200, out);
    }

    return send(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    route(req, res, url).catch((err) => {
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
      else res.end();
    });
  });
}

module.exports = { createServer, publicJob };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS (55 tests).

- [ ] **Step 5: Commit**

```bash
git add custom/local-service
git commit -m "feat(local): bearer-auth HTTP/SSE server (catalog, ipc, jobs, outputs, events)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: MCP endpoint

**Files:**
- Create: `custom/local-service/src/mcp.js`, `custom/local-service/test/helpers/fake-muapi.js`
- Test: `custom/local-service/test/mcp.test.js`

**Interfaces:**
- Consumes: `service.catalogPayload()`, `service.submitGeneration(params)` (Task 6), `queue.get/wait/cancel` (Task 4), `publicJob` (Task 7)
- Produces: `createMcp({config, queue, service, fetchImpl?, log?}) -> {handle(msg) -> Promise<response|null>}`. Local tools: `local_list_models`, `local_generate_image`, `local_job_status`, `local_cancel_job`. Muapi allowlist (all others blocked): `search_models, muapi_upload_image, muapi_image_generate, muapi_image_edit, muapi_video_generate, muapi_video_from_image, muapi_audio_create, muapi_audio_from_text, muapi_enhance_upscale, muapi_enhance_bg_remove, muapi_enhance_face_swap, muapi_enhance_ghibli, muapi_edit_lipsync, muapi_edit_clipping, muapi_predict_result, muapi_account_balance`

- [ ] **Step 1: Write the fake Muapi helper and failing test**

<!-- file: custom/local-service/test/helpers/fake-muapi.js -->
```js
'use strict';
const http = require('node:http');

const ALL_TOOLS = [
  'search_models', 'muapi_upload_image', 'muapi_image_generate', 'muapi_image_edit', 'muapi_video_generate', 'muapi_video_from_image',
  'muapi_audio_create', 'muapi_audio_from_text', 'muapi_enhance_upscale', 'muapi_enhance_bg_remove', 'muapi_enhance_face_swap',
  'muapi_enhance_ghibli', 'muapi_edit_lipsync', 'muapi_edit_clipping', 'muapi_predict_result', 'muapi_account_balance',
  'muapi_keys_list', 'muapi_keys_create', 'muapi_keys_delete', 'muapi_account_topup', 'muapi_brand_new_tool',
];

// Fake of Muapi's hosted MCP (stateless JSON-RPC over HTTP). sse: true answers as text/event-stream.
function startFakeMuapi({ sse = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const msg = JSON.parse(raw);
      requests.push({ headers: req.headers, msg });
      let result;
      if (msg.method === 'tools/list') result = { tools: ALL_TOOLS.map((name) => ({ name, description: `d:${name}`, inputSchema: { type: 'object' } })) };
      else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: `called:${msg.params.name}` }] };
      else result = {};
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (sse) { res.setHeader('content-type', 'text/event-stream'); return res.end(`event: message\ndata: ${payload}\n\n`); }
      res.setHeader('content-type', 'application/json');
      return res.end(payload);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

module.exports = { startFakeMuapi, ALL_TOOLS };
```

<!-- file: custom/local-service/test/mcp.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMcp } = require('../src/mcp');
const { createService } = require('../src/service');
const { JobQueue } = require('../src/queue');
const { startFakeMuapi } = require('./helpers/fake-muapi');

const quiet = { warn() {}, error() {} };
const standin = { invoke: async () => [{ id: 'z-image-turbo', name: 'Z-Image Turbo', state: 'not-downloaded' }] };

function keyFile(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-mcp-')), '.muapi-key');
  if (contents !== null) fs.writeFileSync(file, contents);
  return file;
}

function setup({ muapiUrl = 'http://127.0.0.1:1/mcp', key = 'sk-test\n', run } = {}) {
  const queue = new JobQueue({ run: run || (async () => ({ seed: 9, file: 'j.png', url: '/outputs/j.png', dataUrl: 'data:image/png;base64,AAAA' })) });
  const service = createService({ standin, queue });
  const mcp = createMcp({ config: { muapiKeyFile: keyFile(key), muapiMcpUrl: muapiUrl }, queue, service, log: quiet });
  return { mcp, queue };
}

const call = (mcp, name, args = {}, id = 1) => mcp.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const bodyOf = (res) => JSON.parse(res.result.content[0].text);

test('initialize / ping / initialized handshake', async () => {
  const { mcp } = setup();
  const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'ogai-local');
  assert.deepEqual(await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'ping' }), { jsonrpc: '2.0', id: 2, result: {} });
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'bogus' })).error.code, -32601);
  assert.equal((await mcp.handle({ nonsense: true })).error.code, -32600);
});

test('tools/list without a Muapi key exposes only the local tools', async () => {
  const { mcp } = setup({ key: null });
  const names = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['local_list_models', 'local_generate_image', 'local_job_status', 'local_cancel_job']);
});

test('tools/list adds ONLY allowlisted Muapi tools: key management, top-up and brand-new tools stay blocked', async () => {
  const muapi = await startFakeMuapi();
  try {
    const { mcp } = setup({ muapiUrl: muapi.url });
    const names = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
    for (const ok of ['local_generate_image', 'muapi_image_generate', 'muapi_video_from_image', 'muapi_account_balance', 'search_models', 'muapi_predict_result']) assert.ok(names.includes(ok), ok);
    for (const blocked of ['muapi_keys_list', 'muapi_keys_create', 'muapi_keys_delete', 'muapi_account_topup', 'muapi_brand_new_tool']) assert.equal(names.includes(blocked), false, blocked);
    assert.equal(muapi.requests[0].headers['x-api-key'], 'sk-test');   // key read from file, whitespace trimmed
  } finally { await muapi.close(); }
});

test('allowlisted Muapi tools are forwarded (also over SSE); blocked ones are refused without a network call', async () => {
  for (const sse of [false, true]) {
    const muapi = await startFakeMuapi({ sse });
    try {
      const { mcp } = setup({ muapiUrl: muapi.url });
      const ok = await call(mcp, 'muapi_image_generate', { prompt: 'x' });
      assert.equal(ok.result.content[0].text, 'called:muapi_image_generate');
      const before = muapi.requests.length;
      const blocked = await call(mcp, 'muapi_keys_delete', { id: 1 });
      assert.equal(blocked.error.code, -32602);
      assert.match(blocked.error.message, /blocked/);
      assert.equal(muapi.requests.length, before);
    } finally { await muapi.close(); }
  }
});

test('a Muapi outage becomes an isError tool result, not a crash', async () => {
  const { mcp } = setup({ muapiUrl: 'http://127.0.0.1:1/mcp' });
  const res = await call(mcp, 'muapi_image_generate', { prompt: 'x' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Muapi call failed/);
});

test('local_list_models returns annotated models, filterable by kind', async () => {
  const { mcp } = setup();
  const all = bodyOf(await call(mcp, 'local_list_models'));
  assert.ok(all.models.find((m) => m.id === 'z-image-turbo' && m.star === true));
  assert.ok(all.models.find((m) => m.id === 'wan2gp:wan22-t2v'));
  assert.ok(all.excluded.length >= 2);
  const video = bodyOf(await call(mcp, 'local_list_models', { kind: 'video' }));
  assert.ok(video.models.length > 0 && video.models.every((m) => m.kind === 'video'));
});

test('local_generate_image queues a job; wait_seconds waits for the result; status never contains the data URL', async () => {
  const { mcp } = setup();
  const res = bodyOf(await call(mcp, 'local_generate_image', { model: 'z-image-turbo', prompt: 'a cat', wait_seconds: 5 }));
  assert.equal(res.status, 'done');
  assert.deepEqual(res.result, { seed: 9, file: 'j.png', url: '/outputs/j.png' });
  const again = bodyOf(await call(mcp, 'local_job_status', { job_id: res.id }));
  assert.equal(again.status, 'done');
  assert.equal(JSON.stringify(again).includes('base64'), false);
});

test('local_generate_image without waiting returns the queued job; bad input is an isError result', async () => {
  let release;
  const { mcp } = setup({ run: () => new Promise((r) => { release = r; }) });
  const queued = bodyOf(await call(mcp, 'local_generate_image', { model: 'z-image-turbo', prompt: 'a cat' }));
  assert.ok(['queued', 'running'].includes(queued.status));
  const cancelled = bodyOf(await call(mcp, 'local_cancel_job', { job_id: queued.id }));
  assert.equal(cancelled.cancelled, true);
  if (release) release({});   // only assigned if the job had already started running
  const bad = await call(mcp, 'local_generate_image', { model: 'nope', prompt: 'x' });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /UNKNOWN_MODEL/);
  const missing = await call(mcp, 'local_job_status', { job_id: 'nope' });
  assert.equal(missing.result.isError, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd custom/local-service && node --test test/mcp.test.js`
Expected: FAIL - `Cannot find module '../src/mcp'`.

- [ ] **Step 3: Write the implementation**

<!-- file: custom/local-service/src/mcp.js -->
```js
'use strict';
const fs = require('node:fs');
const { publicJob } = require('./server');

const PROTOCOL = '2025-06-18';

// Default-deny: only these Muapi tools are exposed. Key management (muapi_keys_*), Stripe top-up and any
// tool Muapi adds later stay blocked until someone reviews them and adds them here.
const MUAPI_ALLOW = new Set([
  'search_models', 'muapi_upload_image', 'muapi_image_generate', 'muapi_image_edit', 'muapi_video_generate', 'muapi_video_from_image',
  'muapi_audio_create', 'muapi_audio_from_text', 'muapi_enhance_upscale', 'muapi_enhance_bg_remove', 'muapi_enhance_face_swap',
  'muapi_enhance_ghibli', 'muapi_edit_lipsync', 'muapi_edit_clipping', 'muapi_predict_result', 'muapi_account_balance',
]);

const LOCAL_TOOLS = [
  {
    name: 'local_list_models',
    description: 'List local (self-hosted GPU) generation models with V100 suitability: v100 = recommended|supported|unknown, star = best pick, evidence = proven|untested, route = engine. Excluded models are listed with reasons.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['image', 'video'], description: 'Only models of this kind' } } },
  },
  {
    name: 'local_generate_image',
    description: 'Generate an image on the local GPU (free, slow: jobs queue one at a time). Returns a job; set wait_seconds to wait for it. Result url is served by this server under /outputs with the same bearer token.',
    inputSchema: {
      type: 'object',
      required: ['model', 'prompt'],
      properties: {
        model: { type: 'string', description: 'A model id from local_list_models (image kind)' },
        prompt: { type: 'string' },
        negative_prompt: { type: 'string' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'] },
        seed: { type: 'integer', description: '-1 or omitted = random' },
        steps: { type: 'integer' },
        guidance_scale: { type: 'number' },
        device: { type: 'string', enum: ['v100', 'gtx1080'], description: 'gtx1080 never evicts the Hermes brain (small models only)' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 600, description: 'Wait up to this long for completion (default 0 = return immediately)' },
      },
    },
  },
  { name: 'local_job_status', description: 'Status/result of a local generation job.', inputSchema: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' } } } },
  { name: 'local_cancel_job', description: 'Cancel a queued or running local generation job.', inputSchema: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' } } } },
];

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const textResult = (obj, isError = false) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], ...(isError ? { isError: true } : {}) });

function parseSse(raw) {
  const line = raw.split('\n').find((l) => l.startsWith('data:'));
  if (!line) throw new Error('empty event stream');
  return JSON.parse(line.slice(5).trim());
}

function createMcp({ config, queue, service, fetchImpl = fetch, log = console }) {
  let cloudCache = { at: 0, tools: [] };

  const readKey = () => { try { return fs.readFileSync(config.muapiKeyFile, 'utf8').trim() || null; } catch { return null; } };

  async function muapiRpc(method, params) {
    const key = readKey();
    if (!key) throw new Error('no Muapi key configured');
    const res = await fetchImpl(config.muapiMcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    const body = (res.headers.get('content-type') || '').includes('text/event-stream') ? parseSse(raw) : JSON.parse(raw);
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }

  async function cloudTools() {
    if (!readKey()) return [];
    const ttl = cloudCache.tools.length ? 10 * 60 * 1000 : 30 * 1000;   // retry sooner after a failure
    if (Date.now() - cloudCache.at < ttl) return cloudCache.tools;
    try {
      const { tools } = await muapiRpc('tools/list', {});
      cloudCache = { at: Date.now(), tools: tools.filter((t) => MUAPI_ALLOW.has(t.name)) };
    } catch (err) {
      log.warn(`mcp: could not list Muapi tools: ${err.message}`);
      cloudCache = { at: Date.now(), tools: [] };
    }
    return cloudCache.tools;
  }

  async function listModels({ kind } = {}) {
    const { models, excluded } = await service.catalogPayload();
    const wanted = kind ? models.filter((m) => m.kind === kind) : models;
    return {
      models: wanted.map((m) => ({ id: m.id, name: m.name, kind: m.kind, route: m.route, v100: m.v100, star: m.star, evidence: m.evidence, weightsGb: m.weightsGb, note: m.note, state: m.state })),
      excluded,
    };
  }

  const jobView = (job) => { const p = publicJob(job); return { id: p.id, status: p.status, model: p.params && p.params.model, result: p.result, error: p.error }; };

  async function callLocal(name, args) {
    if (name === 'local_list_models') return textResult(await listModels(args));
    if (name === 'local_generate_image') {
      const { wait_seconds: waitSeconds = 0, ...params } = args;
      const job = service.submitGeneration(params);
      const seen = waitSeconds > 0 ? await queue.wait(job.id, Math.min(600, waitSeconds) * 1000) : job;
      return textResult(jobView(seen));
    }
    const job = queue.get(args.job_id);
    if (!job) return textResult(`no such job: ${args.job_id}`, true);
    if (name === 'local_cancel_job') return textResult({ id: job.id, cancelled: queue.cancel(job.id) });
    return textResult(jobView(job));
  }

  async function callTool(id, { name, arguments: args = {} }) {
    if (LOCAL_TOOLS.some((t) => t.name === name)) {
      try { return rpcResult(id, await callLocal(name, args)); }
      catch (err) { return rpcResult(id, textResult(`${err.code || 'ERROR'}: ${err.message}`, true)); }
    }
    if (MUAPI_ALLOW.has(name)) {
      try { return rpcResult(id, await muapiRpc('tools/call', { name, arguments: args })); }
      catch (err) { return rpcResult(id, textResult(`Muapi call failed: ${err.message}`, true)); }
    }
    return rpcError(id, -32602, `unknown or blocked tool: ${name}`);
  }

  async function handle(msg) {
    const { id, method, params } = msg || {};
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id, -32600, 'invalid request');
    switch (method) {
      case 'initialize': return rpcResult(id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ogai-local', version: '0.1.0' } });
      case 'notifications/initialized': return null;
      case 'ping': return rpcResult(id, {});
      case 'tools/list': return rpcResult(id, { tools: [...LOCAL_TOOLS, ...(await cloudTools())] });
      case 'tools/call': return callTool(id, params || {});
      default: return id === undefined ? null : rpcError(id, -32601, `method not found: ${method}`);
    }
  }

  return { handle };
}

module.exports = { createMcp, MUAPI_ALLOW };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS (63 tests).

- [ ] **Step 5: Commit**

```bash
git add custom/local-service
git commit -m "feat(local): MCP endpoint with local tools + default-deny Muapi pass-through

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Boot, container, deploy, template, docs

**Files:**
- Create: `custom/local-service/src/index.js`, `custom/local-service/Dockerfile`, `custom/local-service/deploy.sh`, `custom/local-service/README.md`, `custom/unraid/my-ogai-local.xml`
- Test: `custom/local-service/test/boot.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `node src/index.js` boots a server on `OGAI_LOCAL_PORT`; container `ogai-local:latest`; `deploy.sh [--build]`.

- [ ] **Step 1: Write the failing end-to-end boot test**

<!-- file: custom/local-service/test/boot.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function waitFor(url, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`server did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('boots for real: health, auth, 12-model catalog, MCP handshake, GPU jobs refused by default', async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-boot-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { PATH: process.env.PATH, OGAI_UPSTREAM_DIR: REPO, OGAI_DATA_DIR: dataDir, OGAI_TOKEN: 'tok', OGAI_LOCAL_PORT: String(port) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: 'Bearer tok', 'content-type': 'application/json' };
  try {
    const health = await (await waitFor(`${base}/health`)).json();
    assert.equal(health.gpuEnabled, false);
    assert.equal(health.channels, 15);
    assert.equal((await fetch(`${base}/api/local/catalog`)).status, 401);

    const { models, excluded } = await (await fetch(`${base}/api/local/catalog`, { headers: auth })).json();
    assert.equal(models.length, 12);
    assert.equal(models.filter((m) => m.star).length, 6);
    assert.ok(excluded.length >= 2);

    const init = await (await fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })).json();
    assert.equal(init.result.serverInfo.name, 'ogai-local');

    const gen = await fetch(`${base}/ipc/local-ai:generate`, { method: 'POST', headers: auth, body: JSON.stringify({ args: [{ model: 'z-image-turbo', prompt: 'cat' }] }) });
    assert.equal(gen.status, 502);
    assert.equal((await gen.json()).code, 'GPU_DISABLED');
  } finally { child.kill('SIGTERM'); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd custom/local-service && node --test test/boot.test.js`
Expected: FAIL - server never comes up (`Cannot find module .../src/index.js`).

- [ ] **Step 3: Write the boot file and container files**

<!-- file: custom/local-service/src/index.js -->
```js
'use strict';
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { loadEngines } = require('./engines');
const { JobQueue } = require('./queue');
const { createRunner } = require('./runner');
const { createService } = require('./service');
const { createMcp } = require('./mcp');
const { createServer } = require('./server');

const config = loadConfig();
fs.mkdirSync(config.outputsDir, { recursive: true });

const standin = loadEngines({ upstreamDir: config.upstreamDir, userDataPath: config.dataDir, resourcesPath: config.resourcesPath });
const queue = new JobQueue({ run: createRunner({ config, standin }).run });
const service = createService({ standin, queue });
const mcp = createMcp({ config, queue, service });
const server = createServer({ config, standin, queue, service, mcp });

server.listen(config.port, '0.0.0.0', () => {
  console.log(`ogai-local listening on :${config.port} (gpuEnabled=${config.gpuEnabled}, arbiter=${config.arbiterUrl ? 'configured' : 'none'}, token=${config.token ? 'set' : 'MISSING'})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}
```

<!-- file: custom/local-service/Dockerfile -->
```dockerfile
# ogai-local: runs upstream's Electron engine modules behind a stand-in (see custom/local-service/README.md).
# Build from the REPO ROOT: docker build -f custom/local-service/Dockerfile -t ogai-local:latest .
FROM node:22-bookworm-slim
WORKDIR /srv
COPY electron/lib /app/electron/lib
COPY custom/local-service/package.json ./package.json
COPY custom/local-service/src ./src
ENV OGAI_UPSTREAM_DIR=/app OGAI_DATA_DIR=/data OGAI_LOCAL_PORT=8790 NODE_ENV=production
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
```

<!-- file: custom/local-service/deploy.sh -->
```bash
#!/usr/bin/env bash
# Build (optional) and (re)create the ogai-local container.
#   custom/local-service/deploy.sh [--build]
# Host-specific values come from the environment; nothing host-specific is committed:
#   OGAI_ARBITER_URL   gpu-arbiter base URL (empty = V100 jobs are refused)
#   OGAI_GPU_ENABLED   1 to allow GPU jobs (default 0 - keep 0 until a GPU test window is approved)
#   OGAI_LOCAL_PORT (8790)   OGAI_DATA (/mnt/user/appdata/open-generative-ai)
set -euo pipefail
cd "$(dirname "$0")/../.."
NAME=ogai-local
IMG=ogai-local:latest
PORT=${OGAI_LOCAL_PORT:-8790}
DATA=${OGAI_DATA:-/mnt/user/appdata/open-generative-ai}

[ "${1:-}" = --build ] && docker build -t "$IMG" -f custom/local-service/Dockerfile .

mkdir -p "$DATA"
TOKEN_FILE="$DATA/.mcp-token"
[ -s "$TOKEN_FILE" ] || (umask 077; openssl rand -hex 24 > "$TOKEN_FILE")

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:8790" -v "$DATA:/data" \
  -e OGAI_TOKEN="$(cat "$TOKEN_FILE")" \
  -e OGAI_ARBITER_URL="${OGAI_ARBITER_URL:-}" \
  -e OGAI_GPU_ENABLED="${OGAI_GPU_ENABLED:-0}" \
  -e TZ="${TZ:-America/New_York}" \
  -l net.unraid.docker.managed=dockerman \
  -l "net.unraid.docker.icon=${OGAI_LOCAL_ICON:-https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/svg/openai.svg}" \
  -l 'net.unraid.docker.webui=http://[IP]:[PORT:8790]/health' \
  "$IMG" >/dev/null

for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)" = healthy ] && { echo "ogai-local healthy on :$PORT (token in $TOKEN_FILE)"; exit 0; }
  sleep 2
done
echo "ogai-local did not become healthy" >&2
docker logs --tail 20 "$NAME" >&2
exit 1
```

<!-- file: custom/unraid/my-ogai-local.xml -->
```xml
<?xml version="1.0"?>
<Container version="2">
  <Name>ogai-local</Name>
  <Repository>ogai-local:latest</Repository>
  <Registry/>
  <Network>bridge</Network>
  <MyIP/>
  <MyMAC/>
  <Shell>sh</Shell>
  <Privileged>false</Privileged>
  <Support>https://github.com/owolfson/Open-Generative-AI</Support>
  <Project>https://github.com/owolfson/Open-Generative-AI</Project>
  <ReadMe/>
  <Overview>Local inference + agent API (REST, SSE, MCP) for the Open-Generative-AI fork. Runs upstream's local-model engines on the GPUs behind the GPU arbiter; GPU jobs stay disabled until OGAI_GPU_ENABLED=1.</Overview>
  <Category>MediaApp:Other AI:</Category>
  <WebUI>http://[IP]:[PORT:8790]/health</WebUI>
  <TemplateURL/>
  <Icon>https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/svg/openai.svg</Icon>
  <ExtraParams>--restart=unless-stopped</ExtraParams>
  <PostArgs/>
  <CPUset/>
  <DateInstalled/>
  <DonateText/>
  <DonateLink/>
  <Requires/>
  <Config Name="API Port" Target="8790" Default="8790" Mode="tcp" Description="REST / SSE / MCP" Type="Port" Display="always" Required="true" Mask="false">8790</Config>
  <Config Name="AppData" Target="/data" Default="/mnt/user/appdata/open-generative-ai" Mode="rw" Description="Models, outputs, Muapi key file" Type="Path" Display="always" Required="true" Mask="false">/mnt/user/appdata/open-generative-ai</Config>
  <Config Name="API Token" Target="OGAI_TOKEN" Default="" Mode="" Description="Bearer token required by every endpoint except /health (deploy.sh generates one in AppData/.mcp-token)" Type="Variable" Display="always" Required="true" Mask="true"/>
  <Config Name="GPU Arbiter URL" Target="OGAI_ARBITER_URL" Default="" Mode="" Description="gpu-arbiter base URL; V100 jobs are refused without it" Type="Variable" Display="always" Required="false" Mask="false"/>
  <Config Name="Enable GPU jobs" Target="OGAI_GPU_ENABLED" Default="0" Mode="" Description="1 = allow GPU jobs. Keep 0 until a GPU test window is approved." Type="Variable" Display="always" Required="false" Mask="false">0</Config>
</Container>
```

<!-- file: custom/local-service/README.md -->
````markdown
# ogai-local

Local inference + agent API for this fork. Runs upstream's own Electron engine modules (`electron/lib/*`, unmodified)
behind a small stand-in for `require('electron')`, and exposes them over HTTP.

| Piece | File |
|---|---|
| Electron stand-in (IPC handlers -> functions, `send` -> events) | `src/standin.js` |
| Loads upstream engines | `src/engines.js` |
| V100 model catalog + drift tripwire | `src/catalog.js` |
| Single-flight queue | `src/queue.js` |
| gpu-arbiter lease (V100 only) | `src/gate.js` |
| Runner (device choice, lease, PNG artifacts) | `src/runner.js` |
| REST + SSE | `src/server.js` |
| MCP (local tools + allowlisted Muapi pass-through) | `src/mcp.js` |

## Safety defaults
- `OGAI_GPU_ENABLED` must be exactly `1` or every job fails with `GPU_DISABLED`.
- V100 jobs also need `OGAI_ARBITER_URL`; a V100 lease evicts the Hermes brain. The GTX 1080 lane (`device: "gtx1080"`) needs no lease.
- Every endpoint except `GET /health` needs `Authorization: Bearer $OGAI_TOKEN` (deploy.sh writes one to `$OGAI_DATA/.mcp-token`).
- Muapi key-management and top-up MCP tools are blocked; only the allowlist in `src/mcp.js` is exposed.

## Use
```bash
custom/local-service/deploy.sh --build          # image + container on :8790
TOKEN=$(cat /mnt/user/appdata/open-generative-ai/.mcp-token)
curl -H "Authorization: Bearer $TOKEN" http://HOST:8790/api/local/catalog
claude mcp add --transport http ogai http://HOST:8790/mcp --header "Authorization: Bearer $TOKEN"
```

## Tests
`cd custom/local-service && node --test test/*.test.js` (never pass a directory to `--test`). Zero dependencies.

## Not yet wired (separate plans)
sd.cpp CUDA build (upstream's Linux binary is CPU/Vulkan/ROCm only and the host CPU has no AVX2), WanGP + ComfyUI(Qwen)
adapters, web-app UI + `window.localAI` shim, registering `ogai-local` in the arbiter registry, GPU test renders.
````

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS (64 tests).

- [ ] **Step 5: Commit**

```bash
git add custom/local-service custom/unraid
git commit -m "feat(local): boot, container image, deploy script, Unraid template, docs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review (spec coverage)

- Decision 1 (unmodified upstream engines behind stand-in): Tasks 1-2 (+ tripwire for npm deps).
- Decision 2 (separate container): Task 9.
- Decision 3 (single-flight, arbiter-gated, GPU off by default, 1080 lane): Tasks 4, 5, 6.
- Decision 4 (MCP + REST, allowlisted Muapi, bearer token): Tasks 7, 8.
- Decision 5 (catalog, unknown-model tripwire, exclusions): Task 3.
- Types: `JobQueue.submit({kind, route, params})`, `job.result = {seed, file, url, dataUrl}`, `publicJob` strips `dataUrl`, `service.submitGeneration/generateAndWait/catalogPayload`, `withLease(cfg, opts, fn, extra)` - names identical across tasks.
- Gaps by design (own plans): sd.cpp CUDA build, WanGP/ComfyUI adapters, web UI + shim, arbiter registry entry, GPU test renders.
