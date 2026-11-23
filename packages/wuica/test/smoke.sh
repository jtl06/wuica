#!/usr/bin/env bash
# Packs the package, installs the tarball into a temporary directory and runs the CLI and the MCP server from there.
# Run after ./build.sh. Usage: test/smoke.sh
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
(cd "$PKG" && npm pack --silent --pack-destination "$TMP" > /dev/null)
cd "$TMP"
npm init -y > /dev/null
npm install --silent ./wuica-*.tgz
printf 'top:\n add rax, rbx\n add rbx, rax\n dec r15\n jnz top\n' > block.s
npx --no-install wuica block.s -arch SKL | head -1 | grep -q 'Throughput (in cycles per iteration): 2.00'
[ "$(npx --no-install wuica block.s -arch all -TPonly | wc -l | tr -d ' ')" = 15 ]
[ "$(echo 4801d8 | npx --no-install wuica -hex -arch ZEN3 -TPonly)" = 1.00 ]
cat > mcp.mjs <<'JS'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: 'npx', args: ['--no-install', 'wuica', 'mcp'] }));
const tools = (await c.listTools()).tools.map((t) => t.name).sort().join(',');
if (tools !== 'analyze,assemble,compare_archs,list_archs') throw new Error(tools);
const r = await c.callTool({ name: 'analyze', arguments: { source: 'add rax, rbx', arch: 'ICL', format: 'json' } });
if (JSON.parse(r.content[0].text).tp !== 1) throw new Error(r.content[0].text);
await c.close();
JS
node mcp.mjs
echo "smoke test passed ($(du -sh node_modules/wuica | cut -f1) installed)"
