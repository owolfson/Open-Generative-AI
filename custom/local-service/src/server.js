'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { bearerOk } = require('./auth');

const GATED = new Set(['local-ai:generate', 'wan2gp:generate']);   // channels that consume a GPU -> always go through the queue
const MAX_BODY = 25 * 1024 * 1024;

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { return reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Status payloads never carry the multi-MB data URL; the image is served from /outputs instead.
function publicJob(job) {
  if (!job) return null;
  const { result, ...rest } = job;
  if (result && typeof result === 'object') {
    const { dataUrl, ...clean } = result;   // eslint-disable-line no-unused-vars
    return { ...rest, result: clean };
  }
  return { ...rest, result };
}

function createServer({ config, standin, queue, service, mcp }) {
  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/health') return send(res, 200, { ok: true, gpuEnabled: config.gpuEnabled, allowedDevices: config.allowedDevices, channels: standin.channels().length });

    if (!config.token) return send(res, 503, { error: 'OGAI_TOKEN is not configured' });
    if (!bearerOk(req.headers.authorization, config.token)) return send(res, 401, { error: 'unauthorized' });

    if (method === 'GET' && pathname === '/api/local/catalog') return send(res, 200, await service.catalogPayload());

    let m = /^\/ipc\/(.+)$/.exec(pathname);
    if (method === 'POST' && m) {
      const channel = decodeURIComponent(m[1]);
      if (!standin.has(channel)) return send(res, 404, { ok: false, error: `unknown channel: ${channel}` });
      const { args = [] } = await readJson(req);
      try {
        if (GATED.has(channel)) {
          const done = await service.generateAndWait(args[0]);
          return send(res, 200, { ok: true, result: { url: done.result.dataUrl, seed: done.result.seed } });
        }
        return send(res, 200, { ok: true, result: await standin.invoke(channel, ...args) });
      } catch (err) {
        return send(res, err.status || 500, { ok: false, error: err.message, code: err.code });
      }
    }

    if (method === 'POST' && pathname === '/api/local/jobs') {
      try { return send(res, 202, { job: publicJob(service.submitGeneration(await readJson(req))) }); }
      catch (err) { return send(res, err.status || 500, { error: err.message, code: err.code }); }
    }
    if (method === 'GET' && pathname === '/api/local/jobs') return send(res, 200, { jobs: queue.list().map(publicJob) });

    m = /^\/api\/local\/jobs\/([\w-]+)$/.exec(pathname);
    if (method === 'GET' && m) {
      const job = queue.get(m[1]);
      return job ? send(res, 200, { job: publicJob(job) }) : send(res, 404, { error: 'no such job' });
    }
    m = /^\/api\/local\/jobs\/([\w-]+)\/cancel$/.exec(pathname);
    if (method === 'POST' && m) {
      return queue.get(m[1]) ? send(res, 200, { cancelled: queue.cancel(m[1]) }) : send(res, 404, { error: 'no such job' });
    }

    m = /^\/outputs\/([\w.-]+\.png)$/.exec(pathname);
    if (method === 'GET' && m) {
      const file = path.join(config.outputsDir, path.basename(m[1]));
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length });
      return res.end(data);
    }

    if (method === 'GET' && pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const onSend = (channel, data) => res.write(`event: ${channel}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => res.write(': hb\n\n'), 15000);
      standin.events.on('send', onSend);
      req.on('close', () => { clearInterval(heartbeat); standin.events.off('send', onSend); });
      return undefined;
    }

    if (pathname === '/mcp') {
      if (method !== 'POST') return send(res, 405, { error: 'POST only' });
      const out = await mcp.handle(await readJson(req));
      if (out === null) { res.writeHead(202); return res.end(); }
      return send(res, 200, out);
    }

    return send(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    route(req, res, url).catch((err) => {
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
      else res.end();
    });
  });
}

module.exports = { createServer, publicJob };
