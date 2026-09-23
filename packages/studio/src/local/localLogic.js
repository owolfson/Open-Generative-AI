// Pure helpers for the local (⚡) studio: no React, no fetch, so they are unit-tested with node:test (custom/web-tests).
// The device rule mirrors custom/local-service/src/runner.js (models over ~5.5GB of weights do not fit the GTX 1080).

export const GTX1080_MAX_WEIGHTS_GB = 5.5;
export const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
export const DEVICE_LABEL = { gtx1080: 'GTX 1080', v100: 'Tesla V100' };
export const V100_WARNING = 'The V100 is shared with Hermes: this stops the Hermes brain (about 5 minutes) and TTS (about 7 minutes) while it runs.';

/** Outputs are served through the proxy: '/outputs/x.mp4' -> '/api/local/outputs/x.mp4'. Data/blob/http URLs pass through. */
export const proxyUrl = (url) => (typeof url === 'string' && url.startsWith('/outputs/') ? `/api/local${url}` : url);

/** What a video model takes, for the model picker. */
export const kindLabel = (model) => (model.kind !== 'video' ? '' : model.needsImage ? 'image → video' : model.acceptsImage ? 'text / image → video' : 'text → video');

export const needsV100 = (model) => (Array.isArray(model.devices) ? !model.devices.includes('gtx1080') : !(typeof model.weightsGb === 'number' && model.weightsGb <= GTX1080_MAX_WEIGHTS_GB));

/** Can this model be run right now, and if not, why. tone: ok | warn | muted. */
export function modelReadiness(model) {
  if (model.route !== 'sdcpp') return { ready: false, tone: 'muted', label: 'Not available', reason: 'Needs the WanGP engine, which is not installed on this server.' };
  if (typeof model.filesPresent === 'boolean') {   // Flux / Qwen-Image / Wan: weights are mounted read-only from the ComfyUI stores
    return model.filesPresent
      ? { ready: true, tone: 'ok', label: 'Ready' }
      : { ready: false, tone: 'warn', label: 'Files missing', reason: 'Its weights are not on the server yet (custom/local-service/fetch-models.py downloads the Wan text-to-video and Hunyuan files).' };
  }
  const aux = Object.values(model.auxiliaryStatus || {});
  if (model.state === 'downloaded' && aux.every((s) => s === 'downloaded')) return { ready: true, tone: 'ok', label: 'Ready' };
  if (model.state === 'downloaded') return { ready: false, tone: 'warn', label: 'Needs text encoder / VAE', reason: 'The model is downloaded but its text encoder or VAE is not.' };
  if (model.state === 'partial') return { ready: false, tone: 'warn', label: 'Partial download', reason: 'A previous download was interrupted; download it again to resume.' };
  return { ready: false, tone: 'warn', label: 'Download needed', reason: 'Not downloaded yet.' };
}

/** Models for the picker of one studio kind, best first: starred, then ready, then by name. Excludes engines we do not run. */
export function pickerModels(models = [], kind) {
  return models
    .filter((m) => m.kind === kind && m.route === 'sdcpp')
    .map((m) => ({ ...m, readiness: modelReadiness(m) }))
    .sort((a, b) => Number(b.star) - Number(a.star) || Number(b.readiness.ready) - Number(a.readiness.ready) || a.name.localeCompare(b.name));
}

/** Pick the device for a request. choice: 'auto' | 'gtx1080' | 'v100'. Never picks the V100 unless the model needs it or the user chose it. */
export function resolveDevice(model, choice, health) {
  const allowed = (health && health.allowedDevices) || [];
  const device = !choice || choice === 'auto' ? (Array.isArray(model.devices) ? model.devices[0] : needsV100(model) ? 'v100' : 'gtx1080') : choice;
  if (Array.isArray(model.devices) && !model.devices.includes(device)) return { error: `${model.name} only runs on the ${model.devices.map((d) => DEVICE_LABEL[d] || d).join(' / ')}${model.deviceNote ? `: ${model.deviceNote}` : ''}.` };
  if (!allowed.includes(device)) return { error: `${DEVICE_LABEL[device] || device} is not enabled on this server.` };
  if (device === 'gtx1080' && needsV100(model)) return { error: `${model.name} is too big for the GTX 1080; use the V100.` };
  return { device, v100: device === 'v100' };
}

export const aspectsFor = (model) => (Array.isArray(model.aspectRatios) && model.aspectRatios.length ? model.aspectRatios : ASPECTS);

const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v));

/** Request body for POST /api/local/jobs. Only sends what the user actually set, so the server's measured-safe defaults apply. */
export const CINEMA_MIN_SEGMENTS = 2;
export const CINEMA_MAX_SEGMENTS = 8;
export const CINEMA_DEFAULT_BLEND_SECONDS = 0.3;   // mirrors the server's own default (service.js) - shown as a placeholder, not forced

export function buildParams({ model, prompt, negative, aspect, device, advanced = {}, imageBase64 }) {
  const p = { model: model.id, prompt: prompt.trim(), aspect_ratio: aspect, device };
  if (negative && negative.trim()) p.negative_prompt = negative.trim();
  if (num(advanced.steps) > 0) p.steps = num(advanced.steps);
  if (num(advanced.guidance) > 0) p.guidance_scale = num(advanced.guidance);
  if (num(advanced.seed) > 0) p.seed = num(advanced.seed);
  if (model.kind === 'video') {
    if (num(advanced.frames) > 0) p.video_frames = num(advanced.frames);
    if (num(advanced.fps) > 0) p.fps = num(advanced.fps);
    if ((model.needsImage || model.acceptsImage) && imageBase64) p.image_base64 = imageBase64;
    const segments = num(advanced.cinemaSegments);
    if (model.chainable && segments >= CINEMA_MIN_SEGMENTS) {
      p.cinema = { segments };
      // 0 is a real, meaningful choice (a hard cut) - only omit blendSeconds when the field was left empty, so the server's own default applies.
      if (advanced.cinemaBlend !== undefined && advanced.cinemaBlend !== '') p.cinema.blendSeconds = num(advanced.cinemaBlend);
    }
  }
  return p;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** What to show for a running job: a phase line and a 0-100 percentage (null = indeterminate). */
export function describeJob(job, { device, elapsedMs = 0, kind = 'image' } = {}) {
  if (!job) return { text: 'Starting…', pct: null };
  if (job.status === 'queued') return { text: 'Queued behind another local job…', pct: null };
  const p = job.progress;
  // A "cinema" job (chained multi-segment video) never shows a step-based percentage: it would reset to 0% at the start
  // of every new segment, which reads as the job stalling or restarting rather than steadily progressing.
  const seg = p && p.segments > 1 ? `Segment ${p.segment}/${p.segments} — ` : '';
  const pct = p && p.segments > 1 ? null : undefined;
  if (p && p.totalSteps) {
    if (p.step >= p.totalSteps) return { text: `${seg}${kind === 'video' ? 'Processing frames…' : 'Decoding image…'}`, pct: pct === null ? null : 100 };
    return { text: `${seg}Step ${p.step}/${p.totalSteps}`, pct: pct === null ? null : Math.round((p.progress ?? p.step / p.totalSteps) * 100) };
  }
  if (p && p.segments > 1) return { text: `${seg}starting…`, pct: null };
  if (device === 'v100' && elapsedMs < 90_000) return { text: 'Waiting for the GPU arbiter — the Hermes brain and TTS are being stopped…', pct: null };
  return { text: 'Loading model…', pct: null };
}

/** A finished server job (made from the GUI, an agent or MCP) as a history entry; null when it has nothing to show. */
export function entryFromJob(job, models = []) {
  if (!job || job.status !== 'done' || !job.result || !job.result.url) return null;
  const params = job.params || {};
  const m = models.find((x) => x.id === params.model);
  return {
    id: job.id, kind: job.kind, url: proxyUrl(job.result.url), prompt: params.prompt || '', model: params.model, modelName: (m && m.name) || params.model,
    device: params.device || '', aspect: params.aspect_ratio || '1:1', seed: job.result.seed,
    seconds: Math.max(0, Math.round(((job.finishedAt || 0) - (job.startedAt || 0)) / 1000)), createdAt: job.finishedAt || Date.now(),
    cinema: job.result.cinema || null,   // { segments, blendSeconds, seeds } when this is a chained "cinema" video - shown as a badge
  };
}

/** Add server jobs the browser has not seen yet (oldest first, so the newest ends on top). Returns the SAME list when nothing is new. */
export function mergeServerJobs(history, jobs, models, dismissed = new Set()) {
  const seen = new Set(history.map((e) => e.id));
  const fresh = jobs.map((j) => entryFromJob(j, models)).filter((e) => e && !seen.has(e.id) && !dismissed.has(e.id)).sort((a, b) => a.createdAt - b.createdAt);
  return fresh.length ? fresh.reduce((list, entry) => pushHistory(list, entry), history) : history;
}

/** Newest first, capped. */
export const pushHistory = (list, entry, cap = 60) => [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, cap);

/** A readable message for the error codes ogai-local returns. */
export function explainError(err) {
  const code = err && err.code;
  const known = {
    GPU_DISABLED: 'GPU jobs are switched off on the local service.',
    DEVICE_REQUIRED: 'This model needs the V100 — choose it as the device.',
    DEVICE_NOT_ALLOWED: 'That GPU is not enabled on the local service.',
    MODEL_FILES_MISSING: 'The model files are missing on the server.',
    ARBITER_REFUSED: 'The GPU arbiter refused the request (the V100 is busy). Try again shortly.',
    IMAGE_REQUIRED: 'This model needs a starting image.',
    LOCAL_UNREACHABLE: 'The local inference service is not reachable.',
    JOB_LOST: 'The local service restarted while this job was running, so the job was lost. Press Generate to run it again.',
    LOCAL_NOT_CONFIGURED: 'The local inference service is not configured for this app.',
    CANCELLED: 'Cancelled.',
  };
  return known[code] || (err && err.message) || 'Local generation failed.';
}
