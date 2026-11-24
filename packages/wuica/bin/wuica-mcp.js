#!/usr/bin/env node
// The wuica MCP server on stdio (same as `wuica mcp`). --help, --version: print and exit.
const args = process.argv.slice(2);
if (args.some((a) => /^(?:-h|-help|--help)$/i.test(a))) {
  const { MCP_USAGE } = await import('../lib/cli.js');
  process.stdout.write(MCP_USAGE);
} else if (args.some((a) => /^(?:-v|-V|-version|--version)$/i.test(a))) {
  const { VERSION } = await import('../lib/cli.js');
  process.stdout.write(`wuica-mcp ${VERSION}\n`);
} else if (args.length) {
  process.stderr.write(`wuica-mcp: unknown argument ${args[0]} (--help for usage)\n`);
  process.exitCode = 1;
} else {
  const { runServer } = await import('../lib/mcp.js');
  await runServer();
}
