'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { withLease, codeError } = require('./gate');
const { assess } = require('./catalog');
const { getSpec, resolveFiles, prepare, buildArgs } = require('./sdcpp-models');
const { runSdCli } = require('./sdcpp');

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

const MIME = { png: 'image/png', avi: 'video/x-msvideo' };

// Upstream's pure progress parser (no electron needed); without it jobs still run, just without progress events.
function loadProgressParser(upstreamDir) {
  try { return require(path.join(upstreamDir, 'electron', 'lib', 'localInferenceRuntime.js')).parseGenerationProgressChunk; }
  catch { return undefined; }
}

/**
 * Executes one queued job on one of two paths, both through the same sd-cli binary:
 * - upstream's own engine (Z-Image, SD 1.5, SDXL), which spawns sd-cli itself. The queue guarantees single-flight, which is
 *   what makes it safe to set CUDA_VISIBLE_DEVICES on process.env there: upstream's spawn() copies process.env at spawn time.
 * - our extended specs (Flux, Qwen-Image, Wan 2.2), which we spawn ourselves with an explicit env (see sdcpp-models.js).
 * Any V100 job holds an arbiter lease for its duration; the GTX 1080 is not arbiter-managed and never evicts the brain.
 */
function createRunner({ config, standin, gateImpl = withLease, sdcli = runSdCli, log = console }) {
  const parseChunk = loadProgressParser(config.upstreamDir || '');
  const emitProgress = (data) => { if (standin.events && standin.events.emit) standin.events.emit('send', 'local-ai:progress', data); };

  function withDeviceLease(job, onGtx1080, vramGb, estSeconds, call) {
    if (onGtx1080) return call();
    return gateImpl(config, { consumer: config.sdcppConsumer, vramGb, estSeconds, note: `ogai-local job ${job.id}` }, call, { log });
  }

  async function runUpstream(job, { signal }, engineParams, onGtx1080) {
    const call = async () => {
      process.env.CUDA_DEVICE_ORDER = 'PCI_BUS_ID';
      process.env.CUDA_VISIBLE_DEVICES = String(onGtx1080 ? config.deviceIndex1080 : config.deviceIndexV100);
      const cancel = () => { standin.invoke('local-ai:cancel-generation').catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try { return await standin.invoke('local-ai:generate', engineParams); }
      finally { signal.removeEventListener('abort', cancel); }
    };
    return withDeviceLease(job, onGtx1080, config.sdcppVramGb, 900, call);
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

  async function runExtended(job, { signal }, spec, engineParams, onGtx1080) {
    // Everything that can fail cheaply fails HERE, before any arbiter lease: a job that cannot run must never evict the brain.
    const params = prepare(spec, engineParams);
    const { files, missing } = resolveFiles(spec, config.modelDirs || [], params);
    if (missing.length) {
      throw codeError('MODEL_FILES_MISSING', `missing model files (searched ${(config.modelDirs || []).join(', ') || 'no model dirs - set OGAI_MODEL_DIRS'}): ${missing.join(', ')}`);
    }
    fs.mkdirSync(config.tmpDir, { recursive: true });
    const outPath = path.join(config.tmpDir, `${job.id}.${spec.ext}`);
    const call = async () => {
      await sdcli({
        binary: config.sdcliPath, libDir: path.dirname(config.sdcliPath), args: buildArgs(spec, params, files, outPath),
        env: { CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: String(onGtx1080 ? config.deviceIndex1080 : config.deviceIndexV100) },
        signal, onProgress: emitProgress, parseChunk,
      });
      return persistFile(job, spec, params.seed, outPath);
    };
    return withDeviceLease(job, onGtx1080, spec.vramGb, spec.kind === 'video' ? 1800 : 900, call);
  }

  async function run(job, ctx) {
    if (!config.gpuEnabled) throw codeError('GPU_DISABLED', 'GPU jobs are disabled: set OGAI_GPU_ENABLED=1 once the GPU test window is approved');
    if (job.route !== 'sdcpp') throw codeError('ENGINE_NOT_READY', `engine route "${job.route}" is not wired yet`);
    const { device: requested, ...engineParams } = job.params;
    const known = assess(engineParams.model);
    const onGtx1080 = chooseDevice(requested, config.allowedDevices, known && known.weightsGb) === 'gtx1080';
    const spec = getSpec(engineParams.model);
    if (spec) return runExtended(job, ctx, spec, engineParams, onGtx1080);
    return persistUpstream(job, await runUpstream(job, ctx, engineParams, onGtx1080));
  }

  return { run };
}

module.exports = { createRunner };
