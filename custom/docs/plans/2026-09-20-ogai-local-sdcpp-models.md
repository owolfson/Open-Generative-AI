# sd.cpp model coverage (Flux, Qwen-Image, Wan 2.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Flux.1 Dev, Qwen-Image 2512 and Wan 2.2 I2V from the sd.cpp binary `ogai-local` already bundles (like Ollama serves models from llama.cpp), reading the model files already on disk from the ComfyUI setups, with every V100 run going through the registered gpu-arbiter lease. This REPLACES the earlier WanGP/ComfyUI-adapter plan.

**Architecture:** A spec table (`src/sdcpp-models.js`) maps catalog ids to model files + sd-cli arguments. A generic runner (`src/sdcpp.js`) spawns `sd-cli` (progress via upstream's own parser). The job runner checks the files exist BEFORE taking a lease, uses a per-model VRAM declaration, and keeps ONE arbiter lease across consecutive queued V100 jobs. Upstream's engine keeps serving its own six models (Z-Image, SD1.5, SDXL).

**Tech Stack:** Node >= 20 (no npm deps), `node:test`, sd.cpp `master-881-17860c0` (CUDA 12.8, sm61+sm70).

**Spec:** `custom/docs/specs/2026-09-19-ogai-local-design.md`; builds on the sdcpp-cuda and v100-arbiter plans.

## Global Constraints

- sd.cpp commands come from its own docs (`build/sdcpp/sd.cpp/docs/{flux,qwen_image,wan}.md`): Flux `--diffusion-model <gguf> --vae ae --clip_l --t5xxl --cfg-scale 1 --sampling-method euler`; Qwen-Image `--diffusion-model --vae --llm --cfg-scale 2.5 --sampling-method euler --diffusion-fa --flow-shift 3`; Wan 2.2 A14B `-M vid_gen --diffusion-model <LowNoise> --high-noise-diffusion-model <HighNoise> --vae <wan_2.1_vae> --t5xxl <umt5> --cfg-scale 3.5 --sampling-method euler --steps N --high-noise-cfg-scale 3.5 --high-noise-sampling-method euler --high-noise-steps N -n <neg> -W 832 -H 480 --diffusion-fa --video-frames 33 --flow-shift 3.0 -i <init image>`; lightx2v 4-step LoRAs via `<lora:NAME:1><lora:|high_noise|NAME:1>` in the prompt + `--lora-model-dir`, `--steps 4 --high-noise-steps 4`.
- The host CPU has no AVX2/F16C: never put text encoders on the CPU (`--clip-on-cpu`) for the V100 path - fp16 CPU compute is very slow here. Weights that do not fit are handled by sd.cpp's auto-fit / `--offload-to-cpu`, only if measured necessary.
- Video output is `.avi` (built into the binary; WebP/WebM are compiled out). Serve `.png` and `.avi` from `/outputs`.
- Model files are found by basename in `OGAI_MODEL_DIRS` (read-only mounts of the ComfyUI stores). A job whose files are missing fails with `MODEL_FILES_MISSING` BEFORE any arbiter lease (never evict the brain for a job that cannot run).
- The V100 stays opt-in per call (`device:"v100"`); big models cannot run on the GTX 1080.
- One arbiter lease may span consecutive queued V100 jobs, released when the next queued job is not a V100 job, needs more VRAM than leased, or the previous job failed; a stale `ogai-local` lease is released at service boot.
- Zero npm dependencies; tests: `node --test test/*.test.js` from `custom/local-service/`.
- Commits end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

### Task 1: Model specs + argument builders (`src/sdcpp-models.js`)

**Interfaces:** `SPECS` keyed by catalog id (`wan2gp:flux-dev`, `wan2gp:qwen-image`, `wan2gp:wan22-i2v`): `{ id, kind: 'image'|'video', ext: 'png'|'avi', files: {role: basename}, vramGb, defaults: {width,height,steps,cfg,...} }`. `getSpec(id) -> spec|undefined`. `resolveFiles(spec, dirs, fsImpl?) -> { files: {role: absPath}, missing: [basename] }` (searches each dir up to 3 levels deep). `buildArgs(spec, params, files, outPath) -> string[]` where `params = {prompt, negative_prompt?, width?, height?, steps?, cfg_scale?, seed?, video_frames?, fps?, init_image?}`; video without `init_image` throws `IMAGE_REQUIRED`.

- [ ] Write tests (flux/qwen/wan arg contents, LoRA tags, defaults vs overrides, `IMAGE_REQUIRED`, `resolveFiles` found/missing) -> see them fail -> implement -> pass -> commit.

### Task 2: Generic sd-cli runner (`src/sdcpp.js`)

**Interfaces:** `runSdCli({ binary, libDir, args, env, signal, onProgress, spawnImpl? }) -> Promise<{ output }>`. Progress lines are parsed with upstream's `parseGenerationProgressChunk` (loaded from `<upstreamDir>/electron/lib/localInferenceRuntime.js`, pure Node) and forwarded to `onProgress({step,totalSteps,progress,status})`. A non-zero exit rejects with `SDCLI_FAILED` (tail of output); an aborted signal kills the child (SIGTERM, then SIGKILL) and rejects with `CANCELLED`.

- [ ] Tests use a fake `sd-cli` shell script (prints progress, writes the `-o` file, exits 0/1, or sleeps to be killed) -> fail -> implement -> pass -> commit.

### Task 3: Runner routing, per-model VRAM, file pre-check, video artifacts

**Interfaces:** for `route: 'sdcpp'` jobs whose model has a spec, `run()` (a) resolves files and throws `MODEL_FILES_MISSING` (listing the basenames) BEFORE touching the arbiter, (b) leases with `spec.vramGb`, (c) spawns via `runSdCli`, (d) persists `<jobId>.<ext>` to the outputs dir and returns `{ seed, file, url, kind, mime, bytes, dataUrl? }` (`dataUrl` only for png). Catalog routes: Flux, Qwen, Wan I2V -> `sdcpp`. `/outputs` serves `.png` and `.avi`. `/ipc` generate returns `{url, seed}` with the file url for video.

- [ ] Tests with fakes for sdcpp/gate: missing-files never calls the gate; lease `vramGb` = spec; png vs avi artifacts; server serves avi with `video/x-msvideo`; catalog `filesPresent` flag -> fail -> implement -> pass -> commit.

### Task 4: Image input for image-to-video + MCP video tool

**Interfaces:** `submitGeneration` accepts `image_job_id` (output of an earlier done image job) or `image_base64`; resolves to a temp file passed as `init_image`; unknown/failed job -> `BAD_REQUEST`. MCP tool `local_generate_video {model, prompt, image_job_id|image_base64, width?, height?, video_frames?, fps?, steps?, device, wait_seconds?}`.

- [ ] Tests -> fail -> implement -> pass -> commit.

### Task 5: One V100 lease across a queued batch + stale-lease release at boot

**Interfaces (as built):** `JobQueue` passes `{ signal, pending() }` to `run` (`pending()` = jobs queued behind the running one, in order) and has `drain(timeoutMs)` for shutdown. `gate.acquireLease(cfg, opts, deps) -> { leaseId, release() }` (idempotent release; `withLease` is built on it; est_seconds capped at the arbiter's 14400). The runner owns the lease: it is sized for the running job plus the consecutive covered V100 jobs behind it (max VRAM, summed est_seconds, note `(+N queued)`), reused while the next job is a V100 job that fits the leased VRAM and remaining time, and released on failure/cancel, non-V100 next, bigger next, no next (10s idle grace), or `runner.shutdown()`. Jobs that would fail before the lease (missing files, bad params) never count as covered. `releaseStaleLease(cfg)` posts `/release {consumer}` at boot (best effort, never throws). SIGTERM: `queue.drain()` stops sd-cli first, then the lease is released.

- [ ] Tests (fake gate counting acquire/release: two V100 jobs -> 1 acquire; bigger second -> re-acquire; failure -> release; non-V100 next -> release; stale release posts once, tolerates failure) -> fail -> implement -> pass -> commit.

### Task 6: Deploy with the model mounts

- [ ] `deploy.sh`: `OGAI_MODEL_MOUNTS=host:container[,host:container]` -> read-only `-v`, and `OGAI_MODEL_DIRS` env; host settings in `deploy.env` mount `/mnt/user/appdata/comfy-imagegen/models` and `/mnt/user/appdata/comfyui-qwen-image/models`; rebuild + redeploy; verify `local_list_models` shows `filesPresent: true` for the three models and `sd-cli --help` still runs.

### Task 7: Supervised V100 batch (needs Owen's go-ahead: brain + TTS down ~10 min)

- [ ] ONE lease, three queued jobs: Flux (text-to-image) -> Qwen-Image -> Wan 2.2 I2V using the Flux image (`image_job_id`). Watch lease/brain/TTS/VRAM/host RAM with the v100 watcher. **Abort criteria:** any 409; V100 memory > 30GB; host RAM available < 3GB; a job running > 20 min; a container crash. Abort = cancel queued jobs, let the job finish or cancel it, release the lease, let the arbiter restore the brain; never start the brain by hand.
- [ ] Record per model: wall time, peak V100 memory, peak host RAM use, image quality, whether the on-disk fp8 text encoders load (else download GGUF text encoders). Tune `vramGb` and the arbiter registry if the peak exceeds the declaration.

---

## Results (2026-09-20)

- **Tasks 1-6 DONE, 121 tests green** (`cd custom/local-service && node --test test/*.test.js`). Commits: specs `d80d14f`, runner `0a24644`, extended path `8b605f8`, image-to-video input `f3dbefa`, lease batching `d9c4e10`, model mounts `485023c`.
- **Live (redeployed):** `ogai-local` mounts `/mnt/user/appdata/comfy-imagegen/models` -> `/models/flux` and `/mnt/user/appdata/comfyui-qwen-image/models` -> `/models/qwen` read-only (`OGAI_MODEL_MOUNTS` in the host-only `deploy.env`; `OGAI_MODEL_DIRS=/models/flux:/models/qwen`). `/api/local/catalog` reports `filesPresent: true` for Flux (22GB), Qwen-Image (24GB), Wan 2.2 I2V (26GB); `sd-cli` runs (needs `LD_LIBRARY_PATH` = its own dir, which the runner sets). Boot released no stale lease (arbiter `/release` = 200, nothing held).
- **Design deltas vs the plan text:** `pending()` (not `peek()`) is what the queue hands the runner; the runner OWNS the lease (`acquireImpl`), sized for the batch (max VRAM, summed est_seconds capped at the arbiter's 14400, `(+N queued)` in the note); a 10s idle timer frees a kept lease if the next job never starts; SIGTERM = `queue.drain()` (stops sd-cli) THEN release; boot prunes `tmpDir`.
- **Known unknown for Task 7:** the on-disk Qwen2.5-VL and UMT5 text encoders are ComfyUI `fp8_scaled` (`*.scale_weight` / `*.scale_input` tensors). sd.cpp renames `.scale_weight` -> `.weight_scale` and applies it in its Linear block, so they MAY load; unproven. If a job dies loading them, fetch GGUF/fp16 encoders (sd.cpp docs use `Qwen2.5-VL-7B-Instruct-Q8_0.gguf` and `umt5-xxl-encoder-Q8_0.gguf`) rather than debugging fp8.
- **Task 7 (supervised V100 batch) NOT run** - waits for Owen's go-ahead (brain + TTS go down ~10 min).

## Results, part 2 - supervised V100 runs (2026-09-20 evening) and GUI

Runs went through the runner + gpu-arbiter with a watcher (arbiter events, brain/TTS state, V100 + host RAM every 3s) and abort rules
(V100 > 30GB, host RAM < 3GB, job > 20 min, arbiter refusal). Every cycle restored the brain (~5-6 min) and TTS cleanly.

| Model | Result | Measured |
|---|---|---|
| Flux.1 Dev | PROVEN | 1024x1024, 20 steps: 160s total (~100s model load, ~1.6s/step); peak 28.8GB (22.8GB sampling + ~6GB VAE decode); quality good, slight mosaic grain in dark areas |
| Qwen-Image 2512 | PROVEN | 1024x1024, 20 steps: 187s (~100s load, ~3s/step); peak 24.5GB WITH `--vae-tiling` (31.9GB without: the >30GB abort rule fired, correctly); excellent, no black image; the fp8-scaled Qwen2.5-VL encoder loads |
| Wan 2.2 I2V | quality mode proven (by Gemini, job f8e6a6da, 640x368/33 frames, `--offload-to-cpu`); **NOT reproducible under normal host load** | see below |

Findings (each one changed the code):
- **Lease sizing**: the lease was sized for the first job only (Flux 22GB/900s); Qwen (24GB) submitted moments later could not share it. Now a V100 lease claims the whole card (min(max spec VRAM, 28GB arbiter budget)) for >= 1h, and `covers()` compares capped claims.
- **`--vae-tiling`** added to all three models (Qwen decode 31.9GB -> 24.5GB).
- **Wan "fast" mode (lightx2v LoRAs) is impossible here**: sd-cli aborts while loading the LoRAs in every `--lora-apply-mode` (`gguf_init_from_reader: tensor 'patch_embedding.weight' has invalid number of dimensions: 5 > 4`), reproduced CPU-only in seconds. Fast mode removed; `fast:true` fails up front (`FAST_UNAVAILABLE`).
- **Wan `--offload-to-cpu` is not viable on this host**: 25GB of weights become ~23.5GB of shmem in sd-cli; with the other containers (~24GB) `MemAvailable` fell to 2.4GB and the kernel OOM killer took sd-cli (job died after both sampling stages, while streaming weights back). The 3GB RAM guard is what kept this from being worse.
- **Wan without offload** (weights on the V100) samples fine but the VAE decode needs ~31.5GB peak (fails "wan_vae ... weight preparation") even with `--vae-tiling`.
- Next candidates (lean host RAM): `--temporal-tiling`, `--backend te=cpu` (T5 on the CPU, ~6.4GB RAM), see Results part 3 when run.
- Web GUI (Image + Video studios, Settings -> Local models, header chip, local-only sign-in): verified in a real browser; a Z-Image render on the GTX 1080 was driven end-to-end from the GUI (2m24s) and viewed in the GUI.

## Self-Review

- Covers: Flux/Qwen/Wan via sd.cpp (T1-T3), the I2V input path and MCP tool (T4), the downtime cost lesson (T5), deploy (T6), evidence with abort rules (T7).
- Names used consistently: `SPECS/getSpec/resolveFiles/buildArgs`, `runSdCli`, `MODEL_FILES_MISSING`, `IMAGE_REQUIRED`, `acquireLease`, `peek`.
- Not covered (explicitly): Wan 2.2 T2V (weights not on disk), Hunyuan/LTX/MiniMax-H3 (sd.cpp supports them; separate decision), WebM/MP4 output, web UI.
