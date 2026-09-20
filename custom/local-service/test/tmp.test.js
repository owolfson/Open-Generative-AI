'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneTmp } = require('../src/tmp');

test('pruneTmp empties the scratch dir (uploaded inputs, orphaned sd-cli outputs) but keeps the dir; a missing dir is fine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-tmp-'));
  fs.mkdirSync(path.join(dir, 'inputs'));
  fs.writeFileSync(path.join(dir, 'inputs', 'a.png'), 'x');
  fs.writeFileSync(path.join(dir, 'job.avi'), 'y');
  assert.equal(pruneTmp(dir), 2);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(pruneTmp(path.join(dir, 'does-not-exist')), 0);
});
