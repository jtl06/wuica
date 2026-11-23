#!/usr/bin/env node
// wuica [options] [FILE | - | HEX]   or   wuica mcp
const args = process.argv.slice(2);
if (args[0] === 'mcp') {
  const { runServer } = await import('../lib/mcp.js');
  await runServer();
} else {
  // a reader that closes the pipe early (wuica ... | head): the rest of the output is dropped quietly, and the exit
  // status stays the result's code
  for (const s of [process.stdout, process.stderr]) s.on('error', (e) => { if (e?.code !== 'EPIPE') throw e; });
  const { main } = await import('../lib/cli.js');
  process.exitCode = await main(args);
}
