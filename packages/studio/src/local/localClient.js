// Browser client for the local inference proxy (/api/local/*, see app/api/local). No token here: the server adds it.
const BASE = '/api/local';
const TERMINAL = new Set(['done', 'error', 'cancelled']);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })); }, { once: true });
});

async function request(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, { method, signal, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    if (err && err.name === 'AbortError') throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    throw Object.assign(new Error('Could not reach the app server.'), { code: 'LOCAL_UNREACHABLE' });
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { code: data && data.code, status: res.status });
  return data;
}

export const getHealth = () => request('/health');
export const getCatalog = () => request('/catalog');
export const listJobs = () => request('/jobs').then((d) => d.jobs);
export const submitJob = (params) => request('/jobs', { method: 'POST', body: params }).then((d) => d.job);
export const getJob = (id, signal) => request(`/jobs/${id}`, { signal }).then((d) => d.job);
export const cancelJob = (id) => request(`/jobs/${id}/cancel`, { method: 'POST', body: {} });
/** Model management channels only (download / delete); generation always goes through submitJob. */
export const invokeIpc = (channel, ...args) => request(`/ipc/${channel}`, { method: 'POST', body: { args } }).then((d) => d.result);

/** Failed polls in a row that waitForJob rides out (~75s at the default interval): a `docker restart` of the local service takes ~45s. */
export const MAX_POLL_FAILURES = 90;

/**
 * Poll a job until it finishes. Rides out the service restarting or a flaky network. Jobs live in the service's memory, so a 404 means the
 * service restarted and forgot this job: that is reported as JOB_LOST, not as a generic failure.
 */
export async function waitForJob(id, { onUpdate, signal, intervalMs = 800 } = {}) {
  let failures = 0;
  for (;;) {
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    let job = null;
    try {
      job = await getJob(id, signal);
      failures = 0;
    } catch (err) {
      if (err.status === 404) throw Object.assign(new Error('The job is gone from the service.'), { code: 'JOB_LOST', status: 404 });
      if (err.code === 'ABORTED' || (failures += 1) > MAX_POLL_FAILURES) throw err;
    }
    if (job) {
      if (onUpdate) onUpdate(job);
      if (TERMINAL.has(job.status)) return job;
    }
    await sleep(intervalMs, signal);
  }
}

/** Server-sent events (model download progress). Returns an unsubscribe function. */
export function subscribeDownloads(onProgress) {
  if (typeof EventSource === 'undefined') return () => {};
  const source = new EventSource(`${BASE}/events`);
  source.addEventListener('local-ai:download-progress', (e) => { try { onProgress(JSON.parse(e.data)); } catch { /* ignore a malformed frame */ } });
  return () => source.close();
}

/** Blob -> bare base64 (no data: prefix), the form image_base64 takes. */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

export async function urlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load the source image.');
  return blobToBase64(await res.blob());
}
