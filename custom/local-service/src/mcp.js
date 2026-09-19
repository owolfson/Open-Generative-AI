'use strict';
const fs = require('node:fs');
const { publicJob } = require('./server');

const PROTOCOL = '2025-06-18';

// Default-deny: only these Muapi tools are exposed. Key management (muapi_keys_*), Stripe top-up and any
// tool Muapi adds later stay blocked until someone reviews them and adds them here.
const MUAPI_ALLOW = new Set([
  'search_models', 'muapi_upload_image', 'muapi_image_generate', 'muapi_image_edit', 'muapi_video_generate', 'muapi_video_from_image',
  'muapi_audio_create', 'muapi_audio_from_text', 'muapi_enhance_upscale', 'muapi_enhance_bg_remove', 'muapi_enhance_face_swap',
  'muapi_enhance_ghibli', 'muapi_edit_lipsync', 'muapi_edit_clipping', 'muapi_predict_result', 'muapi_account_balance',
]);

const LOCAL_TOOLS = [
  {
    name: 'local_list_models',
    description: 'List local (self-hosted GPU) generation models with V100 suitability: v100 = recommended|supported|unknown, star = best pick, evidence = proven|untested, route = engine. Excluded models are listed with reasons.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['image', 'video'], description: 'Only models of this kind' } } },
  },
  {
    name: 'local_generate_image',
    description: 'Generate an image on the local GPU (free, slow: jobs queue one at a time). Returns a job; set wait_seconds to wait for it. Result url is served by this server under /outputs with the same bearer token.',
    inputSchema: {
      type: 'object',
      required: ['model', 'prompt'],
      properties: {
        model: { type: 'string', description: 'A model id from local_list_models (image kind)' },
        prompt: { type: 'string' },
        negative_prompt: { type: 'string' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'] },
        seed: { type: 'integer', description: '-1 or omitted = random' },
        steps: { type: 'integer' },
        guidance_scale: { type: 'number' },
        device: { type: 'string', enum: ['v100', 'gtx1080'], description: 'gtx1080 never evicts the Hermes brain (small models only)' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 600, description: 'Wait up to this long for completion (default 0 = return immediately)' },
      },
    },
  },
  { name: 'local_job_status', description: 'Status/result of a local generation job.', inputSchema: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' } } } },
  { name: 'local_cancel_job', description: 'Cancel a queued or running local generation job.', inputSchema: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' } } } },
];

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const textResult = (obj, isError = false) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], ...(isError ? { isError: true } : {}) });

function parseSse(raw) {
  const line = raw.split('\n').find((l) => l.startsWith('data:'));
  if (!line) throw new Error('empty event stream');
  return JSON.parse(line.slice(5).trim());
}

function createMcp({ config, queue, service, fetchImpl = fetch, log = console }) {
  let cloudCache = { at: 0, tools: [] };

  const readKey = () => { try { return fs.readFileSync(config.muapiKeyFile, 'utf8').trim() || null; } catch { return null; } };

  async function muapiRpc(method, params) {
    const key = readKey();
    if (!key) throw new Error('no Muapi key configured');
    const res = await fetchImpl(config.muapiMcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    const body = (res.headers.get('content-type') || '').includes('text/event-stream') ? parseSse(raw) : JSON.parse(raw);
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }

  async function cloudTools() {
    if (!readKey()) return [];
    const ttl = cloudCache.tools.length ? 10 * 60 * 1000 : 30 * 1000;   // retry sooner after a failure
    if (Date.now() - cloudCache.at < ttl) return cloudCache.tools;
    try {
      const { tools } = await muapiRpc('tools/list', {});
      cloudCache = { at: Date.now(), tools: tools.filter((t) => MUAPI_ALLOW.has(t.name)) };
    } catch (err) {
      log.warn(`mcp: could not list Muapi tools: ${err.message}`);
      cloudCache = { at: Date.now(), tools: [] };
    }
    return cloudCache.tools;
  }

  async function listModels({ kind } = {}) {
    const { models, excluded } = await service.catalogPayload();
    const wanted = kind ? models.filter((m) => m.kind === kind) : models;
    return {
      models: wanted.map((m) => ({ id: m.id, name: m.name, kind: m.kind, route: m.route, v100: m.v100, star: m.star, evidence: m.evidence, weightsGb: m.weightsGb, note: m.note, state: m.state })),
      excluded,
    };
  }

  const jobView = (job) => { const p = publicJob(job); return { id: p.id, status: p.status, model: p.params && p.params.model, result: p.result, error: p.error }; };

  async function callLocal(name, args) {
    if (name === 'local_list_models') return textResult(await listModels(args));
    if (name === 'local_generate_image') {
      const { wait_seconds: waitSeconds = 0, ...params } = args;
      const job = service.submitGeneration(params);
      const seen = waitSeconds > 0 ? await queue.wait(job.id, Math.min(600, waitSeconds) * 1000) : job;
      return textResult(jobView(seen));
    }
    const job = queue.get(args.job_id);
    if (!job) return textResult(`no such job: ${args.job_id}`, true);
    if (name === 'local_cancel_job') return textResult({ id: job.id, cancelled: queue.cancel(job.id) });
    return textResult(jobView(job));
  }

  async function callTool(id, { name, arguments: args = {} }) {
    if (LOCAL_TOOLS.some((t) => t.name === name)) {
      try { return rpcResult(id, await callLocal(name, args)); }
      catch (err) { return rpcResult(id, textResult(`${err.code || 'ERROR'}: ${err.message}`, true)); }
    }
    if (MUAPI_ALLOW.has(name)) {
      try { return rpcResult(id, await muapiRpc('tools/call', { name, arguments: args })); }
      catch (err) { return rpcResult(id, textResult(`Muapi call failed: ${err.message}`, true)); }
    }
    return rpcError(id, -32602, `unknown or blocked tool: ${name}`);
  }

  async function handle(msg) {
    const { id, method, params } = msg || {};
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id, -32600, 'invalid request');
    switch (method) {
      case 'initialize': return rpcResult(id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ogai-local', version: '0.1.0' } });
      case 'notifications/initialized': return null;
      case 'ping': return rpcResult(id, {});
      case 'tools/list': return rpcResult(id, { tools: [...LOCAL_TOOLS, ...(await cloudTools())] });
      case 'tools/call': return callTool(id, params || {});
      default: return id === undefined ? null : rpcError(id, -32601, `method not found: ${method}`);
    }
  }

  return { handle };
}

module.exports = { createMcp, MUAPI_ALLOW };
