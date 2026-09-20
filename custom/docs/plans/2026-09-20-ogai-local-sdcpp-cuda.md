# sd.cpp CUDA lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `ogai-local` a working local image engine: upstream's own sd.cpp engine driving a CUDA build of stable-diffusion.cpp, first on the GTX 1080 lane (never evicts the Hermes brain), with the V100 physically unreachable until a test window is approved.

**Architecture:** A resource-limited builder container compiles sd-cli for sm_61 + sm_70 with AVX-only CPU code and stages it plus the CUDA runtime libs under `vendor/sdcpp/`. The service image bundles that directory as upstream's "bundled binary"; a boot-time sync keeps the on-disk copy in step with the image version. A device policy (`OGAI_ALLOWED_DEVICES`) plus Docker's `--gpus device=<uuid>` decide which GPU a job may use.

**Tech Stack:** Node >= 20 (no npm deps), `node:test`, CMake + CUDA 12.6.3 (devel image), Docker.

**Spec:** `custom/docs/specs/2026-09-19-ogai-local-design.md` (extends `custom/docs/plans/2026-09-19-ogai-local-service-core.md`)

## Global Constraints

- Zero npm dependencies; tests run with `node --test test/*.test.js` from `custom/local-service/` (never pass a directory).
- Upstream `electron/lib/*` stays unmodified; the sd.cpp binary is supplied through the stand-in's bundled-binary path (`OGAI_RESOURCES_PATH`).
- CUDA **12.x** only: CUDA 13 dropped sm_61/sm_70 targets. Build archs exactly `61;70`.
- The host Xeon E5-2689 has AVX only - no AVX2/FMA/F16C/BMI2. ggml CPU code must be built with `GGML_NATIVE=OFF` and those features OFF, or the binary dies with SIGILL.
- The host is memory-starved (swap ~full): the compile runs in a container capped at 8GB RAM / 6 CPUs at low priority, with the build tree on appdata, not in docker.img.
- The first deployment exposes ONLY the GTX 1080 to the container (`--gpus device=<uuid>`) and sets `OGAI_ALLOWED_DEVICES=gtx1080`; no arbiter URL. No task touches the V100 or the Hermes brain.
- No secrets, tokens, or host addresses in committed files.
- Commits end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

Paths are relative to the repo root `/mnt/user/data/Projects/UnraidDev/Open-Generative-AI`; run tests from `custom/local-service/`.

---

### Task 1: Device policy (which GPU may a job use)

**Files:**
- Modify: `custom/local-service/src/config.js`, `custom/local-service/src/runner.js`, `custom/local-service/src/server.js`, `custom/local-service/src/mcp.js`
- Test: `custom/local-service/test/config.test.js`, `custom/local-service/test/runner.test.js`, `custom/local-service/test/server.test.js`, `custom/local-service/test/boot.test.js`

**Interfaces:**
- Produces: `config.allowedDevices: ('v100'|'gtx1080')[]` from `OGAI_ALLOWED_DEVICES` (default both, junk ignored). `runner` picks the device: an explicit `params.device` must be allowed (`DEVICE_NOT_ALLOWED`) and valid (`BAD_REQUEST`); with none given, models with `weightsGb <= 5.5` default to `gtx1080` when allowed (so they never evict the Hermes brain), everything else to `v100`; if only one device is allowed it is used. `GET /health` gains `allowedDevices`.

- [ ] **Step 1: Write the failing tests** - add to the existing test files:

`test/config.test.js` (append):
```js
test('allowed devices default to both GPUs; values are trimmed, lower-cased and junk is ignored', () => {
  assert.deepEqual(loadConfig({}).allowedDevices, ['v100', 'gtx1080']);
  assert.deepEqual(loadConfig({ OGAI_ALLOWED_DEVICES: 'gtx1080' }).allowedDevices, ['gtx1080']);
  assert.deepEqual(loadConfig({ OGAI_ALLOWED_DEVICES: ' GTX1080 , nonsense ,v100' }).allowedDevices, ['gtx1080', 'v100']);
});
```

`test/runner.test.js` - change the `config()` helper to include `allowedDevices: ['v100', 'gtx1080'],` (before the `...over`), change the V100 test's job to `job({ params: { model: 'z-image-turbo', prompt: 'a cat', device: 'v100' } })`, and append:
```js
test('device policy: small models default to the GTX 1080 lane (no brain eviction), big ones to the V100', async () => {
  const small = fakes();
  await createRunner({ config: config(), standin: small.standin, gateImpl: small.gate.impl, log: quiet }).run(job(), ctx());   // z-image-turbo, 5.2GB
  assert.equal(small.gate.calls.length, 0);
  assert.equal(small.standin.envAtGenerate, '1');

  const big = fakes();
  await createRunner({ config: config(), standin: big.standin, gateImpl: big.gate.impl, log: quiet }).run(job({ params: { model: 'stable-diffusion-xl-base', prompt: 'x' } }), ctx());   // 6.9GB
  assert.equal(big.gate.calls.length, 1);
  assert.equal(big.standin.envAtGenerate, '0');
});

test('a device that is not allowed is refused before anything runs; an unknown device is a bad request', async () => {
  const f = fakes();
  const r = createRunner({ config: config({ allowedDevices: ['gtx1080'] }), standin: f.standin, gateImpl: f.gate.impl, log: quiet });
  await assert.rejects(() => r.run(job({ params: { model: 'z-image-turbo', prompt: 'x', device: 'v100' } }), ctx()), { code: 'DEVICE_NOT_ALLOWED' });
  await assert.rejects(() => r.run(job({ params: { model: 'z-image-turbo', prompt: 'x', device: 'tpu' } }), ctx()), { code: 'BAD_REQUEST' });
  assert.equal(f.standin.calls.length, 0);
  assert.equal(f.gate.calls.length, 0);
});

test('with only the GTX 1080 allowed even big models use it and the arbiter is never contacted', async () => {
  const f = fakes();
  const r = createRunner({ config: config({ allowedDevices: ['gtx1080'], arbiterUrl: '' }), standin: f.standin, gateImpl: f.gate.impl, log: quiet });
  await r.run(job({ params: { model: 'stable-diffusion-xl-base', prompt: 'x' } }), ctx());
  assert.equal(f.gate.calls.length, 0);
  assert.equal(f.standin.envAtGenerate, '1');
});

test('with only the V100 allowed small models use it (through the arbiter)', async () => {
  const f = fakes();
  await createRunner({ config: config({ allowedDevices: ['v100'] }), standin: f.standin, gateImpl: f.gate.impl, log: quiet }).run(job(), ctx());
  assert.equal(f.gate.calls.length, 1);
});

test('no allowed device at all is refused', async () => {
  const f = fakes();
  await assert.rejects(() => createRunner({ config: config({ allowedDevices: [] }), standin: f.standin, gateImpl: f.gate.impl, log: quiet }).run(job(), ctx()), { code: 'DEVICE_NOT_ALLOWED' });
});
```

`test/server.test.js` - in `boot()` change the config literal to `{ token, gpuEnabled: true, outputsDir, allowedDevices: ['gtx1080'] }` and in the first test add after `assert.equal(health.channels, 3);`:
```js
    assert.deepEqual(health.allowedDevices, ['gtx1080']);
```

`test/boot.test.js` - after `assert.equal(health.channels, 15);` add:
```js
    assert.deepEqual(health.allowedDevices, ['v100', 'gtx1080']);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: FAIL - `allowedDevices` undefined; runner tests fail on device selection.

- [ ] **Step 3: Write the implementation**

`src/config.js` - after the `gpuEnabled` line add:
```js
    allowedDevices: (env.OGAI_ALLOWED_DEVICES || 'v100,gtx1080').split(',').map((d) => d.trim().toLowerCase()).filter((d) => d === 'v100' || d === 'gtx1080'),
```

`src/runner.js` - add `const { assess } = require('./catalog');` under the `./gate` require, and this above `createRunner`:
```js
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
```
and in `runSdcpp` replace the first two lines
```js
    const { device, ...engineParams } = job.params;
    const onGtx1080 = device === 'gtx1080';
```
with
```js
    const { device: requested, ...engineParams } = job.params;
    const known = assess(engineParams.model);
    const onGtx1080 = chooseDevice(requested, config.allowedDevices, known && known.weightsGb) === 'gtx1080';
```

`src/server.js` - change the health line to
```js
    if (method === 'GET' && pathname === '/health') return send(res, 200, { ok: true, gpuEnabled: config.gpuEnabled, allowedDevices: config.allowedDevices, channels: standin.channels().length });
```

`src/mcp.js` - change the `device` property description to
```js
        device: { type: 'string', enum: ['v100', 'gtx1080'], description: 'Default: gtx1080 for small models (never evicts the Hermes brain), v100 for big ones. Only devices enabled on this deployment are accepted.' },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS (all previous tests plus the new ones).

- [ ] **Step 5: Commit**

```bash
git add custom/local-service
git commit -m "feat(local): device policy - allowed devices, brain-safe default lane

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Version-aware bundled-binary sync

**Files:**
- Create: `custom/local-service/src/bundle.js`
- Modify: `custom/local-service/src/index.js`
- Test: `custom/local-service/test/bundle.test.js`

**Interfaces:**
- Produces: `syncBundledBinary({resourcesPath, userDataPath, platform?, arch?}) -> {synced: boolean, reason?, version?, replaced?}`. Copies `<resourcesPath>/local-ai/<platform>-<arch>/bin` to `<userDataPath>/local-ai/bin` when its `BUNDLE_VERSION` file differs from the installed copy's, replacing the `bin` directory wholesale and leaving the sibling `models` directory alone. (Upstream's `ensureBundledBinaryInstalled` only copies when the binary is absent, so without this a rebuilt image would silently keep running a stale sd-cli from the persistent volume.)

- [ ] **Step 1: Write the failing test**

<!-- file: custom/local-service/test/bundle.test.js -->
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBundledBinary } = require('../src/bundle');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-bundle-'));
const PLATFORM = `${process.platform}-${process.arch}`;

function makeBundle(version, files = { 'sd-cli': 'binary-v' }) {
  const resources = tmp();
  const bin = path.join(resources, 'local-ai', PLATFORM, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(bin, name), body + version);
  if (version) fs.writeFileSync(path.join(bin, 'BUNDLE_VERSION'), `${version}\n`);
  return resources;
}

test('nothing to do without a bundle', () => {
  assert.deepEqual(syncBundledBinary({ resourcesPath: '', userDataPath: tmp() }), { synced: false, reason: 'no bundled binary configured' });
  const noStamp = makeBundle('');
  assert.equal(syncBundledBinary({ resourcesPath: noStamp, userDataPath: tmp() }).synced, false);
  assert.match(syncBundledBinary({ resourcesPath: noStamp, userDataPath: tmp() }).reason, /BUNDLE_VERSION/);
});

test('first boot copies the bundle into <userData>/local-ai/bin', () => {
  const userData = tmp();
  const result = syncBundledBinary({ resourcesPath: makeBundle('v1'), userDataPath: userData });
  assert.deepEqual(result, { synced: true, version: 'v1', replaced: null });
  assert.equal(fs.readFileSync(path.join(userData, 'local-ai', 'bin', 'sd-cli'), 'utf8'), 'binary-vv1');
});

test('the same version is left alone (no needless multi-hundred-MB copy)', () => {
  const userData = tmp();
  const resources = makeBundle('v1');
  syncBundledBinary({ resourcesPath: resources, userDataPath: userData });
  fs.writeFileSync(path.join(userData, 'local-ai', 'bin', 'marker'), 'x');
  const again = syncBundledBinary({ resourcesPath: resources, userDataPath: userData });
  assert.deepEqual(again, { synced: false, reason: 'up to date', version: 'v1' });
  assert.ok(fs.existsSync(path.join(userData, 'local-ai', 'bin', 'marker')));
});

test('a new image version replaces bin wholesale (stale files gone) but never touches downloaded models', () => {
  const userData = tmp();
  syncBundledBinary({ resourcesPath: makeBundle('v1', { 'sd-cli': 'old', 'libold.so': 'old' }), userDataPath: userData });
  const models = path.join(userData, 'local-ai', 'models');
  fs.mkdirSync(models, { recursive: true });
  fs.writeFileSync(path.join(models, 'dreamshaper.safetensors'), 'weights');

  const result = syncBundledBinary({ resourcesPath: makeBundle('v2', { 'sd-cli': 'new' }), userDataPath: userData });
  assert.deepEqual(result, { synced: true, version: 'v2', replaced: 'v1' });
  assert.equal(fs.readFileSync(path.join(userData, 'local-ai', 'bin', 'sd-cli'), 'utf8'), 'newv2');
  assert.equal(fs.existsSync(path.join(userData, 'local-ai', 'bin', 'libold.so')), false);
  assert.equal(fs.readFileSync(path.join(models, 'dreamshaper.safetensors'), 'utf8'), 'weights');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd custom/local-service && node --test test/bundle.test.js`
Expected: FAIL - `Cannot find module '../src/bundle'`.

- [ ] **Step 3: Write the implementation**

<!-- file: custom/local-service/src/bundle.js -->
```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Keep <userData>/local-ai/bin in step with the sd.cpp bundle baked into the image.
 * Upstream's ensureBundledBinaryInstalled() copies only when the binary is missing, so after an image
 * upgrade the persistent volume would keep serving the OLD sd-cli. We compare BUNDLE_VERSION stamps.
 */
function syncBundledBinary({ resourcesPath, userDataPath, platform = process.platform, arch = process.arch }) {
  if (!resourcesPath) return { synced: false, reason: 'no bundled binary configured' };
  const source = path.join(resourcesPath, 'local-ai', `${platform}-${arch}`, 'bin');
  const stamp = path.join(source, 'BUNDLE_VERSION');
  if (!fs.existsSync(stamp)) return { synced: false, reason: `bundle has no BUNDLE_VERSION at ${source}` };

  const version = fs.readFileSync(stamp, 'utf8').trim();
  const dest = path.join(userDataPath, 'local-ai', 'bin');
  const installedStamp = path.join(dest, 'BUNDLE_VERSION');
  const current = fs.existsSync(installedStamp) ? fs.readFileSync(installedStamp, 'utf8').trim() : null;
  if (current === version) return { synced: false, reason: 'up to date', version };

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, dest, { recursive: true });
  return { synced: true, version, replaced: current };
}

module.exports = { syncBundledBinary };
```

In `src/index.js`, add `const { syncBundledBinary } = require('./bundle');` with the other requires and, after `fs.mkdirSync(config.outputsDir, ...)`, add:
```js
const bundle = syncBundledBinary({ resourcesPath: config.resourcesPath, userDataPath: config.dataDir });
console.log(`sd.cpp bundle: ${bundle.synced ? `installed ${bundle.version} (replaced ${bundle.replaced || 'nothing'})` : bundle.reason}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd custom/local-service && node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add custom/local-service
git commit -m "feat(local): version-aware sd.cpp bundle sync (image upgrades must not leave a stale binary on the volume)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: sd.cpp CUDA build recipe

**Files:**
- Create: `custom/local-service/build-sdcpp.sh`, `custom/local-service/sdcpp-inner.sh`, `custom/local-service/.gitignore`

**Interfaces:**
- Produces: `custom/local-service/vendor/sdcpp/` containing `sd-cli`, the CUDA runtime libs it links (`libcudart*`, `libcublas*`, `libcublasLt*`) and `libgomp*`, plus `BUNDLE_VERSION` (`<ref> cuda12.6 sm61+sm70 avx-only`). `vendor/` is git-ignored.

- [ ] **Step 1: Write the build scripts**

<!-- file: custom/local-service/.gitignore -->
```
# compiled sd.cpp + CUDA libs (hundreds of MB) - produced by build-sdcpp.sh
vendor/
```

<!-- file: custom/local-service/build-sdcpp.sh -->
```bash
#!/usr/bin/env bash
# Compile stable-diffusion.cpp (sd-cli) with CUDA for the V100 (sm_70) and the GTX 1080 (sm_61) inside a
# resource-limited builder container; stage the binary + the libs it needs under vendor/sdcpp/.
#
# Why we build it ourselves: upstream's Linux release zips are CPU/Vulkan/ROCm only, and this host's Xeon E5-2689
# has no AVX2/FMA/F16C, so ggml's CPU code must be built AVX-only. CUDA must be 12.x: CUDA 13 dropped sm_61/sm_70.
#
#   custom/local-service/build-sdcpp.sh [git-ref]        default ref: master-881-17860c0
#   OGAI_BUILD_IMAGE  builder image with nvcc 12.x (default nvidia/cuda:12.6.3-devel-ubuntu22.04). An image that already
#                     ships nvcc + g++ + cmake + git + objdump skips the package install, which is very slow on a busy host.
#   OGAI_BUILD_JOBS (3)   OGAI_BUILD_DIR (build tree; keep it off docker.img)
set -euo pipefail
cd "$(dirname "$0")"
REF=${1:-master-881-17860c0}
IMAGE=${OGAI_BUILD_IMAGE:-nvidia/cuda:12.6.3-devel-ubuntu22.04}
OUT=$PWD/vendor/sdcpp
WORK=${OGAI_BUILD_DIR:-/mnt/user/appdata/open-generative-ai/build/sdcpp}
JOBS=${OGAI_BUILD_JOBS:-3}

mkdir -p "$WORK"
rm -rf "$OUT"; mkdir -p "$OUT"

# Memory/CPU caps: nvcc instantiates huge ggml-cuda templates; on this box a runaway build starves everything else.
docker run --rm --name ogai-sdcpp-build \
  --memory=8g --memory-swap=8g --cpus=6 --cpu-shares=128 \
  -v "$WORK:/work" -v "$OUT:/out" -v "$PWD/sdcpp-inner.sh:/inner.sh:ro" \
  -e REF="$REF" -e JOBS="$JOBS" \
  --entrypoint bash "$IMAGE" /inner.sh

echo "staged in $OUT:"; ls -la "$OUT"
```

<!-- file: custom/local-service/sdcpp-inner.sh -->
```bash
#!/usr/bin/env bash
# Runs INSIDE the builder container (see build-sdcpp.sh).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Only install a toolchain if the image lacks one. dpkg fsyncs every file, which on this host's contended
# loop-backed docker.img made the install take ~30 min, so skip fsync (the container is disposable).
need_apt=0
for tool in cmake g++ git objdump; do command -v "$tool" >/dev/null 2>&1 || need_apt=1; done
if [ "$need_apt" = 1 ]; then
  echo 'force-unsafe-io' > /etc/dpkg/dpkg.cfg.d/99-unsafe-io
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends git cmake build-essential ca-certificates libgomp1 >/dev/null
fi
export TMPDIR=/work/tmp    # compiler temp files on the appdata mount, not docker.img
mkdir -p "$TMPDIR"

cd /work
[ -d sd.cpp/.git ] || git clone -q https://github.com/leejet/stable-diffusion.cpp sd.cpp
cd sd.cpp
git fetch -q --tags
git checkout -q "$REF"
git submodule update -q --init --recursive

# CPU side: AVX only (host has no AVX2/FMA/F16C/BMI2/AVX512). GPU side: Pascal (61) + Volta (70).
# SD_WEBP=OFF/SD_WEBM=OFF (WebM requires WebP): we only write PNG, and libwebp ships runtime-dispatched *_AVX2 functions (never called without
# CPUID support, but they would trip the strict instruction guard below and make it impossible to reason about).
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DSD_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="61;70" \
  -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_BMI2=OFF -DGGML_AVX512=OFF \
  -DSD_WEBP=OFF -DSD_WEBM=OFF
nice -n 19 cmake --build build --config Release --target sd-cli -j "$JOBS"

BIN=$(find build -type f -name sd-cli | head -1)
[ -n "$BIN" ] || { echo "sd-cli was not produced" >&2; exit 1; }
cp "$BIN" /out/sd-cli

# Illegal-instruction guard: the CPU code must not contain AVX2/FMA/F16C/BMI2 instructions.
BAD=$(objdump -d --no-show-raw-insn /out/sd-cli | grep -cE '\b(vfmadd[0-9a-z]*|vfnmadd[0-9a-z]*|vpermd|vperm2i128|vpbroadcast[bdwq]|vinserti128|vextracti128|vpgatherd[dq]|vcvtph2ps|vcvtps2ph|shlx|shrx|sarx|pdep|pext)\b' || true)
echo "AVX2/FMA/F16C/BMI2 instructions in sd-cli: $BAD"
if [ "$BAD" != 0 ]; then
  echo "sd-cli contains instructions this CPU cannot run; offending functions:" >&2
  objdump -d --no-show-raw-insn /out/sd-cli | awk '/^[0-9a-f]+ <.*>:$/ { fn=$2 } /\t(vfmadd[0-9a-z]*|vfnmadd[0-9a-z]*|vpermd|vperm2i128|vpbroadcast[bdwq]|vinserti128|vextracti128|vpgatherd[dq]|vcvtph2ps|vcvtps2ph|shlx|shrx|sarx|pdep|pext)[ \t]/ { c[fn]++ } END { for (f in c) printf "%3d  %s\n", c[f], f }' | sort -rn | head -15 >&2
  exit 1
fi

# Runtime libs the binary links against (the NVIDIA runtime injects libcuda at container start). libnccl is linked because
# ggml-cuda auto-detects it (GGML_USE_NCCL is a global define, so disabling it would mean recompiling every CUDA kernel);
# single-GPU jobs never initialise it, we just have to ship it so the dynamic loader finds it.
ldd /out/sd-cli | awk '/=> \//{print $3}' | grep -E 'libcudart|libcublas|libgomp|libnccl' | while read -r lib; do cp -L "$lib" /out/; done
CUDA_VER=$(nvcc --version | sed -n 's/.*release \([0-9.]*\),.*/\1/p')
echo "$REF cuda$CUDA_VER sm61+sm70 avx-only" > /out/BUNDLE_VERSION
chmod -R a+rX /out
echo "--- linked libs ---"; ldd /out/sd-cli
```

- [ ] **Step 2: Syntax-check the scripts**

Run: `bash -n custom/local-service/build-sdcpp.sh && bash -n custom/local-service/sdcpp-inner.sh && echo ok`
Expected: `ok`

- [ ] **Step 3: Run the build (long: pull already done; compile 15-40 min under the resource caps)**

Run: `cd custom/local-service && ./build-sdcpp.sh 2>&1 | tail -40`
Expected: ends with `AVX2/FMA/F16C/BMI2 instructions in sd-cli: 0`, the `ldd` listing, and `vendor/sdcpp` holding `sd-cli`, `libcudart*`, `libcublas*`, `libcublasLt*`, `libgomp*`, `BUNDLE_VERSION`.

- [ ] **Step 4: Commit**

```bash
git add custom/local-service
git commit -m "feat(local): sd.cpp CUDA build recipe (sm61+sm70, AVX-only CPU, resource-capped builder)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Image, deploy script, template

**Files:**
- Modify: `custom/local-service/Dockerfile`, `custom/local-service/deploy.sh`, `custom/local-service/README.md`, `custom/unraid/my-ogai-local.xml`

**Interfaces:**
- Consumes: `vendor/sdcpp/` from Task 3, `syncBundledBinary` (Task 2), `allowedDevices` (Task 1)
- Produces: image with the bundle at `/opt/ogai/resources/local-ai/linux-x64/bin`; `deploy.sh` honours `OGAI_GPU_DEVICES` (docker `--gpus device=...`), `OGAI_ALLOWED_DEVICES`, `OGAI_DEVICE_INDEX_V100`, `OGAI_DEVICE_INDEX_1080`

- [ ] **Step 1: Update the Dockerfile** - right after `WORKDIR /srv` (before the service-code COPYs, so code edits never invalidate the ~1.3GB bundle layer) add:
```dockerfile
# sd.cpp built with CUDA by build-sdcpp.sh (run it first). The stand-in presents this directory to upstream's
# engine as its "bundled binary", so the upstream CPU-only download is never used.
COPY custom/local-service/vendor/sdcpp/ /opt/ogai/resources/local-ai/linux-x64/bin/
```
and change the `ENV` line to
```dockerfile
ENV OGAI_UPSTREAM_DIR=/app OGAI_DATA_DIR=/data OGAI_LOCAL_PORT=8790 OGAI_RESOURCES_PATH=/opt/ogai/resources NODE_ENV=production NVIDIA_DRIVER_CAPABILITIES=compute,utility
```

- [ ] **Step 2: Update deploy.sh** - replace the header comment's env list and the `docker run` with GPU support:
  - add to the comment block: `#   OGAI_GPU_DEVICES   docker --gpus device=<id-or-uuid>[,..]; empty = the container sees NO GPU`, `#   OGAI_ALLOWED_DEVICES  which of v100,gtx1080 jobs may use (default v100,gtx1080)`, `#   OGAI_DEVICE_INDEX_V100 / OGAI_DEVICE_INDEX_1080  CUDA index INSIDE the container`
  - before `docker rm -f`: `GPU_ARGS=(); [ -n "${OGAI_GPU_DEVICES:-}" ] && GPU_ARGS=(--gpus "device=${OGAI_GPU_DEVICES}")`
  - in `docker run` add `"${GPU_ARGS[@]}" \` after `-v "$DATA:/data" \` and add env lines:
```bash
  -e OGAI_ALLOWED_DEVICES="${OGAI_ALLOWED_DEVICES:-v100,gtx1080}" \
  -e OGAI_DEVICE_INDEX_V100="${OGAI_DEVICE_INDEX_V100:-0}" \
  -e OGAI_DEVICE_INDEX_1080="${OGAI_DEVICE_INDEX_1080:-1}" \
```

- [ ] **Step 3: Update the Unraid template** - add three `<Config>` entries (`OGAI_ALLOWED_DEVICES`, `OGAI_DEVICE_INDEX_V100`, `OGAI_DEVICE_INDEX_1080`) and mention `--gpus device=<uuid>` in ExtraParams' description in the Overview.

- [ ] **Step 4: Update the README** - add a "GPU access" section: build order (`build-sdcpp.sh` then `deploy.sh --build`), the first-deployment recipe (`OGAI_GPU_DEVICES=<1080 uuid> OGAI_ALLOWED_DEVICES=gtx1080 OGAI_DEVICE_INDEX_1080=0`), and that `vendor/` must exist before the image builds.

- [ ] **Step 5: Build the image and verify without a GPU**

Run: `cd /mnt/user/data/Projects/UnraidDev/Open-Generative-AI && docker build -t ogai-local:latest -f custom/local-service/Dockerfile . 2>&1 | tail -5 && docker run --rm ogai-local:latest sh -c 'ls /opt/ogai/resources/local-ai/linux-x64/bin | head; cat /opt/ogai/resources/local-ai/linux-x64/bin/BUNDLE_VERSION'`
Expected: build succeeds; listing shows `sd-cli`, CUDA libs, `BUNDLE_VERSION`.

- [ ] **Step 6: Commit**

```bash
git add custom
git commit -m "feat(local): bundle CUDA sd.cpp in the image; deploy.sh GPU/device options

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Real render on the GTX 1080 lane (V100 unreachable)

**Files:** none (verification only; results go to the project memory note)

- [ ] **Step 1: Deploy 1080-only** - `OGAI_GPU_DEVICES=GPU-104c1f82-1a1b-38d4-77c3-a84e3cb00269 OGAI_ALLOWED_DEVICES=gtx1080 OGAI_DEVICE_INDEX_1080=0 OGAI_GPU_ENABLED=1 custom/local-service/deploy.sh`  (no `OGAI_ARBITER_URL`).
  Expected: healthy; `/health` shows `gpuEnabled: true, allowedDevices: ["gtx1080"]`.
- [ ] **Step 2: Prove the V100 is invisible** - `docker exec ogai-local nvidia-smi -L` lists exactly one GPU (the GTX 1080). Expected: no V100 line.
- [ ] **Step 3: sd-cli starts on this CPU (no SIGILL) and sees CUDA** - `docker exec ogai-local /root/...` (the copied binary under `/data/local-ai/bin/sd-cli`) `--help` exits 0; `ldd` has no `not found` except none.
- [ ] **Step 4: Download the smallest model through the service** - `POST /ipc/local-ai:download-model` with `dreamshaper-8` (SD 1.5, 2.1GB); poll `local-ai:list-models` until its state is downloaded.
- [ ] **Step 5: Render via MCP `local_generate_image`** (`model: dreamshaper-8`, default device, `wait_seconds: 300`). Expected: `status: done`, a PNG in `/outputs`, non-black (mean/std brightness > 0), the V100's used VRAM unchanged (~29.2GB), `kokoro-lab` still healthy.
- [ ] **Step 6: Try Z-Image Turbo on the 1080** (download ~5.2GB, render 1) and record whether it fits the ~6GB free VRAM. An out-of-memory result is a valid finding: record it, do not work around it silently.

---

## Self-Review

- Spec decisions covered: unmodified upstream engine via bundled-binary path (Tasks 2, 4); GPU off/isolated by default and the 1080 lane never evicts the brain (Tasks 1, 5); Volta/Pascal + no-AVX2 constraints (Task 3); update-safety of the bundled binary (Task 2).
- Types/names: `allowedDevices`, `chooseDevice`, `syncBundledBinary`, `BUNDLE_VERSION`, `OGAI_RESOURCES_PATH` are used identically across tasks and match the core plan's `config.resourcesPath`/`loadEngines({resourcesPath})`.
- Out of scope (next plans): V100 enablement + arbiter registry entry, WanGP/ComfyUI adapters, web UI + `window.localAI` shim.
