'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdCli } = require('../src/sdcpp');
const { parseGenerationProgressChunk } = require('../../../electron/lib/localInferenceRuntime');   // upstream's pure progress parser

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-sdcli-'));

// A fake sd-cli: mode comes from FAKE_MODE. It writes a file at the -o path recording the env it was started with.
function fakeSdCli(dir) {
  const file = path.join(dir, 'sd-cli');
  fs.writeFileSync(file, `#!/bin/sh
out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done
case "$FAKE_MODE" in
  fail) echo "loading model" >&2; echo "boom: out of memory" >&2; exit 3 ;;
  hang) echo "started" >&2; exec sleep 30 ;;
esac
echo "loading model" >&2
printf '  |=====>    | 1/4 - 1.00s/it\\r' >&2
printf '  |==========>| 2/4 - 1.00s/it\\r' >&2
printf '  |==========>| 3/4 - 1.00s/it\\r' >&2
printf '  |==========>| 4/4 - 1.00s/it\\n' >&2
echo "CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES CUDA_DEVICE_ORDER=$CUDA_DEVICE_ORDER LD=$LD_LIBRARY_PATH" > "$out"
`, { mode: 0o755 });
  return file;
}

const base = (dir, over = {}) => ({ binary: fakeSdCli(dir), libDir: '/opt/libs', args: ['-o', path.join(dir, 'out.txt')], parseChunk: parseGenerationProgressChunk, ...over });

test('runs sd-cli, forwards ordered progress events, and passes the GPU env + library path explicitly', async () => {
  const dir = tmp(); const events = [];
  const res = await runSdCli(base(dir, { env: { FAKE_MODE: 'ok', CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: '1' }, onProgress: (e) => events.push(e) }));
  assert.match(res.output, /loading model/);
  assert.deepEqual(events.map((e) => [e.step, e.totalSteps]), [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.ok(events.every((e) => e.status === 'sampling' && e.progress > 0));
  assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').trim(), 'CUDA_VISIBLE_DEVICES=1 CUDA_DEVICE_ORDER=PCI_BUS_ID LD=/opt/libs');
});

test('a non-zero exit rejects with SDCLI_FAILED and the tail of the output', async () => {
  const dir = tmp();
  await assert.rejects(() => runSdCli(base(dir, { env: { FAKE_MODE: 'fail' } })), (err) => err.code === 'SDCLI_FAILED' && /boom: out of memory/.test(err.message) && /exited \(3\)/.test(err.message));
});

test('aborting the signal kills the process and rejects with CANCELLED', async () => {
  const dir = tmp(); const controller = new AbortController();
  const started = Date.now();
  const pending = runSdCli(base(dir, { env: { FAKE_MODE: 'hang' }, signal: controller.signal, killGraceMs: 500 }));
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(() => pending, { code: 'CANCELLED' });
  assert.ok(Date.now() - started < 5000, 'the hanging process must be killed, not waited for');
});

test('an already-aborted signal never spawns anything', async () => {
  const controller = new AbortController(); controller.abort();
  let spawned = 0;
  await assert.rejects(() => runSdCli({ binary: 'x', libDir: '/l', args: [], signal: controller.signal, spawnImpl: () => { spawned += 1; } }), { code: 'CANCELLED' });
  assert.equal(spawned, 0);
});

test('a missing binary rejects with SDCLI_SPAWN', async () => {
  await assert.rejects(() => runSdCli({ binary: '/nonexistent/sd-cli', libDir: '/l', args: [] }), { code: 'SDCLI_SPAWN' });
});
