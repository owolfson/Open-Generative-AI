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
