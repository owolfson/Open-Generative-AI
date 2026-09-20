'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { withLease, codeError } = require('./gate');
const { assess } = require('./catalog');

const GTX1080_MAX_WEIGHTS_GB = 5.5;   // ~6GB of the 8GB card is free beside the resident TTS container

function chooseDevice(requested, allowed, weightsGb) {
  if (requested !== undefined && requested !== null && requested !== '') {
    if (requested !== 'v100' && requested !== 'gtx1080') throw codeError('BAD_REQUEST', `unknown device: ${requested}`);
    if (!allowed.includes(requested)) throw codeError('DEVICE_NOT_ALLOWED', `device ${requested} is not enabled on this deployment (allowed: ${allowed.join(', ') || 'none'})`);
    return requested;
  }
  // No device asked for: prefer the lane that never evicts the Hermes brain, when the model fits it.
  const fits1080 = typeof weightsGb === 'number' && weightsGb <= GTX1080_MAX_WEIGHTS_GB;
  if (allowed.includes('gtx1080') && (fits1080 || !allowed.includes('v100'))) return 'gtx1080';
  if (allowed.includes('v100')) return 'v100';
  throw codeError('DEVICE_NOT_ALLOWED', 'no GPU device is enabled (OGAI_ALLOWED_DEVICES)');
}

/**
 * Executes one queued job. The queue guarantees single-flight, which is what makes it safe to set
 * CUDA_VISIBLE_DEVICES on process.env: upstream's spawn() copies process.env at spawn time.
 */
function createRunner({ config, standin, gateImpl = withLease, log = console }) {
  async function runSdcpp(job, { signal }) {
    const { device: requested, ...engineParams } = job.params;
    const known = assess(engineParams.model);
    const onGtx1080 = chooseDevice(requested, config.allowedDevices, known && known.weightsGb) === 'gtx1080';

    const call = async () => {
      process.env.CUDA_DEVICE_ORDER = 'PCI_BUS_ID';
      process.env.CUDA_VISIBLE_DEVICES = String(onGtx1080 ? config.deviceIndex1080 : config.deviceIndexV100);
      const cancel = () => { standin.invoke('local-ai:cancel-generation').catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try { return await standin.invoke('local-ai:generate', engineParams); }
      finally { signal.removeEventListener('abort', cancel); }
    };

    // The GTX 1080 is not arbiter-managed and never evicts the Hermes brain; the V100 needs a whole-card lease.
    if (onGtx1080) return call();
    return gateImpl(config, { consumer: config.sdcppConsumer, vramGb: config.sdcppVramGb, estSeconds: 900, note: `ogai-local job ${job.id}` }, call, { log });
  }

  function persist(job, raw) {
    const match = /^data:image\/png;base64,(.+)$/.exec(raw.url || '');
    if (!match) throw codeError('BAD_ENGINE_RESULT', 'sd.cpp returned no PNG data URL');
    fs.mkdirSync(config.outputsDir, { recursive: true });
    const file = `${job.id}.png`;
    fs.writeFileSync(path.join(config.outputsDir, file), Buffer.from(match[1], 'base64'));
    return { seed: raw.seed, file, url: `/outputs/${file}`, dataUrl: raw.url };
  }

  async function run(job, ctx) {
    if (!config.gpuEnabled) throw codeError('GPU_DISABLED', 'GPU jobs are disabled: set OGAI_GPU_ENABLED=1 once the GPU test window is approved');
    if (job.route !== 'sdcpp') throw codeError('ENGINE_NOT_READY', `engine route "${job.route}" is not wired yet`);
    return persist(job, await runSdcpp(job, ctx));
  }

  return { run };
}

module.exports = { createRunner };
