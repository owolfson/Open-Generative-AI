'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStandin } = require('../src/standin');

const ENGINE = `
const { ipcMain, app, BrowserWindow } = require('electron');
module.exports.register = () => {
  ipcMain.handle('t:echo', (_event, a, b) => ({ a, b, userData: app.getPath('userData'), packaged: app.isPackaged }));
  ipcMain.handle('t:progress', () => { BrowserWindow.getAllWindows()[0].webContents.send('t:tick', { n: 1 }); return 'sent'; });
};`;

function loadFakeEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-'));
  const file = path.join(dir, 'engine.js');
  fs.writeFileSync(file, ENGINE);
  require(file).register();
}

test('captures ipc handlers and passes an event object as the first argument', async () => {
  const s = createStandin({ userDataPath: '/data/ud', isPackaged: true });
  try {
    loadFakeEngine();
    assert.deepEqual(s.channels(), ['t:echo', 't:progress']);
    assert.ok(s.has('t:echo'));
    assert.deepEqual(await s.invoke('t:echo', 1, 'two'), { a: 1, b: 'two', userData: '/data/ud', packaged: true });
  } finally { s.uninstall(); }
});

test('webContents.send is re-emitted as a send event', async () => {
  const s = createStandin({ userDataPath: '/data/ud' });
  try {
    loadFakeEngine();
    const seen = [];
    s.events.on('send', (channel, data) => seen.push([channel, data]));
    assert.equal(await s.invoke('t:progress'), 'sent');
    assert.deepEqual(seen, [['t:tick', { n: 1 }]]);
  } finally { s.uninstall(); }
});

test('an unknown channel rejects with ENOCHANNEL', async () => {
  const s = createStandin({ userDataPath: '/x' });
  try { await assert.rejects(() => s.invoke('nope'), { code: 'ENOCHANNEL' }); } finally { s.uninstall(); }
});

test('uninstall removes the electron shim and restores process.resourcesPath', () => {
  const before = process.resourcesPath;
  const s = createStandin({ userDataPath: '/x', resourcesPath: '/res' });
  assert.equal(process.resourcesPath, '/res');
  assert.equal(require('electron').app.getPath(), '/x');
  s.uninstall();
  assert.equal(process.resourcesPath, before);
  // In a repo checkout the real `electron` npm package may resolve (a path string); either way the stand-in must be gone.
  let after = null;
  try { after = require('electron'); } catch { /* not installed: fine */ }
  assert.ok(!after || !after.ipcMain, 'the stand-in must no longer be served for require("electron")');
});
