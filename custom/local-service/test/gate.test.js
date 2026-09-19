'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withLease } = require('../src/gate');
const { startFakeArbiter } = require('./helpers/fake-arbiter');

const quiet = () => { const logs = { warn: [], error: [] }; return { logs, log: { warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) } }; };
const opts = { consumer: 'ogai-local', vramGb: 10, estSeconds: 900, note: 'job x' };

test('refuses to run without an arbiter url', async () => {
  let ran = false;
  await assert.rejects(() => withLease({ arbiterUrl: '' }, opts, async () => { ran = true; }), { code: 'ARBITER_UNCONFIGURED' });
  assert.equal(ran, false);
});

test('acquires with the real field names, runs fn with the lease id, then releases by lease_id', async () => {
  const arb = await startFakeArbiter();
  try {
    const { log } = quiet();
    const out = await withLease({ arbiterUrl: arb.url }, opts, async ({ leaseId }) => `ran:${leaseId}`, { log });
    assert.equal(out, 'ran:lease-1');
    assert.equal(arb.calls[0].path, '/acquire');
    assert.deepEqual(arb.calls[0].body, { consumer: 'ogai-local', vram_gb: 10, est_seconds: 900, wait: true, note: 'job x' });
    assert.equal(arb.calls[1].path, '/release');
    assert.deepEqual(arb.calls[1].body, { lease_id: 'lease-1', consumer: 'ogai-local' });
  } finally { await arb.close(); }
});

test('releases even when fn throws, and the original error propagates', async () => {
  const arb = await startFakeArbiter();
  try {
    await assert.rejects(() => withLease({ arbiterUrl: arb.url }, opts, async () => { throw new Error('render failed'); }, { log: quiet().log }), /render failed/);
    assert.equal(arb.calls.filter((c) => c.path === '/release').length, 1);
  } finally { await arb.close(); }
});

test('a refused acquire never runs fn and surfaces the arbiter detail', async () => {
  const arb = await startFakeArbiter({ grant: false });
  try {
    let ran = false;
    await assert.rejects(() => withLease({ arbiterUrl: arb.url }, opts, async () => { ran = true; }, { log: quiet().log }), (err) => err.code === 'ARBITER_REFUSED' && /V100 not clear/.test(err.message));
    assert.equal(ran, false);
    assert.equal(arb.calls.filter((c) => c.path === '/release').length, 0);
  } finally { await arb.close(); }
});

test('a release that silently no-ops (lease already gone) is warned about, not thrown', async () => {
  const arb = await startFakeArbiter({ releaseNote: 'not the active holder (active=hermes)' });
  try {
    const { log, logs } = quiet();
    assert.equal(await withLease({ arbiterUrl: arb.url }, opts, async () => 'done', { log }), 'done');
    assert.equal(logs.warn.length, 1);
    assert.match(logs.warn[0], /already gone/);
  } finally { await arb.close(); }
});

test('an unreachable arbiter on release is logged and does not mask the result', async () => {
  const arb = await startFakeArbiter();
  const { log, logs } = quiet();
  const realFetch = fetch;
  let calls = 0;
  const flaky = (url, init) => { calls += 1; return calls === 1 ? realFetch(url, init) : Promise.reject(new Error('ECONNREFUSED')); };
  try {
    assert.equal(await withLease({ arbiterUrl: arb.url }, opts, async () => 'result', { fetchImpl: flaky, log }), 'result');
    assert.equal(logs.error.length, 1);
  } finally { await arb.close(); }
});
