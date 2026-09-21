'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const catalog = require('./catalog');
const { getSpec, resolveFiles } = require('./sdcpp-models');

function failure(code, message, status) { return Object.assign(new Error(message), { code, status }); }

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodeImage(input) {
  const raw = String(input).replace(/^data:image\/[a-z+.-]+;base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw failure('BAD_REQUEST', 'image_base64 is not valid base64', 400);
  const buf = Buffer.from(raw, 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw failure('BAD_REQUEST', `image_base64 is larger than ${MAX_IMAGE_BYTES / 1048576}MB`, 400);
  const png = buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
  const jpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!png && !jpeg) throw failure('BAD_REQUEST', 'image_base64 must be a PNG or JPEG', 400);
  return { buf, ext: png ? 'png' : 'jpg' };
}

/** Shared core used by both the HTTP server and the MCP endpoint. */
function createService({ standin, queue, config }) {
  if (standin.events && standin.events.on) standin.events.on('send', (channel, data) => { if (channel === 'local-ai:progress') queue.setProgress(data); });
  function submitGeneration(params) {
    const meta = catalog.assess(params && params.model);
    if (!meta) throw failure('UNKNOWN_MODEL', `unknown or excluded model: ${params && params.model}`, 400);
    if (typeof params.prompt !== 'string' || !params.prompt) throw failure('BAD_REQUEST', 'prompt is required', 400);
    return queue.submit({ kind: meta.kind, route: meta.route, params: resolveInputImage(getSpec(params.model), params) });
  }

  // A caller may reference an earlier job's image or upload one, but can NEVER name a server path: init_image is stripped
  // from the request and only set here, to a file we wrote or an output we produced.
  function resolveInputImage(spec, params) {
    const { init_image: ignored, image_job_id: jobId, image_base64: b64, ...rest } = params;   // eslint-disable-line no-unused-vars
    if (!spec || !(spec.needsImage || spec.acceptsImage)) {
      if (jobId || b64) throw failure('BAD_REQUEST', 'this model does not take an input image', 400);
      return rest;
    }
    if (jobId && b64) throw failure('BAD_REQUEST', 'pass either image_job_id or image_base64, not both', 400);
    if (jobId) {
      const src = queue.get(jobId);
      if (!src || src.status !== 'done' || !src.result || src.result.kind !== 'image') throw failure('BAD_REQUEST', `image_job_id ${jobId} is not a finished image job`, 400);
      const file = path.join(config.outputsDir, path.basename(src.result.file));
      if (!fs.existsSync(file)) throw failure('BAD_REQUEST', `the image of job ${jobId} is no longer on disk`, 400);
      return { ...rest, init_image: file };
    }
    if (b64) {
      const { buf, ext } = decodeImage(b64);
      const dir = path.join(config.tmpDir, 'inputs');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${randomUUID()}.${ext}`);
      fs.writeFileSync(dest, buf);
      return { ...rest, init_image: dest };
    }
    if (spec.acceptsImage) return rest;   // optional: text-to-video
    throw failure('IMAGE_REQUIRED', 'this model needs an input image: pass image_job_id (an earlier image job) or image_base64', 400);
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
      if (spec.kind === 'video') { info.needsImage = Boolean(spec.needsImage); info.acceptsImage = Boolean(spec.acceptsImage); }   // the GUI shows the image picker only for image-to-video
      if (config && config.modelDirs) info.filesPresent = resolveFiles(spec, config.modelDirs, {}).missing.length === 0;
      return info;
    };
    return { models: [...catalog.annotate(sd), ...other].map(withInfo), excluded: catalog.EXCLUDED };
  }

  return { submitGeneration, generateAndWait, catalogPayload };
}

module.exports = { createService, failure };
