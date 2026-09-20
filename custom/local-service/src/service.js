'use strict';
const catalog = require('./catalog');
const { getSpec, resolveFiles } = require('./sdcpp-models');

function failure(code, message, status) { return Object.assign(new Error(message), { code, status }); }

/** Shared core used by both the HTTP server and the MCP endpoint. */
function createService({ standin, queue, config }) {
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
    const listed = new Set(sd.map((m) => m.id));
    // Upstream's engine lists its own models; we add everything else we know, including the extended sd.cpp ones (Flux/Qwen/Wan).
    const other = catalog.staticCatalog().filter((m) => !listed.has(m.id) && (m.route !== 'sdcpp' || getSpec(m.id)));
    const withInfo = (m) => {
      const spec = getSpec(m.id);
      if (!spec) return m;
      const info = { ...m, vramGb: spec.vramGb };
      if (config && config.modelDirs) info.filesPresent = resolveFiles(spec, config.modelDirs, {}).missing.length === 0;
      return info;
    };
    return { models: [...catalog.annotate(sd), ...other].map(withInfo), excluded: catalog.EXCLUDED };
  }

  return { submitGeneration, generateAndWait, catalogPayload };
}

module.exports = { createService, failure };
