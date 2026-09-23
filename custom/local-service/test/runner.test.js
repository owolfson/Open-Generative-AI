'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunner } = require('../src/runner');

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('PNG!').toString('base64')}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-runner-'));
const config = (over = {}) => ({ leaseLingerMs: 0, leaseHandoverMs: 0, gpuEnabled: true, allowedDevices: ['v100', 'gtx1080'], arbiterUrl: 'http://arb', outputsDir: tmp(), sdcppConsumer: 'ogai-local', sdcppVramGb: 10, deviceIndexV100: 0, deviceIndex1080: 1, dataDir: tmp(), tmpDir: tmp(), sdcliPath: '/opt/sd-cli', modelDirs: [], ...over });
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
  const gate = { calls: [], releases: 0 };
  gate.acquire = async (cfg, opts) => { gate.calls.push(opts); return { leaseId: `lease-${gate.calls.length}`, release: async () => { gate.releases += 1; } }; };
  return { standin, gate };
}

test('refuses every job while GPU is disabled', async () => {
  const { standin, gate } = fakes();
  const r = createRunner({ config: config({ gpuEnabled: false }), standin, acquireImpl: gate.acquire, log: quiet });
  await assert.rejects(() => r.run(job(), ctx()), { code: 'GPU_DISABLED' });
  assert.equal(standin.calls.length, 0);
  assert.equal(gate.calls.length, 0);
});

test('routes other than sdcpp are not wired yet', async () => {
  const { standin, gate } = fakes();
  const r = createRunner({ config: config(), standin, acquireImpl: gate.acquire, log: quiet });
  await assert.rejects(() => r.run(job({ route: 'wangp' }), ctx()), { code: 'ENGINE_NOT_READY' });
});

test('V100 job: takes an arbiter lease, pins CUDA device 0, persists the PNG', async () => {
  const { standin, gate } = fakes();
  const cfg = config();
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, log: quiet });
  const out = await r.run(job({ params: { model: 'z-image-turbo', prompt: 'a cat', device: 'v100' } }), ctx());
  assert.deepEqual(gate.calls, [{ consumer: 'ogai-local', vramGb: 28, estSeconds: 3600, note: 'ogai-local job job1' }]);   // whole-card lease: capped at the arbiter's 28GB budget, 1h window
  assert.equal(standin.envAtGenerate, '0');
  assert.equal(out.seed, 7);
  assert.equal(out.file, 'job1.png');
  assert.equal(out.url, '/outputs/job1.png');
  assert.equal(out.dataUrl, PNG_DATA_URL);
  assert.equal(fs.readFileSync(path.join(cfg.outputsDir, 'job1.png'), 'utf8'), 'PNG!');
});

test('GTX 1080 job: no arbiter lease (never evicts the brain), CUDA device 1, device param not forwarded', async () => {
  const { standin, gate } = fakes();
  const r = createRunner({ config: config(), standin, acquireImpl: gate.acquire, log: quiet });
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
  const r = createRunner({ config: config(), standin, acquireImpl: gate.acquire, log: quiet });
  const controller = new AbortController();
  const pending = r.run(job(), { signal: controller.signal });
  await new Promise((res) => setImmediate(res));
  controller.abort();
  await new Promise((res) => setImmediate(res));
  assert.ok(standin.calls.includes('local-ai:cancel-generation'));
  release();
  await pending;
});

test('device policy: small models default to the GTX 1080 lane; a model that needs the V100 must ask for it explicitly', async () => {
  const small = fakes();
  await createRunner({ config: config(), standin: small.standin, acquireImpl: small.gate.acquire, log: quiet }).run(job(), ctx());   // z-image-turbo, 5.2GB
  assert.equal(small.gate.calls.length, 0);
  assert.equal(small.standin.envAtGenerate, '1');

  const big = fakes();
  const rb = createRunner({ config: config(), standin: big.standin, acquireImpl: big.gate.acquire, log: quiet });
  await assert.rejects(() => rb.run(job({ params: { model: 'stable-diffusion-xl-base', prompt: 'x' } }), ctx()),   // 6.9GB
    (err) => err.code === 'DEVICE_REQUIRED' && /v100/.test(err.message) && /Hermes brain/.test(err.message));
  assert.equal(big.gate.calls.length, 0);          // never touched the arbiter
  assert.equal(big.standin.calls.length, 0);        // never ran anything
  await rb.run(job({ params: { model: 'stable-diffusion-xl-base', prompt: 'x', device: 'v100' } }), ctx());
  assert.equal(big.gate.calls.length, 1);           // an explicit request goes through the arbiter
  assert.equal(big.standin.envAtGenerate, '0');
});

test('a device that is not allowed is refused before anything runs; an unknown device is a bad request', async () => {
  const f = fakes();
  const r = createRunner({ config: config({ allowedDevices: ['gtx1080'] }), standin: f.standin, acquireImpl: f.gate.acquire, log: quiet });
  await assert.rejects(() => r.run(job({ params: { model: 'z-image-turbo', prompt: 'x', device: 'v100' } }), ctx()), { code: 'DEVICE_NOT_ALLOWED' });
  await assert.rejects(() => r.run(job({ params: { model: 'z-image-turbo', prompt: 'x', device: 'tpu' } }), ctx()), { code: 'BAD_REQUEST' });
  assert.equal(f.standin.calls.length, 0);
  assert.equal(f.gate.calls.length, 0);
});

test('with only the GTX 1080 allowed even big models use it and the arbiter is never contacted', async () => {
  const f = fakes();
  const r = createRunner({ config: config({ allowedDevices: ['gtx1080'], arbiterUrl: '' }), standin: f.standin, acquireImpl: f.gate.acquire, log: quiet });
  await r.run(job({ params: { model: 'stable-diffusion-xl-base', prompt: 'x' } }), ctx());
  assert.equal(f.gate.calls.length, 0);
  assert.equal(f.standin.envAtGenerate, '1');
});

test('with only the V100 allowed small models use it (through the arbiter)', async () => {
  const f = fakes();
  await createRunner({ config: config({ allowedDevices: ['v100'] }), standin: f.standin, acquireImpl: f.gate.acquire, log: quiet }).run(job(), ctx());
  assert.equal(f.gate.calls.length, 1);
});

test('no allowed device at all is refused', async () => {
  const f = fakes();
  await assert.rejects(() => createRunner({ config: config({ allowedDevices: [] }), standin: f.standin, acquireImpl: f.gate.acquire, log: quiet }).run(job(), ctx()), { code: 'DEVICE_NOT_ALLOWED' });
});

// ---------- extended sd.cpp models (Flux / Qwen / Wan) ----------
const EventEmitter = require('node:events');
function modelDir(files) {
  const d = tmp();
  for (const f of files) { const p = path.join(d, 'models', f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); }
  return d;
}
const FLUX_FILES = ['flux1-dev-Q8_0.gguf', 'ae.sft.safetensors', 'clip_l.safetensors', 't5xxl_fp16.safetensors'];
const WAN_FILES = ['Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf', 'Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf', 'Wan2_1_VAE_bf16.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'];
function fakeSdcli(bytes = 'BYTES') {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const out = opts.args[opts.args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, bytes);
    opts.onProgress({ step: 1, totalSteps: 4, progress: 0.25, status: 'sampling' });
    return { output: '' };
  };
  fn.calls = calls;
  return fn;
}

test('Flux on the V100: leases the model\'s own VRAM, runs sd-cli with the right args and GPU env, persists a png', async () => {
  const { standin, gate } = fakes(); const sd = fakeSdcli('PNGBYTES');
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)] });
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: sd, log: quiet });
  const out = await r.run(job({ params: { model: 'wan2gp:flux-dev', prompt: 'a cat', device: 'v100', seed: 5 } }), ctx());
  assert.equal(gate.calls[0].vramGb, 28);   // the lease claims the whole card (capped at the arbiter's 28GB budget), not just this model's footprint
  assert.equal(gate.calls[0].consumer, 'ogai-local');
  assert.equal(gate.calls[0].estSeconds, 3600);
  const call = sd.calls[0];
  assert.equal(call.binary, cfg.sdcliPath);
  assert.ok(call.args.includes('--t5xxl'));
  assert.equal(call.env.CUDA_VISIBLE_DEVICES, '0');
  assert.equal(call.env.CUDA_DEVICE_ORDER, 'PCI_BUS_ID');
  assert.deepEqual({ seed: out.seed, file: out.file, url: out.url, kind: out.kind, mime: out.mime, bytes: out.bytes }, { seed: 5, file: 'job1.png', url: '/outputs/job1.png', kind: 'image', mime: 'image/png', bytes: 8 });
  assert.equal(out.dataUrl, `data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}`);
  assert.equal(fs.readFileSync(path.join(cfg.outputsDir, 'job1.png'), 'utf8'), 'PNGBYTES');
  assert.equal(standin.calls.length, 0, "upstream's engine is not used for extended models");
});

test('missing model files fail BEFORE any arbiter lease (never evict the brain for a job that cannot run)', async () => {
  const { standin, gate } = fakes(); const sd = fakeSdcli();
  const r = createRunner({ config: config({ modelDirs: [modelDir(['ae.sft.safetensors'])] }), standin, acquireImpl: gate.acquire, sdcli: sd, log: quiet });
  await assert.rejects(() => r.run(job({ params: { model: 'wan2gp:flux-dev', prompt: 'x', device: 'v100' } }), ctx()),
    (err) => err.code === 'MODEL_FILES_MISSING' && /flux1-dev-Q8_0\.gguf/.test(err.message) && /t5xxl_fp16/.test(err.message));
  assert.equal(gate.calls.length, 0);
  assert.equal(sd.calls.length, 0);
});

test('video model: avi artifact with kind video, a longer lease estimate, and no data URL', async () => {
  const { standin, gate } = fakes(); const sd = fakeSdcli('AVIBYTES');
  const cfg = config({ modelDirs: [modelDir(WAN_FILES)] });
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: sd, log: quiet });
  const out = await r.run(job({ params: { model: 'wan2gp:wan22-i2v', prompt: 'it moves', device: 'v100', init_image: '/tmp/in.png', seed: 9 } }), ctx());
  assert.equal(gate.calls[0].vramGb, 28);
  assert.equal(gate.calls[0].estSeconds, 3600);
  assert.ok(sd.calls[0].args.includes('vid_gen'));
  assert.deepEqual({ file: out.file, url: out.url, kind: out.kind, mime: out.mime, seed: out.seed }, { file: 'job1.avi', url: '/outputs/job1.avi', kind: 'video', mime: 'video/x-msvideo', seed: 9 });
  assert.equal(out.dataUrl, undefined);
  assert.equal(fs.readFileSync(path.join(cfg.outputsDir, 'job1.avi'), 'utf8'), 'AVIBYTES');
});

test('an image-to-video job without an input image is refused before the lease', async () => {
  const { standin, gate } = fakes(); const sd = fakeSdcli();
  const r = createRunner({ config: config({ modelDirs: [modelDir(WAN_FILES)] }), standin, acquireImpl: gate.acquire, sdcli: sd, log: quiet });
  await assert.rejects(() => r.run(job({ params: { model: 'wan2gp:wan22-i2v', prompt: 'x', device: 'v100' } }), ctx()), { code: 'IMAGE_REQUIRED' });
  assert.equal(gate.calls.length, 0);
});

test('sd-cli progress is forwarded as local-ai:progress events', async () => {
  const { standin, gate } = fakes(); standin.events = new EventEmitter();
  const seen = []; standin.events.on('send', (channel, data) => seen.push([channel, data]));
  const r = createRunner({ config: config({ modelDirs: [modelDir(FLUX_FILES)] }), standin, acquireImpl: gate.acquire, sdcli: fakeSdcli(), log: quiet });
  await r.run(job({ params: { model: 'wan2gp:flux-dev', prompt: 'x', device: 'v100' } }), ctx());
  assert.deepEqual(seen, [['local-ai:progress', { step: 1, totalSteps: 4, progress: 0.25, status: 'sampling' }]]);
});

// ---------- one V100 lease across a queued batch ----------
const { JobQueue } = require('../src/queue');
function batchSetup({ sdcli, qwen = false } = {}) {
  const { standin, gate } = fakes();
  const sd = sdcli || fakeSdcli();
  const QWEN_ALL = ['qwen_image_vae.safetensors', 'qwen-image-2512-Q6_K.gguf', 'qwen_2.5_vl_7b_fp8_scaled.safetensors'];
  const cfg = config({ modelDirs: [modelDir([...FLUX_FILES, ...(qwen ? QWEN_ALL : ['qwen_image_vae.safetensors'])])] });
  const runner = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: sd, log: quiet });
  const queue = new JobQueue({ run: (j, c) => runner.run(j, c) });
  return { queue, gate, sd, runner, standin };
}
const submit = (queue, params) => queue.submit({ kind: 'image', route: 'sdcpp', params });
const fluxJob = (extra = {}) => ({ model: 'wan2gp:flux-dev', prompt: 'x', device: 'v100', ...extra });
const done = (queue, ...jobs) => Promise.all(jobs.map((j) => queue.wait(j.id, 3000)));
const deferredPromise = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('two queued V100 jobs share ONE lease sized for the whole batch (the brain is evicted and restored once, not twice)', async () => {
  const { queue, gate } = batchSetup();
  const a = submit(queue, fluxJob()); const b = submit(queue, fluxJob());
  await done(queue, a, b);
  assert.equal(queue.get(a.id).status, 'done'); assert.equal(queue.get(b.id).status, 'done');
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.releases, 1);
  assert.equal(gate.calls[0].estSeconds, 3600);     // never less than the 1h window, so later arrivals can join
  assert.equal(gate.calls[0].vramGb, 28);           // a V100 lease claims the whole card
  assert.match(gate.calls[0].note, /\(\+1 queued\)/);
});

test('a non-V100 job in the middle ends the batch: the lease is released before it and re-acquired after', async () => {
  const { queue, gate } = batchSetup();
  const a = submit(queue, fluxJob());
  const mid = submit(queue, { model: 'z-image-turbo', prompt: 'x', device: 'gtx1080' });
  const c = submit(queue, fluxJob());
  await done(queue, a, mid, c);
  assert.equal(gate.calls.length, 2);
  assert.equal(gate.releases, 2);
  assert.deepEqual([a, mid, c].map((j) => queue.get(j.id).status), ['done', 'done', 'done']);
});

test('a failed job keeps the lease when the next queued job is covered (the arbiter restores the brain the instant a lease is released: releasing here would start a cold load that the next job then kills)', async () => {
  let n = 0;
  const failFirst = async (opts) => { n += 1; if (n === 1) throw Object.assign(new Error('sd-cli exploded'), { code: 'SDCLI_FAILED' }); return fakeSdcli()(opts); };
  const { queue, gate } = batchSetup({ sdcli: failFirst });
  const a = submit(queue, fluxJob()); const b = submit(queue, fluxJob());
  await done(queue, a, b);
  assert.equal(queue.get(a.id).status, 'error');
  assert.equal(queue.get(b.id).status, 'done');
  assert.equal(gate.calls.length, 1, 'one lease covers the failed job and the one behind it');
  assert.equal(gate.releases, 1, 'released once, after the last job');
});

test('a failed job with NOTHING behind it releases the lease (no linger configured)', async () => {
  const boom = async () => { throw Object.assign(new Error('sd-cli exploded'), { code: 'SDCLI_FAILED' }); };
  const { queue, gate } = batchSetup({ sdcli: boom });
  const a = submit(queue, fluxJob());
  await done(queue, a);
  assert.equal(queue.get(a.id).status, 'error'); assert.equal(gate.releases, 1);
});

test('a covered job that fails BEFORE the lease (missing files) must not leak the lease', async () => {
  const { queue, gate } = batchSetup();
  const a = submit(queue, fluxJob());
  const b = submit(queue, { model: 'wan2gp:qwen-image', prompt: 'x', device: 'v100' });   // its model files are not present
  await done(queue, a, b);
  assert.equal(queue.get(b.id).error.code, 'MODEL_FILES_MISSING');
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.releases, gate.calls.length, 'every acquired lease is released');
});

test('cancelling the queued covered job releases the lease as soon as the running job ends', async () => {
  const hold = deferredPromise();
  const slow = async (opts) => { await hold.promise; return fakeSdcli()(opts); };
  const { queue, gate } = batchSetup({ sdcli: slow });
  const a = submit(queue, fluxJob()); const b = submit(queue, fluxJob());
  await new Promise((r) => setImmediate(r));
  assert.equal(queue.cancel(b.id), true);
  hold.resolve();
  await done(queue, a);
  assert.equal(queue.get(b.id).status, 'cancelled');
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.releases, 1);
});

test('shutdown() releases a held lease so a redeploy mid-job cannot leave the brain evicted until the lease expires', async () => {
  const hold = deferredPromise();
  const slow = async (opts) => { await hold.promise; return fakeSdcli()(opts); };
  const { queue, gate, runner } = batchSetup({ sdcli: slow });
  const a = submit(queue, fluxJob());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.releases, 0);
  await runner.shutdown();
  assert.equal(gate.releases, 1);
  hold.resolve(); await done(queue, a);
  assert.equal(gate.releases, 1, 'no double release');
});

test('a kept lease is released on its own if the next job never starts (cancelled in the gap)', async () => {
  const { standin, gate } = fakes();
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)] });
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: fakeSdcli(), log: quiet, idleReleaseMs: 30 });
  const next = { id: 'job2', route: 'sdcpp', params: fluxJob() };
  await r.run(job({ params: fluxJob() }), { signal: new AbortController().signal, pending: () => [next] });
  assert.equal(gate.releases, 0, 'kept for the queued job');
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(gate.releases, 1, 'released by the idle timer');
});

test('a batch that would outrun the arbiter\'s 4h est_seconds cap is split, not truncated silently', async () => {
  const { standin, gate } = fakes();
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)] });
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: fakeSdcli(), log: quiet });
  const pendingJobs = Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, route: 'sdcpp', params: fluxJob() }));
  await r.run(job({ params: fluxJob() }), { signal: new AbortController().signal, pending: () => pendingJobs });
  assert.ok(gate.calls[0].estSeconds <= 14400, `est_seconds ${gate.calls[0].estSeconds} must stay within the arbiter's limit`);
  await r.shutdown();
});

// ---------- video: browsers cannot play sd.cpp's MJPEG .avi, so the artifact served is an .mp4 ----------
function videoRun({ mp4 }) {
  const { standin, gate } = fakes();
  const cfg = config({ modelDirs: [modelDir(WAN_FILES)], ffmpegPath: '/opt/ffmpeg' });
  const warnings = [];
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: fakeSdcli('AVIBYTES'), mp4Impl: mp4, log: { warn: (m) => warnings.push(m), error() {} } });
  const run = () => r.run(job({ params: { model: 'wan2gp:wan22-i2v', prompt: 'it moves', device: 'v100', init_image: '/tmp/in.png', seed: 9 } }), ctx());
  return { cfg, run, warnings };
}

test('a finished video is converted to mp4: the mp4 is the artifact, the avi stays as `source`', async () => {
  const seen = [];
  const { cfg, run } = videoRun({ mp4: async ({ ffmpeg, input, output }) => { seen.push({ ffmpeg, input: path.basename(input), output: path.basename(output) }); fs.writeFileSync(output, 'MP4BYTES'); return output; } });
  const out = await run();
  assert.deepEqual(seen, [{ ffmpeg: '/opt/ffmpeg', input: 'job1.avi', output: 'job1.mp4' }]);
  assert.deepEqual({ file: out.file, url: out.url, kind: out.kind, mime: out.mime, source: out.source, bytes: out.bytes }, { file: 'job1.mp4', url: '/outputs/job1.mp4', kind: 'video', mime: 'video/mp4', source: 'job1.avi', bytes: 8 });
  assert.equal(fs.readFileSync(path.join(cfg.outputsDir, 'job1.avi'), 'utf8'), 'AVIBYTES');
});

test('if the mp4 conversion fails the job still succeeds with the avi, and says why', async () => {
  const { run, warnings } = videoRun({ mp4: async () => { throw Object.assign(new Error('ffmpeg exploded'), { code: 'FFMPEG_FAILED' }); } });
  const out = await run();
  assert.equal(out.file, 'job1.avi'); assert.equal(out.mime, 'video/x-msvideo');
  assert.match(out.warning, /mp4 conversion failed.*ffmpeg exploded/);
  assert.equal(warnings.length, 1);
});

test('a lease claims the biggest V100 model footprint even for a small job, so a BIGGER job that arrives later still shares it', async () => {
  // This is the real-world order: the first job starts before the others are even submitted.
  const hold = deferredPromise();
  const slow = async (opts) => { await hold.promise; return fakeSdcli()(opts); };
  const { queue, gate } = batchSetup({ qwen: true, sdcli: slow });
  const a = submit(queue, fluxJob());                                    // 22GB job starts alone and is still running...
  await new Promise((r) => setTimeout(r, 30));
  const b = submit(queue, { model: 'wan2gp:qwen-image', prompt: 'x', device: 'v100' });   // ...when a 24GB job arrives
  hold.resolve();
  await done(queue, a, b);
  assert.equal(gate.calls[0].vramGb, 28);
  assert.equal(gate.calls.length, 1, 'one lease covers both');
  assert.equal(gate.releases, 1);
});

// ---------- Z-Image Base: 1080-only (it renders a blank image on the V100) ----------
const ZBASE_FILES = ['z-image-Q8_0.gguf', 'Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf', 'ae.safetensors'];
function zbaseRunner() {
  const { standin, gate } = fakes(); const sd = fakeSdcli('PNGBYTES');
  const cfg = config({ modelDirs: [modelDir(ZBASE_FILES)] });
  return { gate, sd, r: createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: sd, log: quiet }) };
}

test('Z-Image Base defaults to the GTX 1080 (no arbiter lease) even though its weights are too big for the "small model" rule', async () => {
  const { gate, sd, r } = zbaseRunner();
  await r.run(job({ params: { model: 'z-image-base', prompt: 'a cat' } }), ctx());
  assert.equal(gate.calls.length, 0, 'never touches the V100 lease');
  assert.equal(sd.calls[0].env.CUDA_VISIBLE_DEVICES, '1');
});

test('Z-Image Base refuses the V100 up front with the reason (blank white image, measured), before any lease', async () => {
  const { gate, sd, r } = zbaseRunner();
  await assert.rejects(() => r.run(job({ params: { model: 'z-image-base', prompt: 'a cat', device: 'v100' } }), ctx()), (e) => e.code === 'DEVICE_NOT_SUPPORTED' && /blank/.test(e.message));
  assert.equal(gate.calls.length, 0); assert.equal(sd.calls.length, 0);
});

// ---------- a job may not run past its time limit (a job outliving its lease would let the arbiter restore the brain on top of it) ----------
test('JOB_TIMEOUT: a job that runs past the limit is aborted (sd-cli killed via the signal), reported as JOB_TIMEOUT, and its lease is released', async () => {
  const { standin, gate } = fakes();
  let aborted = false;
  const hang = (opts) => new Promise((_, reject) => { opts.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('sd-cli was cancelled'), { code: 'CANCELLED' })); }, { once: true }); });
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)], jobTimeoutMs: 80 });
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: hang, log: quiet });
  const started = Date.now();
  await assert.rejects(() => r.run(job({ params: fluxJob() }), ctx()), (e) => e.code === 'JOB_TIMEOUT' && /limit/.test(e.message));
  assert.ok(aborted, 'the child was told to stop'); assert.ok(Date.now() - started < 3000);
  assert.equal(gate.calls.length, 1); assert.equal(gate.releases, 1, 'the lease is given back');
});

test('the timeout does not fire for a job that finishes in time, and a user cancel is still a plain cancel', async () => {
  const { standin, gate } = fakes();
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)], jobTimeoutMs: 5000 });
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: fakeSdcli(), log: quiet });
  const out = await r.run(job({ params: fluxJob() }), ctx()); assert.equal(out.kind, 'image');
  const controller = new AbortController();
  const hang = (opts) => new Promise((_, reject) => { opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true }); });
  const r2 = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: hang, log: quiet });
  const p = r2.run(job({ id: 'job2', params: fluxJob() }), { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(() => p, { code: 'CANCELLED' });
});

// ---------- linger: a quick follow-up must not pay a full evict/restore cycle ----------
test('with leaseLingerMs the lease is held after the queue empties, so a follow-up job reuses it; then it is released', async () => {
  const { standin, gate } = fakes();
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)], leaseLingerMs: 120 });
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: fakeSdcli(), log: quiet });
  await r.run(job({ id: 'j1', params: fluxJob() }), ctx());
  assert.equal(gate.releases, 0, 'still held right after the job');
  await r.run(job({ id: 'j2', params: fluxJob() }), ctx());          // arrives within the linger window
  assert.equal(gate.calls.length, 1, 'the follow-up reused the lease (no second evict/restore cycle)');
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(gate.releases, 1, 'released once the linger window passed with no new work');
});

test('a GTX 1080 job (or shutdown) during the linger window gives the V100 back immediately', async () => {
  const { standin, gate } = fakes();
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)], leaseLingerMs: 60_000 });
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: fakeSdcli(), log: quiet });
  await r.run(job({ id: 'j1', params: fluxJob() }), ctx());
  assert.equal(gate.releases, 0);
  await r.run(job({ id: 'j2', params: { model: 'z-image-turbo', prompt: 'x', device: 'gtx1080' } }), ctx());
  assert.equal(gate.releases, 1, 'a job that does not need the V100 releases it');
  await r.run(job({ id: 'j3', params: fluxJob() }), ctx());
  assert.equal(gate.releases, 1);
  await r.shutdown();
  assert.equal(gate.releases, 2, 'shutdown cancels the linger timer and releases');
});

// ---------- lease renewal: a job that does not fit the remaining lease window is HANDED the V100, never given back first ----------
function eventGate() {
  // models the arbiter: one lease at a time; an acquire made while another lease is held waits, and is granted the moment that one is released
  const events = []; let holder = null; const waiters = [];
  const gate = {
    events,
    acquire: async (cfg, opts) => {
      events.push(`acquire#${events.filter((e) => e.startsWith('acquire')).length + 1}(${opts.estSeconds})`);
      if (holder) await new Promise((res) => waiters.push(res));
      const id = `lease-${events.length}`; holder = id;
      return { leaseId: id, release: async () => { events.push(`release(${id})`); holder = null; const w = waiters.shift(); if (w) w(); } };
    },
  };
  return gate;
}

test('renewal: when the next job no longer fits the remaining window, the NEW lease is requested BEFORE the old one is released (no brain restore in between)', async () => {
  const { standin } = fakes(); const g = eventGate();
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)], leaseMinSeconds: 0, leaseLingerMs: 10_000 });   // window = the one job's estimate (900s), so job 2 (900s) cannot fit what is left of it
  const r = createRunner({ config: cfg, standin, acquireImpl: g.acquire, sdcli: fakeSdcli(), log: quiet });
  await r.run(job({ id: 'j1', params: fluxJob() }), ctx());
  await new Promise((res) => setTimeout(res, 15));   // time must pass, or 'fits the remaining window' is true in the same millisecond
  await r.run(job({ id: 'j2', params: fluxJob() }), ctx());
  assert.deepEqual(g.events.map((e) => e.replace(/\(lease-\d+\)|\(\d+\)/, '')), ['acquire#1', 'acquire#2', 'release'], 'acquire #2 goes out before the old lease is released');
  await r.shutdown();
  assert.equal(g.events.filter((e) => e.startsWith('release')).length, 2, 'both leases end up released');
});

test('renewal still ends cleanly when the arbiter refuses the new lease: the job fails with the arbiter error and nothing is left held', async () => {
  const { standin } = fakes(); let n = 0; const released = [];
  const acquire = async () => { n += 1; if (n === 2) throw Object.assign(new Error('V100 not clear'), { code: 'ARBITER_REFUSED' }); return { leaseId: `l${n}`, release: async () => { released.push(`l${n}`); } }; };
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)], leaseMinSeconds: 0, leaseLingerMs: 10_000 });
  const r = createRunner({ config: cfg, standin, acquireImpl: acquire, sdcli: fakeSdcli(), log: quiet });
  await r.run(job({ id: 'j1', params: fluxJob() }), ctx());
  await new Promise((res) => setTimeout(res, 15));   // time must pass, or 'fits the remaining window' is true in the same millisecond
  await assert.rejects(() => r.run(job({ id: 'j2', params: fluxJob() }), ctx()), { code: 'ARBITER_REFUSED' });
  await r.shutdown();
  assert.equal(released.length, 1, 'the old lease was released exactly once and nothing else is held');
});

test('BATTLE-FOUND BUG: a queued V100 job that does not fit the remaining window must NOT make the finishing job release the lease (the arbiter would start restoring the brain, and the next acquire would kill it mid-load); it is handed the lease instead', async () => {
  const { standin } = fakes(); const g = eventGate();
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)], leaseMinSeconds: 0, leaseLingerMs: 0 });
  const r = createRunner({ config: cfg, standin, acquireImpl: g.acquire, sdcli: fakeSdcli(), log: quiet });
  const next = { id: 'j2', route: 'sdcpp', params: fluxJob() };
  let seen = 0;   // j2 is submitted AFTER j1 started (the real order): invisible when j1 sizes its lease, queued when j1 finishes
  await r.run(job({ id: 'j1', params: fluxJob() }), { signal: new AbortController().signal, pending: () => (seen++ === 0 ? [] : [next]) });
  assert.equal(g.events.filter((e) => e.startsWith('release')).length, 0, 'the lease is still held after j1: nothing was released');
  await new Promise((res) => setTimeout(res, 15));   // time must pass, or 'fits the remaining window' is true in the same millisecond
  await r.run(job({ id: 'j2', params: fluxJob() }), ctx());
  assert.deepEqual(g.events.map((e) => e.replace(/\(lease-\d+\)|\(\d+\)/, '')), ['acquire#1', 'acquire#2', 'release', 'release'], 'j2 renewed by handover: acquire #2 went out BEFORE the first release; the last release is j2\'s own lease at the end');
  await r.shutdown();
});

test('a queued job that is NOT a V100 job (or would fail anyway) still ends the batch: the card is given back before it', async () => {
  const { standin, gate } = fakes();
  const cfg = config({ modelDirs: [modelDir(FLUX_FILES)], leaseMinSeconds: 0, leaseLingerMs: 0 });
  const r = createRunner({ config: cfg, standin, acquireImpl: gate.acquire, sdcli: fakeSdcli(), log: quiet });
  const on1080 = { id: 'j2', route: 'sdcpp', params: { model: 'z-image-turbo', prompt: 'x', device: 'gtx1080' } };
  await r.run(job({ id: 'j1', params: fluxJob() }), { signal: new AbortController().signal, pending: () => [on1080] });
  assert.equal(gate.releases, 1, 'released: the next job is on the GTX 1080');
});

// ---------- cinema: chain several of a model's own clips into one longer video ----------
function cinemaFakes({ mp4Calls = [], lastFrameCalls = [], concatCalls = [], failAt = null } = {}) {
  const { standin, gate } = fakes();
  const sd = fakeSdcli('AVIBYTES');
  const mp4Impl = async ({ ffmpeg, input, output }) => { mp4Calls.push({ ffmpeg, input, output }); fs.writeFileSync(output, 'MP4BYTES'); return output; };
  const lastFrameImpl = async ({ ffmpeg, input, output }) => {
    lastFrameCalls.push({ ffmpeg, input, output });
    if (failAt === 'lastFrame') throw Object.assign(new Error('ffmpeg exploded'), { code: 'FFMPEG_FAILED' });
    fs.writeFileSync(output, 'PNGBYTES'); return output;
  };
  const concatImpl = async ({ ffmpeg, inputs, output, tmpDir }) => {
    concatCalls.push({ ffmpeg, inputs: inputs.map((i) => path.basename(i)), tmpDir });
    if (failAt === 'concat') throw Object.assign(new Error('ffmpeg exploded'), { code: 'FFMPEG_FAILED' });
    fs.writeFileSync(output, 'FINALMP4'); return output;
  };
  return { standin, gate, sd, mp4Impl, lastFrameImpl, concatImpl, mp4Calls, lastFrameCalls, concatCalls };
}
const cinemaJob = (over = {}) => job({ params: { model: 'wan2gp:wan22-i2v', prompt: 'a fox trots', device: 'v100', init_image: '/tmp/in.png', cinema: { segments: 3 }, ...over } });

test('cinema: a lease sized for the WHOLE chain (segments x the normal video estimate), one lease for all segments', async () => {
  const f = cinemaFakes();
  const cfg = config({ modelDirs: [modelDir(WAN_FILES)] });
  const r = createRunner({ config: cfg, standin: f.standin, acquireImpl: f.gate.acquire, sdcli: f.sd, mp4Impl: f.mp4Impl, lastFrameImpl: f.lastFrameImpl, concatImpl: f.concatImpl, log: quiet });
  await r.run(cinemaJob(), ctx());
  assert.equal(f.gate.calls.length, 1, 'one lease covers every segment');
  assert.equal(f.gate.calls[0].estSeconds, 5400, '3 segments x 1800s');
  const f2 = cinemaFakes();
  const r2 = createRunner({ config: config({ modelDirs: [modelDir(WAN_FILES)] }), standin: f2.standin, acquireImpl: f2.gate.acquire, sdcli: f2.sd, mp4Impl: f2.mp4Impl, lastFrameImpl: f2.lastFrameImpl, concatImpl: f2.concatImpl, log: quiet });
  await r2.run(cinemaJob({ cinema: { segments: 5 } }), ctx());
  assert.equal(f2.gate.calls[0].estSeconds, 9000, '5 segments x 1800s');
});

test('cinema: runs each segment through sd-cli, converts each to mp4, extracts the last frame between segments, then concatenates - and cleans up every per-segment file', async () => {
  const f = cinemaFakes();
  const cfg = config({ modelDirs: [modelDir(WAN_FILES)], ffmpegPath: '/opt/ffmpeg' });
  const r = createRunner({ config: cfg, standin: f.standin, acquireImpl: f.gate.acquire, sdcli: f.sd, mp4Impl: f.mp4Impl, lastFrameImpl: f.lastFrameImpl, concatImpl: f.concatImpl, log: quiet });
  const out = await r.run(cinemaJob(), ctx());
  assert.equal(f.sd.calls.length, 3, 'one sd-cli call per segment');
  assert.equal(f.mp4Calls.length, 3, 'one mp4 conversion per segment');
  assert.equal(f.lastFrameCalls.length, 2, 'segments-1 last-frame extractions (none needed after the final segment)');
  // segment 1 uses the caller's init_image; segment 2 uses segment 1's last frame; segment 3 uses segment 2's
  assert.equal(f.sd.calls[0].args[f.sd.calls[0].args.indexOf('-i') + 1], '/tmp/in.png');
  assert.equal(path.basename(f.lastFrameCalls[0].input), path.basename(f.mp4Calls[0].output));
  assert.equal(f.sd.calls[1].args[f.sd.calls[1].args.indexOf('-i') + 1], f.lastFrameCalls[0].output);
  assert.equal(f.sd.calls[2].args[f.sd.calls[2].args.indexOf('-i') + 1], f.lastFrameCalls[1].output);
  assert.equal(f.concatCalls.length, 1);
  assert.equal(f.concatCalls[0].inputs.length, 3);
  assert.deepEqual({ file: out.file, url: out.url, kind: out.kind, mime: out.mime, bytes: out.bytes }, { file: 'job1.mp4', url: '/outputs/job1.mp4', kind: 'video', mime: 'video/mp4', bytes: 8 });
  assert.equal(out.cinema.segments, 3);
  assert.equal(out.cinema.seeds.length, 3);
  assert.equal(fs.readFileSync(path.join(cfg.outputsDir, 'job1.mp4'), 'utf8'), 'FINALMP4');
  // nothing per-segment (raw avi, per-segment mp4, extracted frame) is left behind in tmp
  const left = fs.readdirSync(cfg.tmpDir).filter((n) => n.startsWith('job1-'));
  assert.deepEqual(left, [], `leftover cinema scratch files: ${left}`);
});

test('cinema: per-segment prompts (when given) override the job prompt for each segment; omitted reuses it for all', async () => {
  const f = cinemaFakes();
  const cfg = config({ modelDirs: [modelDir(WAN_FILES)] });
  const r = createRunner({ config: cfg, standin: f.standin, acquireImpl: f.gate.acquire, sdcli: f.sd, mp4Impl: f.mp4Impl, lastFrameImpl: f.lastFrameImpl, concatImpl: f.concatImpl, log: quiet });
  await r.run(cinemaJob({ cinema: { segments: 3, prompts: ['a fox emerges', 'the fox trots', 'the fox stops'] } }), ctx());
  const promptOf = (call) => call.args[call.args.indexOf('-p') + 1];
  assert.deepEqual(f.sd.calls.map(promptOf), ['a fox emerges', 'the fox trots', 'the fox stops']);

  const f2 = cinemaFakes();
  const r2 = createRunner({ config: config({ modelDirs: [modelDir(WAN_FILES)] }), standin: f2.standin, acquireImpl: f2.gate.acquire, sdcli: f2.sd, mp4Impl: f2.mp4Impl, lastFrameImpl: f2.lastFrameImpl, concatImpl: f2.concatImpl, log: quiet });
  await r2.run(cinemaJob(), ctx());
  assert.deepEqual(f2.sd.calls.map(promptOf), ['a fox trots', 'a fox trots', 'a fox trots']);
});

test('cinema: each segment gets a FRESH random seed (not the same seed repeated)', async () => {
  const f = cinemaFakes();
  const r = createRunner({ config: config({ modelDirs: [modelDir(WAN_FILES)] }), standin: f.standin, acquireImpl: f.gate.acquire, sdcli: f.sd, mp4Impl: f.mp4Impl, lastFrameImpl: f.lastFrameImpl, concatImpl: f.concatImpl, log: quiet });
  const out = await r.run(cinemaJob(), ctx());
  assert.equal(new Set(out.cinema.seeds).size, 3, `seeds should differ: ${out.cinema.seeds}`);
});

test('cinema: progress events carry segment/segments so the GUI can show "segment i/N"', async () => {
  const f = cinemaFakes();
  const seen = [];
  // emitProgress calls standin.events.emit('send', 'local-ai:progress', data) - a real EventEmitter would hand a 'send' listener (channel, data).
  const standinWithEvents = { ...f.standin, events: { emit: (event, ...args) => { if (event === 'send') seen.push(args[1]); } } };
  standinWithEvents.events.on = () => {};
  const r = createRunner({ config: config({ modelDirs: [modelDir(WAN_FILES)] }), standin: standinWithEvents, acquireImpl: f.gate.acquire, sdcli: f.sd, mp4Impl: f.mp4Impl, lastFrameImpl: f.lastFrameImpl, concatImpl: f.concatImpl, log: quiet });
  await r.run(cinemaJob(), ctx());
  const segTags = seen.filter((e) => e.segments === 3).map((e) => e.segment);
  assert.deepEqual([...new Set(segTags)], [1, 2, 3]);
});

test('cinema: a per-segment timeout (jobTimeoutMs applies to EACH segment, not the whole chain) still lets a slow-but-under-budget chain finish', async () => {
  const f = cinemaFakes();
  const slow = async (opts) => { await new Promise((r2) => setTimeout(r2, 20)); return f.sd(opts); };
  const cfg = config({ modelDirs: [modelDir(WAN_FILES)], jobTimeoutMs: 60 });   // 60ms/segment x 3 = 180ms budget; 3x20ms = 60ms of real work fits
  const r = createRunner({ config: cfg, standin: f.standin, acquireImpl: f.gate.acquire, sdcli: slow, mp4Impl: f.mp4Impl, lastFrameImpl: f.lastFrameImpl, concatImpl: f.concatImpl, log: quiet });
  const out = await r.run(cinemaJob(), ctx());
  assert.equal(out.cinema.segments, 3);
});

test('cinema: cancelling mid-chain stops before the next segment and cleans up (no leftover scratch files, no output written)', async () => {
  const f = cinemaFakes();
  // Realistic: the real runSdCli kills the child process and rejects as soon as the signal aborts (see the other `hang` fakes in this file).
  const hangingSd = (opts) => { f.sd.calls.push(opts); return new Promise((_, reject) => { opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true }); }); };
  const cfg = config({ modelDirs: [modelDir(WAN_FILES)] });
  const r = createRunner({ config: cfg, standin: f.standin, acquireImpl: f.gate.acquire, sdcli: hangingSd, mp4Impl: f.mp4Impl, lastFrameImpl: f.lastFrameImpl, concatImpl: f.concatImpl, log: quiet });
  const controller = new AbortController();
  const pending = r.run(cinemaJob(), { signal: controller.signal });
  await new Promise((res) => setImmediate(res));
  controller.abort();
  await assert.rejects(() => pending);
  assert.equal(f.sd.calls.length, 1, 'only segment 1 was ever started');
  assert.equal(fs.existsSync(path.join(cfg.outputsDir, 'job1.mp4')), false);
  const left = fs.readdirSync(cfg.tmpDir).filter((n) => n.startsWith('job1-'));
  assert.deepEqual(left, []);
});

test('cinema: a failed last-frame extraction fails the whole job and cleans up (no stitched output)', async () => {
  const f = cinemaFakes({ failAt: 'lastFrame' });
  const cfg = config({ modelDirs: [modelDir(WAN_FILES)] });
  const r = createRunner({ config: cfg, standin: f.standin, acquireImpl: f.gate.acquire, sdcli: f.sd, mp4Impl: f.mp4Impl, lastFrameImpl: f.lastFrameImpl, concatImpl: f.concatImpl, log: quiet });
  await assert.rejects(() => r.run(cinemaJob(), ctx()), { code: 'FFMPEG_FAILED' });
  assert.equal(f.sd.calls.length, 1, 'never reached segment 2: only 1 segment ran before the extraction failed');
  assert.equal(fs.existsSync(path.join(cfg.outputsDir, 'job1.mp4')), false);
  const left = fs.readdirSync(cfg.tmpDir).filter((n) => n.startsWith('job1-'));
  assert.deepEqual(left, []);
});

test('cinema: a failed concat fails the job and still cleans up every segment file', async () => {
  const f = cinemaFakes({ failAt: 'concat' });
  const cfg = config({ modelDirs: [modelDir(WAN_FILES)] });
  const r = createRunner({ config: cfg, standin: f.standin, acquireImpl: f.gate.acquire, sdcli: f.sd, mp4Impl: f.mp4Impl, lastFrameImpl: f.lastFrameImpl, concatImpl: f.concatImpl, log: quiet });
  await assert.rejects(() => r.run(cinemaJob(), ctx()), { code: 'FFMPEG_FAILED' });
  assert.equal(f.sd.calls.length, 3, 'all 3 segments rendered; only the final stitch failed');
  assert.equal(fs.existsSync(path.join(cfg.outputsDir, 'job1.mp4')), false);
  const left = fs.readdirSync(cfg.tmpDir).filter((n) => n.startsWith('job1-'));
  assert.deepEqual(left, []);
});
