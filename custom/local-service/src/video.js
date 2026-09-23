'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const codeError = (code, message) => Object.assign(new Error(message), { code });

/**
 * sd.cpp writes MJPEG .avi, which no browser plays. Re-encode to H.264 .mp4 (yuv420p + faststart = plays everywhere and starts
 * before the download finishes). Runs on the CPU; a few seconds for a 33-frame clip.
 */
function toMp4({ ffmpeg, input, output, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg || !fs.existsSync(ffmpeg)) { reject(codeError('FFMPEG_MISSING', `ffmpeg not found${ffmpeg ? ` at ${ffmpeg}` : ' (set OGAI_FFMPEG)'}`)); return; }
    const child = spawnImpl(ffmpeg, ['-y', '-i', input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'veryfast', '-movflags', '+faststart', '-an', output]);
    let stderr = '';
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    child.on('error', (err) => reject(codeError('FFMPEG_MISSING', err.message)));
    child.on('close', (code) => (code === 0 ? resolve(output) : reject(codeError('FFMPEG_FAILED', `ffmpeg exited (${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

/**
 * Grab the LAST frame of an mp4 as a PNG - used to seed the next segment of a chained "cinema" generation with the exact
 * pixels the previous segment ended on. `-sseof -1` seeks to one second before the end WITHOUT decoding the whole file
 * first (fast even on a longer clip), `-update 1` makes the image2 muxer overwrite a single output file instead of
 * numbering frames.
 */
function lastFrame({ ffmpeg, input, output, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg || !fs.existsSync(ffmpeg)) { reject(codeError('FFMPEG_MISSING', `ffmpeg not found${ffmpeg ? ` at ${ffmpeg}` : ' (set OGAI_FFMPEG)'}`)); return; }
    const child = spawnImpl(ffmpeg, ['-y', '-sseof', '-1', '-i', input, '-update', '1', '-frames:v', '1', '-q:v', '2', output]);
    let stderr = '';
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    child.on('error', (err) => reject(codeError('FFMPEG_MISSING', err.message)));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(output)) resolve(output);
      else reject(codeError('FFMPEG_FAILED', `ffmpeg (last frame) exited (${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/**
 * Stitch same-codec mp4 segments into one file with the concat DEMUXER (`-c copy`: a container-level splice, no
 * re-encode - fast and lossless because every segment came from the same spec/model/dims). Used by "cinema" chaining.
 */
function concat({ ffmpeg, inputs, output, spawnImpl = spawn, tmpDir }) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg || !fs.existsSync(ffmpeg)) { reject(codeError('FFMPEG_MISSING', `ffmpeg not found${ffmpeg ? ` at ${ffmpeg}` : ' (set OGAI_FFMPEG)'}`)); return; }
    if (!Array.isArray(inputs) || inputs.length === 0) { reject(codeError('BAD_REQUEST', 'concat needs at least one input file')); return; }
    const listFile = path.join(tmpDir || path.dirname(output), `concat-${randomUUID()}.txt`);
    fs.writeFileSync(listFile, inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const cleanup = () => fs.rmSync(listFile, { force: true });
    const child = spawnImpl(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output]);
    let stderr = '';
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    child.on('error', (err) => { cleanup(); reject(codeError('FFMPEG_MISSING', err.message)); });
    child.on('close', (code) => {
      cleanup();
      if (code === 0) resolve(output);
      else reject(codeError('FFMPEG_FAILED', `ffmpeg (concat) exited (${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

module.exports = { toMp4, lastFrame, concat };
