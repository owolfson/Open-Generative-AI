#!/usr/bin/env python3
"""Live battle test of ogai-local + its web proxy. NO GPU work unless --gpu1080 (then small jobs on the GTX 1080 only: they never touch Hermes).

  custom/local-service/battle/api_battle.py [--web http://HOST:3002] [--svc http://HOST:8790] [--gpu1080]

Reads the bearer token from $OGAI_DATA/.mcp-token. Prints PASS/FAIL per check, exits non-zero on any FAIL. Safe to re-run.
"""
import argparse, base64, json, os, sys, time, urllib.error, urllib.request

ap = argparse.ArgumentParser(); ap.add_argument('--web', default='http://127.0.0.1:3002'); ap.add_argument('--svc', default='http://127.0.0.1:8790'); ap.add_argument('--gpu1080', action='store_true')
A = ap.parse_args()
TOKEN = open(os.path.join(os.environ.get('OGAI_DATA', '/mnt/user/appdata/open-generative-ai'), '.mcp-token')).read().strip()
results = []

def call(base, method, path, body=None, token=TOKEN, raw=None, headers=None, timeout=60):
    h = {'content-type': 'application/json', **(headers or {})}
    if token: h['authorization'] = f'Bearer {token}'
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            txt = r.read(); return r.status, txt, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)
    except Exception as e:
        return 0, str(e).encode(), {}

def js(b):
    try: return json.loads(b)
    except Exception: return None

def check(name, ok, detail=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name + ((' :: ' + str(detail)[:200]) if (detail and not ok) else ''), flush=True)

S, W = A.svc, A.web
print('== auth (service)')
for path in ['/api/local/catalog', '/api/local/jobs', '/events', '/outputs/x.png']:
    check(f'no token -> 401 {path}', call(S, 'GET', path, token=None)[0] == 401)
    check(f'wrong token -> 401 {path}', call(S, 'GET', path, token='0' * 48)[0] == 401)
check('/mcp without token -> 401', call(S, 'POST', '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}, token=None)[0] == 401)
check('/ipc without token -> 401', call(S, 'POST', '/ipc/local-ai:list-models', {'args': []}, token=None)[0] == 401)
check('/health is open and reveals nothing sensitive', (lambda r: r[0] == 200 and set(js(r[1])) <= {'ok', 'gpuEnabled', 'allowedDevices', 'channels'})(call(S, 'GET', '/health', token=None)))

print('== proxy allowlist (web)')
for method, path in [('POST', '/api/local/mcp'), ('GET', '/api/local/mcp'), ('POST', '/api/local/ipc/local-ai:generate'), ('POST', '/api/local/ipc/wan2gp:generate'), ('POST', '/api/local/ipc/evil'),
                     ('GET', '/api/local/outputs/x.html'), ('GET', '/api/local/outputs/a.png.exe'), ('GET', '/api/local/nothing'), ('DELETE', '/api/local/jobs/abc'), ('PUT', '/api/local/jobs'), ('POST', '/api/local/catalog')]:
    check(f'proxy refuses {method} {path}', call(W, method, path, {} if method != 'GET' else None, token=None)[0] in (404, 405))
for path in ['/api/local/outputs/..%2F..%2F..%2Fetc%2Fpasswd', '/api/local/outputs/%2e%2e/%2e%2e/etc/passwd', '/api/local/jobs/..%2F..%2Fcatalog', '/api/local/outputs/..%5C..%5Cetc%5Cpasswd']:
    st, body, _ = call(W, 'GET', path, token=None); check(f'proxy traversal blocked {path}', st in (400, 404) and b'root:' not in body, st)
check('proxy exposes the token nowhere (catalog response has no token)', TOKEN.encode() not in call(W, 'GET', '/api/local/catalog', token=None)[1] and TOKEN.encode() not in call(W, 'GET', '/api/local/health', token=None)[1])
check('proxy /health works without credentials', call(W, 'GET', '/api/local/health', token=None)[0] == 200)

print('== input validation (POST /api/local/jobs)')
def submit(body, base=S): return call(base, 'POST', '/api/local/jobs', body)
st, b, _ = submit({'model': 'nope', 'prompt': 'x'}); check('unknown model -> 400 UNKNOWN_MODEL', st == 400 and (js(b) or {}).get('code') == 'UNKNOWN_MODEL', (st, b[:120]))
st, b, _ = submit({'model': 'dreamshaper-8'}); check('missing prompt -> 400', st == 400, (st, b[:120]))
st, b, _ = submit({'model': 'dreamshaper-8', 'prompt': 123}); check('non-string prompt -> 400', st == 400, (st, b[:120]))
st, b, _ = submit({'model': 'ltx-2.3-22b', 'prompt': 'x'}); check('excluded model -> 400', st == 400, (st, b[:120]))
st, b, _ = call(S, 'POST', '/api/local/jobs', raw=b'{not json'); check('malformed JSON -> 400', st == 400, (st, b[:120]))
st, b, _ = call(S, 'POST', '/api/local/jobs', raw=b'x' * (26 * 1024 * 1024)); check('26MB body -> 413', st in (413, 0), (st, b[:80]))
st, b, _ = submit({'model': 'wan2gp:wan22-i2v', 'prompt': 'x', 'device': 'v100'}); check('I2V without image -> 400 IMAGE_REQUIRED', st == 400 and (js(b) or {}).get('code') == 'IMAGE_REQUIRED', (st, b[:120]))
st, b, _ = submit({'model': 'wan2gp:wan22-t2v', 'prompt': 'x', 'device': 'v100', 'image_base64': base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'0' * 50).decode()}); check('image given to a text-only model -> 400', st == 400, (st, b[:120]))
st, b, _ = submit({'model': 'wan2gp:wan22-i2v', 'prompt': 'x', 'device': 'v100', 'image_base64': base64.b64encode(b'<html><script>alert(1)</script></html>').decode()}); check('HTML disguised as an image -> 400', st == 400, (st, b[:120]))
st, b, _ = submit({'model': 'wan2gp:wan22-i2v', 'prompt': 'x', 'device': 'v100', 'image_base64': base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'0' * (11 * 1024 * 1024)).decode()}); check('11MB image -> 400', st == 400, (st, b[:120]))
st, b, _ = submit({'model': 'wan2gp:wan22-i2v', 'prompt': 'x', 'device': 'v100', 'image_job_id': 'no-such-job'}); check('unknown image_job_id -> 400', st == 400, (st, b[:120]))
st, b, _ = submit({'model': 'wan2gp:wan22-i2v', 'prompt': 'x', 'device': 'v100', 'init_image': '/etc/passwd'}); check('caller-supplied init_image path is ignored (no file read) -> IMAGE_REQUIRED', st == 400 and (js(b) or {}).get('code') == 'IMAGE_REQUIRED', (st, b[:120]))
st, b, _ = submit({'model': 'wan2gp:flux-dev', 'prompt': 'x', 'device': 'mars'}); j = js(b) or {}
check('bad device is rejected when the job runs (queued job then errors BAD_REQUEST, never reaches a GPU)', st in (202, 400))
if st == 202:
    jid = j['job']['id']
    for _ in range(20):
        jj = js(call(S, 'GET', f'/api/local/jobs/{jid}')[1])['job']
        if jj['status'] in ('error', 'done', 'cancelled'): break
        time.sleep(0.5)
    check('bad-device job ended in error BAD_REQUEST', jj['status'] == 'error' and jj['error']['code'] == 'BAD_REQUEST', jj.get('error'))
st, b, _ = submit({'model': 'z-image-base', 'prompt': 'x', 'device': 'v100'})
if st == 202:
    jid = js(b)['job']['id']
    for _ in range(20):
        jj = js(call(S, 'GET', f'/api/local/jobs/{jid}')[1])['job']
        if jj['status'] in ('error', 'done', 'cancelled'): break
        time.sleep(0.5)
    check('Z-Image Base on the V100 refused up front (DEVICE_NOT_SUPPORTED, blank-image model)', jj['status'] == 'error' and jj['error']['code'] == 'DEVICE_NOT_SUPPORTED', jj.get('error'))
for bad, why in [({'width': 1280, 'height': 720}, '720p'), ({'video_frames': 145}, '>121 frames'), ({'width': 970, 'height': 544}, 'not 32-aligned'), ({'video_frames': 50}, 'frames not 8n+1')]:
    st, b, _ = submit({'model': 'wan2gp:ltx-video', 'prompt': 'x', 'device': 'v100', **bad})
    if st == 202:
        jid = js(b)['job']['id']
        for _ in range(20):
            jj = js(call(S, 'GET', f'/api/local/jobs/{jid}')[1])['job']
            if jj['status'] in ('error', 'done', 'cancelled'): break
            time.sleep(0.5)
        check(f'LTX limit enforced before any lease: {why}', jj['status'] == 'error' and jj['error']['code'] == 'LTX_LIMIT', jj.get('error'))
    else: check(f'LTX limit enforced: {why}', st == 400, (st, b[:100]))

print('== hardening (limits, numbers, prompt cap, queue cap)')
def job_outcome(body, secs=20):
    st, b, _ = submit(body)
    if st != 202: return st, js(b), None
    jid = js(b)['job']['id']
    for _ in range(int(secs * 2)):
        jj = js(call(S, 'GET', f'/api/local/jobs/{jid}')[1])['job']
        if jj['status'] in ('error', 'done', 'cancelled'): return st, js(b), jj
        time.sleep(0.5)
    return st, js(b), jj
for label, body, code in [
    ('Wan T2V at 832x480 (measured OOM)', {'model': 'wan2gp:wan22-t2v', 'prompt': 'x', 'device': 'v100', 'width': 832, 'height': 480}, 'PARAM_LIMIT'),
    ('Wan T2V 200 frames', {'model': 'wan2gp:wan22-t2v', 'prompt': 'x', 'device': 'v100', 'video_frames': 200}, 'PARAM_LIMIT'),
    ('Flux 4096x4096', {'model': 'wan2gp:flux-dev', 'prompt': 'x', 'device': 'v100', 'width': 4096, 'height': 4096}, 'PARAM_LIMIT'),
    ('Flux 100000 steps', {'model': 'wan2gp:flux-dev', 'prompt': 'x', 'device': 'v100', 'steps': 100000}, 'PARAM_LIMIT'),
    ('Hunyuan 720p', {'model': 'wan2gp:hunyuan-video', 'prompt': 'x', 'device': 'v100', 'width': 1280, 'height': 720}, 'PARAM_LIMIT'),
    ('steps="abc"', {'model': 'wan2gp:flux-dev', 'prompt': 'x', 'device': 'v100', 'steps': 'abc'}, 'PARAM_INVALID'),
    ('negative width', {'model': 'wan2gp:flux-dev', 'prompt': 'x', 'device': 'v100', 'width': -512}, 'PARAM_INVALID'),
    ('cfg_scale 999', {'model': 'wan2gp:flux-dev', 'prompt': 'x', 'device': 'v100', 'cfg_scale': 999}, 'PARAM_INVALID'),
]:
    st, sub, jj = job_outcome(body)
    check(f'{label} -> {code} before any lease', jj is not None and jj['status'] == 'error' and jj['error']['code'] == code, jj and jj.get('error'))
st, b, _ = submit({'model': 'dreamshaper-8', 'prompt': 'x' * 8001}); check('prompt over 8000 chars -> 400', st == 400, (st, b[:100]))
st, b, _ = submit({'model': 'dreamshaper-8', 'prompt': 'ok', 'negative_prompt': 'x' * 8001}); check('negative_prompt over 8000 chars -> 400', st == 400, (st, b[:100]))
if A.gpu1080:
    ids, codes = [], []
    for i in range(40):
        st, b, _ = submit({'model': 'dreamshaper-8', 'prompt': f'flood {i}', 'device': 'gtx1080'}); codes.append(st)
        if st == 202: ids.append(js(b)['job']['id'])
    check('queue flood: 40 submissions -> at most 26 accepted (1 running + 25 waiting), the rest 429', codes.count(202) <= 26 and codes.count(429) >= 14, (codes.count(202), codes.count(429)))
    for i in ids: call(S, 'POST', f'/api/local/jobs/{i}/cancel', {})
    time.sleep(4)
    left = [j for j in js(call(S, 'GET', '/api/local/jobs')[1])['jobs'] if j['status'] in ('queued', 'running')]
    check('every flooded job cancelled cleanly (nothing left running or queued)', not left, len(left))
    import subprocess as _sp
    check('no sd-cli left after cancelling the flood', not _sp.run(['pgrep', '-x', 'sd-cli'], capture_output=True, text=True).stdout.split())

print('== MCP')
def rpc(method, params=None, i=1): return js(call(S, 'POST', '/mcp', {'jsonrpc': '2.0', 'id': i, 'method': method, **({'params': params} if params is not None else {})})[1]) or {}
tools = {t['name'] for t in rpc('tools/list').get('result', {}).get('tools', [])}
check('tools/list has the local tools', {'local_list_models', 'local_generate_image', 'local_generate_video', 'local_job_status', 'local_cancel_job'} <= tools, tools)
for blocked in ['muapi_keys_create', 'muapi_keys_list', 'muapi_keys_delete', 'muapi_account_topup', 'some_new_tool']:
    r = rpc('tools/call', {'name': blocked, 'arguments': {}}); check(f'MCP blocks {blocked}', 'error' in r, r)
check('MCP tools/call with a WRONG_KIND model refused', 'WRONG_KIND' in json.dumps(rpc('tools/call', {'name': 'local_generate_image', 'arguments': {'model': 'wan2gp:ltx-video', 'prompt': 'x'}})))
check('MCP invalid request -> JSON-RPC error', 'error' in (js(call(S, 'POST', '/mcp', raw=b'{"nope":1}')[1]) or {}))
check('MCP GET -> 405', call(S, 'GET', '/mcp')[0] == 405)
r = rpc('tools/call', {'name': 'local_list_models', 'arguments': {}}); check('local_list_models works and reports models', 'wan2gp:ltx-video' in json.dumps(r))

print('== outputs')
st, b, _ = call(S, 'GET', '/outputs/..%2f..%2fetc%2fpasswd'); check('service /outputs traversal -> 404', st == 404 and b'root:' not in b, st)
st, b, _ = call(S, 'GET', '/outputs/nonexistent.png'); check('missing output -> 404', st == 404)
files = sorted(f for f in os.listdir('/mnt/user/appdata/open-generative-ai/outputs') if f.endswith('.mp4'))
if files:
    f = files[-1]; size = os.path.getsize('/mnt/user/appdata/open-generative-ai/outputs/' + f)
    st, b, h = call(S, 'GET', f'/outputs/{f}', headers={'range': 'bytes=0-99'}); check('Range request -> 206 with 100 bytes', st == 206 and len(b) == 100 and h.get('Content-Range', h.get('content-range', '')).startswith('bytes 0-99/'), (st, len(b), h))
    st, b, h = call(S, 'GET', f'/outputs/{f}', headers={'range': f'bytes={size + 10}-'}); check('unsatisfiable Range -> 416', st == 416, st)
    st, b, h = call(W, 'GET', f'/api/local/outputs/{f}', token=None, headers={'range': 'bytes=0-9'}); check('Range through the web proxy -> 206', st == 206 and len(b) == 10, (st, len(b)))

if A.gpu1080:
    print('== GTX 1080 lane (real jobs, no Hermes impact)')
    def wait(jid, secs=400):
        t0 = time.time()
        while time.time() - t0 < secs:
            jj = js(call(S, 'GET', f'/api/local/jobs/{jid}')[1])['job']
            if jj['status'] in ('done', 'error', 'cancelled'): return jj
            time.sleep(1)
        return jj
    P = {'model': 'dreamshaper-8', 'prompt': 'a small red barn in a green field, photograph', 'device': 'gtx1080', 'aspect_ratio': '1:1'}
    big = 'a red apple ' * 20000   # ~240KB
    st, b, _ = submit({**P, 'prompt': big})
    if st == 202:
        jj = wait(js(b)['job']['id'], 120); check('240KB prompt: no crash, job ends cleanly (done or a clean error)', jj['status'] in ('done', 'error'), jj)
    else: check('240KB prompt rejected up front', st == 400, st)
    ids = [js(submit({**P, 'prompt': P['prompt'] + f' {i}'})[1])['job']['id'] for i in range(3)]
    seen_running = []; t0 = time.time(); done_order = []
    while time.time() - t0 < 300 and len(done_order) < 3:
        states = {i: js(call(S, 'GET', f'/api/local/jobs/{i}')[1])['job']['status'] for i in ids}
        seen_running.append(sum(1 for s in states.values() if s == 'running'))
        for i, s in states.items():
            if s == 'done' and i not in done_order: done_order.append(i)
        time.sleep(0.5)
    check('single-flight: never more than 1 job running at once', max(seen_running) <= 1, max(seen_running))
    check('FIFO: three jobs finished in submission order', done_order == ids, done_order)
    # cancel a running job: kills sd-cli, frees the card, next job still works
    st, b, _ = submit({**P, 'model': 'z-image-turbo', 'prompt': 'a castle on a hill'}); cid = js(b)['job']['id']
    for _ in range(90):
        if js(call(S, 'GET', f'/api/local/jobs/{cid}')[1])['job']['status'] == 'running': break
        time.sleep(1)
    time.sleep(20); call(S, 'POST', f'/api/local/jobs/{cid}/cancel', {})
    jj = wait(cid, 60); check('cancelling a RUNNING job -> cancelled', jj['status'] == 'cancelled', jj['status'])
    time.sleep(3)
    import subprocess
    left = subprocess.run(['pgrep', '-x', 'sd-cli'], capture_output=True, text=True).stdout.split()
    check('no orphaned sd-cli process after cancel', not left, left)
    st, b, _ = submit({**P, 'prompt': 'a lighthouse at dusk'}); jj = wait(js(b)['job']['id'], 300); check('a new job after a cancel still succeeds', jj['status'] == 'done', jj.get('error'))
    # crash injection: kill -9 sd-cli mid-job
    st, b, _ = submit({**P, 'model': 'z-image-turbo', 'prompt': 'a boat on a lake'}); kid = js(b)['job']['id']
    for _ in range(90):
        if js(call(S, 'GET', f'/api/local/jobs/{kid}')[1])['job']['status'] == 'running': break
        time.sleep(1)
    time.sleep(25); subprocess.run(['pkill', '-9', '-x', 'sd-cli'])   # by exact process name, from the host (the slim container has no pkill)
    jj = wait(kid, 60); check('sd-cli killed mid-job -> job ends in a clean error (service survives)', jj['status'] == 'error', jj['status'])
    st, b, _ = submit({**P, 'prompt': 'a mountain path'}); jj = wait(js(b)['job']['id'], 300); check('queue recovers after an sd-cli crash', jj['status'] == 'done', jj.get('error'))
    check('service still healthy after all of the above', call(S, 'GET', '/health', token=None)[0] == 200)

n = len(results); bad = results.count(False)
print(f'\n{n - bad}/{n} checks passed' + ('' if not bad else f'  ({bad} FAILED)'))
sys.exit(1 if bad else 0)
