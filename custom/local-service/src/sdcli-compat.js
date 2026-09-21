'use strict';
const path = require('node:path');

// Upstream's model catalog was written for an older sd.cpp: it asks for the sampler `dpmpp2m`, which the sd.cpp we build (master-881)
// spells `dpm++2m` and rejects otherwise ("invalid sample method dpmpp2m"; SDXL uses it). Rather than patch upstream's files (which would
// conflict on every merge), the stand-in respells such names on the way to the binary, exactly as it already stands in for Electron.
const SAMPLER_FLAGS = new Set(['--sampling-method', '--high-noise-sampling-method']);

/** Respell upstream's `dpmpp*` sampler names as `dpm++*` for the value that follows a sampler flag. Returns a new array. */
function fixSamplerArgs(args) {
  return args.map((arg, i) => (i > 0 && SAMPLER_FLAGS.has(args[i - 1]) && typeof arg === 'string' && arg.startsWith('dpmpp') ? `dpm++${arg.slice(5)}` : arg));
}

/** Wrap child_process.spawn so that sd-cli invocations get their sampler names fixed. Idempotent; other programs are untouched. */
function installSdCliCompat(cp = require('node:child_process')) {
  if (cp.spawn.__ogaiSdCliCompat) return;
  const original = cp.spawn;
  const wrapped = function spawn(command, args, options) {
    if (typeof command === 'string' && path.basename(command) === 'sd-cli' && Array.isArray(args)) return original.call(cp, command, fixSamplerArgs(args), options);
    return original.apply(cp, arguments);   // eslint-disable-line prefer-rest-params
  };
  wrapped.__ogaiSdCliCompat = true;
  cp.spawn = wrapped;
}

module.exports = { installSdCliCompat, fixSamplerArgs };
