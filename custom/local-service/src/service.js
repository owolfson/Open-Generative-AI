'use strict';
const catalog = require('./catalog');

function failure(code, message, status) { return Object.assign(new Error(message), { code, status }); }

/** Shared core used by both the HTTP server and the MCP endpoint. */
function createService({ standin, queue }) {
  function submitGeneration(params) {
    const meta = catalog.assess(params && params.model);
    if (!meta) throw failure('UNKNOWN_MODEL', `unknown or excluded model: ${params && params.model}`, 400);
    if (typeof params.prompt !== 'string' || !params.prompt) throw failure('BAD_REQUEST', 'prompt is required', 400);
    return queue.submit({ kind: meta.kind, route: meta.route, params });
  }

  async function generateAndWait(params) {
    const job = submitGeneration(params);
    const done = await queue.wait(job.id, 6 * 60 * 60 * 1000);
    if (done.status !== 'done') {
      throw failure(done.error ? done.error.code : done.status.toUpperCase(), done.error ? done.error.message : `job ${done.status}`, 502);
    }
    return done;
  }

  async function catalogPayload() {
    const sd = await standin.invoke('local-ai:list-models');
    const other = catalog.staticCatalog().filter((m) => m.route !== 'sdcpp');
    return { models: [...catalog.annotate(sd), ...other], excluded: catalog.EXCLUDED };
  }

  return { submitGeneration, generateAndWait, catalogPayload };
}

module.exports = { createService, failure };
