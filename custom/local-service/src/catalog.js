'use strict';

// V100 assessments for the models in upstream's "Local Model Inference" README section.
// evidence: 'proven' = has produced correct output on THIS V100; 'untested' = supported by design, not yet run here.
// Volta (compute 7.0) facts: WanGP forces fp16 (no bf16); no FP8/FP4/Nunchaku kernels; SDPA attention only.
const SD = 'sdcpp';
const WAN = 'wangp';
const COMFY = 'comfyui';

const ENTRIES = [
  { id: 'z-image-turbo', name: 'Z-Image Turbo', kind: 'image', route: SD, v100: 'recommended', star: true, evidence: 'untested', weightsGb: 5.2, note: '8-step fast lane. Small enough that the GTX 1080 lane may fit (unverified).' },
  { id: 'z-image-base', name: 'Z-Image Base', kind: 'image', route: SD, v100: 'recommended', star: true, evidence: 'untested', weightsGb: 6.2, note: '50-step quality; same weights class as Turbo.' },
  { id: 'stable-diffusion-xl-base', name: 'SDXL Base 1.0', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', weightsGb: 6.9, note: 'Runs, but older than Z-Image/Flux/Qwen.' },
  { id: 'dreamshaper-8', name: 'Dreamshaper 8', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', weightsGb: 2.1, note: 'SD 1.5; tiny and fast, useful for style variety.' },
  { id: 'realistic-vision-v51', name: 'Realistic Vision v5.1', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', weightsGb: 2.1, note: 'SD 1.5 photorealistic.' },
  { id: 'anything-v5', name: 'Anything v5', kind: 'image', route: SD, v100: 'supported', star: false, evidence: 'untested', weightsGb: 2.1, note: 'SD 1.5 anime/illustration.' },
  { id: 'wan2gp:flux-dev', name: 'Flux.1 Dev', kind: 'image', route: WAN, v100: 'recommended', star: true, evidence: 'untested', weightsGb: 12.0, note: 'int8 12.0GB. WanGP forces fp16 on Volta - run a black-image check before trusting it.' },
  { id: 'wan2gp:qwen-image', name: 'Qwen Image', kind: 'image', route: COMFY, v100: 'recommended', star: true, evidence: 'proven', weightsGb: 15.7, note: 'Q6_K GGUF via ComfyUI is proven here (~12 min for 40 steps at 1328x1328, ~25GB peak). Never force fp16: output goes black.' },
  { id: 'wan2gp:wan22-t2v', name: 'Wan 2.2 (Text-to-Video)', kind: 'video', route: WAN, v100: 'recommended', star: true, evidence: 'untested', weightsGb: 29.8, note: 'WanGP ships an fp16-mixed int8 build (14.9GB per expert, two experts).' },
  { id: 'wan2gp:wan22-i2v', name: 'Wan 2.2 (Image-to-Video)', kind: 'video', route: WAN, v100: 'recommended', star: true, evidence: 'untested', weightsGb: 29.8, note: 'Wan 2.1/2.2 I2V GGUFs are already on disk in the ComfyUI store.' },
  { id: 'wan2gp:hunyuan-video', name: 'Hunyuan Video', kind: 'video', route: WAN, v100: 'supported', star: false, evidence: 'untested', weightsGb: 13.2, note: 'Runs, but Wan 2.2 beats it.' },
  { id: 'wan2gp:ltx-video', name: 'LTX Video (0.9.8 13B distilled)', kind: 'video', route: WAN, v100: 'supported', star: false, evidence: 'untested', weightsGb: 13.2, note: 'Fastest video option. LTX-2.3 22B is excluded.' },
];

const EXCLUDED = [
  { id: 'ltx-2.3-22b', reason: 'LTX-2.3 22B (19.4GB int8) caused 4 host crashes on this box; never run it.' },
  { id: 'nvfp4-and-nunchaku-variants', reason: 'Volta (compute 7.0) has no FP4/FP8/Nunchaku kernels.' },
];

const BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

const assess = (id) => BY_ID.get(id);

const UNKNOWN = { kind: 'image', route: null, v100: 'unknown', star: false, evidence: 'untested', weightsGb: null, note: 'Shipped by upstream, not yet assessed for the V100.' };

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
