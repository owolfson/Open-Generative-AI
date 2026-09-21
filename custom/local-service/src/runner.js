'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { acquireLease, codeError, MAX_EST_SECONDS } = require('./gate');
const { assess } = require('./catalog');
const { SPECS, getSpec, resolveFiles, prepare, buildArgs } = require('./sdcpp-models');
const { runSdCli } = require('./sdcpp');
const { toMp4 } = require('./video');

const GTX1080_MAX_WEIGHTS_GB = 5.5;   // ~6GB of the 8GB card is free beside the resident TTS container

function chooseDevice(requested, allowed, weightsGb) {
  if (requested !== undefined && requested !== null && requested !== '') {
    if (requested !== 'v100' && requested !== 'gtx1080') throw codeError('BAD_REQUEST', `unknown device: ${requested}`);
    if (!allowed.includes(requested)) throw codeError('DEVICE_NOT_ALLOWED', `device ${requested} is not enabled on this deployment (allowed: ${allowed.join(', ') || 'none'})`);
    return requested;
  }
  // No device asked for. The V100 is never chosen implicitly while the GTX 1080 exists: a V100 lease stops the
  // Hermes brain and the TTS, so a caller must ask for it by name.
  const fits1080 = typeof weightsGb === 'number' && weightsGb <= GTX1080_MAX_WEIGHTS_GB;
  const has1080 = allowed.includes('gtx1080');
  const hasV100 = allowed.includes('v100');
  if (has1080 && fits1080) return 'gtx1080';
  if (hasV100 && !has1080) return 'v100';           // V100-only deployment: nothing to choose between
  if (has1080 && !hasV100) return 'gtx1080';        // 1080-only deployment: the engine reports if it does not fit
  if (has1080 && hasV100) {
    throw codeError('DEVICE_REQUIRED', 'this model does not fit the GTX 1080; pass device:"v100" to run it on the V100 (that stops the Hermes brain and the TTS for the duration of the job)');
  }
  throw codeError('DEVICE_NOT_ALLOWED', 'no GPU device is enabled (OGAI_ALLOWED_DEVICES)');
}

const MIME = { png: 'image/png', avi: 'video/x-msvideo', mp4: 'video/mp4' };

// Upstream's pure progress parser (no electron needed); without it jobs still run, just without progress events.
function loadProgressParser(upstreamDir) {
  try { return require(path.join(upstreamDir, 'electron', 'lib', 'localInferenceRuntime.js')).parseGenerationProgressChunk; }
  catch { return undefined; }
}

const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const EST_IMAGE_SECONDS = 900;
const EST_VIDEO_SECONDS = 1800;
// A V100 lease is a WHOLE-CARD lease (any grant evicts the Hermes brain and the TTS), so the VRAM it declares is just accounting:
// always claim the biggest model's footprint, so a bigger job that arrives after a smaller one started can still share the lease.
// The window is never shorter than an hour for the same reason (the arbiter force-releases at 2x est_seconds; jobs are not
// started on a lease that would not outlast them, see covers()).
const LEASE_MIN_SECONDS = 3600;
const LEASE_MAX_VRAM_GB = 28;   // the arbiter's SAFE_VRAM_BUDGET: a spec's real peak may exceed it (Flux 28.8GB), the lease claim may not

/**
 * Executes one queued job on one of two paths, both through the same sd-cli binary:
 * - upstream's own engine (Z-Image, SD 1.5, SDXL), which spawns sd-cli itself. The queue guarantees single-flight, which is
 *   what makes it safe to set CUDA_VISIBLE_DEVICES on process.env there: upstream's spawn() copies process.env at spawn time.
 * - our extended specs (Flux, Qwen-Image, Wan 2.2), which we spawn ourselves with an explicit env (see sdcpp-models.js).
 *
 * V100 jobs hold a gpu-arbiter lease; the GTX 1080 is not arbiter-managed and never evicts the brain. A V100 lease costs the
 * Hermes brain + TTS ~10 minutes of downtime per evict/restore cycle, so the runner OWNS the lease and keeps ONE across
 * consecutive queued V100 jobs (sized for the whole batch) instead of paying that cost per job. The lease is released as
 * soon as the next queued job is not a V100 job it covers, the job failed or was cancelled, nothing else is queued (after a
 * short grace so a submit racing the end of a job can still join), or the service shuts down.
 */
function createRunner({ config, standin, acquireImpl = acquireLease, sdcli = runSdCli, mp4Impl = toMp4, log = console, idleReleaseMs = 10_000 }) {
  const parseChunk = loadProgressParser(config.upstreamDir || '');
  const emitProgress = (data) => { if (standin.events && standin.events.emit) standin.events.emit('send', 'local-ai:progress', data); };

  let held = null;   // { lease, vramGb, deadline, idleTimer }

  async function dropLease() {
    const h = held;
    if (!h) return;
    held = null;
    clearTimeout(h.idleTimer);
    await h.lease.release();
  }

  // The lease is whole-card, so what matters is time; VRAM is compared as claimed (capped), never as a model's real peak.
  const covers = (need) => Boolean(held) && Math.min(need.vramGb, LEASE_MAX_VRAM_GB) <= held.vramGb && Date.now() + need.estSeconds * 1000 <= held.deadline;

  /** Everything decided about a job before any GPU work; throws the job's real error (config, device, missing files). */
  function describe(job) {
    if (!config.gpuEnabled) throw codeError('GPU_DISABLED', 'GPU jobs are disabled: set OGAI_GPU_ENABLED=1 once the GPU test window is approved');
    if (job.route !== 'sdcpp') throw codeError('ENGINE_NOT_READY', `engine route "${job.route}" is not wired yet`);
    const { device: requested, ...engineParams } = job.params;
    const known = assess(engineParams.model);
    const spec = getSpec(engineParams.model);
    let pool = config.allowedDevices;
    if (spec && spec.devices) {   // a model that only works on some GPUs (e.g. Z-Image Base: blank on the V100)
      if (requested && !spec.devices.includes(requested)) throw codeError('DEVICE_NOT_SUPPORTED', `${engineParams.model} cannot run on ${requested}: ${spec.deviceNote || `it only supports ${spec.devices.join(', ')}`}`);
      pool = pool.filter((d) => spec.devices.includes(d));
    }
    const onGtx1080 = chooseDevice(requested, pool, known && known.weightsGb) === 'gtx1080';
    if (!spec) return { onGtx1080, engineParams, need: { vramGb: config.sdcppVramGb, estSeconds: EST_IMAGE_SECONDS } };
    // Everything that can fail cheaply fails HERE, before any arbiter lease: a job that cannot run must never evict the brain.
    const params = prepare(spec, engineParams);
    const { files, missing } = resolveFiles(spec, config.modelDirs || [], params);
    if (missing.length) {
      throw codeError('MODEL_FILES_MISSING', `missing model files (searched ${(config.modelDirs || []).join(', ') || 'no model dirs - set OGAI_MODEL_DIRS'}): ${missing.join(', ')}`);
    }
    return { onGtx1080, engineParams, spec, params, files, need: { vramGb: spec.vramGb, estSeconds: spec.kind === 'video' ? EST_VIDEO_SECONDS : EST_IMAGE_SECONDS } };
  }

  /** What a queued job would need from a shared V100 lease, or null when it cannot share one (not V100, or it would fail anyway). */
  function needOf(job) {
    try {
      const d = describe(job);
      return d.onGtx1080 ? null : d.need;
    } catch { return null; }
  }

  /** Make sure this V100 job runs under a lease: reuse the held one if it still covers the job, else take one sized for the batch. */
  async function ensureLease(job, need, pending) {
    if (held && !covers(need)) await dropLease();
    if (held) { clearTimeout(held.idleTimer); return; }
    const batch = [need];
    let seconds = need.estSeconds;
    for (const next of pending) {
      const n = needOf(next);
      if (!n || seconds + n.estSeconds > MAX_EST_SECONDS) break;
      batch.push(n); seconds += n.estSeconds;
    }
    const vramGb = Math.min(LEASE_MAX_VRAM_GB, Math.max(config.sdcppVramGb, ...Object.values(SPECS).map((spec) => spec.vramGb), ...batch.map((n) => n.vramGb)));
    const queued = batch.length - 1;
    seconds = Math.min(Math.max(seconds, LEASE_MIN_SECONDS), MAX_EST_SECONDS);
    const lease = await acquireImpl(config, {
      consumer: config.sdcppConsumer, vramGb, estSeconds: seconds, note: `ogai-local job ${job.id}${queued ? ` (+${queued} queued)` : ''}`,
    }, { log });
    held = { lease, vramGb, deadline: Date.now() + seconds * 1000, idleTimer: null };
  }

  /** After a job: keep the lease only when the very next queued job is covered by it; otherwise give the V100 back now. */
  async function settle(succeeded, pending) {
    if (!held) return;
    const next = succeeded ? pending[0] : null;
    const need = next && needOf(next);
    if (need && covers(need)) {
      // Safety net: if that next job never starts (cancelled in the gap), do not sit on the V100 until the arbiter's expiry.
      held.idleTimer = setTimeout(() => { dropLease().catch((err) => log.error(`runner: idle lease release failed: ${err.message}`)); }, idleReleaseMs);
      if (held.idleTimer.unref) held.idleTimer.unref();
      return;
    }
    await dropLease();
  }

  function persistUpstream(job, raw) {
    const match = /^data:image\/png;base64,(.+)$/.exec(raw.url || '');
    if (!match) throw codeError('BAD_ENGINE_RESULT', 'sd.cpp returned no PNG data URL');
    fs.mkdirSync(config.outputsDir, { recursive: true });
    const file = `${job.id}.png`;
    fs.writeFileSync(path.join(config.outputsDir, file), Buffer.from(match[1], 'base64'));
    return { seed: raw.seed, file, url: `/outputs/${file}`, kind: 'image', mime: MIME.png, dataUrl: raw.url };
  }

  function persistFile(job, spec, seed, tmpPath) {
    if (!fs.existsSync(tmpPath)) throw codeError('BAD_ENGINE_RESULT', 'sd-cli finished but wrote no output file');
    fs.mkdirSync(config.outputsDir, { recursive: true });
    const file = `${job.id}.${spec.ext}`;
    const dest = path.join(config.outputsDir, file);
    fs.copyFileSync(tmpPath, dest);
    fs.unlinkSync(tmpPath);
    const result = { seed, file, url: `/outputs/${file}`, kind: spec.kind, mime: MIME[spec.ext], bytes: fs.statSync(dest).size };
    if (spec.ext === 'png') result.dataUrl = `data:image/png;base64,${fs.readFileSync(dest).toString('base64')}`;   // upstream's UI expects a data URL for images
    return result;
  }

  async function runUpstream(job, { signal }, d) {
    process.env.CUDA_DEVICE_ORDER = 'PCI_BUS_ID';
    process.env.CUDA_VISIBLE_DEVICES = String(d.onGtx1080 ? config.deviceIndex1080 : config.deviceIndexV100);
    const cancel = () => { standin.invoke('local-ai:cancel-generation').catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try { return persistUpstream(job, await standin.invoke('local-ai:generate', d.engineParams)); }
    finally { signal.removeEventListener('abort', cancel); }
  }

  async function runExtended(job, { signal }, d) {
    fs.mkdirSync(config.tmpDir, { recursive: true });
    const outPath = path.join(config.tmpDir, `${job.id}.${d.spec.ext}`);
    await sdcli({
      binary: config.sdcliPath, libDir: path.dirname(config.sdcliPath), args: buildArgs(d.spec, d.params, d.files, outPath),
      env: { CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: String(d.onGtx1080 ? config.deviceIndex1080 : config.deviceIndexV100) },
      signal, onProgress: emitProgress, parseChunk,
    });
    const result = persistFile(job, d.spec, d.params.seed, outPath);
    return d.spec.kind === 'video' ? withMp4(result) : result;
  }

  // Browsers cannot play sd.cpp's MJPEG .avi: make the served artifact an mp4 and keep the avi as `source`. A failed
  // conversion never fails the job (the GPU work is done): the avi is returned with a warning saying why.
  async function withMp4(result) {
    const input = path.join(config.outputsDir, result.file);
    const mp4File = result.file.replace(/\.avi$/, '.mp4');
    try {
      await mp4Impl({ ffmpeg: config.ffmpegPath, input, output: path.join(config.outputsDir, mp4File) });
    } catch (err) {
      log.warn(`runner: mp4 conversion failed (${err.message}); serving the avi`);
      return { ...result, warning: `mp4 conversion failed (${err.message}); this is the raw MJPEG avi, which browsers cannot play` };
    }
    const bytes = fs.statSync(path.join(config.outputsDir, mp4File)).size;
    return { ...result, file: mp4File, url: `/outputs/${mp4File}`, mime: MIME.mp4, bytes, source: result.file };
  }

  /** Run fn with a signal that also fires after the job time limit. A job that outlives its lease would let the arbiter restore the brain on top of it. */
  async function withTimeLimit(ctx, fn) {
    const limitMs = config.jobTimeoutMs || DEFAULT_JOB_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (ctx.signal.aborted) controller.abort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limitMs);
    try {
      return await fn({ ...ctx, signal: controller.signal });
    } catch (err) {
      if (timedOut && !ctx.signal.aborted) throw codeError('JOB_TIMEOUT', `the job exceeded its ${limitMs >= 120000 ? `${Math.round(limitMs / 60000)} minute` : `${Math.round(limitMs / 1000)} second`} limit and was stopped`);
      throw err;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  async function run(job, ctx) {
    if (held) clearTimeout(held.idleTimer);
    const pending = () => (ctx.pending ? ctx.pending() : []);
    let succeeded = false;
    try {
      const d = describe(job);
      if (d.onGtx1080) await dropLease();                       // a held lease is never needed for the 1080; do not sit on the V100
      else await ensureLease(job, d.need, pending());
      const result = await withTimeLimit(ctx, (limited) => (d.spec ? runExtended(job, limited, d) : runUpstream(job, limited, d)));
      succeeded = true;
      return result;
    } finally {
      await settle(succeeded, pending());
    }
  }

  /** Release any held V100 lease now (service shutdown). Callers stop running work first; a repeat release is a no-op. */
  const shutdown = () => dropLease();

  return { run, shutdown };
}

module.exports = { createRunner };
