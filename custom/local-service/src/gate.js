'use strict';

function codeError(code, message) { return Object.assign(new Error(message), { code }); }

async function post(url, body, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Run fn while holding a gpu-arbiter lease on the V100 (a whole-card lease evicts the Hermes brain).
 * /acquire blocks until granted. /release silently no-ops on a mismatched id, so its note is checked.
 */
async function withLease(cfg, { consumer, vramGb, estSeconds, note }, fn, { fetchImpl = fetch, log = console, acquireTimeoutMs = 30 * 60 * 1000 } = {}) {
  if (!cfg.arbiterUrl) throw codeError('ARBITER_UNCONFIGURED', 'refusing to run a V100 job without the GPU arbiter (set OGAI_ARBITER_URL)');

  const acquired = await post(`${cfg.arbiterUrl}/acquire`, { consumer, vram_gb: vramGb, est_seconds: estSeconds, wait: true, note }, fetchImpl, acquireTimeoutMs);
  if (!acquired.ok || acquired.data?.ok === false || !acquired.data?.lease_id) {
    const detail = acquired.data?.detail || acquired.data?.note || `HTTP ${acquired.status}`;
    throw codeError('ARBITER_REFUSED', `GPU arbiter did not grant a lease: ${detail}`);
  }
  const leaseId = acquired.data.lease_id;

  try {
    return await fn({ leaseId });
  } finally {
    try {
      const released = await post(`${cfg.arbiterUrl}/release`, { lease_id: leaseId, consumer }, fetchImpl, 30_000);
      const releaseNote = released.data?.note || '';
      if (!released.ok) log.error(`gate: release failed (HTTP ${released.status}) for lease ${leaseId}`);
      else if (/not the active holder|no active lease/.test(releaseNote)) log.warn(`gate: lease ${leaseId} was already gone at release (${releaseNote}) - it may have expired mid-job`);
    } catch (err) {
      log.error(`gate: release threw for lease ${leaseId}: ${err.message}`);
    }
  }
}

module.exports = { withLease, codeError };
