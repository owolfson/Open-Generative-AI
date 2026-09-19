'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');
const { createService } = require('../src/service');
const { JobQueue } = require('../src/queue');

const DATA_URL = 'data:image/png;base64,AAAA';
const auth = { authorization: 'Bearer tok' };

async function boot({ token = 'tok', run } = {}) {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-srv-'));
  fs.writeFileSync(path.join(outputsDir, 'x.png'), 'PNGDATA');
  const standin = {
    events: new EventEmitter(),
    calls: [],
    channels: () => ['local-ai:list-models', 'local-ai:binary-status', 'local-ai:generate'],
    has: (c) => ['local-ai:list-models', 'local-ai:binary-status', 'local-ai:generate'].includes(c),
    invoke: async (channel, ...args) => {
      standin.calls.push([channel, ...args]);
      if (channel === 'local-ai:list-models') return [{ id: 'z-image-turbo', name: 'Z-Image Turbo', state: 'not-downloaded' }];
      if (channel === 'local-ai:binary-status') return { exists: false };
      return undefined;
    },
  };
  const queue = new JobQueue({ run: run || (async () => ({ seed: 5, file: 'x.png', url: '/outputs/x.png', dataUrl: DATA_URL })) });
  const service = createService({ standin, queue });
  const mcp = { handle: async (msg) => (msg.method === 'notifications/initialized' ? null : { jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method } }) };
  const server = createServer({ config: { token, gpuEnabled: true, outputsDir }, standin, queue, service, mcp });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, standin, queue, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const jsonPost = (url, body, headers = auth) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('/health is open; everything else needs the bearer token', async () => {
  const app = await boot();
  try {
    const health = await (await fetch(`${app.base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.channels, 3);
    assert.equal((await fetch(`${app.base}/api/local/catalog`)).status, 401);
    assert.equal((await fetch(`${app.base}/api/local/catalog`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${app.base}/api/local/catalog`, { headers: auth })).status, 200);
  } finally { await app.close(); }
});

test('with no token configured every protected route is 503 (safe by default)', async () => {
  const app = await boot({ token: '' });
  try {
    assert.equal((await fetch(`${app.base}/api/local/catalog`, { headers: auth })).status, 503);
    assert.equal((await fetch(`${app.base}/health`)).status, 200);
  } finally { await app.close(); }
});

test('catalog merges annotated sd.cpp models with the other engines and exclusions', async () => {
  const app = await boot();
  try {
    const { models, excluded } = await (await fetch(`${app.base}/api/local/catalog`, { headers: auth })).json();
    assert.equal(models.find((m) => m.id === 'z-image-turbo').star, true);
    assert.ok(models.find((m) => m.id === 'wan2gp:wan22-t2v'));
    assert.ok(excluded.length >= 2);
  } finally { await app.close(); }
});

test('/ipc passes non-GPU channels straight through and rejects unknown ones', async () => {
  const app = await boot();
  try {
    const ok = await (await jsonPost(`${app.base}/ipc/local-ai:binary-status`, { args: [] })).json();
    assert.deepEqual(ok, { ok: true, result: { exists: false } });
    const missing = await jsonPost(`${app.base}/ipc/nope:nothing`, { args: [] });
    assert.equal(missing.status, 404);
  } finally { await app.close(); }
});

test('/ipc generate goes through the queue and returns upstream-shaped {url, seed}', async () => {
  const app = await boot();
  try {
    const out = await (await jsonPost(`${app.base}/ipc/local-ai:generate`, { args: [{ model: 'z-image-turbo', prompt: 'a cat' }] })).json();
    assert.deepEqual(out, { ok: true, result: { url: DATA_URL, seed: 5 } });
    assert.equal(app.standin.calls.some((c) => c[0] === 'local-ai:generate'), false);   // the fake runner, not the engine, did the work
  } finally { await app.close(); }
});

test('/ipc generate surfaces runner failures with their code', async () => {
  const app = await boot({ run: async () => { throw Object.assign(new Error('GPU jobs are disabled'), { code: 'GPU_DISABLED' }); } });
  try {
    const res = await jsonPost(`${app.base}/ipc/local-ai:generate`, { args: [{ model: 'z-image-turbo', prompt: 'x' }] });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, error: 'GPU jobs are disabled', code: 'GPU_DISABLED' });
  } finally { await app.close(); }
});

test('job API: submit, poll (no data URL in status), list, unknown model -> 400', async () => {
  const app = await boot();
  try {
    const submitted = await jsonPost(`${app.base}/api/local/jobs`, { model: 'z-image-turbo', prompt: 'a cat' });
    assert.equal(submitted.status, 202);
    const { job } = await submitted.json();
    await app.queue.wait(job.id, 2000);
    const status = await (await fetch(`${app.base}/api/local/jobs/${job.id}`, { headers: auth })).json();
    assert.equal(status.job.status, 'done');
    assert.deepEqual(status.job.result, { seed: 5, file: 'x.png', url: '/outputs/x.png' });
    assert.equal(JSON.stringify(status).includes(DATA_URL), false);
    const listed = await (await fetch(`${app.base}/api/local/jobs`, { headers: auth })).json();
    assert.equal(listed.jobs.length, 1);
    const bad = await jsonPost(`${app.base}/api/local/jobs`, { model: 'nope', prompt: 'x' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'UNKNOWN_MODEL');
    assert.equal((await fetch(`${app.base}/api/local/jobs/00000000-0000-0000-0000-000000000000`, { headers: auth })).status, 404);
  } finally { await app.close(); }
});

test('cancel endpoint cancels a queued job', async () => {
  let release;
  const app = await boot({ run: () => new Promise((r) => { release = r; }) });
  try {
    await jsonPost(`${app.base}/api/local/jobs`, { model: 'z-image-turbo', prompt: 'first' });
    const second = await (await jsonPost(`${app.base}/api/local/jobs`, { model: 'z-image-turbo', prompt: 'second' })).json();
    const res = await (await jsonPost(`${app.base}/api/local/jobs/${second.job.id}/cancel`, {})).json();
    assert.deepEqual(res, { cancelled: true });
    assert.equal(app.queue.get(second.job.id).status, 'cancelled');
    release({});
  } finally { await app.close(); }
});

test('/outputs serves PNGs, needs auth, and refuses traversal', async () => {
  const app = await boot();
  try {
    assert.equal((await fetch(`${app.base}/outputs/x.png`)).status, 401);
    const ok = await fetch(`${app.base}/outputs/x.png`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(await ok.text(), 'PNGDATA');
    assert.equal((await fetch(`${app.base}/outputs/..%2F..%2Fetc%2Fpasswd`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${app.base}/outputs/missing.png`, { headers: auth })).status, 404);
  } finally { await app.close(); }
});

test('/events streams stand-in send events as SSE', async () => {
  const app = await boot();
  try {
    const chunk = await new Promise((resolve, reject) => {
      const req = http.get(`${app.base}/events`, { headers: auth }, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        let buf = '';
        res.on('data', (d) => { buf += d; if (buf.includes('local-ai:progress')) { req.destroy(); resolve(buf); } });
        setTimeout(() => app.standin.events.emit('send', 'local-ai:progress', { step: 3, totalSteps: 8 }), 50);
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
      setTimeout(() => reject(new Error('no SSE event received')), 3000);
    });
    assert.match(chunk, /event: local-ai:progress\ndata: \{"step":3,"totalSteps":8\}/);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(app.standin.events.listenerCount('send'), 0);   // listener removed when the client went away
  } finally { await app.close(); }
});

test('/mcp forwards JSON-RPC to the mcp handler; notifications get 202', async () => {
  const app = await boot();
  try {
    const out = await (await jsonPost(`${app.base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'ping' })).json();
    assert.deepEqual(out, { jsonrpc: '2.0', id: 1, result: { echoed: 'ping' } });
    assert.equal((await jsonPost(`${app.base}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await fetch(`${app.base}/mcp`, { headers: auth })).status, 405);
  } finally { await app.close(); }
});
