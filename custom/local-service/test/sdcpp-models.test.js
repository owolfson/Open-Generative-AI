'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getSpec, resolveFiles, prepare, buildArgs, NEG_WAN } = require('../src/sdcpp-models');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-models-'));
function touch(root, rel) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; }
const pair = (args, flag, value) => { const i = args.indexOf(flag); return i >= 0 && (value === undefined ? true : args[i + 1] === String(value)); };

const FLUX_FILES = { diffusion: '/m/flux1-dev-Q8_0.gguf', vae: '/m/ae.sft.safetensors', clip_l: '/m/clip_l.safetensors', t5xxl: '/m/t5xxl_fp16.safetensors' };
const QWEN_FILES = { diffusion: '/m/qwen-image-2512-Q6_K.gguf', vae: '/m/qwen_image_vae.safetensors', llm: '/m/qwen_2.5_vl_7b_fp8_scaled.safetensors' };
const WAN_FILES = {
  diffusion: '/m/Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf', high_noise: '/m/Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf',
  vae: '/m/Wan2_1_VAE_bf16.safetensors', t5xxl: '/m/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  lora_low: '/l/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors', lora_high: '/l/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors',
};

test('specs exist for exactly the three catalog ids we serve, with the right kind and output type', () => {
  assert.equal(getSpec('wan2gp:flux-dev').kind, 'image');
  assert.equal(getSpec('wan2gp:qwen-image').kind, 'image');
  assert.equal(getSpec('wan2gp:wan22-i2v').kind, 'video');
  assert.equal(getSpec('wan2gp:wan22-i2v').ext, 'avi');
  assert.equal(getSpec('wan2gp:flux-dev').ext, 'png');
  assert.equal(getSpec('z-image-turbo'), undefined);   // upstream's own engine serves that one
  for (const id of ['wan2gp:flux-dev', 'wan2gp:qwen-image', 'wan2gp:wan22-i2v']) assert.ok(getSpec(id).vramGb > 10, id);
});

test('resolveFiles finds files by basename in nested model dirs across several roots', () => {
  const a = tmp(); const b = tmp();
  touch(a, 'unet/flux1-dev-Q8_0.gguf'); touch(a, 'vae/ae.sft.safetensors');
  touch(b, 'clip/clip_l.safetensors'); touch(b, 'clip/t5xxl_fp16.safetensors');
  const { files, missing } = resolveFiles(getSpec('wan2gp:flux-dev'), [a, b], {});
  assert.deepEqual(missing, []);
  assert.equal(files.diffusion, path.join(a, 'unet/flux1-dev-Q8_0.gguf'));
  assert.equal(files.t5xxl, path.join(b, 'clip/t5xxl_fp16.safetensors'));
});

test('resolveFiles reports every missing basename and an unreadable/absent dir is not fatal', () => {
  const a = tmp();
  touch(a, 'vae/ae.sft.safetensors');
  const { missing } = resolveFiles(getSpec('wan2gp:flux-dev'), [a, '/nonexistent/dir'], {});
  assert.deepEqual(missing.sort(), ['clip_l.safetensors', 'flux1-dev-Q8_0.gguf', 't5xxl_fp16.safetensors']);
});

test('LoRA files are only required for the fast (LoRA) Wan mode', () => {
  const a = tmp();
  for (const f of ['Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf', 'Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf', 'Wan2_1_VAE_bf16.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors']) touch(a, `m/${f}`);
  const spec = getSpec('wan2gp:wan22-i2v');
  assert.equal(resolveFiles(spec, [a], { fast: false }).missing.length, 0);
  assert.deepEqual(resolveFiles(spec, [a], {}).missing.sort(), ['wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors', 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors']);
});

test('prepare fills defaults, keeps overrides, and picks a positive random seed when none/-1', () => {
  const p = prepare(getSpec('wan2gp:flux-dev'), { prompt: 'a cat' });
  assert.equal(p.width, 1024); assert.equal(p.height, 1024); assert.equal(p.steps, 20); assert.equal(p.cfg_scale, 1);
  assert.ok(Number.isInteger(p.seed) && p.seed > 0);
  const q = prepare(getSpec('wan2gp:flux-dev'), { prompt: 'a cat', width: 640, steps: 8, seed: 42 });
  assert.equal(q.width, 640); assert.equal(q.steps, 8); assert.equal(q.seed, 42);
  assert.ok(prepare(getSpec('wan2gp:flux-dev'), { prompt: 'x', seed: -1 }).seed > 0);
});

test('Flux args follow sd.cpp docs: all four files, cfg 1, euler, flash attention, text encoders stay on the GPU', () => {
  const spec = getSpec('wan2gp:flux-dev');
  const args = buildArgs(spec, prepare(spec, { prompt: 'a cat', seed: 7 }), FLUX_FILES, '/tmp/out.png');
  assert.ok(pair(args, '--diffusion-model', FLUX_FILES.diffusion));
  assert.ok(pair(args, '--vae', FLUX_FILES.vae));
  assert.ok(pair(args, '--clip_l', FLUX_FILES.clip_l));
  assert.ok(pair(args, '--t5xxl', FLUX_FILES.t5xxl));
  assert.ok(pair(args, '--cfg-scale', 1)); assert.ok(pair(args, '--sampling-method', 'euler'));
  assert.ok(pair(args, '-p', 'a cat')); assert.ok(pair(args, '--seed', 7)); assert.ok(pair(args, '-o', '/tmp/out.png'));
  assert.ok(pair(args, '-W', 1024)); assert.ok(pair(args, '-H', 1024)); assert.ok(pair(args, '--steps', 20));
  assert.ok(args.includes('--diffusion-fa'));
  assert.equal(args.includes('--clip-on-cpu'), false, 'this host has no F16C: fp16 text encoding on the CPU is very slow');
  assert.equal(args.includes('-M'), false);
});

test('Qwen-Image args follow sd.cpp docs: llm text encoder, cfg 2.5, flow shift 3, flash attention', () => {
  const spec = getSpec('wan2gp:qwen-image');
  const args = buildArgs(spec, prepare(spec, { prompt: 'a sign that says HELLO' }), QWEN_FILES, '/tmp/q.png');
  assert.ok(pair(args, '--llm', QWEN_FILES.llm)); assert.ok(pair(args, '--vae', QWEN_FILES.vae));
  assert.ok(pair(args, '--cfg-scale', 2.5)); assert.ok(pair(args, '--flow-shift', 3)); assert.ok(args.includes('--diffusion-fa'));
});

test('Wan 2.2 I2V fast mode: both experts, LoRA tags for low AND high noise, 4+4 steps, cfg 1, 33 frames, avi, init image', () => {
  const spec = getSpec('wan2gp:wan22-i2v');
  const params = prepare(spec, { prompt: 'the apple slowly rotates', init_image: '/tmp/init.png' });
  const args = buildArgs(spec, params, WAN_FILES, '/tmp/v.avi');
  assert.ok(pair(args, '-M', 'vid_gen'));
  assert.ok(pair(args, '--diffusion-model', WAN_FILES.diffusion));
  assert.ok(pair(args, '--high-noise-diffusion-model', WAN_FILES.high_noise));
  assert.ok(pair(args, '--vae', WAN_FILES.vae)); assert.ok(pair(args, '--t5xxl', WAN_FILES.t5xxl));
  assert.ok(pair(args, '-i', '/tmp/init.png')); assert.ok(pair(args, '-o', '/tmp/v.avi'));
  assert.ok(pair(args, '--lora-model-dir', '/l'));
  const prompt = args[args.indexOf('-p') + 1];
  assert.ok(prompt.startsWith('the apple slowly rotates'));
  assert.ok(prompt.includes('<lora:wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise:1>'));
  assert.ok(prompt.includes('<lora:|high_noise|wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise:1>'));
  assert.ok(pair(args, '--steps', 4)); assert.ok(pair(args, '--high-noise-steps', 4));
  assert.ok(pair(args, '--cfg-scale', 1)); assert.ok(pair(args, '--high-noise-cfg-scale', 1));
  assert.ok(pair(args, '--video-frames', 33)); assert.ok(pair(args, '--flow-shift', 3));
  assert.ok(pair(args, '-W', 640)); assert.ok(pair(args, '-H', 368)); assert.ok(args.includes('--offload-to-cpu')); assert.ok(pair(args, '-n', NEG_WAN));
  assert.ok(args.includes('--diffusion-fa'));
});

test('Wan 2.2 I2V quality mode (fast:false): no LoRA, 10+8 steps, cfg 3.5 both stages', () => {
  const spec = getSpec('wan2gp:wan22-i2v');
  const args = buildArgs(spec, prepare(spec, { prompt: 'x', init_image: '/tmp/i.png', fast: false }), WAN_FILES, '/tmp/v.avi');
  assert.equal(args.includes('--lora-model-dir'), false);
  assert.equal(args[args.indexOf('-p') + 1].includes('<lora:'), false);
  assert.ok(pair(args, '--steps', 10)); assert.ok(pair(args, '--high-noise-steps', 8));
  assert.ok(pair(args, '--cfg-scale', 3.5)); assert.ok(pair(args, '--high-noise-cfg-scale', 3.5));
});

test('Wan 2.2 I2V needs an init image; explicit size/frames/fps overrides are honoured', () => {
  const spec = getSpec('wan2gp:wan22-i2v');
  assert.throws(() => prepare(spec, { prompt: 'x' }), { code: 'IMAGE_REQUIRED' });
  const args = buildArgs(spec, prepare(spec, { prompt: 'x', init_image: '/i.png', width: 480, height: 832, video_frames: 17, fps: 8 }), WAN_FILES, '/o.avi');
  assert.ok(pair(args, '-W', 480)); assert.ok(pair(args, '-H', 832)); assert.ok(pair(args, '--video-frames', 17)); assert.ok(pair(args, '--fps', 8));
});

const VIDEO_AREA_OK = ([w, h]) => w * h <= 640 * 368 * 1.1 && w % 16 === 0 && h % 16 === 0;

test('aspect_ratio maps to dimensions (images 64-aligned off base 1024; video = measured-safe table); explicit width/height win', () => {
  const flux = getSpec('wan2gp:flux-dev'); const wan = getSpec('wan2gp:wan22-i2v');
  const dims = (spec, extra) => { const p = prepare(spec, { prompt: 'x', init_image: '/i.png', ...extra }); return [p.width, p.height]; };
  assert.deepEqual(dims(flux, { aspect_ratio: '1:1' }), [1024, 1024]);
  assert.deepEqual(dims(flux, { aspect_ratio: '16:9' }), [1792, 1024]);
  assert.deepEqual(dims(flux, { aspect_ratio: '9:16' }), [1024, 1792]);
  assert.deepEqual(dims(flux, { aspect_ratio: '4:3' }), [1344, 1024]);
  assert.deepEqual(dims(wan, { aspect_ratio: '9:16' }), [368, 640]);
  assert.deepEqual(dims(wan, { aspect_ratio: '16:9' }), [640, 368]);
  assert.ok(VIDEO_AREA_OK(dims(wan, { aspect_ratio: '4:3' })) && VIDEO_AREA_OK(dims(wan, { aspect_ratio: '1:1' })), 'every video ratio stays near the measured-safe pixel area');
  assert.deepEqual(dims(flux, { aspect_ratio: '16:9', width: 512, height: 512 }), [512, 512]);
  assert.deepEqual(dims(flux, { aspect_ratio: 'nonsense' }), [1024, 1024]);
});

test('guidance_scale (upstream naming) is accepted as cfg_scale', () => {
  assert.equal(prepare(getSpec('wan2gp:qwen-image'), { prompt: 'x', guidance_scale: 4 }).cfg_scale, 4);
  assert.equal(prepare(getSpec('wan2gp:qwen-image'), { prompt: 'x', guidance_scale: 4, cfg_scale: 3 }).cfg_scale, 3);
});

test('every extended model decodes with --vae-tiling (measured: the untiled VAE decode adds 6-7GB and pushed Qwen-Image to 31.9GB of the 32GB V100)', () => {
  for (const id of ['wan2gp:flux-dev', 'wan2gp:qwen-image', 'wan2gp:wan22-i2v']) {
    const spec = getSpec(id);
    const args = buildArgs(spec, prepare(spec, { prompt: 'x', init_image: '/i.png', seed: 1 }), { diffusion: '/d', vae: '/v', clip_l: '/c', t5xxl: '/t', llm: '/l', high_noise: '/h', lora_low: '/a/low.safetensors', lora_high: '/a/high.safetensors' }, '/o');
    assert.ok(args.includes('--vae-tiling'), id);
  }
});
