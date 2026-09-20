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
  const out = await r.run(job({ params: { model: 'z-image-turbo', prompt: 'a cat', device: 'v100' } }), ctx());
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

test('device policy: small models default to the GTX 1080 lane; a model that needs the V100 must ask for it explicitly', async () => {
  const small = fakes();
  await createRunner({ config: config(), standin: small.standin, gateImpl: small.gate.impl, log: quiet }).run(job(), ctx());   // z-image-turbo, 5.2GB
  assert.equal(small.gate.calls.length, 0);
  assert.equal(small.standin.envAtGenerate, '1');

  const big = fakes();
  const rb = createRunner({ config: config(), standin: big.standin, gateImpl: big.gate.impl, log: quiet });
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
  const r = createRunner({ config: config({ allowedDevices: ['gtx1080'] }), standin: f.standin, gateImpl: f.gate.impl, log: quiet });
  await assert.rejects(() => r.run(job({ params: { model: 'z-image-turbo', prompt: 'x', device: 'v100' } }), ctx()), { code: 'DEVICE_NOT_ALLOWED' });
  await assert.rejects(() => r.run(job({ params: { model: 'z-image-turbo', prompt: 'x', device: 'tpu' } }), ctx()), { code: 'BAD_REQUEST' });
  assert.equal(f.standin.calls.length, 0);
  assert.equal(f.gate.calls.length, 0);
});

test('with only the GTX 1080 allowed even big models use it and the arbiter is never contacted', async () => {
  const f = fakes();
  const r = createRunner({ config: config({ allowedDevices: ['gtx1080'], arbiterUrl: '' }), standin: f.standin, gateImpl: f.gate.impl, log: quiet });
  await r.run(job({ params: { model: 'stable-diffusion-xl-base', prompt: 'x' } }), ctx());
  assert.equal(f.gate.calls.length, 0);
  assert.equal(f.standin.envAtGenerate, '1');
});

test('with only the V100 allowed small models use it (through the arbiter)', async () => {
  const f = fakes();
  await createRunner({ config: config({ allowedDevices: ['v100'] }), standin: f.standin, gateImpl: f.gate.impl, log: quiet }).run(job(), ctx());
  assert.equal(f.gate.calls.length, 1);
});

test('no allowed device at all is refused', async () => {
  const f = fakes();
  await assert.rejects(() => createRunner({ config: config({ allowedDevices: [] }), standin: f.standin, gateImpl: f.gate.impl, log: quiet }).run(job(), ctx()), { code: 'DEVICE_NOT_ALLOWED' });
});

// ---------- extended sd.cpp models (Flux / Qwen / Wan) ----------
const EventEmitter = require('node:events');
function modelDir(files) {
  const d = tmp();
  for (const f of files) { const p = path.join(d, 'models', f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); }
  return d;
}
const FLUX_FILES = ['flux1-dev-Q8_0.gguf', 'ae.sft.safetensors', 'clip_l.safetensors', 't5xxl_fp16.safetensors'];
const WAN_FILES = ['Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf', 'Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf', 'Wan2_1_VAE_bf16.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors', 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors'];
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
  const r = createRunner({ config: cfg, standin, gateImpl: gate.impl, sdcli: sd, log: quiet });
  const out = await r.run(job({ params: { model: 'wan2gp:flux-dev', prompt: 'a cat', device: 'v100', seed: 5 } }), ctx());
  assert.equal(gate.calls[0].vramGb, 22);
  assert.equal(gate.calls[0].consumer, 'ogai-local');
  assert.equal(gate.calls[0].estSeconds, 900);
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
  const r = createRunner({ config: config({ modelDirs: [modelDir(['ae.sft.safetensors'])] }), standin, gateImpl: gate.impl, sdcli: sd, log: quiet });
  await assert.rejects(() => r.run(job({ params: { model: 'wan2gp:flux-dev', prompt: 'x', device: 'v100' } }), ctx()),
    (err) => err.code === 'MODEL_FILES_MISSING' && /flux1-dev-Q8_0\.gguf/.test(err.message) && /t5xxl_fp16/.test(err.message));
  assert.equal(gate.calls.length, 0);
  assert.equal(sd.calls.length, 0);
});

test('video model: avi artifact with kind video, a longer lease estimate, and no data URL', async () => {
  const { standin, gate } = fakes(); const sd = fakeSdcli('AVIBYTES');
  const cfg = config({ modelDirs: [modelDir(WAN_FILES)] });
  const r = createRunner({ config: cfg, standin, gateImpl: gate.impl, sdcli: sd, log: quiet });
  const out = await r.run(job({ params: { model: 'wan2gp:wan22-i2v', prompt: 'it moves', device: 'v100', init_image: '/tmp/in.png', seed: 9 } }), ctx());
  assert.equal(gate.calls[0].vramGb, 26);
  assert.equal(gate.calls[0].estSeconds, 1800);
  assert.ok(sd.calls[0].args.includes('vid_gen'));
  assert.deepEqual({ file: out.file, url: out.url, kind: out.kind, mime: out.mime, seed: out.seed }, { file: 'job1.avi', url: '/outputs/job1.avi', kind: 'video', mime: 'video/x-msvideo', seed: 9 });
  assert.equal(out.dataUrl, undefined);
  assert.equal(fs.readFileSync(path.join(cfg.outputsDir, 'job1.avi'), 'utf8'), 'AVIBYTES');
});

test('an image-to-video job without an input image is refused before the lease', async () => {
  const { standin, gate } = fakes(); const sd = fakeSdcli();
  const r = createRunner({ config: config({ modelDirs: [modelDir(WAN_FILES)] }), standin, gateImpl: gate.impl, sdcli: sd, log: quiet });
  await assert.rejects(() => r.run(job({ params: { model: 'wan2gp:wan22-i2v', prompt: 'x', device: 'v100' } }), ctx()), { code: 'IMAGE_REQUIRED' });
  assert.equal(gate.calls.length, 0);
});

test('sd-cli progress is forwarded as local-ai:progress events', async () => {
  const { standin, gate } = fakes(); standin.events = new EventEmitter();
  const seen = []; standin.events.on('send', (channel, data) => seen.push([channel, data]));
  const r = createRunner({ config: config({ modelDirs: [modelDir(FLUX_FILES)] }), standin, gateImpl: gate.impl, sdcli: fakeSdcli(), log: quiet });
  await r.run(job({ params: { model: 'wan2gp:flux-dev', prompt: 'x', device: 'v100' } }), ctx());
  assert.deepEqual(seen, [['local-ai:progress', { step: 1, totalSteps: 4, progress: 0.25, status: 'sampling' }]]);
});
