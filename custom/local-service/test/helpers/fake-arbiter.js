'use strict';
const http = require('node:http');

// Minimal stand-in for gpu-arbiter: POST /acquire and POST /release with the real field names.
function startFakeArbiter({ grant = true, refuseStatus = 409, releaseNote = 'released after 1.0s' } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/acquire') {
        if (!grant) { res.statusCode = refuseStatus; return res.end(JSON.stringify({ detail: 'V100 not clear' })); }
        return res.end(JSON.stringify({ ok: true, status: 'ok', lease_id: 'lease-1', holder: body.consumer }));
      }
      if (req.url === '/release') return res.end(JSON.stringify({ ok: true, status: 'ok', note: releaseNote }));
      res.statusCode = 404;
      return res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { startFakeArbiter };
