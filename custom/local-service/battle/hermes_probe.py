#!/usr/bin/env python3
"""Is Hermes REALLY back? Functional probes, not container status: a real chat completion on the brain, a real TTS synthesis, the arbiter state and the
V100 memory baseline. Prints PASS/FAIL per probe; exit 1 if any FAIL.   hermes_probe.py [--wait SECONDS]  (retry until healthy or the time is up)"""
import json, subprocess, sys, time, urllib.request
BRAIN = 'http://127.0.0.1:8780'; TTS = 'http://127.0.0.1:5126'; ARB = 'http://192.168.1.187:6001'
BASELINE_MIB = 29000; TOL_MIB = 1500
def get(url, data=None, timeout=90):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.read()
def probes():
    out = []
    try:
        st, b = get(f'{BRAIN}/v1/chat/completions', {'messages': [{'role': 'user', 'content': 'Reply with exactly one word: pong'}], 'max_tokens': 200, 'temperature': 0, 'chat_template_kwargs': {'enable_thinking': False}}, timeout=120)
        m = json.loads(b)['choices'][0]['message']; text = (m.get('content') or m.get('reasoning_content') or '').strip()
        out.append(('brain answers a real chat completion', st == 200 and len(text) > 0, repr(text)[:40]))
    except Exception as e: out.append(('brain answers a real chat completion', False, str(e)[:80]))
    try:
        st, b = get(f'{TTS}/v1/audio/speech', {'model': 'chatterbox-turbo', 'input': 'Battle test.', 'voice': 'tiffany', 'response_format': 'wav'}, timeout=180)
        out.append(('TTS synthesises real audio', st == 200 and len(b) > 5000, f'{len(b)} bytes'))
    except Exception as e: out.append(('TTS synthesises real audio', False, str(e)[:80]))
    try:
        st, b = get(f'{ARB}/gpu/state', timeout=120); d = json.loads(b)
        out.append(('arbiter idle (no lease, empty queue)', d.get('current_lease') is None and d.get('queue_len') == 0, f"lease={d.get('current_lease')} q={d.get('queue_len')}"))
        used = d['vram']['used_mib']
        out.append((f'V100 memory back at the Hermes baseline (~{BASELINE_MIB} MiB)', abs(used - BASELINE_MIB) <= TOL_MIB, f'{used} MiB'))
        out.append(('arbiter reports the brain as the active peer', d.get('active_peer') == 'hermes-llm', d.get('active_peer')))
    except Exception as e: out.append(('arbiter state readable', False, str(e)[:80]))
    left = subprocess.run(['pgrep', '-x', 'sd-cli'], capture_output=True, text=True).stdout.split()
    out.append(('no orphaned sd-cli process', not left, left))
    return out
wait = int(sys.argv[sys.argv.index('--wait') + 1]) if '--wait' in sys.argv else 0
t0 = time.time()
while True:
    res = probes()
    if all(ok for _, ok, _ in res) or time.time() - t0 > wait: break
    time.sleep(10)
for name, ok, detail in res: print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail != '' else ''))
print(f'recovery check took {round(time.time() - t0)}s')
sys.exit(0 if all(ok for _, ok, _ in res) else 1)
