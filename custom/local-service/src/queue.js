'use strict';
const EventEmitter = require('node:events');
const { randomUUID } = require('node:crypto');

const TERMINAL = new Set(['done', 'error', 'cancelled']);

/** Single-flight FIFO job queue: at most one job runs at a time (one GPU job at a time, never stacked). */
class JobQueue extends EventEmitter {
  constructor({ run, maxJobs = 200, now = Date.now } = {}) {
    super();
    this.run = run;
    this.maxJobs = maxJobs;
    this.now = now;
    this.jobs = new Map();     // id -> job, insertion order = submission order
    this.pending = [];         // ids waiting to run
    this.current = null;       // { id, controller }
  }

  submit({ kind, route, params }) {
    const job = { id: randomUUID(), kind, route, params, status: 'queued', createdAt: this.now(), startedAt: null, finishedAt: null, result: null, error: null };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.#trim();
    this.emit('update', job);
    setImmediate(() => this.#pump());
    return job;
  }

  get(id) { return this.jobs.get(id) || null; }

  list(limit = 50) { return [...this.jobs.values()].slice(-limit).reverse(); }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return false;
    if (job.status === 'queued') {
      this.pending = this.pending.filter((x) => x !== id);
      this.#finish(job, 'cancelled');
      return true;
    }
    this.current.controller.abort();   // the runner observes the signal; #pump records the outcome
    return true;
  }

  wait(id, timeoutMs = 0) {
    const job = this.get(id);
    if (!job || TERMINAL.has(job.status) || timeoutMs <= 0) return Promise.resolve(job);
    return new Promise((resolve) => {
      const finish = (j) => { clearTimeout(timer); this.off('update', onUpdate); resolve(j); };
      const onUpdate = (j) => { if (j.id === id && TERMINAL.has(j.status)) finish(j); };
      const timer = setTimeout(() => finish(this.get(id)), timeoutMs);
      this.on('update', onUpdate);
    });
  }

  async #pump() {
    if (this.current || this.pending.length === 0) return;
    const job = this.jobs.get(this.pending.shift());
    const controller = new AbortController();
    this.current = { id: job.id, controller };
    job.status = 'running';
    job.startedAt = this.now();
    this.emit('update', job);
    try {
      job.result = await this.run(job, { signal: controller.signal });
      this.#finish(job, 'done');
    } catch (err) {
      job.error = { code: err.code || 'ERROR', message: err.message };
      this.#finish(job, controller.signal.aborted ? 'cancelled' : 'error');
    } finally {
      this.current = null;
      setImmediate(() => this.#pump());
    }
  }

  #finish(job, status) {
    job.status = status;
    job.finishedAt = this.now();
    this.emit('update', job);
  }

  #trim() {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.maxJobs) break;
      if (TERMINAL.has(job.status)) this.jobs.delete(id);
    }
  }
}

module.exports = { JobQueue };
