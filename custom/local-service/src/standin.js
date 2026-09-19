'use strict';
const Module = require('node:module');
const EventEmitter = require('node:events');

/**
 * Stand-in for require('electron') so upstream's Electron main-process engine modules run unmodified
 * in a plain Node server.
 *   ipcMain.handle(channel, fn)   recorded; call it with invoke(channel, ...args)
 *   webContents.send(ch, data)    re-emitted as events.emit('send', ch, data)
 *   app.getPath()                 -> userDataPath;  app.isPackaged + process.resourcesPath -> bundled sd-cli dir
 */
function createStandin({ userDataPath, isPackaged = false, resourcesPath } = {}) {
  const handlers = new Map();
  const events = new EventEmitter();
  const window = { webContents: { send: (channel, data) => events.emit('send', channel, data) } };
  const electron = {
    ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn); } },
    app: { getPath: () => userDataPath, isPackaged },
    BrowserWindow: { getAllWindows: () => [window] },
  };

  const previousResources = process.resourcesPath;
  if (resourcesPath) process.resourcesPath = resourcesPath;

  const realLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'electron') return electron;
    return realLoad.call(this, request, ...rest);
  };

  return {
    events,
    channels: () => [...handlers.keys()].sort(),
    has: (channel) => handlers.has(channel),
    async invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw Object.assign(new Error(`unknown channel: ${channel}`), { code: 'ENOCHANNEL' });
      return fn({ sender: window.webContents }, ...args);   // ipcMain handlers receive the IPC event first
    },
    uninstall() {
      Module._load = realLoad;
      process.resourcesPath = previousResources;
    },
  };
}

module.exports = { createStandin };
