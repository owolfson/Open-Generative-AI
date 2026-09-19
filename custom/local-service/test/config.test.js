'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('defaults are safe: GPU off, no arbiter, no token', () => {
  const c = loadConfig({});
  assert.equal(c.gpuEnabled, false);
  assert.equal(c.arbiterUrl, '');
  assert.equal(c.token, '');
  assert.equal(c.port, 8790);
  assert.equal(c.dataDir, '/data');
  assert.equal(c.outputsDir, '/data/outputs');
  assert.equal(c.muapiKeyFile, '/data/.muapi-key');
  assert.equal(c.deviceIndexV100, 0);
  assert.equal(c.deviceIndex1080, 1);
});

test('GPU is only enabled by the literal string 1', () => {
  assert.equal(loadConfig({ OGAI_GPU_ENABLED: '1' }).gpuEnabled, true);
  for (const v of ['0', 'true', 'yes', '']) assert.equal(loadConfig({ OGAI_GPU_ENABLED: v }).gpuEnabled, false, v);
});

test('overrides are honoured and the arbiter url loses trailing slashes', () => {
  const c = loadConfig({ OGAI_ARBITER_URL: 'http://arb:6000//', OGAI_LOCAL_PORT: '9000', OGAI_DATA_DIR: '/x', OGAI_SDCPP_CONSUMER: 'MyCons', OGAI_DEVICE_INDEX_1080: '2' });
  assert.equal(c.arbiterUrl, 'http://arb:6000');
  assert.equal(c.port, 9000);
  assert.equal(c.outputsDir, '/x/outputs');
  assert.equal(c.sdcppConsumer, 'mycons');
  assert.equal(c.deviceIndex1080, 2);
});
