'use strict';

// V100 assessments for the models in upstream's "Local Model Inference" README section.
// evidence: 'proven' = has produced correct output on THIS V100; 'untested' = supported by design, not yet run here.
// Volta (compute 7.0) facts: WanGP forces fp16 (no bf16); no FP8/FP4/Nunchaku kernels; SDPA attention only.
const SD = 'sdcpp';
const WAN = 'wangp';

const ENTRIES = [
  { id: 'z-image-turbo', name: 'Z-Image Turbo', kind: 'image', route: SD, v100: 'recommended', star: true, evidence: 'proven', provenOn: ['gtx1080'], weightsGb: 5.2, note: 'Measured 2026-09-20 on the GTX 1080 lane: 1024x1024, 8 steps, 204s, 7.5GB peak on the card including the resident TTS container. Best quality for the effort.' },
  { id: 'z-image-base', name: 'Z-Image Base', kind: 'image', route: SD, v100: 'recommended', star: true, evidence: 'untested', provenOn: [], weightsGb: 6.2, note: '50-step quality; same weights class as Turbo.' },
  { id: 'stable-diffusion-xl-base', name: 'SDXL Base 1.0', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', provenOn: [], weightsGb: 6.9, note: 'Runs, but older than Z-Image/Flux/Qwen.' },
  { id: 'dreamshaper-8', name: 'Dreamshaper 8', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'proven', provenOn: ['gtx1080'], weightsGb: 2.1, note: 'Measured 2026-09-20 on the GTX 1080 lane: 512x512, 20 steps, 44s including model load, 8.0GB peak on the card (tight beside the TTS container).' },
  { id: 'realistic-vision-v51', name: 'Realistic Vision v5.1', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', provenOn: [], weightsGb: 2.1, note: 'SD 1.5 photorealistic.' },
  { id: 'anything-v5', name: 'Anything v5', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', provenOn: [], weightsGb: 2.1, note: 'SD 1.5 anime/illustration.' },
  { id: 'wan2gp:flux-dev', name: 'Flux.1 Dev', kind: 'image', route: SD, v100: 'recommended', star: true, evidence: 'proven', provenOn: ['v100'], weightsGb: 21.6, note: 'Served by sd.cpp from the Q8_0 GGUF in the ComfyUI store. Proven on the V100 (2026-09-20): 1024x1024, 20 steps = 160s incl. ~100s model load, sampling ~1.6s/step; peak 28.8GB (22.8GB while sampling, +6GB in the VAE decode).' },
  { id: 'wan2gp:qwen-image', name: 'Qwen Image', kind: 'image', route: SD, v100: 'recommended', star: true, evidence: 'proven', provenOn: ['v100'], weightsGb: 24.6, note: 'Served by sd.cpp (Q6_K GGUF + the fp8-scaled Qwen2.5-VL encoder, which loads fine). Proven on the V100 (2026-09-20): 1024x1024, 20 steps = 187s incl. ~100s model load, ~3s/step; peak 24.5GB with --vae-tiling (31.9GB without it). No black-image problem.' },
  { id: 'wan2gp:wan22-t2v', name: 'Wan 2.2 (Text-to-Video)', kind: 'video', route: WAN, v100: 'recommended', star: true, evidence: 'untested', provenOn: [], weightsGb: 29.8, note: 'WanGP ships an fp16-mixed int8 build (14.9GB per expert, two experts).' },
  { id: 'wan2gp:wan22-i2v', name: 'Wan 2.2 (Image-to-Video)', kind: 'video', route: SD, v100: 'recommended', star: true, evidence: 'proven', provenOn: ['v100'], weightsGb: 26.8, note: 'Served by sd.cpp: the Q4_K_M high/low-noise pair from the ComfyUI store, quality mode only (10+8 steps): the lightx2v 4-step LoRAs abort sd.cpp on these GGUFs. Proven on the V100 at 640x368 / 33 frames (377s incl. load, peak 27.4GB) with the T5 encoder params in host RAM (--params-backend te=cpu); output is converted to mp4 for browsers. --offload-to-cpu is NOT used: it needs ~24GB of host shmem and got OOM-killed.' },
  { id: 'wan2gp:hunyuan-video', name: 'Hunyuan Video', kind: 'video', route: WAN, v100: 'supported', star: false, evidence: 'untested', provenOn: [], weightsGb: 13.2, note: 'Runs, but Wan 2.2 beats it.' },
  { id: 'wan2gp:ltx-video', name: 'LTX Video (0.9.8 13B distilled)', kind: 'video', route: WAN, v100: 'supported', star: false, evidence: 'untested', provenOn: [], weightsGb: 13.2, note: 'Fastest video option. LTX-2.3 22B is excluded.' },
];

const EXCLUDED = [
  { id: 'ltx-2.3-22b', reason: 'LTX-2.3 22B (19.4GB int8) caused 4 host crashes on this box; never run it.' },
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
