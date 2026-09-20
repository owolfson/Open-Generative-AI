'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JobQueue } = require('../src/queue');

const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('runs a job and records the result', async () => {
  const q = new JobQueue({ run: async (job) => ({ echoed: job.params.x }) });
  const job = q.submit({ kind: 'image', route: 'sdcpp', params: { x: 1 } });
  assert.equal(job.status, 'queued');
  const done = await q.wait(job.id, 1000);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { echoed: 1 });
  assert.ok(done.startedAt && done.finishedAt);
});

test('is single-flight and FIFO', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const order = [];
  let running = 0; let maxRunning = 0;
  const q = new JobQueue({ run: async (job) => {
    running += 1; maxRunning = Math.max(maxRunning, running); order.push(job.params.n);
    await gates[job.params.n].promise;
    running -= 1;
    return job.params.n;
  } });
  const ids = [0, 1, 2].map((n) => q.submit({ kind: 'image', route: 'sdcpp', params: { n } }).id);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [0]);
  gates[0].resolve(); await q.wait(ids[0], 1000);
  gates[1].resolve(); await q.wait(ids[1], 1000);
  gates[2].resolve(); await q.wait(ids[2], 1000);
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(maxRunning, 1);
});

test('a failing job records code+message and the next job still runs', async () => {
  const q = new JobQueue({ run: async (job) => { if (job.params.fail) throw Object.assign(new Error('boom'), { code: 'GPU_DISABLED' }); return 'ok'; } });
  const a = q.submit({ kind: 'image', route: 'sdcpp', params: { fail: true } });
  const b = q.submit({ kind: 'image', route: 'sdcpp', params: {} });
  const doneA = await q.wait(a.id, 1000);
  assert.equal(doneA.status, 'error');
  assert.deepEqual(doneA.error, { code: 'GPU_DISABLED', message: 'boom' });
  assert.equal((await q.wait(b.id, 1000)).status, 'done');
});

test('cancelling a queued job removes it without running it', async () => {
  const gate = deferred();
  const ran = [];
  const q = new JobQueue({ run: async (job) => { ran.push(job.params.n); await gate.promise; } });
  const first = q.submit({ kind: 'image', route: 'sdcpp', params: { n: 1 } });
  const second = q.submit({ kind: 'image', route: 'sdcpp', params: { n: 2 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(q.cancel(second.id), true);
  assert.equal(q.get(second.id).status, 'cancelled');
  gate.resolve(); await q.wait(first.id, 1000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, [1]);
});

test('cancelling a running job aborts its signal and marks it cancelled', async () => {
  const q = new JobQueue({ run: (job, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const job = q.submit({ kind: 'image', route: 'sdcpp', params: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(q.get(job.id).status, 'running');
  assert.equal(q.cancel(job.id), true);
  assert.equal((await q.wait(job.id, 1000)).status, 'cancelled');
});

test('cancel returns false for unknown or finished jobs', async () => {
  const q = new JobQueue({ run: async () => 1 });
  const job = q.submit({ kind: 'image', route: 'sdcpp', params: {} });
  await q.wait(job.id, 1000);
  assert.equal(q.cancel(job.id), false);
  assert.equal(q.cancel('nope'), false);
});

test('wait times out and returns the current (non-terminal) job', async () => {
  const gate = deferred();
  const q = new JobQueue({ run: () => gate.promise });
  const job = q.submit({ kind: 'image', route: 'sdcpp', params: {} });
  const seen = await q.wait(job.id, 20);
  assert.ok(['queued', 'running'].includes(seen.status));
  gate.resolve();
});

test('list is newest first and old finished jobs are trimmed past maxJobs', async () => {
  const q = new JobQueue({ run: async () => 1, maxJobs: 3 });
  const ids = [];
  for (let i = 0; i < 5; i += 1) { const j = q.submit({ kind: 'image', route: 'sdcpp', params: { i } }); ids.push(j.id); await q.wait(j.id, 1000); }
  const listed = q.list();
  assert.equal(listed.length, 3);
  assert.equal(listed[0].id, ids[4]);
  assert.equal(q.get(ids[0]), null);
});

test('run receives pending(): the jobs queued behind the running one, in order (used to keep one GPU lease across a batch)', async () => {
  const seen = [];
  const gate = (() => { let r; const promise = new Promise((res) => { r = res; }); return { promise, resolve: r }; })();
  const q = new JobQueue({ run: async (job, { pending }) => { seen.push([job.params.n, pending().map((j) => j.params.n)]); if (job.params.n === 1) await gate.promise; return job.params.n; } });
  const a = q.submit({ kind: 'image', route: 'sdcpp', params: { n: 1 } });
  q.submit({ kind: 'image', route: 'sdcpp', params: { n: 2 } });
  const c = q.submit({ kind: 'image', route: 'sdcpp', params: { n: 3 } });
  await new Promise((r) => setImmediate(r));
  gate.resolve(); await q.wait(a.id, 1000); await q.wait(c.id, 1000);
  assert.deepEqual(seen, [[1, [2, 3]], [2, [3]], [3, []]]);
});
