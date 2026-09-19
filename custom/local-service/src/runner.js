'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { withLease, codeError } = require('./gate');

/**
 * Executes one queued job. The queue guarantees single-flight, which is what makes it safe to set
 * CUDA_VISIBLE_DEVICES on process.env: upstream's spawn() copies process.env at spawn time.
 */
function createRunner({ config, standin, gateImpl = withLease, log = console }) {
  async function runSdcpp(job, { signal }) {
    const { device, ...engineParams } = job.params;
    const onGtx1080 = device === 'gtx1080';

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
