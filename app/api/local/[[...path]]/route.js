import { readFileSync } from 'node:fs';
import { matchRoute } from '../proxyRoutes.js';

// Server-side proxy from the browser to the ogai-local service (local GPU generation). The bearer token stays on the server;
// the browser only ever sees the allowlisted routes in ../proxyRoutes.js. Configure with OGAI_LOCAL_URL and either
// OGAI_LOCAL_TOKEN or OGAI_LOCAL_TOKEN_FILE (default /data/.mcp-token, the file ogai-local's deploy.sh writes into the shared /data volume).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const json = (status, body) => Response.json(body, { status });
const upstreamBase = () => (process.env.OGAI_LOCAL_URL || '').replace(/\/+$/, '');

let cached = { at: 0, value: '' };
function token() {
  if (process.env.OGAI_LOCAL_TOKEN) return process.env.OGAI_LOCAL_TOKEN;
  if (Date.now() - cached.at < 30_000 && cached.value) return cached.value;
  try {
    cached = { at: Date.now(), value: readFileSync(process.env.OGAI_LOCAL_TOKEN_FILE || '/data/.mcp-token', 'utf8').trim() };
  } catch {
    cached = { at: 0, value: '' };
  }
  return cached.value;
}

async function handle(request, { params }) {
  const { path = [] } = await params;
  const route = matchRoute(request.method, path);
  if (!route) return json(404, { error: 'not found' });

  const base = upstreamBase();
  if (!base) return json(503, { error: 'Local inference is not configured for this app (OGAI_LOCAL_URL).', code: 'LOCAL_NOT_CONFIGURED' });

  const headers = {};
  if (route.auth) {
    const t = token();
    if (!t) return json(503, { error: 'The local inference token is not available (OGAI_LOCAL_TOKEN / OGAI_LOCAL_TOKEN_FILE).', code: 'LOCAL_NOT_CONFIGURED' });
    headers.authorization = `Bearer ${t}`;
  }
  if (route.body) headers['content-type'] = 'application/json';
  const range = request.headers.get('range');
  if (range && route.passthrough) headers.range = range;

  // Model downloads can run for many minutes; everything else is short. The event stream lives as long as the browser tab.
  const signal = route.stream ? request.signal : AbortSignal.timeout(route.upstream.startsWith('/ipc/') ? 3_600_000 : 60_000);
  const init = { method: request.method, headers, signal };
  if (route.body) init.body = await request.text();

  let res;
  try {
    res = await fetch(base + route.upstream, init);
  } catch {
    return json(502, { error: 'The local inference service is not reachable.', code: 'LOCAL_UNREACHABLE' });
  }

  if (route.stream || route.passthrough) {
    const out = new Headers();
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = res.headers.get(name);
      if (value) out.set(name, value);
    }
    if (route.stream) { out.set('cache-control', 'no-cache, no-transform'); out.set('x-accel-buffering', 'no'); }
    else out.set('cache-control', 'private, max-age=86400, immutable');   // outputs are named by job id and never change
    return new Response(res.body, { status: res.status, headers: out });
  }
  return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
}

export { handle as GET, handle as POST };
