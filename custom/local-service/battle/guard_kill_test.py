#!/usr/bin/env python3
"""V100 session (evicts Hermes for ~10 min plus its recovery - run deliberately). Needs the service on its DEFAULT tunables.

A. The host's Speaches 1080 Guard (cron every 5 min, starts speaches-chatterbox whenever the arbiter's /gpu/ambient_safe does not say
   "safe": false) must DEFER for the whole lease. The batch is timed to straddle a Guard tick; the tick must log a "lease held" skip and the
   TTS must never run while the lease is held.
B. `docker kill -9` of the service in the middle of a V100 job (no SIGTERM handler runs): the restarted service must hand the dead
   process's lease back at boot (hermes gets restored by the arbiter) - not leave it held until the arbiter's 2h hard expiry.

Abort rules (cancel everything): V100 > 30.5GB, host RAM < 3GB, a job running > 20 min. Afterwards run hermes_probe.py --wait 900.
"""
import json, subprocess, sys, threading, time, urllib.request
from datetime import datetime, timezone
DATA = '/mnt/user/appdata/open-generative-ai'; TOKEN = open(f'{DATA}/.mcp-token').read().strip(); SVC = 'http://127.0.0.1:8790'
ARB = 'http://127.0.0.1:6001'; GUARD_LOG = '/var/log/speaches-guard.log'
T0 = time.time(); results = []
def say(*a): print(f'+{int(time.time() - T0):4d}s', *a, flush=True)
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail != '' else ''), flush=True)
def sh(c): return subprocess.run(c, shell=True, capture_output=True, text=True, timeout=30).stdout.strip()
def api(method, path, body=None, timeout=60):
    r = urllib.request.Request(SVC + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                               headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=timeout))
def jobs():
    try: return api('GET', '/api/local/jobs', timeout=10)['jobs']
    except Exception: return None
def arb_lease():
    """(answered, consumer|None). The arbiter answers nothing while it stops/starts containers, so a timeout is not 'no lease'."""
    try:
        l = json.load(urllib.request.urlopen(ARB + '/status', timeout=8)).get('current_lease')
        return True, (l or {}).get('consumer') if isinstance(l, dict) else l
    except Exception: return False, None
def tts(): return sh("docker inspect -f '{{.State.Status}}' speaches-chatterbox 2>/dev/null")
def v100(): return int(sh("nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits | awk -F, '$1==0{print $2+0}'") or 0)
def ram(): return int(sh("awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo") or 99999)
def guard_lines(): return open(GUARD_LOG).read().splitlines()

aborted = []; stop = threading.Event(); peak = [0]; tts_up_while_leased = []; leased = threading.Event()
def watch():
    while not stop.is_set():
        try:
            v, r = v100(), ram(); peak[0] = max(peak[0], v)
            answered, holder = arb_lease()
            if answered and holder == 'ogai-local':
                leased.set()
                if tts() == 'running': tts_up_while_leased.append(int(time.time() - T0))
            active = [j for j in (jobs() or []) if j['status'] in ('queued', 'running')]
            why = None
            if v > 30.5 * 1024: why = f'V100 {v} MiB'
            elif r < 3072: why = f'host RAM {r} MB'
            elif any(j['status'] == 'running' and time.time() * 1000 - (j.get('startedAt') or time.time() * 1000) > 20 * 60 * 1000 for j in active): why = 'job > 20 min'
            if why and not aborted:
                aborted.append(why); say('ABORT:', why)
                for j in active: api('POST', f'/api/local/jobs/{j["id"]}/cancel', {})
        except Exception as e: say('watch err (continuing):', repr(e)[:100])
        stop.wait(2)
threading.Thread(target=watch, daemon=True).start()

env = sh("docker inspect ogai-local --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^OGAI_(LEASE|JOB|MAX)' || echo none")
check('service runs DEFAULT tunables', env == 'none', env)
check('precondition: TTS up, no lease, no jobs', tts() == 'running' and arb_lease() == (True, None) and not [j for j in (jobs() or []) if j['status'] in ('queued', 'running')])

# --- time the submission just after a Guard tick, so the next tick (5 min later) lands well inside the lease
say('waiting for just after a 5-minute Guard tick ...')
while True:
    n = datetime.now(timezone.utc)
    if n.minute % 5 == 0 and 8 <= n.second <= 40: break
    time.sleep(1)
g0 = len(guard_lines())
say('submitting: LTX 5s 960x544, then 3x Z-Image Turbo (all V100, one lease covers the batch)')
ids = [api('POST', '/api/local/jobs', {'model': 'wan2gp:ltx-video', 'device': 'v100', 'width': 960, 'height': 544, 'video_frames': 121,
        'prompt': 'a red fox trotting through a misty autumn forest, leaves falling, soft morning light, cinematic'})['job']['id']]
for i in range(3):
    ids.append(api('POST', '/api/local/jobs', {'model': 'z-image-turbo', 'device': 'v100', 'prompt': f'a lighthouse at dawn, dramatic sky, photograph, variation {i}'})['job']['id'])

# --- A: wait for a Guard tick that lands inside the lease
t_grant = None; skip_seen = None; deadline = time.time() + 20 * 60
while time.time() < deadline and not aborted:
    answered, holder = arb_lease()
    if answered and holder == 'ogai-local' and t_grant is None: t_grant = time.time(); say('lease granted')
    new = guard_lines()[g0:]
    skip_seen = next((l for l in new if 'lease held' in l), None)
    if skip_seen: say('Guard tick during the lease:', skip_seen[:170]); break
    time.sleep(2)
check('a Guard tick landed inside the lease and DEFERRED ("lease held")', skip_seen is not None)
starts_in_lease = [l for l in guard_lines()[g0:] if 'speaches down -> starting' in l]
check('the Guard did not start the TTS while leased', not starts_in_lease, starts_in_lease)
check('TTS never running while the lease was held (2s samples)', leased.is_set() and not tts_up_while_leased, tts_up_while_leased[:5])

# --- B: kill -9 in the middle of a Z-Image job (after the LTX job, so the lease has been renewed/kept across jobs)
say('waiting for a Z-Image job to be running, then kill -9 the service')
run_id = None
while time.time() < deadline and not aborted and not run_id:
    js = jobs() or []
    run_id = next((j['id'] for j in js if j['id'] in ids[1:] and j['status'] == 'running'), None)
    time.sleep(1)
if run_id:
    time.sleep(6)
    ok, holder = arb_lease()
    say('kill -9 ogai-local (lease holder now:', holder, ')')
    t_kill = time.time(); sh('docker kill --signal=KILL ogai-local')
    back = None
    while time.time() - t_kill < 90:
        try:
            if json.load(urllib.request.urlopen(SVC + '/health', timeout=3)).get('ok'): back = time.time() - t_kill; break
        except Exception: pass
        time.sleep(1)
    check('service restarted by docker after kill -9', back is not None, f'{back and round(back, 1)}s')
    released = None
    while time.time() - t_kill < 240:
        answered, holder = arb_lease()
        if answered and holder is None: released = time.time() - t_kill; break
        time.sleep(2)
    check('the restarted service handed the dead process\'s lease back (arbiter lease None)', released is not None, f'{released and round(released, 1)}s after the kill')
    log = sh('docker logs --since 6m ogai-local 2>&1 | grep -iE "stale|released a stale" | tail -3')
    say('service log:', log[:200])
    arb_log = sh(f"docker logs --since {int(time.time() - t_kill) + 10}s gpu-arbiter 2>&1 | grep -E 'released lease|FORCE-RELEASING|treating as released' | tail -3")
    check('released by the boot path, not by the arbiter\'s hard expiry', 'FORCE-RELEASING' not in arb_log and 'released lease' in arb_log, arb_log.replace('\n', ' | ')[:200])
    after = jobs()
    check('no phantom queued/running job after the restart', after is not None and not [j for j in after if j['status'] in ('queued', 'running')], [j['status'] for j in (after or [])][-4:])
    time.sleep(8)
    orphan = sh("docker exec ogai-local sh -c 'pgrep -x sd-cli || true' 2>/dev/null")
    check('no orphan sd-cli', orphan == '', orphan)
else:
    check('a Z-Image job reached running', False)
stop.set()
check('no abort rule fired', not aborted, aborted)
say('peak V100 MiB', peak[0])
say('RESULT', f'{sum(results)}/{len(results)} passed  -> now run hermes_probe.py --wait 900')
sys.exit(0 if all(results) else 1)
