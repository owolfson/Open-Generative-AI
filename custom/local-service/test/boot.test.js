'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function waitFor(url, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`server did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('boots for real: health, auth, 12-model catalog, MCP handshake, GPU jobs refused by default', async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-boot-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { PATH: process.env.PATH, OGAI_UPSTREAM_DIR: REPO, OGAI_DATA_DIR: dataDir, OGAI_TOKEN: 'tok', OGAI_LOCAL_PORT: String(port) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: 'Bearer tok', 'content-type': 'application/json' };
  try {
    const health = await (await waitFor(`${base}/health`)).json();
    assert.equal(health.gpuEnabled, false);
    assert.equal(health.channels, 15);
    assert.equal((await fetch(`${base}/api/local/catalog`)).status, 401);

    const { models, excluded } = await (await fetch(`${base}/api/local/catalog`, { headers: auth })).json();
    assert.equal(models.length, 12);
    assert.equal(models.filter((m) => m.star).length, 6);
    assert.ok(excluded.length >= 2);

    const init = await (await fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })).json();
    assert.equal(init.result.serverInfo.name, 'ogai-local');

    const gen = await fetch(`${base}/ipc/local-ai:generate`, { method: 'POST', headers: auth, body: JSON.stringify({ args: [{ model: 'z-image-turbo', prompt: 'cat' }] }) });
    assert.equal(gen.status, 502);
    assert.equal((await gen.json()).code, 'GPU_DISABLED');
  } finally { child.kill('SIGTERM'); }
});
