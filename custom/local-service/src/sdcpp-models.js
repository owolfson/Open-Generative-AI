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
  '--params-backend', 'te=cpu', '--vae-tiling'];


const SPECS = {
  'wan2gp:flux-dev': {
    id: 'wan2gp:flux-dev', kind: 'image', ext: 'png', vramGb: 29,   // measured peak 28.8GB (1024x1024: 22.8GB while sampling, +6GB in the VAE decode)
    files: { diffusion: 'flux1-dev-Q8_0.gguf', vae: 'ae.sft.safetensors', clip_l: 'clip_l.safetensors', t5xxl: 't5xxl_fp16.safetensors' },
    defaults: () => ({ width: 1024, height: 1024, steps: 20, cfg_scale: 1 }),
    // No --clip-on-cpu: this host has no F16C, so fp16 text encoding on the CPU is very slow. The V100 has room for T5 on the GPU.
    build: (p, f) => ['--diffusion-model', f.diffusion, '--vae', f.vae, '--clip_l', f.clip_l, '--t5xxl', f.t5xxl,
      '--sampling-method', 'euler', '--diffusion-fa', '--vae-tiling', ...(p.negative_prompt ? ['-n', p.negative_prompt] : [])],
  },
  'wan2gp:qwen-image': {
    id: 'wan2gp:qwen-image', kind: 'image', ext: 'png', vramGb: 25,   // measured peak 24.5GB with --vae-tiling
    files: { diffusion: 'qwen-image-2512-Q6_K.gguf', vae: 'qwen_image_vae.safetensors', llm: 'qwen_2.5_vl_7b_fp8_scaled.safetensors' },
    defaults: () => ({ width: 1024, height: 1024, steps: 20, cfg_scale: 2.5, flow_shift: 3 }),
    build: (p, f) => ['--diffusion-model', f.diffusion, '--vae', f.vae, '--llm', f.llm,
      '--sampling-method', 'euler', '--diffusion-fa', '--vae-tiling', '--flow-shift', str(p.flow_shift), ...(p.negative_prompt ? ['-n', p.negative_prompt] : [])],
  },
  'wan2gp:wan22-i2v': {
    id: 'wan2gp:wan22-i2v', kind: 'video', ext: 'avi', vramGb: 28, needsImage: true,   // vramGb: measured peak 27.4GB
    files: {
      diffusion: 'Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf', high_noise: 'Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf',
      vae: 'Wan2_1_VAE_bf16.safetensors', t5xxl: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    },
    defaults: WAN_DEFAULTS,
    validate: WAN_VALIDATE,
    build: (p, f) => [...wanArgs(p, f), '-i', p.init_image],
  },
  'wan2gp:wan22-t2v': {
    id: 'wan2gp:wan22-t2v', kind: 'video', ext: 'avi', vramGb: 28,   // same footprint class as I2V (no image-encode step); re-measure if it ever runs near the limit
    files: {
      diffusion: 'Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf', high_noise: 'Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf',
      vae: 'Wan2_1_VAE_bf16.safetensors', t5xxl: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    },
    defaults: WAN_DEFAULTS,
    validate: WAN_VALIDATE,
    build: (p, f) => wanArgs(p, f),
  },
  'wan2gp:hunyuan-video': {
    // HunyuanVideo 1.5 (8.3B), the recipe from sd.cpp's docs/hunyuan_video.md: Qwen2.5-VL is the main text encoder (--llm), ByT5 the
    // glyph encoder (--t5xxl). 480p text-to-video, fp16. The text encoders' params live in host RAM (te=cpu), the diffusion model + VAE on the GPU.
    id: 'wan2gp:hunyuan-video', kind: 'video', ext: 'avi', vramGb: 28,   // provisional: measured on the V100, see the catalog note
    files: { diffusion: 'hunyuanvideo1.5_480p_t2v_fp16.safetensors', vae: 'hunyuanvideo15_vae_fp16.safetensors', llm: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', t5xxl: 'byt5_small_glyphxl_fp16.safetensors' },
    defaults: () => ({ width: 640, height: 368, steps: 30, cfg_scale: 6, video_frames: 33, fps: 24 }),
    build: (p, f) => ['-M', 'vid_gen', '--diffusion-model', f.diffusion, '--vae', f.vae, '--llm', f.llm, '--t5xxl', f.t5xxl,
      '--sampling-method', 'euler', '--diffusion-fa', '--video-frames', str(p.video_frames), '--fps', str(p.fps),
      ...(p.negative_prompt ? ['-n', p.negative_prompt] : []), '--params-backend', 'te=cpu', '--vae-tiling'],
  },
};

const getSpec = (id) => SPECS[id];

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
function dimsFor(kind, ar) {
  if (kind === 'video') return VIDEO_DIMS[ar] || null;
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
  const p = { ...spec.defaults(given), ...given };
  const dims = given.aspect_ratio ? dimsFor(spec.kind, given.aspect_ratio) : null;
  if (dims) { if (given.width === undefined) p.width = dims[0]; if (given.height === undefined) p.height = dims[1]; }
  if (given.guidance_scale !== undefined && given.cfg_scale === undefined) p.cfg_scale = Number(given.guidance_scale);   // upstream's name for it
  const seed = Number(p.seed);
  p.seed = Number.isInteger(seed) && seed > 0 ? seed : randomInt(1, 2147483647);
  if (spec.needsImage && !p.init_image) throw codeError('IMAGE_REQUIRED', 'this model needs an input image (image_job_id or image_base64)');
  return p;
}

function buildArgs(spec, p, files, outPath) {
  return ['-p', spec.prompt ? spec.prompt(p, files) : p.prompt, '--seed', str(p.seed), '--steps', str(p.steps),
    '-W', str(p.width), '-H', str(p.height), '--cfg-scale', str(p.cfg_scale), ...spec.build(p, files), '-o', outPath];
}

module.exports = { SPECS, getSpec, resolveFiles, prepare, buildArgs, NEG_WAN };
