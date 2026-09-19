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
