# ogai-local

Local inference + agent API for this fork. Runs upstream's own Electron engine modules (`electron/lib/*`, unmodified)
behind a small stand-in for `require('electron')`, and exposes them over HTTP.

| Piece | File |
|---|---|
| Electron stand-in (IPC handlers -> functions, `send` -> events) | `src/standin.js` |
| Loads upstream engines | `src/engines.js` |
| V100 model catalog + drift tripwire | `src/catalog.js` |
| Single-flight queue | `src/queue.js` |
| gpu-arbiter lease (V100 only) | `src/gate.js` |
| Runner (device choice, lease, PNG artifacts) | `src/runner.js` |
| REST + SSE | `src/server.js` |
| MCP (local tools + allowlisted Muapi pass-through) | `src/mcp.js` |

## Safety defaults
- `OGAI_GPU_ENABLED` must be exactly `1` or every job fails with `GPU_DISABLED`.
- V100 jobs also need `OGAI_ARBITER_URL`; a V100 lease evicts the Hermes brain. The GTX 1080 lane (`device: "gtx1080"`) needs no lease.
- Every endpoint except `GET /health` needs `Authorization: Bearer $OGAI_TOKEN` (deploy.sh writes one to `$OGAI_DATA/.mcp-token`).
- Muapi key-management and top-up MCP tools are blocked; only the allowlist in `src/mcp.js` is exposed.

## Use
```bash
custom/local-service/deploy.sh --build          # image + container on :8790
TOKEN=$(cat /mnt/user/appdata/open-generative-ai/.mcp-token)
curl -H "Authorization: Bearer $TOKEN" http://HOST:8790/api/local/catalog
claude mcp add --transport http ogai http://HOST:8790/mcp --header "Authorization: Bearer $TOKEN"
```

## Tests
`cd custom/local-service && node --test test/*.test.js` (never pass a directory to `--test`). Zero dependencies.

## Not yet wired (separate plans)
sd.cpp CUDA build (upstream's Linux binary is CPU/Vulkan/ROCm only and the host CPU has no AVX2), WanGP + ComfyUI(Qwen)
adapters, web-app UI + `window.localAI` shim, registering `ogai-local` in the arbiter registry, GPU test renders.
