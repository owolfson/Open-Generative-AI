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

test('routes: everything we can serve goes through sd.cpp; only models without weights on disk stay unwired', () => {
  for (const id of ['z-image-turbo', 'z-image-base', 'stable-diffusion-xl-base', 'wan2gp:flux-dev', 'wan2gp:qwen-image', 'wan2gp:wan22-i2v']) assert.equal(catalog.assess(id).route, 'sdcpp', id);
  assert.equal(catalog.assess('wan2gp:ltx-video').route, 'wangp');   // sd.cpp only supports LTX-2.3/2.5 (excluded), not this 0.9.8 build
  for (const id of ['wan2gp:wan22-t2v', 'wan2gp:hunyuan-video']) assert.equal(catalog.assess(id).route, 'sdcpp', id);
});

test('evidence: only models actually run on this box are proven, and provenOn says on which GPU', () => {
  const proven = Object.fromEntries(catalog.staticCatalog().filter((m) => m.evidence === 'proven').map((m) => [m.id, m.provenOn]));
  assert.deepEqual(proven, { 'dreamshaper-8': ['gtx1080'], 'z-image-turbo': ['gtx1080'], 'wan2gp:wan22-i2v': ['v100'], 'wan2gp:flux-dev': ['v100'], 'wan2gp:qwen-image': ['v100'], 'realistic-vision-v51': ['gtx1080'], 'anything-v5': ['gtx1080'] });   // Wan I2V: job f8e6a6da on the V100; Qwen was proven under ComfyUI, not under this engine; Flux/Qwen here are still untested
  for (const m of catalog.staticCatalog().filter((e) => e.evidence === 'untested')) assert.deepEqual(m.provenOn, [], m.id);
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
