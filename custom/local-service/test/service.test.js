'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  assert.equal(job.route, 'sdcpp');   // Qwen-Image is now served by sd.cpp, no longer routed to a separate engine
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
  // upstream-served sd.cpp models appear only if the engine listed them; the extended ones (own specs) are always known
  assert.deepEqual(models.filter((m) => m.route === 'sdcpp').map((m) => m.id).sort(), ['wan2gp:flux-dev', 'wan2gp:qwen-image', 'wan2gp:wan22-i2v', 'z-image-turbo']);
  assert.ok(excluded.some((e) => e.id === 'ltx-2.3-22b'));
});

test('catalogPayload tells agents which extended models are runnable right now (filesPresent) and their VRAM declaration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-cat-'));
  for (const f of ['flux1-dev-Q8_0.gguf', 'ae.sft.safetensors', 'clip_l.safetensors', 't5xxl_fp16.safetensors']) fs.writeFileSync(path.join(dir, f), 'x');
  const svc = createService({ standin, queue: new JobQueue({ run: async () => ({}) }), config: { modelDirs: [dir] } });
  const byId = Object.fromEntries((await svc.catalogPayload()).models.map((m) => [m.id, m]));
  assert.equal(byId['wan2gp:flux-dev'].filesPresent, true);
  assert.equal(byId['wan2gp:flux-dev'].vramGb, 22);
  assert.equal(byId['wan2gp:qwen-image'].filesPresent, false);
  assert.equal(byId['wan2gp:wan22-i2v'].filesPresent, false);
  assert.equal(byId['wan2gp:hunyuan-video'].filesPresent, undefined, 'models with no engine are not judged');
});
