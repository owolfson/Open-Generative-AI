'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withLease, acquireLease, releaseStaleLease, releaseStaleLeaseWithRetry, _boot } = require('../src/gate');
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

test('acquireLease returns a handle whose release is idempotent (exactly one POST /release)', async () => {
  const arb = await startFakeArbiter();
  try {
    const lease = await acquireLease({ arbiterUrl: arb.url }, opts, { log: quiet().log });
    assert.equal(lease.leaseId, 'lease-1');
    await lease.release(); await lease.release();
    assert.equal(arb.calls.filter((c) => c.path === '/release').length, 1);
    assert.deepEqual(arb.calls.find((c) => c.path === '/release').body, { lease_id: 'lease-1', consumer: 'ogai-local' });
  } finally { await arb.close(); }
});

test('acquireLease refuses without an arbiter and surfaces a 409 as ARBITER_REFUSED', async () => {
  await assert.rejects(() => acquireLease({ arbiterUrl: '' }, opts), { code: 'ARBITER_UNCONFIGURED' });
  const arb = await startFakeArbiter({ grant: false });
  try { await assert.rejects(() => acquireLease({ arbiterUrl: arb.url }, opts, { log: quiet().log }), { code: 'ARBITER_REFUSED' }); } finally { await arb.close(); }
});

test('releaseStaleLease releases by consumer name at boot and never throws', async () => {
  const arb = await startFakeArbiter({ releaseNote: 'released after 400.0s' });
  try {
    const out = await releaseStaleLease({ arbiterUrl: arb.url, sdcppConsumer: 'ogai-local' }, { log: quiet().log });
    assert.deepEqual(arb.calls.map((c) => [c.path, c.body]), [['/release', { consumer: 'ogai-local' }]]);
    assert.equal(out.released, true);
  } finally { await arb.close(); }
  const idle = await startFakeArbiter({ releaseNote: 'not the active holder (active=hermes)' });
  try { assert.equal((await releaseStaleLease({ arbiterUrl: idle.url, sdcppConsumer: 'ogai-local' }, { log: quiet().log })).released, false); } finally { await idle.close(); }
  assert.deepEqual(await releaseStaleLease({ arbiterUrl: '', sdcppConsumer: 'ogai-local' }, { log: quiet().log }), { released: false, reason: 'no arbiter configured' });
  const down = await releaseStaleLease({ arbiterUrl: 'http://127.0.0.1:1', sdcppConsumer: 'ogai-local' }, { log: quiet().log });
  assert.equal(down.released, false);
});

test('boot-time release retries while the arbiter is busy, and stops at the first real reply', async () => {
  _boot.leaseRequested = false;
  const cfg = { arbiterUrl: 'http://arbiter.test', sdcppConsumer: 'ogai-local' };
  const sleeps = []; let n = 0;
  const flaky = async () => { if (++n < 3) throw new Error('timed out'); return { ok: true, status: 200, json: async () => ({ ok: true, note: 'released after 900.0s' }) }; };
  const out = await releaseStaleLeaseWithRetry(cfg, { fetchImpl: flaky, log: quiet().log, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(n, 3); assert.equal(out.released, true); assert.deepEqual(sleeps, [5000, 10000]);
  // "not the active holder" is a real answer: nothing stale, so no more attempts
  n = 0; const nothing = async () => { n++; return { ok: true, status: 200, json: async () => ({ ok: true, note: 'not the active holder (active=none)' }) }; };
  assert.equal((await releaseStaleLeaseWithRetry(cfg, { fetchImpl: nothing, log: quiet().log, sleep: async () => {} })).released, false); assert.equal(n, 1);
});

test('boot-time release gives up after the last delay, and never retries once this process has asked for its own lease', async () => {
  const cfg = { arbiterUrl: 'http://arbiter.test', sdcppConsumer: 'ogai-local' };
  _boot.leaseRequested = false; let n = 0;
  const dead = async () => { n++; throw new Error('timed out'); };
  const out = await releaseStaleLeaseWithRetry(cfg, { fetchImpl: dead, log: quiet().log, sleep: async () => {}, delaysMs: [1, 1, 1] });
  assert.equal(n, 4); assert.equal(out.released, false);
  // a lease requested by this process between attempts must NOT be released by a later retry (it would kill the live lease)
  n = 0; _boot.leaseRequested = false;
  const out2 = await releaseStaleLeaseWithRetry(cfg, { fetchImpl: dead, log: quiet().log, delaysMs: [1, 1, 1], sleep: async () => { _boot.leaseRequested = true; } });
  assert.equal(n, 1); assert.match(out2.reason, /already requested a lease/);
  _boot.leaseRequested = false;
  assert.deepEqual(await releaseStaleLeaseWithRetry({ arbiterUrl: '', sdcppConsumer: 'ogai-local' }, { log: quiet().log }), { released: false, reason: 'no arbiter configured' });
});
