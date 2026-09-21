'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toMp4 } = require('../src/video');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-video-'));

// A fake ffmpeg: records its arguments next to the output and writes the output file (last argument).
function fakeFfmpeg(dir, { fail = false } = {}) {
  const file = path.join(dir, 'ffmpeg');
  fs.writeFileSync(file, `#!/bin/sh
for a; do out="$a"; done
echo "$@" > "$out.args"
${fail ? 'echo "Invalid data found" >&2; exit 1' : 'echo MP4BYTES > "$out"'}
`, { mode: 0o755 });
  return file;
}

test('toMp4 runs ffmpeg with browser-safe H.264 settings and returns the output path', async () => {
  const dir = tmp(); const input = path.join(dir, 'in.avi'); const output = path.join(dir, 'out.mp4');
  fs.writeFileSync(input, 'AVI');
  const res = await toMp4({ ffmpeg: fakeFfmpeg(dir), input, output });
  assert.equal(res, output);
  assert.equal(fs.readFileSync(output, 'utf8').trim(), 'MP4BYTES');
  const args = fs.readFileSync(`${output}.args`, 'utf8');
  for (const want of ['-y', `-i ${input}`, '-c:v libx264', '-pix_fmt yuv420p', '-movflags +faststart', '-an']) assert.ok(args.includes(want), `${want} in: ${args}`);
});

test('toMp4 rejects with FFMPEG_FAILED (and the tail of stderr) on a non-zero exit, and FFMPEG_MISSING without a binary', async () => {
  const dir = tmp(); const input = path.join(dir, 'in.avi'); fs.writeFileSync(input, 'AVI');
  await assert.rejects(() => toMp4({ ffmpeg: fakeFfmpeg(dir, { fail: true }), input, output: path.join(dir, 'o.mp4') }), (e) => e.code === 'FFMPEG_FAILED' && /Invalid data found/.test(e.message));
  await assert.rejects(() => toMp4({ ffmpeg: path.join(dir, 'nope'), input, output: path.join(dir, 'o.mp4') }), { code: 'FFMPEG_MISSING' });
  await assert.rejects(() => toMp4({ ffmpeg: '', input, output: path.join(dir, 'o.mp4') }), { code: 'FFMPEG_MISSING' });
});
