// The README's agent setup (## MCP server): every JSON and TOML snippet parses and starts the server with the published
// command, `npx -y wuica-cli mcp`, which runs bin/wuica.js with `mcp` (the package's bin wuica-cli) -- checked here
// with a handshake. The one-line `mcp add` commands use the same command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
const section = readme.slice(readme.indexOf('## MCP server'), readme.indexOf('## API contract'));
const COMMAND = ['npx', '-y', 'wuica-cli', 'mcp'];

// fenced blocks (indented ones in lists too): [{lang, text}]
const blocks = [...section.matchAll(/^( *)```(\w*)\n([\s\S]*?)^\1```$/gm)].map((m) => ({ lang: m[2], text: m[3].split('\n').map((l) => l.slice(m[1].length)).join('\n') }));

// the TOML the snippets use: [table.path] headers and key = JSON-like value lines
function tinyToml(text) {
  const out = {};
  let at = out;
  for (const line of text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
    const h = /^\[([\w.-]+)\]$/.exec(line);
    if (h) { at = h[1].split('.').reduce((o, k) => (o[k] ??= {}), out); continue; }
    const kv = /^([\w-]+)\s*=\s*(.+)$/.exec(line);
    assert.ok(kv, `TOML line: ${line}`);
    at[kv[1]] = JSON.parse(kv[2]);
  }
  return out;
}

// every server entry in a parsed config: its command as one array
function commands(v, out = []) {
  if (Array.isArray(v) || v === null || typeof v !== 'object') return out;
  if (typeof v.command === 'string') out.push([v.command, ...(v.args ?? [])]);
  else if (Array.isArray(v.command)) out.push(v.command);
  else for (const x of Object.values(v)) commands(x, out);
  return out;
}

test('the README\'s agent snippets parse and use `npx -y wuica-cli mcp`', () => {
  const configs = blocks.filter((b) => b.lang === 'json' || b.lang === 'toml');
  assert.ok(configs.length >= 6, `${configs.length} JSON/TOML snippets`);
  for (const b of configs) {
    const v = b.lang === 'json' ? JSON.parse(b.text) : tinyToml(b.text);
    const cmds = commands(v);
    assert.equal(cmds.length, 1, b.text);
    assert.deepEqual(cmds[0], COMMAND, b.text);
  }
  const adds = blocks.filter((b) => b.lang === 'sh').flatMap((b) => b.text.trim().split('\n'));
  assert.ok(adds.length >= 4);
  for (const l of adds) assert.match(l, /^\w+ mcp add wuica -- npx -y wuica-cli mcp$/);
  assert.ok(/args: \["-y", "wuica-cli", "mcp"\]/.test(blocks.find((b) => b.lang === 'yaml').text), 'goose');
});

test('`wuica-cli mcp` is the package\'s bin wuica-cli with mcp: it answers initialize', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'wuica-cli');
  const bin = pkg.bin['wuica-cli'];
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  const r = spawnSync(process.execPath, [path.join(DIR, bin), 'mcp'], { input: init + '\n', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout.split('\n')[0]).result.serverInfo.name, 'wuica');
});
