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

**Interfaces:** `JobQueue` passes `{ signal, peek() }` to `run` (`peek` = next pending job or null). `gate.acquireLease(cfg, opts) -> { leaseId, release() }` (`withLease` reuses it). Runner keeps the lease while the next pending job is a V100 job needing <= the leased VRAM; releases on failure, non-V100 next, bigger next, or no next. `releaseStaleLease(cfg, fetchImpl)` posts `/release {consumer}` at boot (best effort).

- [ ] Tests (fake gate counting acquire/release: two V100 jobs -> 1 acquire; bigger second -> re-acquire; failure -> release; non-V100 next -> release; stale release posts once, tolerates failure) -> fail -> implement -> pass -> commit.

### Task 6: Deploy with the model mounts

- [ ] `deploy.sh`: `OGAI_MODEL_MOUNTS=host:container[,host:container]` -> read-only `-v`, and `OGAI_MODEL_DIRS` env; host settings in `deploy.env` mount `/mnt/user/appdata/comfy-imagegen/models` and `/mnt/user/appdata/comfyui-qwen-image/models`; rebuild + redeploy; verify `local_list_models` shows `filesPresent: true` for the three models and `sd-cli --help` still runs.

### Task 7: Supervised V100 batch (needs Owen's go-ahead: brain + TTS down ~10 min)

- [ ] ONE lease, three queued jobs: Flux (text-to-image) -> Qwen-Image -> Wan 2.2 I2V using the Flux image (`image_job_id`). Watch lease/brain/TTS/VRAM/host RAM with the v100 watcher. **Abort criteria:** any 409; V100 memory > 30GB; host RAM available < 3GB; a job running > 20 min; a container crash. Abort = cancel queued jobs, let the job finish or cancel it, release the lease, let the arbiter restore the brain; never start the brain by hand.
- [ ] Record per model: wall time, peak V100 memory, peak host RAM use, image quality, whether the on-disk fp8 text encoders load (else download GGUF text encoders). Tune `vramGb` and the arbiter registry if the peak exceeds the declaration.

---

## Self-Review

- Covers: Flux/Qwen/Wan via sd.cpp (T1-T3), the I2V input path and MCP tool (T4), the downtime cost lesson (T5), deploy (T6), evidence with abort rules (T7).
- Names used consistently: `SPECS/getSpec/resolveFiles/buildArgs`, `runSdCli`, `MODEL_FILES_MISSING`, `IMAGE_REQUIRED`, `acquireLease`, `peek`.
- Not covered (explicitly): Wan 2.2 T2V (weights not on disk), Hunyuan/LTX/MiniMax-H3 (sd.cpp supports them; separate decision), WebM/MP4 output, web UI.
