#!/usr/bin/env node
// Starts the wuica API server. Settings: environment variables WUICA_* (lib/config.js), e.g.
//   WUICA_PORT=8787 WUICA_WORKERS=2 node bin/wuica-server.js

import { createApp } from '../lib/app.js';
import { fromEnv } from '../lib/config.js';

const app = await createApp(fromEnv());
const addr = await app.listen();
const c = app.config;
process.stdout.write(JSON.stringify({
  time: new Date().toISOString(), event: 'listening', address: `${addr.address}:${addr.port}`, workers: c.workers,
  maxQueue: c.maxQueue, timeoutMs: c.timeoutMs, rate: c.rateBurst ? `${c.ratePerMinute}/min, burst ${c.rateBurst}` : 'off',
}) + '\n');

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event: 'shutdown', signal: sig }) + '\n');
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  });
}
