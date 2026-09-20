'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Keep <userData>/local-ai/bin in step with the sd.cpp bundle baked into the image.
 * Upstream's ensureBundledBinaryInstalled() copies only when the binary is missing, so after an image
 * upgrade the persistent volume would keep serving the OLD sd-cli. We compare BUNDLE_VERSION stamps.
 */
function syncBundledBinary({ resourcesPath, userDataPath, platform = process.platform, arch = process.arch }) {
  if (!resourcesPath) return { synced: false, reason: 'no bundled binary configured' };
  const source = path.join(resourcesPath, 'local-ai', `${platform}-${arch}`, 'bin');
  const stamp = path.join(source, 'BUNDLE_VERSION');
  if (!fs.existsSync(stamp)) return { synced: false, reason: `bundle has no BUNDLE_VERSION at ${source}` };

  const version = fs.readFileSync(stamp, 'utf8').trim();
  const dest = path.join(userDataPath, 'local-ai', 'bin');
  const installedStamp = path.join(dest, 'BUNDLE_VERSION');
  const current = fs.existsSync(installedStamp) ? fs.readFileSync(installedStamp, 'utf8').trim() : null;
  if (current === version) return { synced: false, reason: 'up to date', version };

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, dest, { recursive: true });
  return { synced: true, version, replaced: current };
}

module.exports = { syncBundledBinary };
