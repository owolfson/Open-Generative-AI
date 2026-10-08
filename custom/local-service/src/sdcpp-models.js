'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');

// Extra models served by the SAME sd-cli binary that upstream's engine uses (which only knows its own six). Ids reuse the
// names upstream's UI gives its Wan2GP catalog so a future UI wiring finds them. Commands follow sd.cpp's own docs
// (flux.md, qwen_image.md, wan.md). Model files are located by basename in OGAI_MODEL_DIRS (read-only mounts).
const NEG_WAN = "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

const str = (v) => String(v);
const codeError = (code, message) => Object.assign(new Error(message), { code });

// ---- 16GB V100 placement (2026-10-07) ----
// The V100-SXM2-16GB replaced the dead 32GB card. With all weights resident every big model here needed more than 16GB (32GB-era
// peaks: Flux 28.8, Wan 27.4, Hunyuan 28.9, Qwen-Image 24.5, LTX 20.7). sd.cpp's own low-VRAM recipe (docs/backend.md, performance.md):
//   te=cpu         text encoders' params stay in host RAM and are staged to the GPU to run (no F16C here, so CPU compute is not an option)
//   diffusion=disk diffusion params are re-read from the model file on demand instead of held in RAM. --offload-to-cpu would keep the whole
//                  model in RAM and has already had sd-cli OOM-killed on this 48GB host; the files sit in page cache anyway.
//   --max-vram -1  budget = the card's free memory at start minus ~1GiB; a graph that doesn't fit runs in segments (needs the
//                  model's graph to have cut points; HunyuanVideo's has none, hence its Q8_0 file below).
// Measured on the 16GB card per spec (peak VRAM, wall time incl. load).
const FIT_16GB = ['--params-backend', 'te=cpu,diffusion=disk', '--max-vram', '-1'];

// ---- Wan 2.2 (I2V and T2V share everything except the input image) ----
// sd.cpp's documented quality recipe (10 low-noise + 8 high-noise steps, cfg 3.5 on both). The lightx2v 4-step LoRAs (a "fast" mode)
// are NOT offered: with these Q4_K_M GGUFs sd-cli aborts while loading the LoRAs in every --lora-apply-mode (auto / at_runtime /
// immediately; "gguf_init_from_reader: tensor 'patch_embedding.weight' has invalid number of dimensions: 5 > 4"), reproduced with no GPU.
const WAN_DEFAULTS = () => ({ width: 640, height: 368, steps: 10, high_noise_steps: 8, cfg_scale: 3.5, high_noise_cfg_scale: 3.5, video_frames: 33, fps: 16, flow_shift: 3 });
const WAN_VALIDATE = (params) => {
  if (params.fast === true) throw codeError('FAST_UNAVAILABLE', 'fast mode (lightx2v 4-step LoRAs) is unavailable: sd.cpp aborts loading those LoRAs against the Q4_K_M Wan GGUFs on this box; use the default quality mode');
};
const wanArgs = (p, f) => ['-M', 'vid_gen', '--diffusion-model', f.diffusion, '--high-noise-diffusion-model', f.high_noise, '--vae', f.vae, '--t5xxl', f.t5xxl,
  '--high-noise-cfg-scale', str(p.high_noise_cfg_scale), '--sampling-method', 'euler', '--high-noise-sampling-method', 'euler',
  '--high-noise-steps', str(p.high_noise_steps), '-n', p.negative_prompt || NEG_WAN, '--diffusion-fa',
  '--video-frames', str(p.video_frames), '--fps', str(p.fps), '--flow-shift', str(p.flow_shift),
  // Memory placement, measured on the V100 + this 48GB host (quality mode, 640x368, 33 frames):
  //   --params-backend te=cpu  T5's params (6.4GB) in RAM, computed on the GPU, the rest on the V100: WORKS. 377s, peak 27.4GB, host RAM never below 12GB free
  //   (no flag)                all weights on the V100: sampling ok, then the VAE decode fails 'weight preparation' (31.5GB peak)
  //   --offload-to-cpu         worked once for Gemini, but it is 23.5GB of shmem: with the other containers the kernel OOM-killed sd-cli
  //   --max-vram 22            fails in the diffusion ('wan.blocks.23 failed during weight preparation');  --backend te=cpu: SIGSEGV
  // 16GB card (2026-10-07), FIT_16GB: T2V peak 11.0GB / 247s, I2V peak 11.1GB / 263s (640x368, 33 frames, 4+4 steps).
  '--vae-tiling', ...FIT_16GB];


// ---- LTX-2.3 hard limits ----
// From this host's crash history (memory: feedback_ltx_720p_NEVER_v100, feedback_ltx_22b_duration_limit): LTX at 720p and clips over 5s took the
// whole machine down (7+ host crashes, all through LTX Desktop). This service runs LTX differently, but the limits stay as CODE, not advice:
// 540p-class (<= 960x576 = 552,960 px) and <= 121 frames (5s at 24fps). Sizes must be multiples of 32 and frames 8n+1 (the VAE's strides).
const LTX_MAX_PIXELS = 960 * 576;
const LTX_MAX_FRAMES = 121;
const LTX_DIMS = { '16:9': [960, 544], '9:16': [544, 960], '1:1': [640, 640], '4:3': [768, 576], '3:4': [576, 768] };
function ltxCheck(p) {
  const w = Number(p.width); const h = Number(p.height); const n = Number(p.video_frames);
  if (w * h > LTX_MAX_PIXELS) throw codeError('LTX_LIMIT', `LTX is limited to 540p-class sizes (at most 960x576 = ${LTX_MAX_PIXELS} px): ${w}x${h} is refused (720p crashed this host)`);
  if (n > LTX_MAX_FRAMES) throw codeError('LTX_LIMIT', `LTX is limited to 121 frames (5s at 24fps): ${n} frames refused`);
  if (w % 32 !== 0 || h % 32 !== 0) throw codeError('LTX_LIMIT', `LTX sizes must be a multiple of 32 (got ${w}x${h}); e.g. 960x544, 640x352`);
  if ((n - 1) % 8 !== 0) throw codeError('LTX_LIMIT', `LTX frame counts must be 8n+1 (33, 49, 97, 121...); got ${n}`);
}

// ---- measured-safe limits ----
// A request must not be able to take the V100 down: an oversized job either runs out of memory AFTER evicting Hermes for minutes, or
// (worse) runs past its lease window so the arbiter restores the brain on top of it. Every ceiling below is a size/length that was
// actually measured on this hardware (see the catalog notes); anything beyond is refused up front with PARAM_LIMIT, before any lease.
const IMG_1MP = { '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344], '4:3': [1152, 896], '3:4': [896, 1152] };   // ~1 MP each, like the measured 1024x1024
const LIMITS_IMAGE_1MP = { maxPixels: 1_110_000, maxSteps: 60, why: 'measured at 1024x1024 (~1 MP)' };
const LIMITS_WAN = { maxPixels: 264_000, maxFrames: 33, maxSteps: 30, why: 'measured at 640x368 x 33 frames (832x480 ran out of memory in the VAE decode)' };
const INT_FIELDS = ['width', 'height', 'steps', 'high_noise_steps', 'video_frames', 'fps'];
const NUM_FIELDS = ['cfg_scale', 'high_noise_cfg_scale', 'guidance_scale'];

function checkNumbers(given) {
  for (const k of INT_FIELDS) {
    if (given[k] === undefined) continue;
    const v = Number(given[k]);
    if (!Number.isInteger(v) || v <= 0) throw codeError('PARAM_INVALID', `${k} must be a positive whole number (got ${JSON.stringify(given[k])})`);
  }
  for (const k of NUM_FIELDS) {
    if (given[k] === undefined) continue;
    const v = Number(given[k]);
    if (!Number.isFinite(v) || v < 0 || v > 30) throw codeError('PARAM_INVALID', `${k} must be a number between 0 and 30 (got ${JSON.stringify(given[k])})`);
  }
  // sd-cli's --strength (noising/unnoising strength against an init image): 0 = ignore the image entirely, 1 = the CLI's own default free-running img2video.
  if (given.strength !== undefined) {
    const v = Number(given.strength);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw codeError('PARAM_INVALID', `strength must be a number between 0 and 1 (got ${JSON.stringify(given.strength)})`);
  }
  if (given.seed !== undefined && !Number.isFinite(Number(given.seed))) throw codeError('PARAM_INVALID', `seed must be a number (got ${JSON.stringify(given.seed)})`);
}

function checkLimits(spec, p) {
  const L = spec.limits;
  if (!L) return;
  if (L.maxPixels && p.width * p.height > L.maxPixels) throw codeError('PARAM_LIMIT', `${spec.id}: ${p.width}x${p.height} is larger than what was measured to work (${L.why}); at most ${L.maxPixels} pixels`);
  if (L.maxFrames && p.video_frames > L.maxFrames) throw codeError('PARAM_LIMIT', `${spec.id}: ${p.video_frames} frames is more than what was measured to work (${L.why}); at most ${L.maxFrames}`);
  for (const k of ['steps', 'high_noise_steps']) {
    if (L.maxSteps && p[k] > L.maxSteps) throw codeError('PARAM_LIMIT', `${spec.id}: ${k}=${p[k]} is above the limit of ${L.maxSteps}`);
  }
}

const SPECS = {
  'z-image-base': {
    // Upstream serves this with the Q4_K_M GGUF, which renders a SOLID WHITE image here (the job even reports "done"): reproduced on the GTX 1080 and the
    // V100, with cfg 1/5/7.5, euler/default sampler, with/without flash attention and the simple scheduler, and the file is byte-identical to Hugging Face's.
    // The Q8_0 quant of the same model renders correctly, so Z-Image Base is served from OUR spec with Q8_0 (7.2GB; 50 steps is slow, 30 is the default).
    id: 'z-image-base', kind: 'image', ext: 'png', vramGb: 14,
    // ...and it renders a BLANK image on the V100 at every size and setting tried (512 and 1024, with and without flash attention) while the SAME file renders
    // correctly on the GTX 1080: fp16 tensor-core overflow on Volta. So it is restricted to the 1080, where it runs through host-RAM offload (slow: sizes are 768-based).
    devices: ['gtx1080'], deviceNote: 'it renders a blank image on the Tesla V100 (fp16 overflow, measured at 512 and 1024) and only works on the GTX 1080',
    dims: { '1:1': [768, 768], '16:9': [1024, 576], '9:16': [576, 1024], '4:3': [832, 640], '3:4': [640, 832] }, limits: { maxPixels: 1_050_000, maxSteps: 60, why: 'a 1080 with host-RAM offload' },
    files: { diffusion: 'z-image-Q8_0.gguf', llm: 'Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf', vae: 'ae.safetensors' },
    defaults: () => ({ width: 768, height: 768, steps: 20, cfg_scale: 5 }),
    build: (p, f) => ['--diffusion-model', f.diffusion, '--llm', f.llm, '--vae', f.vae, '--sampling-method', 'euler', '--diffusion-fa', ...(p.negative_prompt ? ['-n', p.negative_prompt] : [])],
  },
  'wan2gp:flux-dev': {
    id: 'wan2gp:flux-dev', kind: 'image', ext: 'png', vramGb: 14,   // 16GB card: peak 13.5GB, 141s at 1024x1024 / 20 steps (32GB card, all resident: 28.8GB, 160s)
    files: { diffusion: 'flux1-dev-Q8_0.gguf', vae: 'ae.sft.safetensors', clip_l: 'clip_l.safetensors', t5xxl: 't5xxl_fp16.safetensors' },
    dims: IMG_1MP, limits: LIMITS_IMAGE_1MP,
    defaults: () => ({ width: 1024, height: 1024, steps: 20, cfg_scale: 1 }),
    // No --clip-on-cpu: this host has no F16C, so fp16 text encoding on the CPU is very slow. T5 runs on the GPU (params staged from RAM).
    build: (p, f) => ['--diffusion-model', f.diffusion, '--vae', f.vae, '--clip_l', f.clip_l, '--t5xxl', f.t5xxl,
      '--sampling-method', 'euler', '--diffusion-fa', '--vae-tiling', ...(p.negative_prompt ? ['-n', p.negative_prompt] : []), ...FIT_16GB],
  },
  'wan2gp:qwen-image': {
    id: 'wan2gp:qwen-image', kind: 'image', ext: 'png', vramGb: 15.5,   // 16GB card: peak 15.5GB (the whole budget, segmented), 286s at 1024x1024 / 20 steps (32GB card: 24.5GB, 187s)
    files: { diffusion: 'qwen-image-2512-Q6_K.gguf', vae: 'qwen_image_vae.safetensors', llm: 'qwen_2.5_vl_7b_fp8_scaled.safetensors' },
    dims: IMG_1MP, limits: LIMITS_IMAGE_1MP,
    defaults: () => ({ width: 1024, height: 1024, steps: 20, cfg_scale: 2.5, flow_shift: 3 }),
    build: (p, f) => ['--diffusion-model', f.diffusion, '--vae', f.vae, '--llm', f.llm,
      '--sampling-method', 'euler', '--diffusion-fa', '--vae-tiling', '--flow-shift', str(p.flow_shift), ...(p.negative_prompt ? ['-n', p.negative_prompt] : []), ...FIT_16GB],
  },
  // Qwen-Image-2.1 is NOT offered (2026-10-08): on the V100 (sd.cpp master-945) it renders vertical hatching over the whole frame
  // and green/magenta blobs - with Q8_0 or bf16 weights, flash-attn on/off, prefix cache on/off, cuBLAS forced to fp32, all
  // weights resident. Same signature as open sd.cpp issue #2078 (T4, also pre-Ampere). Files stay in models/extended/qwen-image-2.1.
  'wan2gp:wan22-i2v': {
    id: 'wan2gp:wan22-i2v', kind: 'video', ext: 'avi', vramGb: 11.5, needsImage: true,   // 16GB card: measured peak 11.1GB (32GB card, te=cpu only: 27.4GB)
    files: {
      diffusion: 'Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf', high_noise: 'Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf',
      vae: 'Wan2_1_VAE_bf16.safetensors', t5xxl: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    },
    defaults: WAN_DEFAULTS, limits: LIMITS_WAN, frameChoices: [17, 25, 33],   // at 16fps: 1.1s / 1.6s / 2.1s (33 is the measured VAE-decode ceiling)
    validate: WAN_VALIDATE,
    build: (p, f) => [...wanArgs(p, f), '-i', p.init_image],
  },
  'wan2gp:wan22-t2v': {
    id: 'wan2gp:wan22-t2v', kind: 'video', ext: 'avi', vramGb: 11.5,   // 16GB card: measured peak 11.0GB
    files: {
      diffusion: 'Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf', high_noise: 'Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf',
      vae: 'Wan2_1_VAE_bf16.safetensors', t5xxl: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    },
    defaults: WAN_DEFAULTS, limits: LIMITS_WAN, frameChoices: [17, 25, 33],   // at 16fps: 1.1s / 1.6s / 2.1s
    validate: WAN_VALIDATE,
    build: (p, f) => wanArgs(p, f),
  },
  'wan2gp:hunyuan-video': {
    // HunyuanVideo 1.5 (8.3B), the recipe from sd.cpp's docs/hunyuan_video.md: Qwen2.5-VL is the main text encoder (--llm), ByT5 the
    // glyph encoder (--t5xxl). 480p text-to-video, fp16. The text encoders' params live in host RAM (te=cpu), the diffusion model + VAE on the GPU.
    id: 'wan2gp:hunyuan-video', kind: 'video', ext: 'avi', vramGb: 10,   // 16GB card, Q8_0: peak 9.8GB, 213s (640x368, 33 frames, 12 steps); 30 steps ~275s
    // 2026-10-07: the fp16 diffusion file (16.9GB) can't run on the 16GB card - its graph has no cut points, so sd.cpp must place all of it at
    // once ('cannot make enough memory available ... need 16891 MB'). Converted ONCE to Q8_0 (9.0GB, near-lossless) with
    // `sd-cli -M convert --diffusion-model hunyuanvideo1.5_480p_t2v_fp16.safetensors -o hunyuanvideo1.5_480p_t2v-Q8_0.gguf --type q8_0` (142s, CPU).
    files: { diffusion: 'hunyuanvideo1.5_480p_t2v-Q8_0.gguf', vae: 'hunyuanvideo15_vae_fp16.safetensors', llm: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', t5xxl: 'byt5_small_glyphxl_fp16.safetensors' },
    limits: { ...LIMITS_WAN, maxSteps: 60, why: 'measured at 640x368 x 33 frames, 30 steps' }, frameChoices: [17, 25, 33],   // at 24fps: 0.7s / 1.0s / 1.4s
    defaults: () => ({ width: 640, height: 368, steps: 30, cfg_scale: 6, video_frames: 33, fps: 24 }),
    build: (p, f) => ['-M', 'vid_gen', '--diffusion-model', f.diffusion, '--vae', f.vae, '--llm', f.llm, '--t5xxl', f.t5xxl,
      '--sampling-method', 'euler', '--diffusion-fa', '--video-frames', str(p.video_frames), '--fps', str(p.fps),
      ...(p.negative_prompt ? ['-n', p.negative_prompt] : []), ...FIT_16GB,
      // VAE decode. NO --temporal-tiling: sd.cpp's temporal tiling of this VAE draws a fine grid/mesh over every frame after the first
      // temporal chunk (~frame 9 on), whatever the spatial tile size (8x8 and 32x32 both) or step count (12 and 30) - found 2026-10-07 by
      // looking at the frames; the 32GB-era '8x8 + temporal' setting had the same defect. With the diffusion params evicted before the
      // decode (FIT_16GB) spatial-only tiles decode 33 frames in 9.8GB, clean on every frame (95s decode). sd.cpp master-945 (#2059)
      // measures tiles in IMAGE PIXELS (it was latent cells): 16 latent cells x the VAE's 16x spatial stride = 256x256 px.
      '--vae-tiling', '--vae-tile-size', '256x256'],
  },
  'wan2gp:ltx-video': {
    // LTX-2.3 22B distilled as a Q4_K_M GGUF (unsloth), run by sd.cpp exactly as its docs/ltx2.md shows (distilled = 8 steps, cfg 1).
    // Why NOT LTX Desktop: its bf16/int8 pipeline block-cycles 43GB of weights through host RAM and crashed this host repeatedly (and the
    // container is gone). Here the whole 14GB model sits in VRAM and only Gemma's params (7.4GB) live in host RAM (te=cpu, same
    // placement that made Wan/Hunyuan work), so there is no RAM<->VRAM cycling and no 43GB read.
    id: 'wan2gp:ltx-video', kind: 'video', ext: 'avi', vramGb: 15.5, acceptsImage: true,   // image optional: text-to-video, or image-to-video when one is given. 16GB card: peak 15.5GB (the whole budget, segmented)
    files: {
      diffusion: 'ltx-2.3-22b-distilled-1.1-Q4_K_M.gguf', vae: 'ltx-2.3-22b-distilled_video_vae.safetensors', audio_vae: 'ltx-2.3-22b-distilled_audio_vae.safetensors',
      connectors: 'ltx-2.3-22b-distilled_embeddings_connectors.safetensors', llm: 'gemma-3-12b-it-qat-UD-Q4_K_XL.gguf',
    },
    dims: LTX_DIMS,
    defaults: () => ({ width: 640, height: 352, steps: 8, cfg_scale: 1, video_frames: 49, fps: 24 }),
    check: ltxCheck, limits: { maxSteps: 30 }, frameChoices: [33, 49, 97, 121],   // 8n+1 (LTX's VAE stride); at 24fps: 1.3s / 2.0s / 4.0s / 5.0s (121 is LTX_MAX_FRAMES)
    build: (p, f) => ['-M', 'vid_gen', '--diffusion-model', f.diffusion, '--vae', f.vae, '--audio-vae', f.audio_vae, '--llm', f.llm, '--embeddings-connectors', f.connectors,
      '--sampling-method', 'euler', '--diffusion-fa', '--video-frames', str(p.video_frames), '--fps', str(p.fps),
      ...(p.init_image ? ['-i', p.init_image] : []), ...(p.negative_prompt ? ['-n', p.negative_prompt] : []),
      // 16GB card: 640x352 x 121 frames peak 15.4GB / 250s; 960x544 x 121 (the largest LTX_DIMS allows) peak 15.5GB / 313s
      // (32GB card: 418s). The plain VAE decode ran out of memory and sd.cpp's own retry with spatial+temporal tiling succeeded,
      // so temporal tiling is asked for up front.
      '--vae-tiling', '--temporal-tiling', ...FIT_16GB],
  },
  'wan2gp:ltx-2.5': {
    // LTX-2.5 22B (open weights 2026-08-11): same transformer/VAE family as LTX-2.3 with better motion, a learned keyframe embedding
    // and a Gemma 4 text encoder that has the text projection built in (so no --embeddings-connectors file). sd.cpp docs/ltx2.md:
    // the conv video VAE (the default video VAE is a diffusion decoder sd.cpp does not implement), the audio VAE, and the Gemma 4
    // encoder converted once from bf16 to Q8_0 with `sd-cli -M convert --type q8_0`. Distilled Q4_K_M from vantagewithai/LTX-2.5-GGUF
    // (the GGUF source sd.cpp's docs link). Same 540p-class / 5s limits as LTX-2.3 (ltxCheck).
    // 16GB card (2026-10-08): 640x352 x 49 frames = 320s, 960x544 x 121 = 554s, peak 13.4-13.6GB.
    id: 'wan2gp:ltx-2.5', kind: 'video', ext: 'avi', vramGb: 14, acceptsImage: true,
    files: {
      diffusion: 'ltx-2.5-22b-distilled-transformer-Q4_K_M.gguf', vae: 'ltx-2.5-video-vae-conv-bf16.safetensors',
      audio_vae: 'ltx-2.5-audio-vae-bf16.safetensors', llm: 'gemma4-12b-with-proj-ltx-2.5-Q8_0.gguf',
    },
    dims: LTX_DIMS,
    defaults: () => ({ width: 640, height: 352, steps: 8, cfg_scale: 1, video_frames: 49, fps: 24 }),
    check: ltxCheck, limits: { maxSteps: 30 }, frameChoices: [33, 49, 97, 121],
    build: (p, f) => ['-M', 'vid_gen', '--diffusion-model', f.diffusion, '--vae', f.vae, '--audio-vae', f.audio_vae, '--llm', f.llm,
      '--sampling-method', 'euler', '--diffusion-fa', '--video-frames', str(p.video_frames), '--fps', str(p.fps),
      ...(p.init_image ? ['-i', p.init_image] : []), ...(p.negative_prompt ? ['-n', p.negative_prompt] : []),
      // A FIXED 10GiB budget, not FIT_16GB's -1: under -1 (~14.5GiB) the 14GB Q8_0 Gemma-4 encoder fits in one segment, stays on the
      // card through the text projection, and that step runs out of memory (cuMemCreate) before diffusion starts. At 10 the encoder
      // is segmented and freed (down to 3.3GB) before diffusion; peak 13.4-13.6GB. 12 was no faster and peaked at 15.6GB.
      '--vae-tiling', '--temporal-tiling', '--params-backend', 'te=cpu,diffusion=disk', '--max-vram', '10'],
  },
};

const getSpec = (id) => SPECS[id];

// Whether a spec can be chained into a "cinema" sequence (each segment after the first is seeded from the last frame of
// the one before it): it needs to be a video model that takes an input image, same flag resolveInputImage already uses.
const canChain = (spec) => Boolean(spec && spec.kind === 'video' && (spec.needsImage || spec.acceptsImage));

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function findFile(dir, name, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.name === name && (e.isFile() || (e.isSymbolicLink() && isFile(path.join(dir, e.name))))) return path.join(dir, e.name);
  if (depth > 0) {
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const hit = findFile(path.join(dir, e.name), name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Locate the files a job needs. Returns { files: {role: absolutePath}, missing: [basename] }. */
function resolveFiles(spec, dirs, params = {}) {
  const roles = spec.required ? spec.required(params) : Object.keys(spec.files);
  const files = {}; const missing = [];
  for (const role of roles) {
    const name = spec.files[role];
    let hit = null;
    for (const dir of dirs) { hit = findFile(dir, name, 3); if (hit) break; }
    if (hit) files[role] = hit; else missing.push(name);
  }
  return { files, missing };
}

// Video sizes hold the pixel area MEASURED safe on the V100 (640x368 = 235k px; 832x480 died in the VAE decode ~570MB short),
// all multiples of 16 as Wan needs.
const VIDEO_DIMS = { '1:1': [480, 480], '16:9': [640, 368], '9:16': [368, 640], '4:3': [576, 432], '3:4': [432, 576] };

// aspect_ratio -> 64-aligned dimensions (same idea as upstream's arToDimensions): base 1024 for images.
function dimsFor(spec, ar) {
  if (spec.dims) return spec.dims[ar] || null;
  if (spec.kind === 'video') return VIDEO_DIMS[ar] || null;
  const base = 1024;
  const align = (v) => Math.round(v / 64) * 64;
  return {
    '1:1': [base, base], '16:9': [align((base * 16) / 9), base], '9:16': [base, align((base * 16) / 9)],
    '4:3': [align((base * 4) / 3), base], '3:4': [base, align((base * 4) / 3)],
  }[ar] || null;
}

/** Merge defaults with the caller's params, pick a seed, and enforce required inputs. */
function prepare(spec, params) {
  if (spec.validate) spec.validate(params);   // refuse unsupported options before anything else (and before any lease)
  const given = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  checkNumbers(given);
  const p = { ...spec.defaults(given), ...given };
  for (const k of [...INT_FIELDS, ...NUM_FIELDS, 'strength']) if (given[k] !== undefined) p[k] = Number(given[k]);   // numeric strings from JSON forms become numbers
  const dims = given.aspect_ratio ? dimsFor(spec, given.aspect_ratio) : null;
  if (dims) { if (given.width === undefined) p.width = dims[0]; if (given.height === undefined) p.height = dims[1]; }
  if (given.guidance_scale !== undefined && given.cfg_scale === undefined) p.cfg_scale = Number(given.guidance_scale);   // upstream's name for it
  const seed = Number(p.seed);
  p.seed = Number.isInteger(seed) && seed > 0 ? seed : randomInt(1, 2147483647);
  if (spec.needsImage && !p.init_image) throw codeError('IMAGE_REQUIRED', 'this model needs an input image (image_job_id or image_base64)');
  checkLimits(spec, p);            // measured-safe ceilings on the FINAL values (defaults + aspect ratio + overrides)
  if (spec.check) spec.check(p);   // model-specific rules (LTX)
  return p;
}

function buildArgs(spec, p, files, outPath) {
  return ['-p', spec.prompt ? spec.prompt(p, files) : p.prompt, '--seed', str(p.seed), '--steps', str(p.steps),
    '-W', str(p.width), '-H', str(p.height), '--cfg-scale', str(p.cfg_scale),
    ...(p.strength !== undefined && p.init_image ? ['--strength', str(p.strength)] : []),   // only meaningful against an init image; sd-cli's own default (0.75) otherwise
    ...spec.build(p, files), '-o', outPath];
}

module.exports = { SPECS, getSpec, resolveFiles, prepare, buildArgs, canChain, NEG_WAN };
