'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEngines } = require('../src/engines');

const REPO = path.resolve(__dirname, '..', '..', '..');   // custom/local-service/test -> repo root
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-engines-'));
const SD_IDS = ['anything-v5', 'dreamshaper-8', 'realistic-vision-v51', 'stable-diffusion-xl-base', 'z-image-base', 'z-image-turbo'];

test('loads upstream engines unmodified: 15 IPC channels and 6 sd.cpp models', async () => {
  const s = loadEngines({ upstreamDir: REPO, userDataPath: tmp() });
  try {
    assert.equal(s.channels().length, 15);
    for (const c of ['local-ai:generate', 'local-ai:list-models', 'local-ai:cancel-generation', 'wan2gp:probe']) assert.ok(s.has(c), c);
    const models = await s.invoke('local-ai:list-models');
    assert.deepEqual(models.map((m) => m.id).sort(), SD_IDS);
  } finally { s.uninstall(); }
});

test('wan2gp: none skips upstream stale Wan2GP provider', () => {
  const s = loadEngines({ upstreamDir: REPO, userDataPath: tmp(), wan2gp: 'none' });
  try {
    assert.equal(s.has('local-ai:generate'), true);
    assert.equal(s.has('wan2gp:probe'), false);
  } finally { s.uninstall(); }
});

test('a bundled sd-cli under resourcesPath is reported as installed (no upstream download)', async () => {
  const res = tmp();
  const bin = path.join(res, 'local-ai', `${process.platform}-${process.arch}`, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'sd-cli'), '#!/bin/sh\n');
  const s = loadEngines({ upstreamDir: REPO, userDataPath: tmp(), resourcesPath: res });
  try { assert.equal((await s.invoke('local-ai:binary-status')).exists, true); } finally { s.uninstall(); }
});

test('without a bundled binary the engine reports not installed', async () => {
  const s = loadEngines({ upstreamDir: REPO, userDataPath: tmp() });
  try { assert.equal((await s.invoke('local-ai:binary-status')).exists, false); } finally { s.uninstall(); }
});

test('engines can be loaded twice in one process (require cache is purged)', () => {
  loadEngines({ upstreamDir: REPO, userDataPath: tmp() }).uninstall();
  const b = loadEngines({ upstreamDir: REPO, userDataPath: tmp() });
  try { assert.equal(b.channels().length, 15); } finally { b.uninstall(); }
});

test('tripwire: upstream engine modules only require node builtins (the slim image has no node_modules)', () => {
  const builtins = new Set(require('node:module').builtinModules);
  const lib = path.join(REPO, 'electron', 'lib');
  const offenders = [];
  for (const file of fs.readdirSync(lib).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(lib, file), 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const name = m[1];
      if (name.startsWith('.') || name === 'electron' || builtins.has(name.replace(/^node:/, ''))) continue;
      offenders.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [], 'upstream added an npm dependency to electron/lib - the ogai-local image needs it too');
});
