# Battle tests

Everything here is a live test against a running `ogai-local` (and, for the V100/GUI scripts, the web container, the gpu-arbiter, and
Hermes). Nothing is mocked; `test/*.test.js` (unit, mocked, `node --test`) is the fast pre-commit gate - these are the slow, real ones.

## No GPU: `api_battle.py`

Validation, hardening, MCP allowlist, output serving, queue/timeout/cancel behavior. Safe to run any time; needs no arbiter interaction.

```bash
python3 api_battle.py [--web http://HOST:3002] [--svc http://HOST:8790] [--gpu1080]
```

`--gpu1080` adds real jobs on the GTX 1080 lane only (single-flight, FIFO, cancel, sd-cli-crash recovery) - never touches Hermes or the
V100. Without it, 72 checks; with it, 84. Both passing is the bar for "safe to redeploy."

## V100 sessions - evict Hermes (brain ~4.5 min, TTS ~7 min). Run deliberately, not casually.

All of these share the same shape: a watcher (`v100-watch.py OUTDIR`, arbiter/brain/TTS/VRAM/RAM on a timeline) plus an abort guard
(`abort_guard.py`: V100 > 30.5GB, host RAM < 3GB, a job > 20 min -> cancel everything and stop). Always run both alongside the test itself,
and always finish with `hermes_probe.py --wait 900` (functional recovery: a real chat completion, real TTS synthesis, arbiter idle, V100
back at the ~29000 MiB baseline, no orphaned sd-cli) - a container simply being "Up" is not evidence Hermes actually works again.

- **`v100_battle.py`** - staggered mixed batch (renewal-by-handover across queued jobs of different sizes), fault injection (sd-cli killed
  mid-job, a running job cancelled), LTX at the end. Needs the service started with `OGAI_LEASE_MIN_S=0` so back-to-back jobs don't fit the
  previous lease window and are forced through the renewal path (the one that must never let the brain start restoring mid-batch) - do not
  run this against the default-tunables deployment, it won't exercise anything.
- **`timeout_test.py`** - a scratch instance's `JOB_TIMEOUT` firing correctly.
- **`guard_kill_test.py`** - the default-tunables deployment (no env overrides), two things in one run:
  - **A.** The host's "Speaches 1080 Guard" cron (every 5 min, starts `speaches-chatterbox` whenever the arbiter's `/gpu/ambient_safe` does
    not say `"safe": false`) must DEFER for the whole lease, not just when a persistent holder container happens to be running (see
    `custom/local-service/README.md`'s GPU arbiter registration section, point 4, for the incident this closes). The script times the
    submission to straddle a real 5-minute Guard tick.
  - **B.** An uncontrolled crash of the service mid-lease: the restarted service's own boot-time `releaseStaleLeaseWithRetry` must hand the
    dead process's lease back, not leave it held until the arbiter's multi-hour hard expiry. **Simulating this correctly matters and is
    not obvious** - two plausible-looking methods do NOT reproduce a real crash:
    - `docker kill`/`docker stop` from the host: dockerd tracks these as admin-intentional and deliberately does not fire
      `--restart unless-stopped` for them. (Confirmed live: the container sat `exited` for 2+ minutes; the ONLY thing that noticed and
      released the lease was the arbiter's own Sept-1 stale-holder self-heal, not this service - see `app.py`'s `heartbeat_loop`.)
    - `docker exec <name> kill -9 1`: silently no-ops. A PID namespace's init (PID 1) is immune to unhandled signals sent from WITHIN its
      own namespace - including SIGKILL - and `docker exec` joins that namespace (`man 7 pid_namespaces`). The process never even
      receives it.
    - What actually works: send the signal from the HOST's own pid namespace, bypassing both of the above -
      `kill -9 $(docker inspect -f '{{.State.Pid}}' <name>)`. dockerd sees an unexpected exit it didn't initiate and the restart policy
      fires for real (`RestartCount` increments). That's what `guard_kill_test.py` does.

Run order for a full V100 pass: `v100_battle.py` (with `OGAI_LEASE_MIN_S=0`) -> redeploy on default tunables -> `guard_kill_test.py` ->
`hermes_probe.py --wait 900`.

## GUI: `gui_battle.js`

Drives a real Chromium through Playwright (no local Chrome on this host - see `reference_browser_vision_dev_browser_cdp` in memory for the
dev-browser-over-CDP recipe). GTX 1080 lane only; never touches the V100 or Hermes.

```bash
docker run --rm --network container:dev-browser \
  -e OGAI_WEB=http://HOST:3002 -e OGAI_TOKEN=$(cat $OGAI_DATA/.mcp-token) \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v <playwright-core node_modules>:/pw:ro -v $(pwd):/out -e NODE_PATH=/pw \
  node:22-bookworm-slim node /out/gui_battle.js
```

The container has no `docker` CLI, so restart/orphan-process checks go over the Engine API through the mounted socket, not `execSync`.
`ONLY=3,6` (etc.) runs a subset of scenarios by number. Scenarios: empty/oversize prompt, V100-confirm dialog dismissed (no job, no lease),
reload mid-job (job resumes, finishes, survives the reload), cancel mid-run (no orphaned sd-cli), an API-submitted job queued behind a GUI
job (both show up), `docker restart` mid-job (the page says the job was lost, not a stale "unreachable"; generating still works
afterwards), mobile width (no horizontal scroll). Shots land in `shots/gb-*.png`.

## A finding this suite exists because of

The GUI's `waitForJob` originally gave up after 5 failed polls (~5s) and showed "service not reachable" for a `docker restart` that takes
~45s - by the time it showed anything, the service was already healthy again, so the message was stale and wrong. Fixed in
`packages/studio/src/local/localClient.js`/`localLogic.js`: it rides out ~75s of failed polls, and a 404 (jobs live in the service's
memory, so a restart forgets them) is reported as `JOB_LOST` with a message that says what happened and what to do. Covered by
`custom/web-tests/local-client.test.mjs` and GUI battle scenario 6.
