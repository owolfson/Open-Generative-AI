'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toMp4, lastFrame, concat, crossfadeConcat } = require('../src/video');

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

// ---------- lastFrame / concat: used to chain "cinema" video segments ----------
test('lastFrame seeks near the end (-sseof -1) and writes a single PNG', async () => {
  const dir = tmp(); const input = path.join(dir, 'seg1.mp4'); const output = path.join(dir, 'last.png');
  fs.writeFileSync(input, 'MP4');
  const res = await lastFrame({ ffmpeg: fakeFfmpeg(dir), input, output });
  assert.equal(res, output);
  const args = fs.readFileSync(`${output}.args`, 'utf8');
  for (const want of ['-sseof -1', `-i ${input}`, '-update 1', '-frames:v 1']) assert.ok(args.includes(want), `${want} in: ${args}`);
});

test('lastFrame rejects FFMPEG_FAILED / FFMPEG_MISSING the same way toMp4 does', async () => {
  const dir = tmp(); const input = path.join(dir, 'seg1.mp4'); fs.writeFileSync(input, 'MP4');
  await assert.rejects(() => lastFrame({ ffmpeg: fakeFfmpeg(dir, { fail: true }), input, output: path.join(dir, 'o.png') }), { code: 'FFMPEG_FAILED' });
  await assert.rejects(() => lastFrame({ ffmpeg: path.join(dir, 'nope'), input, output: path.join(dir, 'o.png') }), { code: 'FFMPEG_MISSING' });
});

test('concat writes a filelist (safe against a quote in a path) and runs the concat demuxer with -c copy', async () => {
  const dir = tmp();
  const a = path.join(dir, "seg 1 it's.mp4"); const b = path.join(dir, 'seg2.mp4'); const output = path.join(dir, 'final.mp4');
  fs.writeFileSync(a, 'A'); fs.writeFileSync(b, 'B');
  const res = await concat({ ffmpeg: fakeFfmpeg(dir), inputs: [a, b], output, tmpDir: dir });
  assert.equal(res, output);
  const args = fs.readFileSync(`${output}.args`, 'utf8');
  for (const want of ['-f concat', '-safe 0', '-c copy']) assert.ok(args.includes(want), `${want} in: ${args}`);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('concat-')).length, 0, 'the temporary filelist is cleaned up');
});

test('concat rejects on ffmpeg failure (and still cleans up the filelist) and on no inputs', async () => {
  const dir = tmp(); const a = path.join(dir, 'a.mp4'); fs.writeFileSync(a, 'A');
  await assert.rejects(() => concat({ ffmpeg: fakeFfmpeg(dir, { fail: true }), inputs: [a], output: path.join(dir, 'o.mp4'), tmpDir: dir }), { code: 'FFMPEG_FAILED' });
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('concat-')).length, 0);
  await assert.rejects(() => concat({ ffmpeg: fakeFfmpeg(dir), inputs: [], output: path.join(dir, 'o.mp4') }), { code: 'BAD_REQUEST' });
});

// ---------- crossfadeConcat: dissolve at each "cinema" seam instead of a hard cut (masks the motion-energy jump a hard cut shows) ----------
test('crossfadeConcat chains an xfade node per seam, with each offset advancing by (segment length - blend length)', async () => {
  const dir = tmp();
  const a = path.join(dir, 'a.mp4'); const b = path.join(dir, 'b.mp4'); const c = path.join(dir, 'c.mp4'); const output = path.join(dir, 'final.mp4');
  fs.writeFileSync(a, 'A'); fs.writeFileSync(b, 'B'); fs.writeFileSync(c, 'C');
  const res = await crossfadeConcat({ ffmpeg: fakeFfmpeg(dir), inputs: [a, b, c], segmentDurationSec: 1.375, blendSeconds: 0.3, output });
  assert.equal(res, output);
  const args = fs.readFileSync(`${output}.args`, 'utf8');
  assert.ok(args.includes(`-i ${a}`) && args.includes(`-i ${b}`) && args.includes(`-i ${c}`));
  // seam 1: offset = 1 * (1.375 - 0.3) = 1.075; seam 2 (chained onto the first node's output): offset = 2 * (1.375 - 0.3) = 2.150
  assert.match(args, /\[0\]\[1\]xfade=transition=fade:duration=0\.3:offset=1\.075\[v1\]/);
  assert.match(args, /\[v1\]\[2\]xfade=transition=fade:duration=0\.3:offset=2\.150\[out\]/);
  assert.ok(args.includes('-map [out]'));
  for (const want of ['-c:v libx264', '-pix_fmt yuv420p', '-movflags +faststart']) assert.ok(args.includes(want), `${want} in: ${args}`);
});

test('crossfadeConcat with a single input just copies it (nothing to blend)', async () => {
  const dir = tmp(); const a = path.join(dir, 'a.mp4'); fs.writeFileSync(a, 'ONLYSEG');
  const output = path.join(dir, 'o.mp4');
  const res = await crossfadeConcat({ ffmpeg: fakeFfmpeg(dir), inputs: [a], segmentDurationSec: 1.375, blendSeconds: 0.3, output });
  assert.equal(res, output);
  assert.equal(fs.readFileSync(output, 'utf8'), 'ONLYSEG');
});

test('crossfadeConcat rejects FFMPEG_FAILED / FFMPEG_MISSING / no inputs the same way concat does', async () => {
  const dir = tmp(); const a = path.join(dir, 'a.mp4'); const b = path.join(dir, 'b.mp4'); fs.writeFileSync(a, 'A'); fs.writeFileSync(b, 'B');
  await assert.rejects(() => crossfadeConcat({ ffmpeg: fakeFfmpeg(dir, { fail: true }), inputs: [a, b], segmentDurationSec: 1.375, blendSeconds: 0.3, output: path.join(dir, 'o.mp4') }), { code: 'FFMPEG_FAILED' });
  await assert.rejects(() => crossfadeConcat({ ffmpeg: path.join(dir, 'nope'), inputs: [a, b], segmentDurationSec: 1.375, blendSeconds: 0.3, output: path.join(dir, 'o.mp4') }), { code: 'FFMPEG_MISSING' });
  await assert.rejects(() => crossfadeConcat({ ffmpeg: fakeFfmpeg(dir), inputs: [], segmentDurationSec: 1.375, blendSeconds: 0.3, output: path.join(dir, 'o.mp4') }), { code: 'BAD_REQUEST' });
});
