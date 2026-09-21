'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service');
const { JobQueue } = require('../src/queue');
const { randomUUID } = require('node:crypto');

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
  assert.equal(byId['wan2gp:wan22-t2v'].route, 'sdcpp');   // text-to-video is served by sd.cpp now (Wan T2V + HunyuanVideo 1.5)
  // upstream-served sd.cpp models appear only if the engine listed them; the extended ones (own specs) are always known
  assert.deepEqual(models.filter((m) => m.route === 'sdcpp').map((m) => m.id).sort(), ['wan2gp:flux-dev', 'wan2gp:hunyuan-video', 'wan2gp:ltx-video', 'wan2gp:qwen-image', 'wan2gp:wan22-i2v', 'wan2gp:wan22-t2v', 'z-image-base', 'z-image-turbo']);
  assert.ok(excluded.some((e) => e.id === 'ltx-2.3-22b'));
});

test('catalogPayload tells agents which extended models are runnable right now (filesPresent) and their VRAM declaration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-cat-'));
  for (const f of ['flux1-dev-Q8_0.gguf', 'ae.sft.safetensors', 'clip_l.safetensors', 't5xxl_fp16.safetensors']) fs.writeFileSync(path.join(dir, f), 'x');
  const svc = createService({ standin, queue: new JobQueue({ run: async () => ({}) }), config: { modelDirs: [dir] } });
  const byId = Object.fromEntries((await svc.catalogPayload()).models.map((m) => [m.id, m]));
  assert.equal(byId['wan2gp:flux-dev'].filesPresent, true);
  assert.equal(byId['wan2gp:flux-dev'].vramGb, 29);   // measured peak on the V100
  assert.equal(byId['wan2gp:qwen-image'].filesPresent, false);
  assert.equal(byId['wan2gp:wan22-i2v'].filesPresent, false);
  assert.equal(byId['wan2gp:wan22-i2v'].needsImage, true); assert.equal(byId['wan2gp:wan22-t2v'].needsImage, false); assert.equal(byId['wan2gp:hunyuan-video'].needsImage, false);   // the GUI shows the image picker only when needed
  assert.equal(byId['wan2gp:flux-dev'].needsImage, undefined, 'image models have no such flag');
  assert.equal(byId['wan2gp:ltx-video'].needsImage, false); assert.equal(byId['wan2gp:ltx-video'].acceptsImage, true); assert.equal(byId['wan2gp:wan22-t2v'].acceptsImage, false);   // LTX: image optional
});

// ---------- image input for image-to-video ----------
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function i2vSetup(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-i2v-'));
  const config = { outputsDir: path.join(dir, 'outputs'), tmpDir: path.join(dir, 'tmp'), modelDirs: [] };
  fs.mkdirSync(config.outputsDir, { recursive: true });
  const queue = new JobQueue({ run: run || (async (job) => job.params.__result || {}) });
  return { dir, config, queue, svc: createService({ standin, queue, config }) };
}
async function finishedImageJob({ queue, config }, file = `${randomUUID()}.png`, kind = 'image') {
  fs.writeFileSync(path.join(config.outputsDir, file), PNG_1PX);
  const job = queue.submit({ kind, route: 'sdcpp', params: { __result: { kind, file, url: `/outputs/${file}` } } });
  await queue.wait(job.id, 1000);
  return job;
}

test('image-to-video without any image is refused at submission with IMAGE_REQUIRED', () => {
  const { svc } = i2vSetup();
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x' }), { code: 'IMAGE_REQUIRED', status: 400 });
});

test('image_job_id chains a finished image job into an image-to-video job (init_image = that job\'s output file)', async () => {
  const ctx = i2vSetup(); const src = await finishedImageJob(ctx);
  const job = ctx.svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'it moves', image_job_id: src.id, device: 'v100' });
  assert.equal(job.params.init_image, path.join(ctx.config.outputsDir, src.result.file));
  assert.equal(job.params.image_job_id, undefined);
  assert.equal(job.params.device, 'v100');
  assert.equal(job.kind, 'video');
});

test('image_job_id must be a finished IMAGE job whose file still exists', async () => {
  const ctx = i2vSetup();
  assert.throws(() => ctx.svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', image_job_id: 'nope' }), { code: 'BAD_REQUEST' });
  const video = await finishedImageJob(ctx, 'v.avi', 'video');
  assert.throws(() => ctx.svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', image_job_id: video.id }), { code: 'BAD_REQUEST' });
  const gone = await finishedImageJob(ctx); fs.unlinkSync(path.join(ctx.config.outputsDir, gone.result.file));
  assert.throws(() => ctx.svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', image_job_id: gone.id }), /no longer on disk/);
});

test('image_base64 (raw or data URL) is validated, size-limited, and written under tmp/inputs', () => {
  const { svc, config } = i2vSetup();
  for (const b64 of [PNG_1PX.toString('base64'), `data:image/png;base64,${PNG_1PX.toString('base64')}`]) {
    const job = svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', image_base64: b64 });
    assert.ok(job.params.init_image.startsWith(path.join(config.tmpDir, 'inputs')));
    assert.deepEqual(fs.readFileSync(job.params.init_image), PNG_1PX);
    assert.equal(job.params.image_base64, undefined);
  }
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', image_base64: '!!not base64!!' }), { code: 'BAD_REQUEST' });
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', image_base64: Buffer.from('plain text, not an image').toString('base64') }), /PNG or JPEG/);
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', image_base64: Buffer.alloc(11 * 1024 * 1024, 1).toString('base64') }), /larger than/);
});

test('a caller can NEVER set init_image directly (no reading arbitrary server files), nor pass both image sources', async () => {
  const ctx = i2vSetup(); const src = await finishedImageJob(ctx);
  const job = ctx.svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', image_job_id: src.id, init_image: '/etc/passwd' });
  assert.equal(job.params.init_image, path.join(ctx.config.outputsDir, src.result.file));
  assert.throws(() => ctx.svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', init_image: '/etc/passwd' }), { code: 'IMAGE_REQUIRED' });
  assert.throws(() => ctx.svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', image_job_id: src.id, image_base64: PNG_1PX.toString('base64') }), /not both/);
});

test('text-to-image models reject an input image instead of silently ignoring it', async () => {
  const ctx = i2vSetup(); const src = await finishedImageJob(ctx);
  assert.throws(() => ctx.svc.submitGeneration({ model: 'wan2gp:flux-dev', prompt: 'x', image_job_id: src.id }), /does not take an input image/);
  assert.equal(ctx.svc.submitGeneration({ model: 'wan2gp:flux-dev', prompt: 'x', init_image: '/etc/passwd' }).params.init_image, undefined);
});

test('sd-cli progress events from the stand-in land on the running job (this is what the GUI polls)', async () => {
  const { EventEmitter } = require('node:events');
  const events = new EventEmitter();
  const gate = (() => { let r; const promise = new Promise((res) => { r = res; }); return { promise, resolve: r }; })();
  const q = new JobQueue({ run: async () => { await gate.promise; return {}; } });
  createService({ standin: { ...standin, events }, queue: q });
  const job = q.submit({ kind: 'image', route: 'sdcpp', params: {} });
  await new Promise((r) => setImmediate(r));
  events.emit('send', 'local-ai:download-progress', { step: 9 });                    // other channels are ignored
  events.emit('send', 'local-ai:progress', { step: 3, totalSteps: 8, progress: 0.375, status: 'sampling' });
  assert.equal(q.get(job.id).progress.step, 3);
  gate.resolve(); await q.wait(job.id, 1000);
});
