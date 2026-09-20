'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Boot-time cleanup of the scratch dir: nothing is running yet, so uploaded input images and orphaned sd-cli outputs are garbage. */
function pruneTmp(dir) {
  let removed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

module.exports = { pruneTmp };
