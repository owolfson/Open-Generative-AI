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

test('Wan needs exactly the four model files and no LoRAs (the lightx2v LoRAs crash sd.cpp with these GGUFs)', () => {
  const a = tmp();
  const spec = getSpec('wan2gp:wan22-i2v');
  assert.deepEqual(resolveFiles(spec, [a], {}).missing.sort(), ['Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf', 'Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf', 'Wan2_1_VAE_bf16.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors']);
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

test('Wan 2.2 I2V: both experts, sd.cpp quality recipe (10+8 steps, cfg 3.5 both stages), 33 frames, avi, init image, no LoRA', () => {
  const spec = getSpec('wan2gp:wan22-i2v');
  const params = prepare(spec, { prompt: 'the apple slowly rotates', init_image: '/tmp/init.png' });
  const args = buildArgs(spec, params, WAN_FILES, '/tmp/v.avi');
  assert.ok(pair(args, '-M', 'vid_gen'));
  assert.ok(pair(args, '--diffusion-model', WAN_FILES.diffusion));
  assert.ok(pair(args, '--high-noise-diffusion-model', WAN_FILES.high_noise));
  assert.ok(pair(args, '--vae', WAN_FILES.vae)); assert.ok(pair(args, '--t5xxl', WAN_FILES.t5xxl));
  assert.ok(pair(args, '-i', '/tmp/init.png')); assert.ok(pair(args, '-o', '/tmp/v.avi'));
  assert.equal(args[args.indexOf('-p') + 1], 'the apple slowly rotates');
  assert.equal(args.includes('--lora-model-dir'), false);
  assert.ok(pair(args, '--steps', 10)); assert.ok(pair(args, '--high-noise-steps', 8));
  assert.ok(pair(args, '--cfg-scale', 3.5)); assert.ok(pair(args, '--high-noise-cfg-scale', 3.5));
  assert.ok(pair(args, '--video-frames', 33)); assert.ok(pair(args, '--flow-shift', 3));
  assert.ok(pair(args, '-W', 640)); assert.ok(pair(args, '-H', 368)); assert.ok(pair(args, '-n', NEG_WAN));
  // memory placement, all measured on this host: T5's params live in RAM (6.4GB), everything else stays on the V100; NOT --offload-to-cpu (23.5GB of shmem, OOM-killed)
  assert.ok(pair(args, '--params-backend', 'te=cpu')); assert.equal(args.includes('--offload-to-cpu'), false); assert.ok(args.includes('--vae-tiling'));
  assert.ok(args.includes('--diffusion-fa'));
});

test('Wan fast mode (lightx2v LoRAs) is refused up front with a reason: sd.cpp aborts loading those LoRAs against these GGUFs (measured in every apply mode)', () => {
  const spec = getSpec('wan2gp:wan22-i2v');
  assert.throws(() => prepare(spec, { prompt: 'x', init_image: '/i.png', fast: true }), (e) => e.code === 'FAST_UNAVAILABLE' && /LoRA/.test(e.message));
  assert.doesNotThrow(() => prepare(spec, { prompt: 'x', init_image: '/i.png', fast: false }));
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

// ---------- text-to-video: Wan 2.2 T2V and HunyuanVideo 1.5 (no input image) ----------
const T2V_FILES = { diffusion: '/m/Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf', high_noise: '/m/Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf', vae: '/m/Wan2_1_VAE_bf16.safetensors', t5xxl: '/m/umt5_xxl_fp8_e4m3fn_scaled.safetensors' };
const HY_FILES = { diffusion: '/m/hunyuanvideo1.5_480p_t2v_fp16.safetensors', vae: '/m/hunyuanvideo15_vae_fp16.safetensors', llm: '/m/qwen_2.5_vl_7b_fp8_scaled.safetensors', t5xxl: '/m/byt5_small_glyphxl_fp16.safetensors' };

test('text-to-video specs exist: video/avi, NO input image, distinct from image-to-video', () => {
  for (const id of ['wan2gp:wan22-t2v', 'wan2gp:hunyuan-video']) {
    const spec = getSpec(id);
    assert.equal(spec.kind, 'video', id); assert.equal(spec.ext, 'avi', id); assert.ok(!spec.needsImage, id);
    assert.doesNotThrow(() => prepare(spec, { prompt: 'x' }), id);          // no IMAGE_REQUIRED
    assert.ok(spec.vramGb > 10, id);
  }
  assert.equal(getSpec('wan2gp:wan22-i2v').needsImage, true);
});

test('Wan 2.2 T2V: the I2V recipe (both experts, 10+8 steps, cfg 3.5, te params in RAM, vae tiling) minus the init image; its own weights', () => {
  const spec = getSpec('wan2gp:wan22-t2v');
  assert.deepEqual(Object.values(spec.files).sort(), ['Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf', 'Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf', 'Wan2_1_VAE_bf16.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors']);
  const args = buildArgs(spec, prepare(spec, { prompt: 'a lovely cat' }), T2V_FILES, '/o.avi');
  assert.ok(pair(args, '-M', 'vid_gen')); assert.ok(pair(args, '--diffusion-model', T2V_FILES.diffusion)); assert.ok(pair(args, '--high-noise-diffusion-model', T2V_FILES.high_noise));
  assert.equal(args.includes('-i'), false, 'text-to-video has no init image');
  assert.ok(pair(args, '--steps', 10)); assert.ok(pair(args, '--high-noise-steps', 8)); assert.ok(pair(args, '--cfg-scale', 3.5)); assert.ok(pair(args, '--high-noise-cfg-scale', 3.5));
  assert.ok(pair(args, '-W', 640)); assert.ok(pair(args, '-H', 368)); assert.ok(pair(args, '--video-frames', 33)); assert.ok(pair(args, '-n', NEG_WAN));
  assert.ok(pair(args, '--params-backend', 'te=cpu')); assert.ok(args.includes('--vae-tiling')); assert.equal(args.includes('--offload-to-cpu'), false); assert.equal(args.includes('--lora-model-dir'), false);
  assert.throws(() => prepare(spec, { prompt: 'x', fast: true }), { code: 'FAST_UNAVAILABLE' });
});

test('HunyuanVideo 1.5: sd.cpp doc recipe (diffusion + vae + Qwen2.5-VL as --llm + ByT5 as --t5xxl, cfg 6, euler, fa, tiling), single expert, no LoRA', () => {
  const spec = getSpec('wan2gp:hunyuan-video');
  assert.deepEqual(Object.values(spec.files).sort(), ['byt5_small_glyphxl_fp16.safetensors', 'hunyuanvideo1.5_480p_t2v_fp16.safetensors', 'hunyuanvideo15_vae_fp16.safetensors', 'qwen_2.5_vl_7b_fp8_scaled.safetensors']);
  const args = buildArgs(spec, prepare(spec, { prompt: 'a lovely cat', seed: 5 }), HY_FILES, '/o.avi');
  assert.ok(pair(args, '-M', 'vid_gen')); assert.ok(pair(args, '--diffusion-model', HY_FILES.diffusion)); assert.ok(pair(args, '--vae', HY_FILES.vae));
  assert.ok(pair(args, '--llm', HY_FILES.llm)); assert.ok(pair(args, '--t5xxl', HY_FILES.t5xxl));
  assert.ok(pair(args, '--cfg-scale', 6)); assert.ok(pair(args, '--sampling-method', 'euler')); assert.ok(args.includes('--diffusion-fa')); assert.ok(args.includes('--vae-tiling'));
  assert.ok(pair(args, '--video-frames', 33)); assert.ok(pair(args, '--params-backend', 'te=cpu'));
  // measured on the V100: the untiled/default-tiled VAE decode needs 13GB beside the 16GB model and fails; small spatial tiles + temporal tiling decode 33 frames in ~19GB
  assert.ok(args.includes('--temporal-tiling')); assert.ok(pair(args, '--vae-tile-size', '8x8'));
  assert.equal(args.includes('--high-noise-diffusion-model'), false); assert.equal(args.includes('-i'), false);
});

// ---------- LTX-2.3 22B distilled (Q4_K_M GGUF) through sd.cpp ----------
const LTX_FILES = { diffusion: '/m/ltx-2.3-22b-distilled-1.1-Q4_K_M.gguf', vae: '/m/ltx-2.3-22b-distilled_video_vae.safetensors', audio_vae: '/m/ltx-2.3-22b-distilled_audio_vae.safetensors', connectors: '/m/ltx-2.3-22b-distilled_embeddings_connectors.safetensors', llm: '/m/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf' };

test('LTX-2.3 distilled: sd.cpp recipe (8 steps, cfg 1, euler, fa), text encoder params in RAM, vae tiling, image optional', () => {
  const spec = getSpec('wan2gp:ltx-video');
  assert.equal(spec.kind, 'video'); assert.equal(spec.ext, 'avi'); assert.ok(!spec.needsImage); assert.equal(spec.acceptsImage, true);
  assert.deepEqual(Object.values(spec.files).sort(), ['gemma-3-12b-it-qat-UD-Q4_K_XL.gguf', 'ltx-2.3-22b-distilled-1.1-Q4_K_M.gguf', 'ltx-2.3-22b-distilled_audio_vae.safetensors', 'ltx-2.3-22b-distilled_embeddings_connectors.safetensors', 'ltx-2.3-22b-distilled_video_vae.safetensors']);
  const t2v = buildArgs(spec, prepare(spec, { prompt: 'a lovely cat', seed: 3 }), LTX_FILES, '/o.avi');
  assert.ok(pair(t2v, '-M', 'vid_gen')); assert.ok(pair(t2v, '--diffusion-model', LTX_FILES.diffusion)); assert.ok(pair(t2v, '--vae', LTX_FILES.vae)); assert.ok(pair(t2v, '--audio-vae', LTX_FILES.audio_vae));
  assert.ok(pair(t2v, '--llm', LTX_FILES.llm)); assert.ok(pair(t2v, '--embeddings-connectors', LTX_FILES.connectors));
  assert.ok(pair(t2v, '--steps', 8)); assert.ok(pair(t2v, '--cfg-scale', 1)); assert.ok(pair(t2v, '--sampling-method', 'euler')); assert.ok(t2v.includes('--diffusion-fa'));
  assert.ok(pair(t2v, '--fps', 24)); assert.ok(pair(t2v, '--params-backend', 'te=cpu')); assert.ok(t2v.includes('--vae-tiling')); assert.equal(t2v.includes('--offload-to-cpu'), false);
  assert.equal(t2v.includes('-i'), false, 'text-to-video without an image');
  const i2v = buildArgs(spec, prepare(spec, { prompt: 'a lovely cat', init_image: '/tmp/in.png' }), LTX_FILES, '/o.avi');
  assert.ok(pair(i2v, '-i', '/tmp/in.png'), 'the same model animates an image when one is given');
});

test('LTX-2.3 sizes: 540p-class only (32-aligned), 16:9 -> 960x544, 9:16 -> 544x960', () => {
  const spec = getSpec('wan2gp:ltx-video');
  const dims = (ar) => { const p = prepare(spec, { prompt: 'x', aspect_ratio: ar }); return [p.width, p.height]; };
  assert.deepEqual(dims('16:9'), [960, 544]); assert.deepEqual(dims('9:16'), [544, 960]);
  for (const ar of ['1:1', '4:3', '3:4']) { const [w, h] = dims(ar); assert.ok(w % 32 === 0 && h % 32 === 0 && w * h <= 960 * 576, ar); }
});

test('LTX-2.3 HARD LIMITS from the host-crash history (720p and >5s crashed this box): refused before any lease', () => {
  const spec = getSpec('wan2gp:ltx-video');
  for (const bad of [{ width: 1280, height: 720 }, { width: 1024, height: 576 }, { video_frames: 145 }, { video_frames: 193 }]) {
    assert.throws(() => prepare(spec, { prompt: 'x', ...bad }), (e) => e.code === 'LTX_LIMIT' && /540p|5 ?s|121/.test(e.message), JSON.stringify(bad));
  }
  for (const bad of [{ width: 970, height: 544 }, { video_frames: 50 }, { video_frames: 100 }]) {
    assert.throws(() => prepare(spec, { prompt: 'x', ...bad }), (e) => e.code === 'LTX_LIMIT' && /multiple|8n\+1|32/.test(e.message), JSON.stringify(bad));
  }
  for (const ok of [{ width: 960, height: 544, video_frames: 121 }, { width: 640, height: 352, video_frames: 33 }, { width: 544, height: 960, video_frames: 97 }]) assert.doesNotThrow(() => prepare(spec, { prompt: 'x', ...ok }), JSON.stringify(ok));
});

// ---------- Z-Image Base: our own spec with the Q8_0 quant (the upstream Q4_K_M renders a solid white image on this hardware) ----------
const ZB_FILES = { diffusion: '/m/z-image-Q8_0.gguf', llm: '/m/Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf', vae: '/m/ae.safetensors' };

test('Z-Image Base is served by our spec with the Q8_0 GGUF (Q4_K_M produced blank white images: measured on the 1080 and the V100, every sampler/cfg tried)', () => {
  const spec = getSpec('wan2gp:z-image-base') || getSpec('z-image-base');
  assert.ok(spec, 'spec exists'); assert.equal(spec.kind, 'image'); assert.equal(spec.ext, 'png');
  assert.deepEqual(Object.values(spec.files).sort(), ['Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf', 'ae.safetensors', 'z-image-Q8_0.gguf']);
  const args = buildArgs(spec, prepare(spec, { prompt: 'a red apple', seed: 4 }), ZB_FILES, '/o.png');
  assert.ok(pair(args, '--diffusion-model', ZB_FILES.diffusion)); assert.ok(pair(args, '--llm', ZB_FILES.llm)); assert.ok(pair(args, '--vae', ZB_FILES.vae));
  assert.ok(pair(args, '--cfg-scale', 5)); assert.ok(pair(args, '--steps', 30)); assert.ok(pair(args, '--sampling-method', 'euler')); assert.ok(args.includes('--diffusion-fa'));
  assert.ok(pair(args, '-W', 1024)); assert.ok(pair(args, '-H', 1024));
});
