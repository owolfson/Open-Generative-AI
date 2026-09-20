'use strict';
const { spawn } = require('node:child_process');

const codeError = (code, message) => Object.assign(new Error(message), { code });

/**
 * Run one sd-cli process to completion. Generic on purpose: the caller builds the arguments (see sdcpp-models.js) and
 * passes the GPU selection through `env` explicitly (no mutation of process.env).
 * - progress: `parseChunk` is upstream's own parser (localInferenceRuntime.parseGenerationProgressChunk); each fresh
 *   {step,totalSteps,progress} is forwarded to onProgress with status 'sampling'.
 * - failure: non-zero exit -> SDCLI_FAILED with the tail of the output.
 * - cancel: aborting `signal` sends SIGTERM (then SIGKILL after killGraceMs) and rejects with CANCELLED.
 */
function runSdCli({ binary, libDir, args, env = {}, signal, onProgress = () => {}, parseChunk, spawnImpl = spawn, killGraceMs = 5000 }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(codeError('CANCELLED', 'cancelled before start')); return; }

    let child;
    try {
      child = spawnImpl(binary, args, { env: { ...process.env, ...env, LD_LIBRARY_PATH: libDir, DYLD_LIBRARY_PATH: libDir } });
    } catch (err) { reject(codeError('SDCLI_SPAWN', err.message)); return; }

    const tail = [];
    const state = { tail: '', lastStep: 0, lastTotalSteps: 0 };
    let aborted = false;
    let killTimer = null;

    const onData = (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n|\r/)) {
        if (line.trim()) { tail.push(line); if (tail.length > 40) tail.shift(); }
      }
      if (parseChunk) for (const ev of parseChunk(text, state)) onProgress({ ...ev, status: 'sampling' });
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);

    const cleanup = () => { clearTimeout(killTimer); if (signal) signal.removeEventListener('abort', abort); };   // eslint-disable-line no-use-before-define
    function abort() {
      aborted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      if (killTimer.unref) killTimer.unref();
    }
    if (signal) signal.addEventListener('abort', abort, { once: true });

    child.on('error', (err) => { cleanup(); reject(codeError('SDCLI_SPAWN', err.message)); });
    child.on('close', (code, sig) => {
      cleanup();
      if (aborted) { reject(codeError('CANCELLED', 'sd-cli was cancelled')); return; }
      if (code !== 0) { reject(codeError('SDCLI_FAILED', `sd-cli exited (${code === null ? sig : code}): ${tail.slice(-20).join('\n')}`)); return; }
      resolve({ output: tail.join('\n') });
    });
  });
}

module.exports = { runSdCli };
