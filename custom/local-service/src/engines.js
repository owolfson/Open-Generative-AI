'use strict';
const path = require('node:path');
const { createStandin } = require('./standin');

// Upstream modules destructure require('electron') once at load, so a second load in the same
// process would keep talking to the first stand-in. Drop them from the cache before loading.
function purgeEngineCache(libDir) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(libDir + path.sep)) delete require.cache[key];
  }
}

/**
 * Load upstream's sd.cpp engine (and, unless overridden, its Wan2GP provider) behind the stand-in.
 * wan2gp: 'upstream' loads upstream's provider; 'none' skips it (our own adapter replaces it).
 */
function loadEngines({ upstreamDir, userDataPath, resourcesPath, wan2gp = 'upstream' }) {
  const libDir = path.join(upstreamDir, 'electron', 'lib');
  const standin = createStandin({ userDataPath, isPackaged: Boolean(resourcesPath), resourcesPath });
  purgeEngineCache(libDir);
  require(path.join(libDir, 'localInference.js')).register();
  if (wan2gp === 'upstream') require(path.join(libDir, 'wan2gpProvider.js')).register();
  return standin;
}

module.exports = { loadEngines };
