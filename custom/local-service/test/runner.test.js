'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunner } = require('../src/runner');

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('PNG!').toString('base64')}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-runner-'));
const config = (over = {}) => ({ gpuEnabled: true, allowedDevices: ['v100', 'gtx1080'], arbiterUrl: 'http://arb', outputsDir: tmp(), sdcppConsumer: 'ogai-local', sdcppVramGb: 10, deviceIndexV100: 0, deviceIndex1080: 1, dataDir: tmp(), tmpDir: tmp(), sdcliPath: '/opt/sd-cli', modelDirs: [], ...over });
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

test('a failed job releases the lease; the next queued job then acquires its own', async () => {
  let n = 0;
  const failFirst = async (opts) => { n += 1; if (n === 1) throw Object.assign(new Error('sd-cli exploded'), { code: 'SDCLI_FAILED' }); return fakeSdcli()(opts); };
  const { queue, gate } = batchSetup({ sdcli: failFirst });
  const a = submit(queue, fluxJob()); const b = submit(queue, fluxJob());
  await done(queue, a, b);
  assert.equal(queue.get(a.id).status, 'error');
  assert.equal(queue.get(b.id).status, 'done');
  assert.equal(gate.calls.length, 2);
  assert.equal(gate.releases, 2);
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
