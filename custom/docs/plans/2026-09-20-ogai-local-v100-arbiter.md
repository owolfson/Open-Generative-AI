# V100 enablement + gpu-arbiter registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `ogai-local` run jobs on the V100 through gpu-arbiter, registered as a first-class consumer, without ever evicting the Hermes brain by accident.

**Architecture:** (1) A device policy that makes the V100 opt-in per call. (2) `ogai-local` registered in the arbiter (`PRIORITIES`, `CONSUMER_PEAK_VRAM_GB`, and `_UI_ONLY_CONSUMER_ALIASES` so an always-on container does not block ambient restoration). (3) The container sees both GPUs and knows the arbiter URL. (4) One supervised live V100 job proves the acquire / evict / release / restore cycle.

**Tech Stack:** Node >= 20 (no deps), `node:test`, the arbiter's Python `app.py` (bind-mounted read-only), Docker compose project `hermes`.

**Spec:** `custom/docs/specs/2026-09-19-ogai-local-design.md`; builds on `2026-09-20-ogai-local-sdcpp-cuda.md`.

## Global Constraints

- **What a V100 lease does (read from arbiter `grant_lease`, 2026-09-20):** on ANY grant it stops `hermes-llm` (brain), `speaches-chatterbox` (TTS) and `ltx-desktop`; on release, once the queue drains and the card is clear, `_restore_ambient_peers_if_clear` starts them again. So every V100 job costs the brain and TTS the job's duration plus their reload time.
- Registry names MUST equal the real `docker ps` container name (`ogai-local`), or the safety check treats the consumer as unknown.
- `_persistent_holder_running()` treats any registered consumer whose container is merely *running* as a holder and blocks ambient restoration. `ogai-local` is always running but holds VRAM only inside a lease, so it MUST be added to `_UI_ONLY_CONSUMER_ALIASES` (the documented ace-step-ui fix).
- The arbiter file is edited only with a timestamped backup, `python3 -m py_compile` before recreate, and only while no lease is held and the queue is empty. Recreate via compose (`--no-deps`), never bare `docker restart` (recorded mount-loss incident).
- The V100 is opt-in per call: an agent that does not pass `device: "v100"` must never trigger an eviction. Refusal from the arbiter (409) must never be worked around; the job just fails.
- One live V100 test only, with the arbiter, `hermes-llm`, TTS and VRAM watched throughout; abort criteria are stated in Task 4.
- Host-specific values (GPU uuids, arbiter URL) live in `$OGAI_DATA/deploy.env`, never in the repo.
- Commits end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

### Task 1: V100 is opt-in (device policy)

**Files:** Modify `custom/local-service/src/runner.js`, `custom/local-service/src/mcp.js`; Test `custom/local-service/test/runner.test.js`.

**Interfaces:** `chooseDevice(requested, allowed, weightsGb)`. With no device requested: a model that fits the 1080 (`weightsGb <= 5.5`) and `gtx1080` allowed -> `gtx1080`; only `v100` allowed -> `v100`; only `gtx1080` allowed -> `gtx1080`; BOTH allowed but the model does not fit the 1080 -> throws `DEVICE_REQUIRED` (tell the caller to pass `device:"v100"` and state the consequence). Explicit `device` rules are unchanged.

- [ ] **Step 1: Write the failing test** - in `test/runner.test.js` replace the second half of the test named `device policy: small models default to the GTX 1080 lane (no brain eviction), big ones to the V100` so the big-model case expects a refusal, and add a case proving an explicit request still works:
```js
  const big = fakes();
  const rb = createRunner({ config: config(), standin: big.standin, gateImpl: big.gate.impl, log: quiet });
  await assert.rejects(() => rb.run(job({ params: { model: 'stable-diffusion-xl-base', prompt: 'x' } }), ctx()), (err) => err.code === 'DEVICE_REQUIRED' && /v100/.test(err.message) && /Hermes brain/.test(err.message));
  assert.equal(big.gate.calls.length, 0);          // never touched the arbiter
  assert.equal(big.standin.calls.length, 0);        // never ran anything
  await rb.run(job({ params: { model: 'stable-diffusion-xl-base', prompt: 'x', device: 'v100' } }), ctx());
  assert.equal(big.gate.calls.length, 1);           // an explicit request goes through the arbiter
  assert.equal(big.standin.envAtGenerate, '0');
```
(and rename the test to `device policy: small models default to the GTX 1080 lane; a model that needs the V100 must ask for it explicitly`).

- [ ] **Step 2: Run it to see it fail** - `cd custom/local-service && node --test test/*.test.js` - Expected: that test FAILS (the code still auto-selects the V100).

- [ ] **Step 3: Implement** - in `chooseDevice` (`src/runner.js`) replace the "No device asked for" block with:
```js
  // No device asked for. The V100 is never chosen implicitly when the GTX 1080 exists: a V100 lease stops the
  // Hermes brain and the TTS, so an agent must ask for it by name.
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
```
and in `src/mcp.js` change the `device` description to `Default: gtx1080 for models that fit it. Anything bigger needs device:"v100" explicitly - that runs through the GPU arbiter and stops the Hermes brain and the TTS for the duration of the job. Only devices enabled on this deployment are accepted.`

- [ ] **Step 4: Run tests** - `node --test test/*.test.js` - Expected: all PASS.

- [ ] **Step 5: Commit** - `git add custom/local-service && git commit -m "feat(local): the V100 is opt-in per call (never chosen implicitly)"`.

---

### Task 2: Register `ogai-local` in gpu-arbiter

**Files:** `/mnt/user/appdata/gpu-arbiter/app.py` (host file, bind-mounted RO into the `gpu-arbiter` container); record the change in `custom/local-service/README.md`.

- [ ] **Step 1: Preconditions** - `GET :6001/status` shows `current_lease: null` and an empty queue; `wan2gp`, `comfy*`, `aria-latentsync`, `ltx-desktop` are not running.
- [ ] **Step 2: Backup** - `cp -p app.py app.py.bak-ogai-local-$(date +%Y%m%d-%H%M%S)`.
- [ ] **Step 3: Three exact edits** (each `old` string must match exactly once):
  1. `PRIORITIES`: after `"wan2gp": 4,` add `"ogai-local": 4,`.
  2. `CONSUMER_PEAK_VRAM_GB`: add `"ogai-local": 10.0,` with the comment `# sd.cpp jobs via ogai-local (Z-Image Turbo/Base, SDXL). Measured ~5.5GB of its own at 1024px on the GTX 1080 (2026-09-20); 10 is conservative. Container is always up but holds VRAM only inside a lease.`
  3. `_UI_ONLY_CONSUMER_ALIASES = {"ace-step-ui", "ace-step", "ace_step"}` -> add `"ogai-local"` with a comment explaining it is always-on and job-scoped, so it must not count as a persistent holder.
- [ ] **Step 4: Syntax check** - `python3 -m py_compile app.py`.
- [ ] **Step 5: Recreate via compose** - `cd /boot/config/plugins/compose.manager/projects/Hermes && docker compose -p hermes up -d --no-deps --force-recreate gpu-arbiter`; then verify the container has the docker.sock mount, the `app.py` bind mount, `LLAMACPP_CONTAINERS=hermes-llm`, `IDLE_SWAP_BACK_SEC=0`.
- [ ] **Step 6: Verify without side effects** - `GET :6001/gpu/state` lists `ogai-local` in `can_fit`; `GET :6001/gpu/ambient_safe` still reports safe; `hermes-llm` untouched (same `StartedAt`).

---

### Task 3: Two-GPU deployment with the arbiter URL

**Files:** Modify `custom/local-service/deploy.sh`; host file `$OGAI_DATA/deploy.env`.

- [ ] **Step 1: Quote the `--gpus` value** - Docker parses `--gpus device=A,B` as two keys; wrap it: `GPU_ARGS=(--gpus "\"device=${OGAI_GPU_DEVICES}\"")` (a single device keeps working).
- [ ] **Step 2: Host settings** - in `deploy.env` set `OGAI_GPU_DEVICES=<V100 uuid>,<GTX 1080 uuid>`, `OGAI_ALLOWED_DEVICES=v100,gtx1080`, `OGAI_DEVICE_INDEX_V100=0`, `OGAI_DEVICE_INDEX_1080=1`, `OGAI_ARBITER_URL=http://<host>:6001`.
- [ ] **Step 3: Redeploy and verify** - `deploy.sh`; inside the container `nvidia-smi -L` lists BOTH GPUs and the CUDA order is V100 = 0, GTX 1080 = 1; `/health` reports `allowedDevices: ["v100","gtx1080"]`; the 1080 lane still works with no arbiter traffic (arbiter history unchanged after a 1080 job).

---

### Task 4: One supervised live V100 job

- [ ] **Step 1: Preconditions** - arbiter idle (no lease, empty queue), Task 2 registration live, brain healthy, TTS up. Record: `hermes-llm` / `speaches-chatterbox` StartedAt, V100 used MiB, arbiter history tail.
- [ ] **Step 2: Run** - MCP `local_generate_image` with `model: z-image-turbo`, `device: "v100"` (the same prompt as the 1080 run, for a like-for-like time), `wait_seconds` large.
- [ ] **Step 3: Watch** - poll arbiter `/status` + V100 VRAM + container states every few seconds. Expected event order in arbiter history: grant to `ogai-local` -> (brain and TTS stopped) -> release -> restore (`hermes-llm`, then TTS started).
- [ ] **Step 4: Verify the outcome, not just the job** - image is real and not black; V100 was used (VRAM sampled from inside the lease, and the render time differs from the 1080's 204s); arbiter `current_lease` is null; `hermes-llm` is healthy again and V100 memory is back near its pre-test level; TTS is back; total brain downtime is recorded.
- **Abort criteria (act immediately, do not wait for the job):** the arbiter answers 409 for anything but a benign reason; `hermes-llm` does not begin restoring within 3 minutes of release; V100 memory does not fall after the job ends; any container crash-loops; host load or swap gets worse than before the test. Abort means: release the lease if held, and let the arbiter restore the brain, or start `hermes-llm` through the arbiter's own `/swap-to/hermes-llm`; never start the brain by hand on top of a resident holder.

---

## Self-Review

- Constraints map to tasks: opt-in V100 (Task 1), registry + always-on trap (Task 2), isolation config (Task 3), supervised proof with abort rules (Task 4).
- Names used consistently: `chooseDevice`, `DEVICE_REQUIRED`, `ogai-local`, `_UI_ONLY_CONSUMER_ALIASES`, `deploy.env`.
- Deferred to the next plan: WanGP / ComfyUI(Qwen) adapters. They need container start/stop control (their containers must be stopped after a job or they block ambient restoration) and `ogai-local` has no docker socket by design, so that plan must decide how (a small privileged helper, or the arbiter's own swap endpoints).
