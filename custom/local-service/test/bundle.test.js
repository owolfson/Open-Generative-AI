'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBundledBinary } = require('../src/bundle');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-bundle-'));
const PLATFORM = `${process.platform}-${process.arch}`;

function makeBundle(version, files = { 'sd-cli': 'binary-v' }) {
  const resources = tmp();
  const bin = path.join(resources, 'local-ai', PLATFORM, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(bin, name), body + version);
  if (version) fs.writeFileSync(path.join(bin, 'BUNDLE_VERSION'), `${version}\n`);
  return resources;
}

test('nothing to do without a bundle', () => {
  assert.deepEqual(syncBundledBinary({ resourcesPath: '', userDataPath: tmp() }), { synced: false, reason: 'no bundled binary configured' });
  const noStamp = makeBundle('');
  assert.equal(syncBundledBinary({ resourcesPath: noStamp, userDataPath: tmp() }).synced, false);
  assert.match(syncBundledBinary({ resourcesPath: noStamp, userDataPath: tmp() }).reason, /BUNDLE_VERSION/);
});

test('first boot copies the bundle into <userData>/local-ai/bin', () => {
  const userData = tmp();
  const result = syncBundledBinary({ resourcesPath: makeBundle('v1'), userDataPath: userData });
  assert.deepEqual(result, { synced: true, version: 'v1', replaced: null });
  assert.equal(fs.readFileSync(path.join(userData, 'local-ai', 'bin', 'sd-cli'), 'utf8'), 'binary-vv1');
});

test('the same version is left alone (no needless multi-hundred-MB copy)', () => {
  const userData = tmp();
  const resources = makeBundle('v1');
  syncBundledBinary({ resourcesPath: resources, userDataPath: userData });
  fs.writeFileSync(path.join(userData, 'local-ai', 'bin', 'marker'), 'x');
  const again = syncBundledBinary({ resourcesPath: resources, userDataPath: userData });
  assert.deepEqual(again, { synced: false, reason: 'up to date', version: 'v1' });
  assert.ok(fs.existsSync(path.join(userData, 'local-ai', 'bin', 'marker')));
});

test('a new image version replaces bin wholesale (stale files gone) but never touches downloaded models', () => {
  const userData = tmp();
  syncBundledBinary({ resourcesPath: makeBundle('v1', { 'sd-cli': 'old', 'libold.so': 'old' }), userDataPath: userData });
  const models = path.join(userData, 'local-ai', 'models');
  fs.mkdirSync(models, { recursive: true });
  fs.writeFileSync(path.join(models, 'dreamshaper.safetensors'), 'weights');

  const result = syncBundledBinary({ resourcesPath: makeBundle('v2', { 'sd-cli': 'new' }), userDataPath: userData });
  assert.deepEqual(result, { synced: true, version: 'v2', replaced: 'v1' });
  assert.equal(fs.readFileSync(path.join(userData, 'local-ai', 'bin', 'sd-cli'), 'utf8'), 'newv2');
  assert.equal(fs.existsSync(path.join(userData, 'local-ai', 'bin', 'libold.so')), false);
  assert.equal(fs.readFileSync(path.join(models, 'dreamshaper.safetensors'), 'utf8'), 'weights');
});
