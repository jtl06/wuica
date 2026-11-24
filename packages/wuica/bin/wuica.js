#!/usr/bin/env node
// wuica [options] [FILE | - | HEX]   or   wuica mcp [--help | --version]
const args = process.argv.slice(2);
if (args[0] === 'mcp') {
  const rest = args.slice(1);
  if (rest.some((a) => /^(?:-h|-help|--help)$/i.test(a))) {
    const { MCP_USAGE } = await import('../lib/cli.js');
    process.stdout.write(MCP_USAGE);
  } else if (rest.some((a) => /^(?:-v|-V|-version|--version)$/i.test(a))) {
    const { VERSION } = await import('../lib/cli.js');
    process.stdout.write(`wuica-mcp ${VERSION}\n`);
  } else if (rest.length) {
    process.stderr.write(`wuica mcp: unknown argument ${rest[0]} (--help for usage)\n`);
    process.exitCode = 1;
  } else {
    const { runServer } = await import('../lib/mcp.js');
    await runServer();
  }
} else {
  // a reader that closes the pipe early (wuica ... | head): the rest of the output is dropped quietly, and the exit
  // status stays the result's code
  for (const s of [process.stdout, process.stderr]) s.on('error', (e) => { if (e?.code !== 'EPIPE') throw e; });
  const { main } = await import('../lib/cli.js');
  process.exitCode = await main(args);
}
