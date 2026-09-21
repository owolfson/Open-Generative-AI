'use strict';
const path = require('node:path');

// Upstream's model catalog was written for an older sd.cpp: it asks for the sampler `dpmpp2m`, which the sd.cpp we build (master-881)
// spells `dpm++2m` and rejects otherwise ("invalid sample method dpmpp2m"; SDXL uses it). Rather than patch upstream's files (which would
// conflict on every merge), the stand-in respells such names on the way to the binary, exactly as it already stands in for Electron.
const SAMPLER_FLAGS = new Set(['--sampling-method', '--high-noise-sampling-method']);

// Flags upstream's engine still passes that this sd.cpp removed (it detects the model version from the file now): `--sd-version <v>`, `--flux`.
const VALUE_FLAGS_WITH_TEXT = new Set(['-p', '-n', '--prompt', '--negative-prompt']);   // the argument after these is user text, never a flag
const DROPPED = new Map([['--sd-version', 1], ['--flux', 0]]);   // flag -> number of value arguments to drop with it

/** Respell upstream's `dpmpp*` sampler names as `dpm++*` and drop removed flags. Returns a new array. */
function fixSamplerArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const afterText = i > 0 && VALUE_FLAGS_WITH_TEXT.has(args[i - 1]);
    if (!afterText && typeof arg === 'string' && DROPPED.has(arg)) { i += DROPPED.get(arg); continue; }
    out.push(i > 0 && SAMPLER_FLAGS.has(args[i - 1]) && typeof arg === 'string' && arg.startsWith('dpmpp') ? `dpm++${arg.slice(5)}` : arg);
  }
  return out;
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
