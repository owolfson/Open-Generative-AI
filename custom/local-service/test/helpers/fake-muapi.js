'use strict';
const http = require('node:http');

const ALL_TOOLS = [
  'search_models', 'muapi_upload_image', 'muapi_image_generate', 'muapi_image_edit', 'muapi_video_generate', 'muapi_video_from_image',
  'muapi_audio_create', 'muapi_audio_from_text', 'muapi_enhance_upscale', 'muapi_enhance_bg_remove', 'muapi_enhance_face_swap',
  'muapi_enhance_ghibli', 'muapi_edit_lipsync', 'muapi_edit_clipping', 'muapi_predict_result', 'muapi_account_balance',
  'muapi_keys_list', 'muapi_keys_create', 'muapi_keys_delete', 'muapi_account_topup', 'muapi_brand_new_tool',
];

// Fake of Muapi's hosted MCP (stateless JSON-RPC over HTTP). sse: true answers as text/event-stream.
function startFakeMuapi({ sse = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const msg = JSON.parse(raw);
      requests.push({ headers: req.headers, msg });
      let result;
      if (msg.method === 'tools/list') result = { tools: ALL_TOOLS.map((name) => ({ name, description: `d:${name}`, inputSchema: { type: 'object' } })) };
      else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: `called:${msg.params.name}` }] };
      else result = {};
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (sse) { res.setHeader('content-type', 'text/event-stream'); return res.end(`event: message\ndata: ${payload}\n\n`); }
      res.setHeader('content-type', 'application/json');
      return res.end(payload);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

module.exports = { startFakeMuapi, ALL_TOOLS };
