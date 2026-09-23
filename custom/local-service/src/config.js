'use strict';
const path = require('node:path');

function loadConfig(env = process.env) {
  const dataDir = env.OGAI_DATA_DIR || '/data';
  return {
    port: Number(env.OGAI_LOCAL_PORT || 8790),
    dataDir,
    outputsDir: path.join(dataDir, 'outputs'),
    sdcliPath: path.join(dataDir, 'local-ai', 'bin', 'sd-cli'),          // where the boot-time bundle sync puts the CUDA sd-cli
    tmpDir: path.join(dataDir, 'local-ai', 'tmp'),
    ffmpegPath: env.OGAI_FFMPEG || '/usr/local/bin/ffmpeg',                // turns sd.cpp's MJPEG .avi into a browser-playable .mp4
    // read-only mounts (OGAI_MODEL_DIRS) first, then the service's own model folder (upstream's downloads + fetch-models.py's extended/ subfolder); searched by basename
    modelDirs: [...(env.OGAI_MODEL_DIRS || '').split(':').filter(Boolean), path.join(dataDir, 'local-ai', 'models')],
    leaseMinSeconds: Number(env.OGAI_LEASE_MIN_S === undefined ? 3600 : env.OGAI_LEASE_MIN_S),            // shortest lease window requested from the arbiter (its hard expiry is 2x this)
    leaseLingerMs: Number(env.OGAI_LEASE_LINGER_S === undefined ? 30 : env.OGAI_LEASE_LINGER_S) * 1000,   // hold the V100 lease this long after the queue empties (0 = release at once)
    maxPending: Number(env.OGAI_MAX_QUEUE || 25),                          // waiting jobs allowed before 429 QUEUE_FULL
    jobTimeoutMs: Number(env.OGAI_JOB_TIMEOUT_S || 1800) * 1000,           // a job running longer than this is stopped (JOB_TIMEOUT); a cinema job gets this PER segment
    cinemaMaxSegments: Number(env.OGAI_CINEMA_MAX_SEGMENTS || 8),          // chained "cinema" video: at most this many 5s-class clips stitched into one
    upstreamDir: env.OGAI_UPSTREAM_DIR || '/app',           // repo root that contains electron/lib
    resourcesPath: env.OGAI_RESOURCES_PATH || '',           // holds local-ai/<platform>-<arch>/bin/sd-cli
    token: env.OGAI_TOKEN || '',
    gpuEnabled: env.OGAI_GPU_ENABLED === '1',               // safety switch: nothing touches a GPU unless this is exactly "1"
    allowedDevices: (env.OGAI_ALLOWED_DEVICES || 'v100,gtx1080').split(',').map((d) => d.trim().toLowerCase()).filter((d) => d === 'v100' || d === 'gtx1080'),
    arbiterUrl: (env.OGAI_ARBITER_URL || '').replace(/\/+$/, ''),
    sdcppConsumer: (env.OGAI_SDCPP_CONSUMER || 'ogai-local').toLowerCase(),
    sdcppVramGb: Number(env.OGAI_SDCPP_VRAM_GB || 10),
    deviceIndexV100: Number(env.OGAI_DEVICE_INDEX_V100 ?? 0),
    deviceIndex1080: Number(env.OGAI_DEVICE_INDEX_1080 ?? 1),
    muapiKeyFile: env.MUAPI_KEY_FILE || path.join(dataDir, '.muapi-key'),
    muapiMcpUrl: env.MUAPI_MCP_URL || 'https://api.muapi.ai/mcp',
  };
}

module.exports = { loadConfig };
