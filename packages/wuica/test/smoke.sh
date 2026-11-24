#!/usr/bin/env bash
# Packs the package, installs the tarball into an empty directory and runs what a user runs from there: the CLI (one
# CPU, several CPUs, a batch of files, -md, -whatif) and the MCP server (wuica-mcp: the handshake, tools/list, one
# analyze and one what_if). Run after ./build.sh; CI runs it on the oldest Node that package.json's engines allows.
# Usage: test/smoke.sh
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "smoke: $*" >&2; exit 1; }
echo "node $(node -v)"
(cd "$PKG" && npm pack --silent --pack-destination "$TMP" > /dev/null)
cd "$TMP"
npm init -y > /dev/null
npm install --silent --no-audit --no-fund ./wuica-cli-*.tgz
BIN="$TMP/node_modules/.bin"
printf 'top:\n add rax, rbx\n add rbx, rax\n dec r15\n jnz top\n' > block.s
"$BIN/wuica" -example saxpy -show > saxpy.s

"$BIN/wuica" block.s -arch SKL | head -1 | grep -q 'Throughput (in cycles per iteration): 2.00' || fail 'one CPU'
[ "$(echo 4801d8 | "$BIN/wuica" -hex -arch ZEN3 -TPonly)" = 1.00 ] || fail 'hex from stdin'
out="$("$BIN/wuica" -example saxpy -arch SKL,ZEN3)"
echo "$out" | grep -Eq '^SKL +Skylake +2015 +1\.50 ' || fail "several CPUs: $out"
echo "$out" | grep -Eq '^ZEN3 ' || fail "several CPUs: $out"
[ "$("$BIN/wuica" block.s saxpy.s -arch SKL,ZEN3 -TPonly | wc -l | tr -d ' ')" = 4 ] || fail 'a batch of files'
"$BIN/wuica" block.s saxpy.s | grep -Eq '^saxpy\.s +' || fail 'a batch table'
md="$("$BIN/wuica" -example saxpy -arch SKL,ZEN3,ADL-P -md)"
echo "$md" | grep -Fq '| SKL   | Skylake           | 2015 | 1.50 |' || fail "-md: $md"
"$BIN/wuica" -example dot1 -whatif -md | grep -Fq '| 4 accumulators   |   4.00 |' || fail '-whatif -md'
"$BIN/wuica" -example chain -md -json > /dev/null 2>&1 && fail '-md -json is a usage error'

# the MCP server over stdio, with the SDK the package has as a development dependency
cat > "$PKG/.smoke-mcp.mjs" <<'JS'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: process.argv[2], args: [] }));
const tools = (await c.listTools()).tools.map((t) => t.name).sort().join(',');
if (tools !== 'analyze,assemble,compare_archs,diff_blocks,list_archs,list_loops,what_if') throw new Error(`tools: ${tools}`);
const r = await c.callTool({ name: 'analyze', arguments: { source: 'add rax, rbx', arch: 'ICL', format: 'json' } });
if (JSON.parse(r.content[0].text).tp !== 1) throw new Error(r.content[0].text);
const w = await c.callTool({ name: 'what_if', arguments: { source: 'loop:\n vaddps ymm0, ymm0, ymm1\n dec rcx\n jnz loop\n', arch: 'SKL' } });
if (w.isError || !/accumulators/.test(w.content[0].text)) throw new Error(w.content[0].text);
await c.close();
JS
trap 'rm -rf "$TMP" "$PKG/.smoke-mcp.mjs"' EXIT
node "$PKG/.smoke-mcp.mjs" "$BIN/wuica-mcp" || fail 'wuica-mcp'
echo "smoke test passed on node $(node -v) ($(du -sh node_modules/wuica-cli | cut -f1) installed)"
