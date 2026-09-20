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

const SPECS = {
  'wan2gp:flux-dev': {
    id: 'wan2gp:flux-dev', kind: 'image', ext: 'png', vramGb: 22,
    files: { diffusion: 'flux1-dev-Q8_0.gguf', vae: 'ae.sft.safetensors', clip_l: 'clip_l.safetensors', t5xxl: 't5xxl_fp16.safetensors' },
    defaults: () => ({ width: 1024, height: 1024, steps: 20, cfg_scale: 1 }),
    // No --clip-on-cpu: this host has no F16C, so fp16 text encoding on the CPU is very slow. The V100 has room for T5 on the GPU.
    build: (p, f) => ['--diffusion-model', f.diffusion, '--vae', f.vae, '--clip_l', f.clip_l, '--t5xxl', f.t5xxl,
      '--sampling-method', 'euler', '--diffusion-fa', ...(p.negative_prompt ? ['-n', p.negative_prompt] : [])],
  },
  'wan2gp:qwen-image': {
    id: 'wan2gp:qwen-image', kind: 'image', ext: 'png', vramGb: 24,
    files: { diffusion: 'qwen-image-2512-Q6_K.gguf', vae: 'qwen_image_vae.safetensors', llm: 'qwen_2.5_vl_7b_fp8_scaled.safetensors' },
    defaults: () => ({ width: 1024, height: 1024, steps: 20, cfg_scale: 2.5, flow_shift: 3 }),
    build: (p, f) => ['--diffusion-model', f.diffusion, '--vae', f.vae, '--llm', f.llm,
      '--sampling-method', 'euler', '--diffusion-fa', '--flow-shift', str(p.flow_shift), ...(p.negative_prompt ? ['-n', p.negative_prompt] : [])],
  },
  'wan2gp:wan22-i2v': {
    id: 'wan2gp:wan22-i2v', kind: 'video', ext: 'avi', vramGb: 26, needsImage: true,
    files: {
      diffusion: 'Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf', high_noise: 'Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf',
      vae: 'Wan2_1_VAE_bf16.safetensors', t5xxl: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      lora_low: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors', lora_high: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors',
    },
    // fast (default): the lightx2v 4-step LoRAs, cfg 1. quality (fast:false): sd.cpp's documented 10+8 steps, cfg 3.5, no LoRA.
    defaults: (params) => (params.fast === false
      ? { width: 832, height: 480, steps: 10, high_noise_steps: 8, cfg_scale: 3.5, high_noise_cfg_scale: 3.5, video_frames: 33, fps: 16, flow_shift: 3, fast: false }
      : { width: 832, height: 480, steps: 4, high_noise_steps: 4, cfg_scale: 1, high_noise_cfg_scale: 1, video_frames: 33, fps: 16, flow_shift: 3, fast: true }),
    required: (params) => (params.fast === false ? ['diffusion', 'high_noise', 'vae', 't5xxl'] : ['diffusion', 'high_noise', 'vae', 't5xxl', 'lora_low', 'lora_high']),
    prompt: (p, f) => (p.fast ? `${p.prompt}<lora:${path.parse(f.lora_low).name}:1><lora:|high_noise|${path.parse(f.lora_high).name}:1>` : p.prompt),
    build: (p, f) => ['-M', 'vid_gen', '--diffusion-model', f.diffusion, '--high-noise-diffusion-model', f.high_noise, '--vae', f.vae, '--t5xxl', f.t5xxl,
      '--high-noise-cfg-scale', str(p.high_noise_cfg_scale), '--sampling-method', 'euler', '--high-noise-sampling-method', 'euler',
      '--high-noise-steps', str(p.high_noise_steps), '-n', p.negative_prompt || NEG_WAN, '--diffusion-fa',
      '--video-frames', str(p.video_frames), '--fps', str(p.fps), '--flow-shift', str(p.flow_shift), '-i', p.init_image,
      ...(p.fast ? ['--lora-model-dir', path.dirname(f.lora_low)] : [])],   // both lightx2v LoRAs live in the same directory
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

/** Merge defaults with the caller's params, pick a seed, and enforce required inputs. */
function prepare(spec, params) {
  const given = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const p = { ...spec.defaults(given), ...given };
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
