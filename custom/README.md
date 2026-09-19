# Owen's fork - customizations

Fork of [Anil-matcha/Open-Generative-AI](https://github.com/Anil-matcha/Open-Generative-AI). Everything
that is ours lives here or is listed in the ledger below; upstream files are touched as little as possible
so `git merge` from upstream stays clean.

## Branches

| Branch | What | Rule |
|---|---|---|
| `main` | exact mirror of `upstream/main` | fast-forward only, never commit here |
| `owen` | `main` + our commits | the deployable branch; only advances after a green build + smoke test |

Remotes: `origin` = this fork, `upstream` = Anil-matcha. `git rerere` is on, so a conflict resolved once is
remembered on the next merge.

## Update from upstream

```bash
custom/sync-upstream.sh --check            # merge + build + smoke on a scratch container, deploy nothing
custom/sync-upstream.sh --deploy [--push]  # ...then swap the live container; auto-rollback if unhealthy
```

A conflict, failed build or failed smoke leaves `owen` and the live container untouched. Each run writes
`$OGAI_DATA/sync.state.json` (last outcome) and `sync.log`.

## Rollback

`open-generative-ai:prev` is always the image that was running before the last deploy:
`custom/deploy.sh open-generative-ai:prev`

## Fresh install (new box / after a docker.img wipe)

```bash
git clone --recurse-submodules -b owen https://github.com/owolfson/Open-Generative-AI.git
cd Open-Generative-AI
custom/build.sh open-generative-ai:latest
custom/deploy.sh                     # port 3002, data in /mnt/user/appdata/open-generative-ai
cp custom/unraid/my-Open-Generative-AI.xml /boot/config/plugins/dockerMan/templates-user/   # Unraid UI template
```

`OGAI_PORT`, `OGAI_DATA`, `OGAI_ICON` override the deploy defaults. The Muapi key is entered in the app UI
(stored in the browser); it is never part of this repo.

## How the image is built

`custom/build.sh` builds **upstream's own `Dockerfile` verbatim**, then layers `custom/Dockerfile.overlay`
(healthcheck, version labels, telemetry off, `/data`). Build logic stays upstream-owned, so upstream build
changes never conflict with us.

## Ledger - every deviation from upstream

| Change | Where | Why | Upstream touch-point |
|---|---|---|---|
| `./src/models.js` subpath export | `packages/studio/package.json` | upstream's per-component exports commit dropped it; the legacy `src/lib/models.js` re-exports it, so `vite build` breaks | 1 line - candidate for an upstream PR |
| `.dockerignore` | repo root | upstream ships none, so every build shipped `node_modules`/`.git`/`release` as context | new file |
| build / deploy / sync / smoke scripts, overlay Dockerfile, Unraid template | `custom/` | fork tooling | none |

Add a row here whenever a change outside `custom/` is made - this table is what you re-check after a bad merge.

## Not in this repo

Secrets, LAN addresses, and API keys. Host-specific values come from env vars or the running container.
