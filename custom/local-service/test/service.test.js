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
  assert.equal(byId['wan2gp:flux-dev'].vramGb, 14);   // measured peak on the 16GB V100 (2026-10-07)
  assert.equal(byId['wan2gp:qwen-image'].filesPresent, false);
  assert.equal(byId['wan2gp:wan22-i2v'].filesPresent, false);
  assert.equal(byId['wan2gp:wan22-i2v'].needsImage, true); assert.equal(byId['wan2gp:wan22-t2v'].needsImage, false); assert.equal(byId['wan2gp:hunyuan-video'].needsImage, false);   // the GUI shows the image picker only when needed
  assert.equal(byId['wan2gp:flux-dev'].needsImage, undefined, 'image models have no such flag');
  assert.deepEqual(byId['z-image-base'].devices, ['gtx1080']); assert.match(byId['z-image-base'].deviceNote, /blank/); assert.equal(byId['wan2gp:flux-dev'].devices, undefined);   // per-model device restriction reaches clients
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

// ---------- cinema: chain several of a model's own clips into one longer video ----------
test('cinema.segments is bounds-checked (2..cinemaMaxSegments) and only accepted for a chainable (image-to-video-capable) model', () => {
  const { svc } = i2vSetup();
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: 'nope' }), { code: 'BAD_REQUEST', status: 400 });
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 1 } }), /2 to 8/);
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 9 } }), /2 to 8/);
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 2.5 } }), { code: 'BAD_REQUEST' });
  // wan22-t2v and hunyuan-video take no input image at all -> cannot chain
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:wan22-t2v', prompt: 'x', cinema: { segments: 3 } }), { code: 'CINEMA_UNSUPPORTED' });
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:hunyuan-video', prompt: 'x', cinema: { segments: 3 } }), { code: 'CINEMA_UNSUPPORTED' });
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:flux-dev', prompt: 'x', cinema: { segments: 3 } }), { code: 'CINEMA_UNSUPPORTED' });   // an image model, not video at all
  assert.equal(svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 4 } }).params.cinema.segments, 4);
});

test('cinema.blendSeconds: a short crossfade dissolve at each seam (default 0.3s, 0 = hard cut), bounds-checked 0-2', () => {
  const { svc } = i2vSetup();
  assert.equal(svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 2 } }).params.cinema.blendSeconds, 0.3, 'default');
  assert.equal(svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 2, blendSeconds: 0 } }).params.cinema.blendSeconds, 0, 'explicit 0 = hard cut, honoured');
  assert.equal(svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 2, blendSeconds: 1.5 } }).params.cinema.blendSeconds, 1.5);
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 2, blendSeconds: -0.1 } }), { code: 'BAD_REQUEST' });
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 2, blendSeconds: 2.1 } }), /0 \(hard cut\) to 2/);
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 2, blendSeconds: 'nope' } }), { code: 'BAD_REQUEST' });
});

test('a caller-set cinemaMaxSegments is honoured', () => {
  const { config } = i2vSetup();
  const svc = createService({ standin, queue: new JobQueue({ run: async () => ({}) }), config: { ...config, cinemaMaxSegments: 3 } });
  assert.equal(svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 3 } }).params.cinema.segments, 3);
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 4 } }), /2 to 3/);
});

test('prompts (per-segment) must match cinema.segments exactly, each a non-empty string within the length cap; omitted = reuse prompt for every segment', () => {
  const { svc } = i2vSetup();
  const ok = svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'a fox', cinema: { segments: 3 }, prompts: ['a', 'b', 'c'] });
  assert.deepEqual(ok.params.cinema.prompts, ['a', 'b', 'c']);
  assert.equal(ok.params.prompts, undefined, 'prompts lives inside cinema, not duplicated at the top level');
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 3 }, prompts: ['a', 'b'] }), /exactly cinema\.segments \(3\)/);
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 2 }, prompts: ['a', '  '] }), { code: 'BAD_REQUEST' });
  assert.throws(() => svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 2 }, prompts: ['a', 'x'.repeat(8001)] }), /longer than 8000/);
  const reused = svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'a fox', cinema: { segments: 3 } });
  assert.equal(reused.params.cinema.prompts, undefined);
  assert.equal(reused.params.prompt, 'a fox');
});

test('cinema on an image-to-video model (needsImage) still requires a starting image the normal way for segment 1', async () => {
  const ctx = i2vSetup(); const src = await finishedImageJob(ctx);
  assert.throws(() => ctx.svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', cinema: { segments: 2 } }), { code: 'IMAGE_REQUIRED' });
  const job = ctx.svc.submitGeneration({ model: 'wan2gp:wan22-i2v', prompt: 'x', cinema: { segments: 2 }, image_job_id: src.id });
  assert.equal(job.params.init_image, path.join(ctx.config.outputsDir, src.result.file));
  assert.equal(job.params.cinema.segments, 2);
});

test('cinema on LTX (acceptsImage, optional) works with no starting image (segment 1 is text-to-video) or with one', () => {
  const { svc } = i2vSetup();
  const textToVideo = svc.submitGeneration({ model: 'wan2gp:ltx-video', prompt: 'x', cinema: { segments: 2 } });
  assert.equal(textToVideo.params.init_image, undefined);
  assert.equal(textToVideo.params.cinema.segments, 2);
});

test('catalogPayload exposes chainable = needsImage || acceptsImage, only for video models', async () => {
  const { config } = i2vSetup();
  const svc = createService({ standin, queue: new JobQueue({ run: async () => ({}) }), config });
  const byId = Object.fromEntries((await svc.catalogPayload()).models.map((m) => [m.id, m]));
  assert.equal(byId['wan2gp:ltx-video'].chainable, true);
  assert.equal(byId['wan2gp:wan22-i2v'].chainable, true);
  assert.equal(byId['wan2gp:wan22-t2v'].chainable, false);
  assert.equal(byId['wan2gp:hunyuan-video'].chainable, false);
  assert.equal(byId['wan2gp:flux-dev'].chainable, undefined, 'image models have no chainable flag at all');
});

test('catalogPayload exposes each video model\'s own fps + frameChoices, so the GUI can offer LTX\'s 5s option instead of a fixed Wan-shaped list', async () => {
  const { config } = i2vSetup();
  const svc = createService({ standin, queue: new JobQueue({ run: async () => ({}) }), config });
  const byId = Object.fromEntries((await svc.catalogPayload()).models.map((m) => [m.id, m]));
  assert.equal(byId['wan2gp:ltx-video'].fps, 24);
  assert.deepEqual(byId['wan2gp:ltx-video'].frameChoices, [33, 49, 97, 121]);   // 121/24fps = 5.04s
  assert.equal(byId['wan2gp:wan22-i2v'].fps, 16);
  assert.deepEqual(byId['wan2gp:wan22-i2v'].frameChoices, [17, 25, 33]);
  assert.equal(byId['wan2gp:hunyuan-video'].fps, 24);
  assert.equal(byId['wan2gp:flux-dev'].fps, undefined, 'image models have no fps at all');
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

test('prompts and negative prompts are length-capped at submission (an argument over ~128KB makes exec fail; huge prompts are never useful)', () => {
  const svc = createService({ standin, queue: new JobQueue({ run: async () => ({}) }) });
  assert.throws(() => svc.submitGeneration({ model: 'z-image-turbo', prompt: 'x'.repeat(8001) }), { code: 'BAD_REQUEST', status: 400 });
  assert.throws(() => svc.submitGeneration({ model: 'z-image-turbo', prompt: 'ok', negative_prompt: 'x'.repeat(8001) }), { code: 'BAD_REQUEST', status: 400 });
  assert.doesNotThrow(() => svc.submitGeneration({ model: 'z-image-turbo', prompt: 'x'.repeat(8000) }));
});

test('the queue is bounded: at most maxPending waiting jobs, then 429 QUEUE_FULL (a flood cannot pile up V100 jobs)', async () => {
  const gate = (() => { let r; const promise = new Promise((res) => { r = res; }); return { promise, resolve: r }; })();
  const q = new JobQueue({ run: async () => { await gate.promise; return {}; } });
  const svc = createService({ standin, queue: q, config: { maxPending: 3 } });
  const first = svc.submitGeneration({ model: 'z-image-turbo', prompt: 'a' });          // becomes the running job
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 3; i += 1) svc.submitGeneration({ model: 'z-image-turbo', prompt: `w${i}` });   // 3 waiting = the cap
  assert.throws(() => svc.submitGeneration({ model: 'z-image-turbo', prompt: 'too many' }), { code: 'QUEUE_FULL', status: 429 });
  q.cancel(q.pending[0]);   // a slot frees up
  assert.doesNotThrow(() => svc.submitGeneration({ model: 'z-image-turbo', prompt: 'fits again' }));
  gate.resolve(); await q.wait(first.id, 1000);
});
