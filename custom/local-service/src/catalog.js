'use strict';

// V100 assessments for the models in upstream's "Local Model Inference" README section.
// evidence: 'proven' = has produced correct output on THIS V100; 'untested' = supported by design, not yet run here.
// Volta (compute 7.0) facts: WanGP forces fp16 (no bf16); no FP8/FP4/Nunchaku kernels; SDPA attention only.
const SD = 'sdcpp';
const WAN = 'wangp';

const ENTRIES = [
  { id: 'z-image-turbo', name: 'Z-Image Turbo', kind: 'image', route: SD, v100: 'recommended', star: true, evidence: 'proven', provenOn: ['gtx1080', 'v100'], weightsGb: 5.2, note: '16GB V100 (2026-10-07, through the API): 1024x1024 = 44s, clean at 1:1. Measured 2026-09-20 on the GTX 1080 lane: 1024x1024, 8 steps, 204s, 7.5GB peak on the card including the resident TTS container. Best quality for the effort. Also proven on the V100 (2026-09-20 and re-verified 2026-09-21): 1024x1024, 8 steps = ~35s render.' },
  { id: 'z-image-base', name: 'Z-Image Base', kind: 'image', route: SD, v100: 'unsupported', star: false, evidence: 'untested', provenOn: [], weightsGb: 7.2, note: 'GTX 1080 ONLY. Served from our own spec with the Q8_0 GGUF (upstream\'s Q4_K_M renders a solid white image), 768-based sizes, 20 steps, cfg 5. It renders a BLANK image on the Tesla V100 at every size/setting tried (fp16 overflow), so the V100 is refused; on the 1080 it runs through host-RAM offload and is slow. Z-Image Turbo is the fast, proven Z-Image.' },
  { id: 'stable-diffusion-xl-base', name: 'SDXL Base 1.0', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'proven', provenOn: ['v100'], weightsGb: 6.9, note: 'SDXL 1.0 base. Proven on the V100 (2026-09-21): 1024x1024, 30 steps = 76s, sharp results. Needs the V100 (weights + 1024px decode do not fit the 1080 beside the TTS model).' },
  { id: 'dreamshaper-8', name: 'Dreamshaper 8', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'proven', provenOn: ['gtx1080', 'v100'], weightsGb: 2.1, note: 'Measured 2026-09-20 on the GTX 1080 lane: 512x512, 20 steps, 44s including model load, 8.0GB peak on the card (tight beside the TTS container). Also proven on the V100 (2026-09-21): 512x512, ~14s.' },
  { id: 'realistic-vision-v51', name: 'Realistic Vision v5.1', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'proven', provenOn: ['gtx1080', 'v100'], weightsGb: 2.1, note: 'SD 1.5 photorealistic. Proven on the GTX 1080 at 512x512 (2026-09-21, ~50s). Sizes above ~512x512 (e.g. 3:4 = 512x768) run out of memory in the VAE decode on the 8GB card beside the resident TTS model: use 1:1 there, or the V100. Also proven on the V100 (2026-09-21), including 3:4 (512x768) which the 1080 cannot do: ~17s.' },
  { id: 'anything-v5', name: 'Anything v5', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'proven', provenOn: ['gtx1080', 'v100'], weightsGb: 2.1, note: 'SD 1.5 anime/illustration. Proven on the GTX 1080 at 512x512 (2026-09-21). Same size limit as the other SD 1.5 models: 1:1 on the 1080, larger on the V100. Also proven on the V100 (2026-09-21), including 3:4 (512x768): ~16s.' },
  { id: 'wan2gp:flux-dev', name: 'Flux.1 Dev (legacy)', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'proven', provenOn: ['v100'], weightsGb: 21.6, note: 'LEGACY (2026-10-07): superseded by Qwen-Image-2.1 and Z-Image Turbo. On this V100 Flux renders a fine crosshatch/mesh over dark smooth areas (cliffs, spray) visible at 1:1 - unchanged with VAE tiling off, flash-attn off, guidance 2.5, 30 steps or all weights resident, and present on the old 32GB card too. 16GB card: 1024x1024 / 20 steps = 141s, peak 13.5GB (Q8_0, text encoder params in host RAM, diffusion params streamed).' },
  { id: 'wan2gp:qwen-image', name: 'Qwen Image (2512)', kind: 'image', route: SD, v100: 'recommended', star: true, evidence: 'proven', provenOn: ['v100'], weightsGb: 24.6, note: 'Qwen-Image-2512, Apache-2.0: the pick for COMMERCIAL work with strong text rendering (Qwen-Image-2.1 is newer and better but research-only). Q6_K GGUF + the fp8-scaled Qwen2.5-VL encoder. 16GB card (2026-10-07): 1024x1024 / 20 steps = 265-286s, peak 15.5GB (the 16.4GB model is streamed in segments). Sign text rendered exactly.' },
  { id: 'wan2gp:wan22-t2v', name: 'Wan 2.2 (Text-to-Video)', kind: 'video', route: SD, v100: 'recommended', star: true, evidence: 'proven', provenOn: ['v100'], weightsGb: 19.3, note: 'Wan 2.2 A14B Q4_K_M high/low-noise pair (QuantStack GGUF), quality mode (10+8 steps), UMT5 params in host RAM, diffusion params streamed, VAE tiling. 16GB card (2026-10-07): 640x368 x 33 frames, peak 11.0GB, ~250s at 4+4 steps; coherent motion. mp4 output.' },
  { id: 'wan2gp:wan22-i2v', name: 'Wan 2.2 (Image-to-Video)', kind: 'video', route: SD, v100: 'recommended', star: true, evidence: 'proven', provenOn: ['v100'], weightsGb: 26.8, note: 'Wan 2.2 A14B Q4_K_M high/low-noise pair, quality mode only (10+8 steps; the lightx2v 4-step LoRAs abort sd.cpp on these GGUFs). 16GB card (2026-10-07): 640x368 x 33 frames = 377s at the default 10+8 steps, peak 11.1GB; the input image is followed faithfully. --offload-to-cpu is NOT used (it needs ~24GB of host RAM and got OOM-killed).' },
  { id: 'wan2gp:hunyuan-video', name: 'HunyuanVideo 1.5 (Text-to-Video)', kind: 'video', route: SD, v100: 'supported', star: false, evidence: 'proven', provenOn: ['v100'], weightsGb: 12.4, note: 'HunyuanVideo 1.5 480p converted once to Q8_0 (9.0GB; the fp16 file cannot run on the 16GB card) + its VAE + Qwen2.5-VL + ByT5. 16GB card (2026-10-07): 640x368 x 33 frames, 30 steps = ~300s, peak 9.8GB. The VAE decode uses spatial-only 16x16 tiles: sd.cpp temporal tiling drew a grid over every frame after ~frame 9 (also on the old 32GB setup).' },
  { id: 'wan2gp:ltx-video', name: 'LTX-2.3 22B (Text/Image-to-Video, distilled)', kind: 'video', route: SD, v100: 'supported', star: false, evidence: 'proven', provenOn: ['v100'], weightsGb: 26.0, note: 'LTX-2.3 22B distilled Q4_K_M through sd.cpp (8 steps, cfg 1), Gemma-3-12B params in host RAM, diffusion params streamed. 16GB card (2026-10-07): 640x352 x 49 frames = 129s; 960x544 x 121 frames (5s, the cap) = 313s at peak 15.5GB (faster than the old 32GB card). HARD LIMITS in code: 540p-class (<=960x576), <=121 frames. Text-to-video, or image-to-video with an optional starting image.' },
  { id: 'wan2gp:ltx-2.5', name: 'LTX-2.5 22B (Text/Image-to-Video, distilled)', kind: 'video', route: SD, v100: 'supported', star: false, evidence: 'untested', provenOn: [], weightsGb: 30.5, note: 'LTX-2.5 22B (2026-08-11): better motion than 2.3, Gemma-4-12B encoder with the projection built in. Distilled Q4_K_M (vantagewithai GGUF, on disk) + the conv video VAE + audio VAE + encoder (Q8_0 after a one-time convert). WAITING: the VAEs and the encoder are only in the gated Lightricks/LTX-2.5 repo - accept its license on Hugging Face and give the server a read token. Same hard limits as LTX-2.3: <=960x576, <=121 frames.' },
];

const EXCLUDED = [
  { id: 'ltx-2.3-22b', reason: 'LTX Desktop (the bf16/int8 22B pipeline that block-cycles ~43GB of weights through host RAM, and 720p) crashed this host 7+ times and its container is gone. LTX-2.3 is offered instead as a Q4 GGUF through sd.cpp, capped at 540p / 5s.' },
  { id: 'qwen-image-2.1', reason: 'Qwen-Image-2.1 (2026-09-20, #1 open-weights image model) renders vertical hatching and green/magenta blobs on this V100 in sd.cpp master-945, whatever the weights (Q8_0 / bf16), flash-attn, prefix cache, cuBLAS precision or VRAM placement - same signature as open sd.cpp issue #2078 on a T4 (also pre-Ampere). Files kept on disk; re-test with newer sd.cpp builds. Research-only license anyway.' },
  { id: 'nvfp4-and-nunchaku-variants', reason: 'Volta (compute 7.0) has no FP4/FP8/Nunchaku kernels.' },
];

const BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

const assess = (id) => BY_ID.get(id);

const UNKNOWN = { kind: 'image', route: null, v100: 'unknown', star: false, evidence: 'untested', provenOn: [], weightsGb: null, note: 'Shipped by upstream, not yet assessed for the V100.' };

function annotate(models) {
  return models.map((m) => {
    const known = BY_ID.get(m.id);
    if (!known) return { ...m, ...UNKNOWN };
    const { name, ...meta } = known;   // keep upstream's display name
    return { ...m, ...meta };
  });
}

const staticCatalog = () => ENTRIES.map((e) => ({ ...e }));

module.exports = { assess, annotate, staticCatalog, EXCLUDED };
