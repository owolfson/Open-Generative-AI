'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');

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

module.exports = { toMp4 };
