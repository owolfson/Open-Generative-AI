import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute } from '../../app/api/local/proxyRoutes.js';

test('the proxy exposes exactly the local-studio routes', () => {
  assert.deepEqual(matchRoute('GET', ['health']), { upstream: '/health', auth: false, body: false, stream: false, passthrough: false });
  assert.equal(matchRoute('GET', ['catalog']).upstream, '/api/local/catalog');
  assert.equal(matchRoute('POST', ['jobs']).body, true);
  assert.equal(matchRoute('GET', ['jobs', 'abc-123']).upstream, '/api/local/jobs/abc-123');
  assert.equal(matchRoute('POST', ['jobs', 'abc-123', 'cancel']).upstream, '/api/local/jobs/abc-123/cancel');
  assert.equal(matchRoute('GET', ['events']).stream, true);
  const out = matchRoute('GET', ['outputs', 'f8e6a6da.mp4']);
  assert.equal(out.upstream, '/outputs/f8e6a6da.mp4'); assert.equal(out.passthrough, true);
});

test('everything else is refused: MCP, arbitrary paths, traversal, other file types, wrong methods, non-management IPC channels', () => {
  for (const [method, segs] of [
    ['POST', ['mcp']], ['GET', ['mcp']], ['GET', []], ['GET', ['..', 'etc', 'passwd']],
    ['GET', ['outputs', '..%2Fsecret.png']], ['GET', ['outputs', 'a', 'b.png']], ['GET', ['outputs', 'x.html']], ['GET', ['outputs', 'x.png.exe']],
    ['DELETE', ['jobs', 'abc']], ['PUT', ['jobs']], ['POST', ['catalog']], ['GET', ['jobs', 'a/../b']],
    ['POST', ['ipc', 'local-ai:generate']],        // generation must go through the queue, not the raw channel
    ['POST', ['ipc', 'wan2gp:generate']], ['POST', ['ipc', 'evil']],
  ]) assert.equal(matchRoute(method, segs), null, `${method} /${segs.join('/')}`);
});

test('model management IPC channels are allowed', () => {
  for (const ch of ['local-ai:download-model', 'local-ai:download-auxiliary', 'local-ai:delete-model', 'local-ai:binary-status']) {
    assert.equal(matchRoute('POST', ['ipc', ch]).upstream, `/ipc/${ch}`, ch);
  }
});
