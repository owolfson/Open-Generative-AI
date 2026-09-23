'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const catalog = require('./catalog');
const { getSpec, resolveFiles, canChain } = require('./sdcpp-models');

const MAX_PROMPT_CHARS = 8000;   // an argv entry over ~128KB makes exec fail, and no model uses more than a few hundred tokens
const CINEMA_MIN_SEGMENTS = 2;   // 1 segment is just a normal job; omit `cinema` for that

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
  // "cinema": chain several of this model's own clips into one longer video, each one after the first seeded from the
  // last frame of the one before it (a real generation each time, not extrapolation/interpolation). Only a model that
  // takes an input image can chain (canChain === needsImage || acceptsImage, the same flag resolveInputImage uses).
  function validateCinema(spec, params) {
    if (params.cinema === undefined) return undefined;
    const c = params.cinema;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) throw failure('BAD_REQUEST', 'cinema must be an object, e.g. {"segments": 4}', 400);
    const max = (config && config.cinemaMaxSegments) || 8;
    const segments = Number(c.segments);
    if (!Number.isInteger(segments) || segments < CINEMA_MIN_SEGMENTS || segments > max) {
      throw failure('BAD_REQUEST', `cinema.segments must be a whole number from ${CINEMA_MIN_SEGMENTS} to ${max} (got ${JSON.stringify(c.segments)})`, 400);
    }
    if (!canChain(spec)) {
      throw failure('CINEMA_UNSUPPORTED', `${params.model} cannot be chained into a cinema sequence: it does not take an input image between segments (needs image-to-video support)`, 400);
    }
    if (params.prompts !== undefined) {
      if (!Array.isArray(params.prompts) || params.prompts.length !== segments) {
        throw failure('BAD_REQUEST', `prompts must be an array of exactly cinema.segments (${segments}) strings, one per segment - or omit it to reuse prompt for every segment`, 400);
      }
      params.prompts.forEach((p, i) => {
        if (typeof p !== 'string' || !p.trim()) throw failure('BAD_REQUEST', `prompts[${i}] must be a non-empty string`, 400);
        if (p.length > MAX_PROMPT_CHARS) throw failure('BAD_REQUEST', `prompts[${i}] is longer than ${MAX_PROMPT_CHARS} characters`, 400);
      });
    }
    return { segments, prompts: params.prompts };
  }

  function submitGeneration(params) {
    const meta = catalog.assess(params && params.model);
    if (!meta) throw failure('UNKNOWN_MODEL', `unknown or excluded model: ${params && params.model}`, 400);
    if (typeof params.prompt !== 'string' || !params.prompt) throw failure('BAD_REQUEST', 'prompt is required', 400);
    if (params.prompt.length > MAX_PROMPT_CHARS) throw failure('BAD_REQUEST', `prompt is longer than ${MAX_PROMPT_CHARS} characters`, 400);
    if (typeof params.negative_prompt === 'string' && params.negative_prompt.length > MAX_PROMPT_CHARS) throw failure('BAD_REQUEST', `negative_prompt is longer than ${MAX_PROMPT_CHARS} characters`, 400);
    const spec = getSpec(params.model);
    const cinema = validateCinema(spec, params);   // throws before anything is queued when the request is bad
    const maxPending = (config && config.maxPending) || 25;
    if (queue.pending.length >= maxPending) throw failure('QUEUE_FULL', `${queue.pending.length} jobs are already waiting (limit ${maxPending}); try again when some have finished`, 429);
    const resolved = resolveInputImage(spec, params);
    if (!cinema) return queue.submit({ kind: meta.kind, route: meta.route, params: resolved });
    const { prompts: droppedTopLevelPrompts, ...withoutPrompts } = resolved;   // eslint-disable-line no-unused-vars -- moved into cinema.prompts below
    return queue.submit({ kind: meta.kind, route: meta.route, params: { ...withoutPrompts, cinema } });
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
      if (spec.devices) { info.devices = spec.devices; info.deviceNote = spec.deviceNote; }   // clients must not offer a GPU this model cannot use
      if (spec.kind === 'video') {
        info.needsImage = Boolean(spec.needsImage); info.acceptsImage = Boolean(spec.acceptsImage);   // the GUI shows the image picker only for image-to-video
        info.chainable = canChain(spec);   // the GUI offers "cinema" (chained multi-segment) mode only for models that can take an image between segments
        info.fps = spec.defaults({}).fps;   // each model has its own fps (Wan 16, LTX/Hunyuan 24): the GUI needs this to LABEL frame counts as seconds, not assume one
        if (spec.frameChoices) info.frameChoices = spec.frameChoices;   // this model's own valid/measured-safe frame counts (LTX's must be 8n+1 and go further: up to 121 = 5s)
      }
      if (config && config.modelDirs) info.filesPresent = resolveFiles(spec, config.modelDirs, {}).missing.length === 0;
      return info;
    };
    return { models: [...catalog.annotate(sd), ...other].map(withInfo), excluded: catalog.EXCLUDED };
  }

  return { submitGeneration, generateAndWait, catalogPayload };
}

module.exports = { createService, failure };
