# ogai-local

Local inference + agent API for this fork. Runs upstream's own Electron engine modules (`electron/lib/*`, unmodified)
behind a small stand-in for `require('electron')`, and exposes them over HTTP.

| Piece | File |
|---|---|
| Electron stand-in (IPC handlers -> functions, `send` -> events) | `src/standin.js` |
| Loads upstream engines | `src/engines.js` |
| V100 model catalog + drift tripwire | `src/catalog.js` |
| Single-flight queue | `src/queue.js` |
| gpu-arbiter lease (V100 only) | `src/gate.js` |
| Runner (device choice, lease, PNG artifacts) | `src/runner.js` |
| REST + SSE | `src/server.js` |
| MCP (local tools + allowlisted Muapi pass-through) | `src/mcp.js` |

## Safety defaults
- `OGAI_GPU_ENABLED` must be exactly `1` or every job fails with `GPU_DISABLED`.
- V100 jobs also need `OGAI_ARBITER_URL`; a V100 lease evicts the Hermes brain. The GTX 1080 lane (`device: "gtx1080"`) needs no lease.
- Every endpoint except `GET /health` needs `Authorization: Bearer $OGAI_TOKEN` (deploy.sh writes one to `$OGAI_DATA/.mcp-token`).
- Muapi key-management and top-up MCP tools are blocked; only the allowlist in `src/mcp.js` is exposed.

## GPU access (sd.cpp with CUDA)
Upstream's Linux sd.cpp binaries are CPU/Vulkan/ROCm only and this host's Xeon has no AVX2, so we build our own:
```bash
custom/local-service/build-sdcpp.sh          # CUDA 12.6 build for sm_61 + sm_70, AVX-only CPU code -> vendor/sdcpp/ (git-ignored)
custom/local-service/fetch-models.py         # verified downloads: --group wan-t2v|hunyuan|zimage-base|ltx (files go to $OGAI_DATA/local-ai/models/extended)
custom/local-service/fetch-ffmpeg.sh         # static ffmpeg -> vendor/ffmpeg/ (git-ignored): sd.cpp's MJPEG avi is re-encoded to a browser-playable mp4
custom/local-service/deploy.sh --build       # image bundles vendor/sdcpp + vendor/ffmpeg; both MUST exist before the image builds
```
The container only sees the GPUs you pass in. First deployment - GTX 1080 only, V100 physically unreachable, no arbiter:
```bash
OGAI_GPU_DEVICES=<GTX 1080 uuid> OGAI_ALLOWED_DEVICES=gtx1080 OGAI_DEVICE_INDEX_1080=0 OGAI_GPU_ENABLED=1 custom/local-service/deploy.sh
```
Without a `device`, models that fit the GTX 1080 (<= 5.5GB of weights) run there and never evict the Hermes brain. Anything bigger
must ask for `device: "v100"` explicitly (otherwise `DEVICE_REQUIRED`): a V100 job goes through the GPU arbiter, which stops the Hermes
brain and the TTS for the duration of the job and restores them afterwards.
After an image upgrade the boot-time bundle sync (`src/bundle.js`) replaces the on-volume sd-cli when `BUNDLE_VERSION` changes.

## Measured on this host (2026-09-20, GTX 1080 lane, V100 not visible to the container)
| Model | Size | Steps | Time | Peak VRAM on the card* |
|---|---|---|---|---|
| Dreamshaper 8 (SD 1.5) | 512x512 | 20 | 44s incl. model load | 8.0GB |
| Z-Image Turbo | 1024x1024 | 8 | 204s | 7.5GB |

\* total for the card, including the ~2GB the resident TTS container holds, so a render leaves almost no headroom for it.
Upstream passes no offload/tiling flags to sd-cli, so bigger models than these will not fit the 1080.

## GPU arbiter registration (V100)
`ogai-local` is registered in gpu-arbiter. The arbiter's `app.py` is outside this repo (bind-mounted read-only from
`/mnt/user/appdata/gpu-arbiter/app.py`), so the change is recorded here. Four edits, each made with a timestamped backup:
1. `PRIORITIES["ogai-local"] = 4` (same class as the other media consumers).
2. `CONSUMER_PEAK_VRAM_GB["ogai-local"] = 28.0` (the whole-card claim the runner requests; the figure only feeds the arbiter's
   informational `can_fit`, `/acquire` uses the request's own `vram_gb`). Registry names must equal the docker container name.
3. `_UI_ONLY_CONSUMER_ALIASES` += `"ogai-local"`. The container is always up but holds VRAM only inside a lease; without this
   `_persistent_holder_running()` sees a running registered container and blocks restoring hermes-llm/speaches forever.
4. `/gpu/ambient_safe` also answers `safe: false` while a lease is held or queued (before: only "a persistent holder container is
   running"). Because of (3) the holder check can never see `ogai-local`, so the host's "Speaches 1080 Guard" (cron every 5 min, starts
   `speaches-chatterbox` whenever that endpoint says safe) revived the TTS onto the V100 in the middle of a 28GB lease (found by the
   battle test: guard log `speaches down -> starting` at the +236s mark of a lease). The lease leg is additional, not a replacement:
   the 2026-09-01 acestep incident was a lease-ONLY check going clear while a persistent holder still ran, which the holder check keeps
   covering.

Apply with `cd /boot/config/plugins/compose.manager/projects/Hermes && docker compose -p hermes up -d --no-deps --force-recreate gpu-arbiter`
(never a bare `docker restart`; only while no lease is held). The gate (`src/gate.js`) never runs a V100 job without a granted lease and
releases by `lease_id`. The V100 is opt-in per call (`device: "v100"`); the default lane is the GTX 1080.

**What a V100 job really costs (measured 2026-09-20, Z-Image Turbo 1024px, brain + TTS resident beforehand):**
compute is cheap, service downtime is not. The arbiter stops `hermes-llm` and `speaches-chatterbox` on ANY grant and restores them on release.
| | Time |
|---|---|
| Arbiter eviction handshake before the grant | 59s |
| Lease held (render ~35s; the GTX 1080 takes 204s) | 39.5s |
| Brain (`hermes-llm`) unavailable | ~4.5 min |
| TTS unavailable (its model reloads concurrently with the brain's) | ~7 min |
The arbiter's `/status` does not answer while it is stopping containers (~65s), so callers must not treat a status timeout as failure.

## Host settings file
Per-host values (GPU uuid, arbiter url, builder image) belong in `$OGAI_DATA/deploy.env`, not in the repo:
```
OGAI_GPU_DEVICES=<GTX 1080 uuid>
OGAI_ALLOWED_DEVICES=gtx1080
OGAI_DEVICE_INDEX_1080=0
OGAI_GPU_ENABLED=1
```
`deploy.sh` and `build-sdcpp.sh` read it (real environment variables win). Re-applying the Unraid template without these
settings recreates the container WITHOUT GPU access and with GPU jobs off; use `deploy.sh`.

## Use
```bash
custom/local-service/deploy.sh --build          # image + container on :8790
TOKEN=$(cat /mnt/user/appdata/open-generative-ai/.mcp-token)
curl -H "Authorization: Bearer $TOKEN" http://HOST:8790/api/local/catalog
claude mcp add --transport http ogai http://HOST:8790/mcp --header "Authorization: Bearer $TOKEN"
```

## Tests
`cd custom/local-service && node --test test/*.test.js` (never pass a directory to `--test`). Zero dependencies.

## Models served through sd.cpp, measured on the V100 (2026-09-20/21, supervised, through the arbiter)

Model files are read from the ComfyUI stores mounted read-only (`OGAI_MODEL_MOUNTS`). One V100 lease covers a whole queued batch.

| Model | Recipe | Measured |
|---|---|---|
| Flux.1 Dev (Q8_0) | 1024x1024, 20 steps, `--diffusion-fa --vae-tiling` | 160s incl. ~100s load; peak 28.8GB (VAE decode adds ~6GB) |
| Qwen-Image 2512 (Q6_K) | 1024x1024, 20 steps, `--diffusion-fa --vae-tiling --flow-shift 3` | 187s; peak 24.5GB with tiling (31.9GB without); fp8-scaled Qwen2.5-VL encoder loads |
| Wan 2.2 I2V (Q4_K_M pair) | quality mode only, 640x368, 33 frames, `--params-backend te=cpu --vae-tiling` | 377s; peak 27.4GB; host RAM stays >12GB free; mp4 output |
| Wan 2.2 T2V (Q4_K_M pair) | same recipe as I2V, no init image | 412s; peak 27.3GB |
| HunyuanVideo 1.5 (480p fp16) | 640x368, 33 frames, 30 steps, `--params-backend te=cpu --vae-tiling --temporal-tiling --vae-tile-size 8x8` | 650s; peak 26.5GB |
| LTX-2.3 22B distilled (Q4_K_M) | 8 steps, cfg 1, te params in RAM, VAE tiling; HARD LIMITS 960x576 px / 121 frames | 640x352x33 = 130s; 960x544x121 (5s) = 418s; ~17-21GB |
| SDXL 1.0 | upstream engine + compat shim | 1024x1024, 30 steps = 76s on the V100 |
| Z-Image Base | our spec, Q8_0, 768-based, GTX 1080 ONLY (blank on the V100) | slow (host-RAM offload) |

Do not retry (all measured to fail here): Wan "fast" lightx2v LoRAs (sd-cli aborts in every `--lora-apply-mode`), `--offload-to-cpu` for Wan
(23.5GB of shmem -> kernel OOM kill), Wan with no placement flag (VAE decode OOM), `--max-vram` (weight-preparation failure), `--backend te=cpu` (SIGSEGV).
The full story is in `custom/docs/plans/2026-09-20-ogai-local-sdcpp-models.md`.

## Cinema: chaining several clips into one longer video

Every video model caps a single clip at a few seconds (LTX: 121 frames/24fps = 5s, the crash-history limit; Wan: 33 frames/16fps = ~2s) -
that limit stays as code, on purpose. To go longer, `cinema: { segments: N }` on a `POST /jobs` request (or `local_generate_video`'s
`cinema` argument over MCP, or the "Cinema" field in the GUI's Advanced panel) chains `N` of a model's own clips into one video: segment 2+
is a REAL, independent generation seeded from the exact last frame of the one before it (via the bundled ffmpeg), not extrapolation or
frame interpolation. All `N` segments run back to back under ONE arbiter lease (sized for the whole chain), then get stitched losslessly
(`-c copy`, no re-encode) into a single mp4. `N` is 2-8 (`OGAI_CINEMA_MAX_SEGMENTS`, default 8); `prompts: [...]` (one string per segment,
array length must equal `segments`) lets the scene evolve across the video instead of repeating one prompt.

Only a model that takes an input image can chain: `wan2gp:ltx-video` (optional image -> also chainable) and `wan2gp:wan22-i2v` (needs one
for segment 1 the normal way, via `image_job_id`/`image_base64`). `wan2gp:wan22-t2v` and `wan2gp:hunyuan-video` cannot (`CINEMA_UNSUPPORTED`).
Each segment pays its own full render time - a 5-segment LTX cinema job is roughly 5x a single LTX job (~30-40 min total): poll
`local_job_status`/`GET /jobs/:id` rather than blocking on a huge `wait_seconds` (though MCP's cap does scale: 600s x `segments`).

## Web GUI
The Next app talks to this service only through its own `/api/local/*` proxy (see `custom/README.md`, "Local inference").

## Not yet wired
MiniMax-H3 through sd.cpp.
