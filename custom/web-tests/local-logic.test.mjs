import test from 'node:test';
import assert from 'node:assert/strict';
import { entryFromJob, mergeServerJobs, proxyUrl, modelReadiness, pickerModels, resolveDevice, buildParams, describeJob, pushHistory, explainError, formatDuration, needsV100 } from '../../packages/studio/src/local/localLogic.js';

const flux = { id: 'wan2gp:flux-dev', name: 'Flux.1 Dev', kind: 'image', route: 'sdcpp', star: true, weightsGb: 21.6, filesPresent: true };
const zimage = { id: 'z-image-turbo', name: 'Z-Image Turbo', kind: 'image', route: 'sdcpp', star: true, weightsGb: 4.9, state: 'downloaded', auxiliaryStatus: { llm: 'downloaded', vae: 'downloaded' } };
const wan = { id: 'wan2gp:wan22-i2v', name: 'Wan 2.2 (Image-to-Video)', kind: 'video', route: 'sdcpp', star: true, weightsGb: 26.8, filesPresent: false };
const wanT2v = { id: 'wan2gp:wan22-t2v', name: 'Wan 2.2 T2V', kind: 'video', route: 'wangp', star: true };
const health = { allowedDevices: ['v100', 'gtx1080'] };

test('proxyUrl only rewrites server output paths', () => {
  assert.equal(proxyUrl('/outputs/a.mp4'), '/api/local/outputs/a.mp4');
  assert.equal(proxyUrl('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
  assert.equal(proxyUrl('https://cdn.muapi.ai/x.png'), 'https://cdn.muapi.ai/x.png');
  assert.equal(proxyUrl(undefined), undefined);
});

test('readiness: extended models follow filesPresent, upstream models follow download state, wangp models are unavailable', () => {
  assert.equal(modelReadiness(flux).ready, true);
  assert.deepEqual([modelReadiness(wan).ready, modelReadiness(wan).label], [false, 'Files missing']);
  assert.equal(modelReadiness(zimage).ready, true);
  assert.equal(modelReadiness({ ...zimage, auxiliaryStatus: { llm: 'downloaded', vae: 'not-downloaded' } }).label, 'Needs text encoder / VAE');
  assert.equal(modelReadiness({ ...zimage, state: 'partial' }).label, 'Partial download');
  assert.equal(modelReadiness({ ...zimage, state: 'not-downloaded' }).label, 'Download needed');
  assert.equal(modelReadiness(wanT2v).label, 'Not available');
});

test('picker: one kind, runnable engine only, starred then ready first', () => {
  const list = pickerModels([wan, wanT2v, { ...zimage, star: false }, flux, { ...flux, id: 'x', name: 'A', star: true, filesPresent: false }], 'image');
  assert.deepEqual(list.map((m) => m.id), ['wan2gp:flux-dev', 'x', 'z-image-turbo']);
  assert.deepEqual(pickerModels([wan, wanT2v, flux], 'video').map((m) => m.id), ['wan2gp:wan22-i2v']);
});

test('device: auto never picks the V100 for a small model; big models need it; disabled devices are refused', () => {
  assert.equal(needsV100(zimage), false); assert.equal(needsV100(flux), true);
  assert.deepEqual(resolveDevice(zimage, 'auto', health), { device: 'gtx1080', v100: false });
  assert.deepEqual(resolveDevice(flux, 'auto', health), { device: 'v100', v100: true });
  assert.deepEqual(resolveDevice(zimage, 'v100', health), { device: 'v100', v100: true });
  assert.match(resolveDevice(flux, 'gtx1080', health).error, /too big for the GTX 1080/);
  assert.match(resolveDevice(flux, 'auto', { allowedDevices: ['gtx1080'] }).error, /Tesla V100 is not enabled/);
  assert.match(resolveDevice(zimage, 'auto', undefined).error, /not enabled/);
});

test('buildParams sends only what the user set; video adds frames/fps/fast/image', () => {
  assert.deepEqual(buildParams({ model: flux, prompt: '  a cat ', aspect: '1:1', device: 'v100' }), { model: 'wan2gp:flux-dev', prompt: 'a cat', aspect_ratio: '1:1', device: 'v100' });
  const p = buildParams({ model: flux, prompt: 'x', negative: ' blurry ', aspect: '16:9', device: 'v100', advanced: { steps: '12', guidance: '3.5', seed: '42', frames: '17' } });
  assert.deepEqual([p.negative_prompt, p.steps, p.guidance_scale, p.seed, p.video_frames], ['blurry', 12, 3.5, 42, undefined]);
  const v = buildParams({ model: wan, prompt: 'moves', aspect: '16:9', device: 'v100', advanced: { frames: '17', fps: '8', seed: '' }, imageBase64: 'AAAA' });
  assert.deepEqual([v.video_frames, v.fps, v.fast, v.image_base64, v.seed], [17, 8, undefined, 'AAAA', undefined]);   // no fast/quality switch: quality is the only mode
});

test('describeJob: queued, arbiter wait on the V100, model load, sampling, decode', () => {
  assert.equal(describeJob({ status: 'queued' }).text, 'Queued behind another local job…');
  assert.match(describeJob({ status: 'running' }, { device: 'v100', elapsedMs: 10_000 }).text, /GPU arbiter/);
  assert.equal(describeJob({ status: 'running' }, { device: 'v100', elapsedMs: 120_000 }).text, 'Loading model…');
  assert.equal(describeJob({ status: 'running' }, { device: 'gtx1080', elapsedMs: 1000 }).text, 'Loading model…');
  assert.deepEqual(describeJob({ status: 'running', progress: { step: 3, totalSteps: 8, progress: 0.375 } }), { text: 'Step 3/8', pct: 38 });
  assert.deepEqual(describeJob({ status: 'running', progress: { step: 8, totalSteps: 8, progress: 1 } }, { kind: 'video' }), { text: 'Processing frames…', pct: 100 });   // Wan runs several stages (encode, high noise, low noise): the end of one is not the end of the job
  assert.deepEqual(describeJob({ status: 'running', progress: { step: 20, totalSteps: 20, progress: 1 } }, { kind: 'image' }), { text: 'Decoding image…', pct: 100 });
});

test('history: newest first, deduped by id, capped', () => {
  let h = [];
  for (let i = 0; i < 5; i += 1) h = pushHistory(h, { id: `j${i}` }, 3);
  assert.deepEqual(h.map((e) => e.id), ['j4', 'j3', 'j2']);
  assert.deepEqual(pushHistory(h, { id: 'j3', again: true }, 3).map((e) => e.id), ['j3', 'j4', 'j2']);
});

test('error messages and durations are human readable', () => {
  assert.match(explainError({ code: 'ARBITER_REFUSED' }), /V100 is busy/);
  assert.equal(explainError({ code: 'WEIRD', message: 'raw message' }), 'raw message');
  assert.equal(explainError(null), 'Local generation failed.');
  assert.deepEqual([formatDuration(4200), formatDuration(65_000), formatDuration(600_000)], ['4s', '1m 05s', '10m 00s']);
});

const doneJob = (over = {}) => ({ id: 'j1', kind: 'image', status: 'done', startedAt: 1000, finishedAt: 5000, params: { model: 'wan2gp:flux-dev', prompt: 'a lighthouse', device: 'v100', aspect_ratio: '1:1' }, result: { url: '/outputs/j1.png', seed: 7 }, ...over });

test('entryFromJob turns a finished server job (from the GUI, an agent or MCP) into a history entry', () => {
  assert.deepEqual(entryFromJob(doneJob(), [flux]), { id: 'j1', kind: 'image', url: '/api/local/outputs/j1.png', prompt: 'a lighthouse', model: 'wan2gp:flux-dev', modelName: 'Flux.1 Dev', device: 'v100', aspect: '1:1', seed: 7, seconds: 4, createdAt: 5000 });
  assert.equal(entryFromJob(doneJob({ params: { model: 'mystery', prompt: 'x' } }), [flux]).modelName, 'mystery');
  for (const j of [null, doneJob({ status: 'error' }), doneJob({ status: 'running' }), doneJob({ result: null }), doneJob({ result: {} })]) assert.equal(entryFromJob(j, [flux]), null);
});

test('mergeServerJobs adds unseen finished jobs oldest-first (so the newest ends on top), never re-adds dismissed ones or duplicates', () => {
  const jobs = [doneJob({ id: 'a', finishedAt: 100 }), doneJob({ id: 'b', finishedAt: 300 }), doneJob({ id: 'c', finishedAt: 200 }), doneJob({ id: 'd', status: 'error' }), doneJob({ id: 'gone', finishedAt: 50 })];
  const merged = mergeServerJobs([{ id: 'a' }], jobs, [flux], new Set(['gone']));
  assert.deepEqual(merged.map((e) => e.id), ['b', 'c', 'a']);
  assert.equal(mergeServerJobs(merged, jobs, [flux], new Set(['gone'])), merged, 'nothing new: the same list comes back (no needless writes)');
});
