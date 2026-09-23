'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMcp } = require('../src/mcp');
const { createService } = require('../src/service');
const { JobQueue } = require('../src/queue');
const { startFakeMuapi } = require('./helpers/fake-muapi');

const quiet = { warn() {}, error() {} };
const standin = { invoke: async () => [{ id: 'z-image-turbo', name: 'Z-Image Turbo', state: 'not-downloaded' }] };

function keyFile(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-mcp-')), '.muapi-key');
  if (contents !== null) fs.writeFileSync(file, contents);
  return file;
}

function setup({ muapiUrl = 'http://127.0.0.1:1/mcp', key = 'sk-test\n', run } = {}) {
  const queue = new JobQueue({ run: run || (async () => ({ seed: 9, file: 'j.png', url: '/outputs/j.png', dataUrl: 'data:image/png;base64,AAAA' })) });
  const service = createService({ standin, queue });
  const mcp = createMcp({ config: { muapiKeyFile: keyFile(key), muapiMcpUrl: muapiUrl }, queue, service, log: quiet });
  return { mcp, queue };
}

const call = (mcp, name, args = {}, id = 1) => mcp.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const bodyOf = (res) => JSON.parse(res.result.content[0].text);

test('initialize / ping / initialized handshake', async () => {
  const { mcp } = setup();
  const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'ogai-local');
  assert.deepEqual(await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'ping' }), { jsonrpc: '2.0', id: 2, result: {} });
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'bogus' })).error.code, -32601);
  assert.equal((await mcp.handle({ nonsense: true })).error.code, -32600);
});

test('tools/list without a Muapi key exposes only the local tools', async () => {
  const { mcp } = setup({ key: null });
  const names = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['local_list_models', 'local_generate_image', 'local_generate_video', 'local_job_status', 'local_cancel_job']);
});

test('tools/list adds ONLY allowlisted Muapi tools: key management, top-up and brand-new tools stay blocked', async () => {
  const muapi = await startFakeMuapi();
  try {
    const { mcp } = setup({ muapiUrl: muapi.url });
    const names = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
    for (const ok of ['local_generate_image', 'muapi_image_generate', 'muapi_video_from_image', 'muapi_account_balance', 'search_models', 'muapi_predict_result']) assert.ok(names.includes(ok), ok);
    for (const blocked of ['muapi_keys_list', 'muapi_keys_create', 'muapi_keys_delete', 'muapi_account_topup', 'muapi_brand_new_tool']) assert.equal(names.includes(blocked), false, blocked);
    assert.equal(muapi.requests[0].headers['x-api-key'], 'sk-test');   // key read from file, whitespace trimmed
  } finally { await muapi.close(); }
});

test('allowlisted Muapi tools are forwarded (also over SSE); blocked ones are refused without a network call', async () => {
  for (const sse of [false, true]) {
    const muapi = await startFakeMuapi({ sse });
    try {
      const { mcp } = setup({ muapiUrl: muapi.url });
      const ok = await call(mcp, 'muapi_image_generate', { prompt: 'x' });
      assert.equal(ok.result.content[0].text, 'called:muapi_image_generate');
      const before = muapi.requests.length;
      const blocked = await call(mcp, 'muapi_keys_delete', { id: 1 });
      assert.equal(blocked.error.code, -32602);
      assert.match(blocked.error.message, /blocked/);
      assert.equal(muapi.requests.length, before);
    } finally { await muapi.close(); }
  }
});

test('a Muapi outage becomes an isError tool result, not a crash', async () => {
  const { mcp } = setup({ muapiUrl: 'http://127.0.0.1:1/mcp' });
  const res = await call(mcp, 'muapi_image_generate', { prompt: 'x' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Muapi call failed/);
});

test('local_list_models returns annotated models, filterable by kind', async () => {
  const { mcp } = setup();
  const all = bodyOf(await call(mcp, 'local_list_models'));
  assert.ok(all.models.find((m) => m.id === 'z-image-turbo' && m.star === true));
  assert.ok(all.models.find((m) => m.id === 'wan2gp:wan22-t2v'));
  assert.ok(all.excluded.length >= 2);
  const video = bodyOf(await call(mcp, 'local_list_models', { kind: 'video' }));
  assert.ok(video.models.length > 0 && video.models.every((m) => m.kind === 'video'));
});

test('local_generate_image queues a job; wait_seconds waits for the result; status never contains the data URL', async () => {
  const { mcp } = setup();
  const res = bodyOf(await call(mcp, 'local_generate_image', { model: 'z-image-turbo', prompt: 'a cat', wait_seconds: 5 }));
  assert.equal(res.status, 'done');
  assert.deepEqual(res.result, { seed: 9, file: 'j.png', url: '/outputs/j.png' });
  const again = bodyOf(await call(mcp, 'local_job_status', { job_id: res.id }));
  assert.equal(again.status, 'done');
  assert.equal(JSON.stringify(again).includes('base64'), false);
});

test('local_generate_image without waiting returns the queued job; bad input is an isError result', async () => {
  let release;
  const { mcp } = setup({ run: () => new Promise((r) => { release = r; }) });
  const queued = bodyOf(await call(mcp, 'local_generate_image', { model: 'z-image-turbo', prompt: 'a cat' }));
  assert.ok(['queued', 'running'].includes(queued.status));
  const cancelled = bodyOf(await call(mcp, 'local_cancel_job', { job_id: queued.id }));
  assert.equal(cancelled.cancelled, true);
  if (release) release({});   // only assigned if the job had already started running
  const bad = await call(mcp, 'local_generate_image', { model: 'nope', prompt: 'x' });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /UNKNOWN_MODEL/);
  const missing = await call(mcp, 'local_job_status', { job_id: 'nope' });
  assert.equal(missing.result.isError, true);
});

test('local_generate_video queues a video job chained from an earlier image job; the tools refuse the wrong kind of model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-mcpv-'));
  const cfg = { outputsDir: path.join(dir, 'o'), tmpDir: path.join(dir, 't'), muapiKeyFile: keyFile(null), muapiMcpUrl: 'http://127.0.0.1:1/mcp' };
  fs.mkdirSync(cfg.outputsDir, { recursive: true });
  const queue = new JobQueue({ run: async (job) => job.params.__result || { seed: 1, file: 'z.avi', url: '/outputs/z.avi', kind: 'video' } });
  const service = createService({ standin, queue, config: cfg });
  const mcp = createMcp({ config: cfg, queue, service, log: quiet });

  fs.writeFileSync(path.join(cfg.outputsDir, 'img.png'), 'x');
  const imgJob = queue.submit({ kind: 'image', route: 'sdcpp', params: { __result: { kind: 'image', file: 'img.png', url: '/outputs/img.png' } } });
  await queue.wait(imgJob.id, 1000);

  const ok = bodyOf(await call(mcp, 'local_generate_video', { model: 'wan2gp:wan22-i2v', prompt: 'it moves', image_job_id: imgJob.id, device: 'v100', wait_seconds: 5 }));
  assert.equal(ok.status, 'done');
  assert.equal(ok.result.kind, 'video');

  const wrongImage = await call(mcp, 'local_generate_image', { model: 'wan2gp:wan22-i2v', prompt: 'x', image_job_id: imgJob.id });
  assert.equal(wrongImage.result.isError, true);
  assert.match(wrongImage.result.content[0].text, /WRONG_KIND.*local_generate_video/);
  const wrongVideo = await call(mcp, 'local_generate_video', { model: 'wan2gp:flux-dev', prompt: 'x' });
  assert.equal(wrongVideo.result.isError, true);
  assert.match(wrongVideo.result.content[0].text, /WRONG_KIND.*local_generate_image/);

  const noImage = await call(mcp, 'local_generate_video', { model: 'wan2gp:wan22-i2v', prompt: 'x' });
  assert.equal(noImage.result.isError, true);
  assert.match(noImage.result.content[0].text, /IMAGE_REQUIRED/);
});

// ---------- cinema: chain several of a model's own clips into one longer video (exposed through the MCP tool too) ----------
test('local_list_models exposes each video model\'s chainable/fps/frameChoices (an MCP caller needs these to use cinema correctly)', async () => {
  const { mcp } = setup();
  const video = bodyOf(await call(mcp, 'local_list_models', { kind: 'video' })).models;
  const ltx = video.find((m) => m.id === 'wan2gp:ltx-video');
  assert.equal(ltx.chainable, true);
  assert.equal(ltx.fps, 24);
  assert.deepEqual(ltx.frameChoices, [33, 49, 97, 121]);
  const t2v = video.find((m) => m.id === 'wan2gp:wan22-t2v');
  assert.equal(t2v.chainable, false, 'text-to-video-only models cannot chain');
});

test('local_generate_video accepts cinema + prompts and they reach the queued job\'s params unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-mcpc-'));
  const cfg = { outputsDir: path.join(dir, 'o'), tmpDir: path.join(dir, 't'), muapiKeyFile: keyFile(null), muapiMcpUrl: 'http://127.0.0.1:1/mcp' };
  fs.mkdirSync(cfg.outputsDir, { recursive: true });
  const queue = new JobQueue({ run: () => new Promise(() => {}) });   // never resolves: inspect the queued job before it would run
  const service = createService({ standin, queue, config: cfg });
  const mcp = createMcp({ config: cfg, queue, service, log: quiet });
  const res = bodyOf(await call(mcp, 'local_generate_video', {
    model: 'wan2gp:ltx-video', prompt: 'a fox trots', device: 'v100', cinema: { segments: 3 }, prompts: ['a fox emerges', 'the fox trots', 'the fox stops'],
  }));
  const queued = queue.get(res.id);
  assert.deepEqual(queued.params.cinema, { segments: 3, prompts: ['a fox emerges', 'the fox trots', 'the fox stops'] });
});

test('an invalid cinema request (bad segment count, or a model that cannot chain) is an isError result, not queued', async () => {
  const { mcp } = setup();
  const badCount = await call(mcp, 'local_generate_video', { model: 'wan2gp:ltx-video', prompt: 'x', device: 'v100', cinema: { segments: 1 } });
  assert.equal(badCount.result.isError, true);
  assert.match(badCount.result.content[0].text, /BAD_REQUEST/);
  const cantChain = await call(mcp, 'local_generate_video', { model: 'wan2gp:wan22-t2v', prompt: 'x', device: 'v100', cinema: { segments: 3 } });
  assert.equal(cantChain.result.isError, true);
  assert.match(cantChain.result.content[0].text, /CINEMA_UNSUPPORTED/);
});

test('local_generate_video: wait_seconds is capped at 600s normally, but scales with cinema.segments (each segment is a full render)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-mcpw-'));
  const cfg = { outputsDir: path.join(dir, 'o'), tmpDir: path.join(dir, 't'), muapiKeyFile: keyFile(null), muapiMcpUrl: 'http://127.0.0.1:1/mcp' };
  fs.mkdirSync(cfg.outputsDir, { recursive: true });
  const queue = new JobQueue({ run: async (job) => job.params.__result || { seed: 1, file: 'z.mp4', url: '/outputs/z.mp4', kind: 'video' } });
  const waits = []; const realWait = queue.wait.bind(queue);
  queue.wait = (id, ms) => { waits.push(ms); return realWait(id, ms); };
  const service = createService({ standin, queue, config: cfg });
  const mcp = createMcp({ config: cfg, queue, service, log: quiet });

  await call(mcp, 'local_generate_video', { model: 'wan2gp:ltx-video', prompt: 'x', device: 'v100', wait_seconds: 700 });
  assert.equal(waits[0], 600_000, 'a normal (non-cinema) job is still capped at 600s even if wait_seconds asks for more');

  await call(mcp, 'local_generate_video', { model: 'wan2gp:ltx-video', prompt: 'x', device: 'v100', cinema: { segments: 3 }, wait_seconds: 1700 });
  assert.equal(waits[1], 1700_000, "1700s fits under the scaled cap (600*3=1800s), so the caller's own value is honoured");

  await call(mcp, 'local_generate_video', { model: 'wan2gp:ltx-video', prompt: 'x', device: 'v100', cinema: { segments: 3 }, wait_seconds: 5000 });
  assert.equal(waits[2], 1800_000, 'still capped once past the scaled ceiling (600*3=1800s)');
});
