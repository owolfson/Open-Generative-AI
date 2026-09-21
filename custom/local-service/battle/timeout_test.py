#!/usr/bin/env python3
"""Proves JOB_TIMEOUT on a real sd-cli: starts a SCRATCH ogai-local (own port, own data dir, GTX 1080 only, no arbiter) with a 12s job limit,
runs a Dreamshaper job (~45s normally), and checks the job is stopped with JOB_TIMEOUT and no sd-cli is left. Never touches the live service or the V100."""
import json, os, subprocess, sys, time, urllib.request
DATA = '/mnt/user/appdata/open-generative-ai'; SCR = '/tmp/ogai-timeout-scratch'; NAME = 'ogai-timeout-test'; PORT = 8798; TOKEN = 'battle-token'
LIVE_MODELS = f'{DATA}/local-ai/models'
def sh(*a, **k): return subprocess.run(a, capture_output=True, text=True, **k)
sh('docker', 'rm', '-f', NAME); sh('rm', '-rf', SCR); os.makedirs(f'{SCR}/local-ai', exist_ok=True)
os.symlink(LIVE_MODELS, f'{SCR}/local-ai/models')   # same absolute path is mounted read-only below, so the symlink resolves inside the container
uuid1080 = 'GPU-104c1f82-1a1b-38d4-77c3-a84e3cb00269'
sh('docker', 'run', '-d', '--name', NAME, '-p', f'{PORT}:8790', '-v', f'{SCR}:/data', '-v', f'{LIVE_MODELS}:{LIVE_MODELS}:ro', '--runtime=nvidia',
   '-e', f'NVIDIA_VISIBLE_DEVICES={uuid1080}', '-e', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility', '-e', f'OGAI_TOKEN={TOKEN}', '-e', 'OGAI_GPU_ENABLED=1',
   '-e', 'OGAI_ALLOWED_DEVICES=gtx1080', '-e', 'OGAI_DEVICE_INDEX_1080=0', '-e', 'OGAI_JOB_TIMEOUT_S=12', 'ogai-local:latest')
ok = False
try:
    for _ in range(30):
        if sh('docker', 'inspect', '-f', '{{.State.Health.Status}}', NAME).stdout.strip() == 'healthy': break
        time.sleep(2)
    def api(method, path, body=None):
        r = urllib.request.Request(f'http://127.0.0.1:{PORT}{path}', data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
        return json.load(urllib.request.urlopen(r, timeout=30))
    job = api('POST', '/api/local/jobs', {'model': 'dreamshaper-8', 'prompt': 'a red barn', 'device': 'gtx1080'})['job']
    t0 = time.time(); j = job
    while time.time() - t0 < 120:
        j = api('GET', f'/api/local/jobs/{job["id"]}')['job']
        if j['status'] in ('done', 'error', 'cancelled'): break
        time.sleep(1)
    secs = round(time.time() - t0)
    time.sleep(3); left = sh('pgrep', '-a', '-x', 'sd-cli').stdout.strip()
    print(f'job -> {j["status"]} {j.get("error")} after {secs}s; sd-cli left: {left or "none"}')
    ok = j['status'] == 'error' and j['error']['code'] == 'JOB_TIMEOUT' and secs < 60 and not left
    nxt = api('POST', '/api/local/jobs', {'model': 'dreamshaper-8', 'prompt': 'a blue barn', 'device': 'gtx1080', 'aspect_ratio': '1:1'})['job']
    print('(the service accepts new work after a timeout:', bool(nxt['id']), ')')
    api('POST', f'/api/local/jobs/{nxt["id"]}/cancel', {})
finally:
    sh('docker', 'rm', '-f', NAME); sh('rm', '-rf', SCR)
print('PASS JOB_TIMEOUT stops a real sd-cli, reports JOB_TIMEOUT, leaves nothing behind' if ok else 'FAIL JOB_TIMEOUT test')
sys.exit(0 if ok else 1)
