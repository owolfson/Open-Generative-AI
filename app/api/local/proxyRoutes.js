// Allowlist for the /api/local proxy to the ogai-local service. Pure (no I/O) so it can be unit-tested with node:test.
// The browser never talks to ogai-local directly and never sees its token; only these routes exist. Deliberately absent:
// /mcp (Muapi pass-through and key tools), /ipc/* channels other than model management, arbitrary paths.

const IPC_ALLOWED = new Set([
  'local-ai:binary-status',
  'local-ai:download-model',
  'local-ai:download-auxiliary',
  'local-ai:delete-model',
]);

const ROUTES = [
  { method: 'GET', re: /^health$/, to: () => '/health', auth: false },
  { method: 'GET', re: /^catalog$/, to: () => '/api/local/catalog' },
  { method: 'GET', re: /^jobs$/, to: () => '/api/local/jobs' },
  { method: 'POST', re: /^jobs$/, to: () => '/api/local/jobs', body: true },
  { method: 'GET', re: /^jobs\/([\w-]+)$/, to: (m) => `/api/local/jobs/${m[1]}` },
  { method: 'POST', re: /^jobs\/([\w-]+)\/cancel$/, to: (m) => `/api/local/jobs/${m[1]}/cancel`, body: true },
  { method: 'GET', re: /^outputs\/([\w.-]+\.(?:png|avi|mp4))$/, to: (m) => `/outputs/${m[1]}`, passthrough: true },
  { method: 'GET', re: /^events$/, to: () => '/events', stream: true },
  { method: 'POST', re: /^ipc\/(local-ai:[\w-]+)$/, to: (m) => (IPC_ALLOWED.has(m[1]) ? `/ipc/${m[1]}` : null), body: true },
];

/** @returns {{upstream: string, auth: boolean, body: boolean, stream: boolean, passthrough: boolean} | null} */
export function matchRoute(method, segments = []) {
  const path = segments.join('/');
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const m = route.re.exec(path);
    if (!m) continue;
    const upstream = route.to(m);
    if (!upstream) return null;
    return { upstream, auth: route.auth !== false, body: Boolean(route.body), stream: Boolean(route.stream), passthrough: Boolean(route.passthrough) };
  }
  return null;
}
