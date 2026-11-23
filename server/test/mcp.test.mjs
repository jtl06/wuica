// The remote MCP endpoint through the SDK's client over Streamable HTTP: the same tools and results as the package's
// stdio server (the same createServer(w), run in-process here over an in-memory transport).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWuica } from 'wuica';
import { createServer } from 'wuica/mcp';
import { start, post, get, HEX, ASM } from './helpers.mjs';

let s, remote, local;
before(async () => {
  s = await start();
  remote = new Client({ name: 'wuica-server-test', version: '0' });
  await remote.connect(new StreamableHTTPClientTransport(new URL(s.base + '/mcp')));
  // the package's MCP server on the library, for the expected results
  const w = await createWuica();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(w).connect(a);
  local = new Client({ name: 'local', version: '0' });
  await local.connect(b);
});
after(async () => { await remote.close(); await local.close(); await s.close(); });

test('initialize: server info and instructions', () => {
  assert.equal(remote.getServerVersion().name, 'wuica');
  assert.match(remote.getInstructions(), /throughput of x86-64 basic blocks/);
  assert.deepEqual(remote.getServerVersion(), local.getServerVersion());
});

test('tools/list: the four tools of the stdio server, same schemas', async () => {
  const r = await remote.listTools();
  assert.deepEqual(r.tools.map((t) => t.name).sort(), ['analyze', 'assemble', 'compare_archs', 'list_archs']);
  assert.deepEqual(r, JSON.parse(JSON.stringify(await local.listTools()))); // the in-memory transport keeps `_meta: undefined`
});

const calls = [
  ['list_archs', {}],
  ['list_archs', { fields: ['id', 'xedChip'] }],
  ['analyze', { arch: 'SKL', hex: HEX }],
  ['analyze', { arch: 'ZEN3', source: ASM, format: 'json' }],
  ['analyze', { arch: 'ADL-P', source: 'addq %rbx, %rax', syntax: 'att', format: 'text', options: { noMacroFusion: true } }],
  ['analyze', { arch: 'K8', hex: HEX }],
  ['analyze', { source: 'frobnicate rax' }],
  ['compare_archs', { hex: HEX }],
  ['compare_archs', { source: ASM, archs: ['SKL', 'ICL', 'ZEN3'] }],
  ['assemble', { source: 'vaddps zmm0, zmm1, zmm2' }],
  ['assemble', { source: 'mov rax, [' }],
];

for (const [name, args] of calls) {
  test(`tools/call ${name} ${JSON.stringify(args).slice(0, 60)}: same result as the stdio server`, async () => {
    const r = await remote.callTool({ name, arguments: args });
    assert.deepEqual(r, await local.callTool({ name, arguments: args }));
    if (name === 'analyze' && args.arch === 'K8') assert.equal(r.isError, true);
    if (name === 'analyze' && args.arch === 'SKL') {
      const summary = JSON.parse(r.content[0].text);
      assert.equal(summary.code, 0);
      assert.equal(typeof summary.tp, 'number');
      assert.match(r.content[1].text, /^Throughput \(in cycles per iteration\)/);
    }
  });
}

test('invalid arguments are rejected by the tool schema', async () => {
  const r = await remote.callTool({ name: 'analyze', arguments: { hex: HEX, bogus: 1 } });
  assert.equal(r.isError, true);
});

test('stateless transport: GET and DELETE are 405; no session id; CORS', async () => {
  assert.equal((await get(s.base, '/mcp', { Accept: 'text/event-stream' })).status, 405);
  assert.equal((await fetch(s.base + '/mcp', { method: 'DELETE' })).status, 405);
  const r = await post(s.base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Accept: 'application/json, text/event-stream', Origin: 'https://example.org' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('mcp-session-id'), null);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.json.result.tools.length, 4);
  const pre = await fetch(s.base + '/mcp', { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /Mcp-Protocol-Version/);
});
