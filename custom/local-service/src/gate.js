'use strict';

function codeError(code, message) { return Object.assign(new Error(message), { code }); }

async function post(url, body, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null; let bodyParsed = true;
  try { data = await res.json(); } catch { bodyParsed = false; /* non-JSON error body, or a 2xx whose body didn't parse */ }
  return { ok: res.ok, status: res.status, data, bodyParsed };
}

const MAX_EST_SECONDS = 14400;   // the arbiter rejects est_seconds above this
const boot = { leaseRequested: false };   // set once THIS process asks for any lease (see releaseStaleLeaseWithRetry)

/**
 * Take a gpu-arbiter lease on the V100 (a whole-card lease evicts the Hermes brain + TTS). /acquire blocks until granted.
 * The handle's release() is idempotent; /release silently no-ops on a mismatched id, so its note is checked and logged.
 */
async function acquireLease(cfg, { consumer, vramGb, estSeconds, note }, { fetchImpl = fetch, log = console, acquireTimeoutMs = 30 * 60 * 1000 } = {}) {
  if (!cfg.arbiterUrl) throw codeError('ARBITER_UNCONFIGURED', 'refusing to run a V100 job without the GPU arbiter (set OGAI_ARBITER_URL)');

  boot.leaseRequested = true;
  const acquired = await post(`${cfg.arbiterUrl}/acquire`, { consumer, vram_gb: vramGb, est_seconds: Math.min(estSeconds, MAX_EST_SECONDS), wait: true, note }, fetchImpl, acquireTimeoutMs);
  if (!acquired.ok || acquired.data?.ok === false || !acquired.data?.lease_id) {
    const detail = acquired.data?.detail || acquired.data?.note || `HTTP ${acquired.status}`;
    throw codeError('ARBITER_REFUSED', `GPU arbiter did not grant a lease: ${detail}`);
  }
  const leaseId = acquired.data.lease_id;

  let released = false;
  async function release() {
    if (released) return;
    released = true;
    try {
      const res = await post(`${cfg.arbiterUrl}/release`, { lease_id: leaseId, consumer }, fetchImpl, 30_000);
      const releaseNote = res.data?.note || '';
      if (!res.ok) log.error(`gate: release failed (HTTP ${res.status}) for lease ${leaseId}`);
      else if (/not the active holder|no active lease/.test(releaseNote)) log.warn(`gate: lease ${leaseId} was already gone at release (${releaseNote}) - it may have expired mid-job`);
    } catch (err) {
      log.error(`gate: release threw for lease ${leaseId}: ${err.message}`);
    }
  }
  return { leaseId, release };
}

/** Run fn while holding a lease (acquired and released around it). */
async function withLease(cfg, opts, fn, deps) {
  const lease = await acquireLease(cfg, opts, deps);
  try { return await fn({ leaseId: lease.leaseId }); } finally { await lease.release(); }
}

/**
 * Boot-time backstop: a previous process of this service may have died holding the V100 lease (which keeps the Hermes brain
 * evicted until the arbiter's own expiry). Release by consumer name; the arbiter only honours it when we ARE the holder.
 * Best effort: never throws.
 */
async function releaseStaleLease(cfg, { fetchImpl = fetch, log = console } = {}) {
  if (!cfg.arbiterUrl) return { released: false, reason: 'no arbiter configured' };
  try {
    const res = await post(`${cfg.arbiterUrl}/release`, { consumer: cfg.sdcppConsumer }, fetchImpl, 10_000);
    if (!res.ok) { log.warn(`gate: stale-lease release got HTTP ${res.status}`); return { released: false, reason: `HTTP ${res.status}` }; }
    if (!res.bodyParsed) {
      // A 2xx whose body didn't parse is ambiguous, not a "no": the arbiter answers this while mid-restore (stopping/starting
      // hermes-llm and speaches), which is exactly when a race on the response body is most likely. Found live (2026-09-21): the
      // arbiter's own log showed a real "released lease ..." for the right consumer/duration right when this should have logged a
      // success here, and it never did - only two earlier timeout failures. Treating it as unanswered (retry, don't give up) is the
      // safe reading; the old code silently read it as "not the holder" and both dropped the retry AND never logged the release.
      log.warn('gate: stale-lease release got an OK response with an unparseable body - retrying rather than assuming it failed');
      return { released: false, reason: 'OK response, unparseable body' };
    }
    const note = res.data?.note || '';
    const released = /^released after/.test(note);
    if (released) log.warn(`gate: released a stale ${cfg.sdcppConsumer} lease left by a previous process (${note})`);
    return { released, reason: note, answered: true };
  } catch (err) {
    log.warn(`gate: stale-lease release failed: ${err.message}`);
    return { released: false, reason: err.message };
  }
}

/**
 * releaseStaleLease with retries, for the boot path. A single attempt that hits an arbiter that is busy (it answers nothing while it stops
 * or starts containers) would leave the dead process's lease held until the arbiter's own expiry (2x the window, hours) with the brain
 * evicted. Retries stop at the first real arbiter reply, and as soon as THIS process has asked for a lease of its own: a later release by
 * consumer name would otherwise cancel that live lease.
 */
async function releaseStaleLeaseWithRetry(cfg, { delaysMs = [5_000, 10_000, 20_000, 30_000, 60_000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...deps } = {}) {
  let out = await releaseStaleLease(cfg, deps);
  for (const delay of delaysMs) {
    if (out.answered || !cfg.arbiterUrl || out.reason === 'no arbiter configured') return out;
    await sleep(delay);
    if (boot.leaseRequested) return { released: false, reason: 'gave up retrying: this process already requested a lease' };
    out = await releaseStaleLease(cfg, deps);
  }
  return out;
}

module.exports = { acquireLease, withLease, releaseStaleLease, releaseStaleLeaseWithRetry, codeError, MAX_EST_SECONDS, _boot: boot };
