# ogai-local - local inference + agent API for the Open-Generative-AI fork

Approved by Owen 2026-09-19 (chat). Mirrors upstream's "Local Model Inference (Desktop App Only)" design
(two engines: sd.cpp + Wan2GP; Settings -> Local Models; a Local toggle in the studios) on a server.

## Decisions
1. **Run upstream's engine code unmodified.** `electron/lib/localInference.js` and `wan2gpProvider.js` are plain
   Node; Electron coupling is only `ipcMain.handle`, `webContents.send`, `app.getPath('userData')`,
   `app.isPackaged`/`process.resourcesPath`. A ~20-line stand-in for `require('electron')` lets them run in a
   server. Proven with a prototype (15 IPC channels captured, 6 sd.cpp models listed, upstream's 17 tests pass).
   Upstream engine updates therefore arrive through `custom/sync-upstream.sh`; only the stand-in and overrides are ours.
2. **Separate GPU container `ogai-local`** (Debian + Node), not inside the alpine Next image. The web app will
   proxy `/api/local/*` to it (later plan).
3. **Every GPU job is single-flight and arbiter-gated.** V100 jobs acquire a whole-card lease from gpu-arbiter
   (evicts the Hermes brain). GPU work is refused unless `OGAI_GPU_ENABLED=1` (default off) so nothing touches the
   V100 before Owen approves a test window. The GTX 1080 lane (sd.cpp only) needs no lease.
4. **Agent surface = MCP + REST from the same service.** MCP exposes local tools plus an allowlisted pass-through of
   Muapi's hosted MCP; Muapi's key-management and top-up tools are blocked (default-deny for any new tool).
   All endpoints except `/health` require a bearer token.
5. **Model catalog** = every README local model that can run on the V100, starred where best; anything upstream adds
   later shows as `v100: "unknown"` (never silently trusted). Excluded: LTX-2.3 22B (4 host crashes), FP4/FP8/Nunchaku
   variants (Volta has no kernels).

## Hardware facts this design depends on (verified 2026-09-19)
- V100 = compute 7.0: WanGP forces fp16 (no bf16); Qwen-Image under forced fp16 produces black output (ComfyUI test).
- Xeon E5-2689 has no AVX2 -> upstream's prebuilt Linux sd-cli would SIGILL; sd.cpp needs our own CUDA build (later plan).
- gpu-arbiter: `POST /acquire {consumer, vram_gb, est_seconds, wait}` blocks until granted, returns `lease_id`;
  `POST /release {lease_id, consumer}` silently no-ops on a mismatched id (check the note); leases expire.
- Upstream `generate()` takes `{model, prompt, negative_prompt, aspect_ratio, seed, steps, guidance_scale}` and
  returns `{url: "data:image/png;base64,...", seed}`.

## Out of scope for the core plan (each gets its own plan)
sd.cpp CUDA build; WanGP + ComfyUI(Qwen) engine adapters; React Settings/Local toggle UI + `window.localAI` shim;
registering `ogai-local` in the arbiter registry; GPU test renders.
