#!/usr/bin/env node
// wuica [options] [FILE | - | HEX]   or   wuica mcp
const args = process.argv.slice(2);
if (args[0] === 'mcp') {
  const { runServer } = await import('../lib/mcp.js');
  await runServer();
} else {
  const { main } = await import('../lib/cli.js');
  process.exitCode = await main(args);
}
