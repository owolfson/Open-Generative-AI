#!/usr/bin/env python3
"""Download the model files ogai-local needs for the text-to-video models, verified against Hugging Face's own SHA-256.

  custom/local-service/fetch-models.py [--group wan-t2v|hunyuan|all] [--list]

Files land in $OGAI_DATA/local-ai/models/extended (the service always searches it; see src/config.js). Resumable (re-run after an
interruption), idle-friendly (use `ionice -c3 nice -n19` on a busy host) and safe to re-run: files that already verify are skipped.

The other extended models are NOT fetched here: Flux, Qwen-Image and Wan 2.2 image-to-video are read from the ComfyUI model folders
mounted through OGAI_MODEL_MOUNTS, and Wan T2V reuses two files from there (Wan2_1_VAE_bf16.safetensors, umt5_xxl_fp8_e4m3fn_scaled.safetensors),
as does Hunyuan (qwen_2.5_vl_7b_fp8_scaled.safetensors). The upstream sd.cpp models (Z-Image, SD 1.5, SDXL) download from Settings -> Local models.
"""
import argparse, hashlib, json, os, subprocess, sys, time, urllib.request

DEST = os.path.join(os.environ.get('OGAI_DATA', '/mnt/user/appdata/open-generative-ai'), 'local-ai', 'models', 'extended')
GROUPS = {
    'wan-t2v': [  # Wan 2.2 text-to-video, Q4_K_M pair (same quant as the image-to-video pair already in use)
        ('QuantStack/Wan2.2-T2V-A14B-GGUF', 'LowNoise/Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf'),
        ('QuantStack/Wan2.2-T2V-A14B-GGUF', 'HighNoise/Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf'),
    ],
    'hunyuan': [  # HunyuanVideo 1.5, 480p text-to-video, fp16 (the Qwen2.5-VL text encoder comes from the ComfyUI store)
        ('Comfy-Org/HunyuanVideo_1.5_repackaged', 'split_files/text_encoders/byt5_small_glyphxl_fp16.safetensors'),
        ('Comfy-Org/HunyuanVideo_1.5_repackaged', 'split_files/vae/hunyuanvideo15_vae_fp16.safetensors'),
        ('Comfy-Org/HunyuanVideo_1.5_repackaged', 'split_files/diffusion_models/hunyuanvideo1.5_480p_t2v_fp16.safetensors'),
    ],
}

def say(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)

def hf_meta(repo, path):
    tree = json.load(urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}/tree/main/{os.path.dirname(path)}', timeout=30))
    for item in tree:
        if item['path'] == path: return item['lfs']['oid'], item['size']
    raise SystemExit(f'not found on Hugging Face: {repo}/{path}')

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(8 << 20), b''): h.update(block)
    return h.hexdigest()

def fetch(repo, path):
    name = os.path.basename(path); dest = os.path.join(DEST, name)
    want, size = hf_meta(repo, path)
    if os.path.exists(dest) and os.path.getsize(dest) == size and sha256(dest) == want:
        say('ok (already verified)', name); return
    for attempt in range(1, 6):
        say(f'download {name} ({size / 1e9:.2f} GB), attempt {attempt}')
        subprocess.run(['curl', '-fL', '--retry', '3', '-C', '-', '-o', dest + '.part', f'https://huggingface.co/{repo}/resolve/main/{path}'], check=False)
        if os.path.exists(dest + '.part') and os.path.getsize(dest + '.part') == size: break
        time.sleep(10)
    else: raise SystemExit(f'giving up on {name}')
    say('verify sha256', name)
    got = sha256(dest + '.part')
    if got != want:
        os.remove(dest + '.part'); raise SystemExit(f'SHA-256 MISMATCH for {name}: {got} != {want}')
    os.rename(dest + '.part', dest); say('verified', name)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--group', choices=[*GROUPS, 'all'], default='all'); ap.add_argument('--list', action='store_true', help='show what would be downloaded and exit')
    args = ap.parse_args()
    files = [f for g, items in GROUPS.items() if args.group in (g, 'all') for f in items]
    if args.list:
        for repo, path in files: print(f'{repo}/{path}')
        return
    os.makedirs(DEST, exist_ok=True)
    for repo, path in files: fetch(repo, path)
    say('all done ->', DEST)

if __name__ == '__main__': main()
