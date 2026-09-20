'use strict';
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { loadEngines } = require('./engines');
const { syncBundledBinary } = require('./bundle');
const { JobQueue } = require('./queue');
const { releaseStaleLease } = require('./gate');
const { createRunner } = require('./runner');
const { createService } = require('./service');
const { createMcp } = require('./mcp');
const { createServer } = require('./server');

const config = loadConfig();
fs.mkdirSync(config.outputsDir, { recursive: true });
const bundle = syncBundledBinary({ resourcesPath: config.resourcesPath, userDataPath: config.dataDir });
console.log(`sd.cpp bundle: ${bundle.synced ? `installed ${bundle.version} (replaced ${bundle.replaced || 'nothing'})` : bundle.reason}`);

const standin = loadEngines({ upstreamDir: config.upstreamDir, userDataPath: config.dataDir, resourcesPath: config.resourcesPath });
const runner = createRunner({ config, standin });
const queue = new JobQueue({ run: runner.run });
const service = createService({ standin, queue, config });
const mcp = createMcp({ config, queue, service });
const server = createServer({ config, standin, queue, service, mcp });

// A previous process may have died holding the V100 lease (brain stays evicted until the arbiter expires it): give it back.
releaseStaleLease(config).catch(() => {});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`ogai-local listening on :${config.port} (gpuEnabled=${config.gpuEnabled}, arbiter=${config.arbiterUrl ? 'configured' : 'none'}, token=${config.token ? 'set' : 'MISSING'})`);
});

// Stop the running sd-cli FIRST, then release the lease: releasing while it still runs would let the arbiter restore the brain on top of it.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    setTimeout(() => process.exit(0), 9000).unref();
    server.close();
    try { await queue.drain(8000); await runner.shutdown(); } catch (err) { console.error(`shutdown: ${err.message}`); }
    process.exit(0);
  });
}
