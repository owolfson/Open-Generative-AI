// waitForJob against a stubbed fetch: it must ride out a service restart, and report a forgotten job as JOB_LOST.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForJob, MAX_POLL_FAILURES } from '../../packages/studio/src/local/localClient.js';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const withFetch = async (impl, fn) => { const real = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = real; } };

test('waitForJob rides out a service that is down for many polls, then returns the finished job', async () => {
  let n = 0;
  const seen = [];
  const done = await withFetch(async () => {
    n += 1;
    if (n <= 60) throw new TypeError('fetch failed');                    // the service is restarting
    return reply(200, { job: { id: 'j1', status: n < 65 ? 'running' : 'done' } });
  }, () => waitForJob('j1', { intervalMs: 1, onUpdate: (j) => seen.push(j.status) }));
  assert.equal(done.status, 'done'); assert.ok(seen.includes('running'));
});

test('waitForJob gives up with LOCAL_UNREACHABLE once the service stays down past the tolerance', async () => {
  let n = 0;
  await assert.rejects(() => withFetch(async () => { n += 1; throw new TypeError('fetch failed'); }, () => waitForJob('j1', { intervalMs: 0 })), { code: 'LOCAL_UNREACHABLE' });
  assert.equal(n, MAX_POLL_FAILURES + 1);
});

test('a 404 (the restarted service forgot the job) is reported as JOB_LOST straight away', async () => {
  let n = 0;
  await assert.rejects(() => withFetch(async () => { n += 1; return reply(404, { error: 'no such job', code: 'JOB_NOT_FOUND' }); }, () => waitForJob('j1', { intervalMs: 1 })), { code: 'JOB_LOST' });
  assert.equal(n, 1);
});
