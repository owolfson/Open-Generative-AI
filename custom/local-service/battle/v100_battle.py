#!/usr/bin/env python3
"""V100 battle session (evicts Hermes for the duration - run only when that is acceptable). Needs the service started with OGAI_LEASE_MIN_S=0 so that
jobs submitted one after another do not fit the previous lease window and force RENEWALS (the path that must never let the brain restore in between).

Staggered mixed batch + fault injection, then the arbiter's own log is checked: between the first grant and the final release Hermes' brain
must NOT start restoring ('starting llamacpp container'). Abort rules: V100 > 30.5GB, host RAM < 3GB, a job running > 20 min -> cancel everything.
"""
import json, os, re, subprocess, sys, threading, time, urllib.request
from datetime import datetime, timedelta, timezone
DATA = '/mnt/user/appdata/open-generative-ai'; TOKEN = open(f'{DATA}/.mcp-token').read().strip(); SVC = 'http://127.0.0.1:8790'
T0 = time.time(); results = []
def say(*a): print(f'+{int(time.time() - T0):4d}s', *a, flush=True)
def api(method, path, body=None):
    r = urllib.request.Request(SVC + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=60))
def job(jid): return api('GET', f'/api/local/jobs/{jid}')['job']
def check(name, ok, detail=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail != '' else ''), flush=True)
def mem_v100():
    for line in subprocess.run(['nvidia-smi', '--query-gpu=index,memory.used', '--format=csv,noheader,nounits'], capture_output=True, text=True).stdout.splitlines():
        i, m = line.split(','); 
        if i.strip() == '0': return int(m)
def ram(): return int(subprocess.run("awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo", shell=True, capture_output=True, text=True).stdout)

aborted = []; peak = [0]; min_ram = [10**9]
def guard():
    while not stop.is_set():
        v, r = mem_v100(), ram(); peak[0] = max(peak[0], v); min_ram[0] = min(min_ram[0], r)
        active = [j for j in api('GET', '/api/local/jobs')['jobs'] if j['status'] in ('queued', 'running')]
        why = None
        if v > 30.5 * 1024: why = f'V100 {v} MiB'
        elif r < 3072: why = f'host RAM {r} MB'
        elif any(j['status'] == 'running' and time.time() * 1000 - (j.get('startedAt') or time.time() * 1000) > 20 * 60 * 1000 for j in active): why = 'job > 20 min'
        if why and not aborted:
            aborted.append(why); say('ABORT:', why)
            for j in active: api('POST', f'/api/local/jobs/{j["id"]}/cancel', {})
        stop.wait(3)
stop = threading.Event(); threading.Thread(target=guard, daemon=True).start()

START_UTC = datetime.now(timezone.utc)
def submit(model, prompt, **kw): return api('POST', '/api/local/jobs', {'model': model, 'prompt': prompt, 'device': 'v100', **kw})['job']['id']
def wait_status(jid, want, secs=900, min_step=None):
    t = time.time()
    while time.time() - t < secs:
        j = job(jid); st = j['status']; p = j.get('progress') or {}
        if st in want and (min_step is None or (p.get('step') or 0) >= min_step): return j
        if st in ('done', 'error', 'cancelled') and st not in want: return j
        time.sleep(1)
    return job(jid)
def finish(jid, secs=900): return wait_status(jid, ('done', 'error', 'cancelled'), secs)

say('A: z-image-turbo alone (first job takes the lease; its window is just its own estimate)')
a = submit('z-image-turbo', 'a lighthouse at dawn, dramatic sky, photograph')
wait_status(a, ('running',))
say('B, C submitted while A runs (each will not fit what is left of the previous window -> renewals)')
b = submit('dreamshaper-8', 'a red apple on a wooden table, studio light, photograph')
c = submit('stable-diffusion-xl-base', 'a red fox in an autumn forest, misty morning, photograph')
ja = finish(a); jb = finish(b); jc = finish(c)
check('A, B, C all finished (done)', [ja['status'], jb['status'], jc['status']] == ['done'] * 3, [ja['status'], jb['status'], jc['status']])

say('D (Flux) gets its sd-cli KILLED mid-run; E is already queued behind it')
d = submit('wan2gp:flux-dev', 'a lighthouse on a rocky cliff at sunset, dramatic clouds, photograph', aspect_ratio='1:1')
e = submit('realistic-vision-v51', 'portrait photo of an elderly fisherman, golden hour light, 85mm lens', aspect_ratio='3:4')
wait_status(d, ('running',), min_step=3, secs=600)
subprocess.run(['pkill', '-9', '-x', 'sd-cli'])
jd = finish(d, 120); je = finish(e, 300)
check('killed job ends in a clean error, not a hang', jd['status'] == 'error', jd['status'])
check('the job queued behind the crashed one still runs and succeeds', je['status'] == 'done', je.get('error') or je['status'])

say('F (Qwen) is CANCELLED while running; G is queued behind it')
f = submit('wan2gp:qwen-image', 'a cozy reading nook with a big window on a rainy day, warm lamp light, photograph', aspect_ratio='1:1')
g = submit('anything-v5', '1girl, silver hair, blue eyes, school uniform, cherry blossoms, masterpiece', aspect_ratio='3:4')
wait_status(f, ('running',), min_step=2, secs=600)
api('POST', f'/api/local/jobs/{f}/cancel', {})
jf = finish(f, 120); jg = finish(g, 300)
check('running job cancelled -> cancelled', jf['status'] == 'cancelled', jf['status'])
check('the job queued behind the cancelled one still runs and succeeds', jg['status'] == 'done', jg.get('error') or jg['status'])

say('H: LTX text-to-video (the big one) after all of that')
h = submit('wan2gp:ltx-video', 'a red fox trotting through a misty autumn forest, leaves falling, soft morning light, cinematic', width=640, height=352, video_frames=33)
jh = finish(h, 900); check('LTX video after the fault injections succeeds', jh['status'] == 'done', jh.get('error') or jh['status'])
stop.set()
say('queue drained; waiting for the linger window and the final release')
for _ in range(60):
    st = json.load(urllib.request.urlopen('http://192.168.1.187:6001/gpu/state', timeout=120))
    if st.get('current_lease') is None: break
    time.sleep(3)
check('final release happened (arbiter has no lease)', st.get('current_lease') is None, st.get('current_lease'))

# ---- the arbiter's own account ----
since = int((datetime.now(timezone.utc) - START_UTC).total_seconds()) + 60
log = subprocess.run(['docker', 'logs', '--since', f'{since}s', 'gpu-arbiter'], capture_output=True, text=True); lines = (log.stdout + log.stderr).splitlines()
ev = [(l[:23], l) for l in lines if re.search(r'granted lease to ogai-local|released lease|starting llamacpp|restarting evictable|stopping llamacpp|stopping evictable|FORCE', l)]
for _, l in ev: print('   arbiter:', l[:170])
grants = [i for i, (_, l) in enumerate(ev) if 'granted lease' in l]; releases = [i for i, (_, l) in enumerate(ev) if 'released lease' in l]
first_grant = grants[0]; last_release = releases[-1]
between = [l for _, l in ev[first_grant:last_release] if 'starting llamacpp' in l or 'restarting evictable' in l]
check(f'grants={len(grants)} releases={len(releases)}: every grant was released', len(grants) == len(releases), (len(grants), len(releases)))
check('renewals happened (more than one grant in the session)', len(grants) >= 3, len(grants))
check("Hermes' brain / TTS did NOT start restoring between the first grant and the final release (no thrash)", not between, between[:2])
check('no lease was force-released by the arbiter', not any('FORCE' in l for _, l in ev))
check(f'V100 peak stayed under 30.5GB (peak {peak[0]} MiB)', peak[0] < 30.5 * 1024)
check(f'host RAM never dipped under 3GB (min {min_ram[0]} MB)', min_ram[0] >= 3072)
check('no abort rule fired', not aborted, aborted)
n = len(results); bad = results.count(False); print(f'\n{n - bad}/{n} checks passed' + ('' if not bad else f'  ({bad} FAILED)')); sys.exit(1 if bad else 0)
