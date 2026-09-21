'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installSdCliCompat, fixSamplerArgs } = require('../src/sdcli-compat');

test('fixSamplerArgs respells upstream\'s dpmpp* sampler names the way this sd.cpp build expects (dpm++*), and nothing else', () => {
  assert.deepEqual(fixSamplerArgs(['-p', 'x', '--sampling-method', 'dpmpp2m', '--steps', '30']), ['-p', 'x', '--sampling-method', 'dpm++2m', '--steps', '30']);
  assert.deepEqual(fixSamplerArgs(['--sampling-method', 'dpmpp2s_a']), ['--sampling-method', 'dpm++2s_a']);
  assert.deepEqual(fixSamplerArgs(['--high-noise-sampling-method', 'dpmpp2m']), ['--high-noise-sampling-method', 'dpm++2m']);
  // already valid / other names / prompts that merely contain the word are untouched
  assert.deepEqual(fixSamplerArgs(['--sampling-method', 'euler_a', '--sampler', 'x']), ['--sampling-method', 'euler_a', '--sampler', 'x']);
  assert.deepEqual(fixSamplerArgs(['--sampling-method', 'dpm++2m']), ['--sampling-method', 'dpm++2m']);
  assert.deepEqual(fixSamplerArgs(['-p', 'dpmpp2m', '-n', 'dpmpp2m']), ['-p', 'dpmpp2m', '-n', 'dpmpp2m']);
  assert.deepEqual(fixSamplerArgs(['--sampling-method']), ['--sampling-method'], 'a flag with no value is left alone');
});

test('installSdCliCompat wraps spawn for the sd-cli binary only, passes options through, and is idempotent', () => {
  const calls = [];
  const cp = { spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return 'child'; } };
  installSdCliCompat(cp); installSdCliCompat(cp);
  assert.equal(cp.spawn('/data/local-ai/bin/sd-cli', ['--sampling-method', 'dpmpp2m'], { env: { A: '1' } }), 'child');
  assert.deepEqual(calls[0], { cmd: '/data/local-ai/bin/sd-cli', args: ['--sampling-method', 'dpm++2m'], opts: { env: { A: '1' } } });
  cp.spawn('ffmpeg', ['--sampling-method', 'dpmpp2m'], {});
  assert.deepEqual(calls[1].args, ['--sampling-method', 'dpmpp2m'], 'other programs are never touched');
  assert.equal(calls.length, 2, 'installing twice must not double-wrap (each spawn reaches the original once)');
});

test('fixSamplerArgs also drops flags this sd.cpp no longer has (--sd-version <v>, --flux): the build detects the model version itself', () => {
  assert.deepEqual(fixSamplerArgs(['-m', '/m/sdxl.safetensors', '-p', 'x', '--sampling-method', 'dpmpp2m', '--sd-version', 'sdxl', '-v']), ['-m', '/m/sdxl.safetensors', '-p', 'x', '--sampling-method', 'dpm++2m', '-v']);
  assert.deepEqual(fixSamplerArgs(['--sd-version', 'sd2', '--steps', '20']), ['--steps', '20']);
  assert.deepEqual(fixSamplerArgs(['--flux', '-p', 'x']), ['-p', 'x']);
  assert.deepEqual(fixSamplerArgs(['-p', '--sd-version', '-n', '--flux']), ['-p', '--sd-version', '-n', '--flux'], 'flag-looking prompt text right after -p/-n is a value, not a flag');
});
