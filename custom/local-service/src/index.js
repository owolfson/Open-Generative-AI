'use strict';
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { loadEngines } = require('./engines');
const { syncBundledBinary } = require('./bundle');
const { JobQueue } = require('./queue');
const { createRunner } = require('./runner');
const { createService } = require('./service');
const { createMcp } = require('./mcp');
const { createServer } = require('./server');

const config = loadConfig();
fs.mkdirSync(config.outputsDir, { recursive: true });
const bundle = syncBundledBinary({ resourcesPath: config.resourcesPath, userDataPath: config.dataDir });
console.log(`sd.cpp bundle: ${bundle.synced ? `installed ${bundle.version} (replaced ${bundle.replaced || 'nothing'})` : bundle.reason}`);

const standin = loadEngines({ upstreamDir: config.upstreamDir, userDataPath: config.dataDir, resourcesPath: config.resourcesPath });
const queue = new JobQueue({ run: createRunner({ config, standin }).run });
const service = createService({ standin, queue, config });
const mcp = createMcp({ config, queue, service });
const server = createServer({ config, standin, queue, service, mcp });

server.listen(config.port, '0.0.0.0', () => {
  console.log(`ogai-local listening on :${config.port} (gpuEnabled=${config.gpuEnabled}, arbiter=${config.arbiterUrl ? 'configured' : 'none'}, token=${config.token ? 'set' : 'MISSING'})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}
