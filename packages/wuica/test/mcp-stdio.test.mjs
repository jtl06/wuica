// The hand-written stdio MCP server (lib/mcp.js, no dependencies): through the SDK's real client (a devDependency), and
// raw lines for what a client library hides (parse errors, notifications, batches, version negotiation, EOF).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validate, PROTOCOL_VERSIONS } from '../lib/mcp.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(DIR, 'bin/wuica-mcp.js');

let client;
before(async () => {
  client = new Client({ name: 'wuica-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], stderr: 'pipe' }));
});
after(async () => { await client?.close(); });

test('the SDK client: initialize, ping, tools/list, every tool, errors', async () => {
  assert.deepEqual(client.getServerVersion().name, 'wuica');
  assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: true } });
  assert.deepEqual(await client.ping(), {});
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['list_archs', 'analyze', 'what_if', 'diff_blocks', 'compare_archs', 'list_loops', 'assemble']);
  for (const [name, args] of [['list_archs', {}], ['analyze', { hex: '4801d84801c349ffcf75f5', format: 'json' }], ['what_if', { hex: '4801d84801c349ffcf75f5', variants: ['unroll2'] }],
    ['compare_archs', { hex: '4801d84801c349ffcf75f5', archs: ['SKL'] }], ['assemble', { source: 'add rax, rbx' }]]) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, undefined, name);
    assert.ok(JSON.parse(r.content[0].text), name);
  }
  // invalid arguments: a tool error the model can act on
  const bad = await client.callTool({ name: 'analyze', arguments: { hex: '4801d8', bogus: 1 } });
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].text, 'Invalid arguments for tool analyze: arguments: unknown key "bogus" (known: arch, source, hex, syntax, loop, func, options, format, details)');
  // the option ranges are the library's (README, "Option ranges per interface"): any integer, not a fraction
  const range = await client.callTool({ name: 'analyze', arguments: { hex: '4801d8', options: { alignmentOffset: 1.5 } } });
  assert.equal(range.content[0].text, 'Invalid arguments for tool analyze: options.alignmentOffset: expected an integer, got 1.5');
  const far = await client.callTool({ name: 'analyze', arguments: { hex: '4801d8', format: 'json', options: { alignmentOffset: 64 } } });
  assert.equal(JSON.parse(far.content[0].text).tp, 1);
  const miss = await client.callTool({ name: 'assemble', arguments: {} });
  assert.equal(miss.content[0].text, 'Invalid arguments for tool assemble: source: required');
  // an unknown tool and an unknown method: protocol errors
  await assert.rejects(client.callTool({ name: 'frob', arguments: {} }), (e) => e.code === -32602 && /Unknown tool: frob/.test(e.message));
  await assert.rejects(client.request({ method: 'resources/list', params: {} }, (await import('@modelcontextprotocol/sdk/types.js')).ListResourcesResultSchema), (e) => e.code === -32601);
});

// raw lines: the replies (parsed) to the lines written, then stdin closes; resolves {replies, stdout, code}
function rawSession(lines) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, stdout: out, replies: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
    for (const l of lines) p.stdin.write(l + '\n');
    p.stdin.end();
  });
}

test('raw lines: version negotiation, parse errors, notifications, batches, EOF', async () => {
  const init = (v, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  const s = await rawSession([
    init('1999-01-01'),
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc": "2.0", "id": 2, "method": ',
    '{"jsonrpc":"2.0","id":3,"method":"ping"}',
    '{"id":4,"method":"ping"}',
    '[{"jsonrpc":"2.0","id":5,"method":"ping"}]',
    '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_archs","arguments":[]}}',
    '{"jsonrpc":"2.0","id":7,"method":"nope"}',
  ]);
  assert.equal(s.code, 0); // the end of stdin ends the server
  const byId = new Map(s.replies.map((r) => [r.id, r]));
  assert.equal(byId.get(1).result.protocolVersion, PROTOCOL_VERSIONS[0]); // an unknown version: the latest
  assert.deepEqual(byId.get(1).result.capabilities, { tools: { listChanged: true } });
  assert.equal(byId.get(1).result.serverInfo.name, 'wuica');
  assert.deepEqual(byId.get(3).result, {});
  assert.equal(byId.get(6).error.code, -32602);
  assert.equal(byId.get(7).error.code, -32601);
  const nulls = s.replies.filter((r) => r.id === null).map((r) => r.error.code);
  assert.deepEqual(nulls, [-32700, -32600]); // a parse error; a batch under the negotiated 2025-11-25
  assert.equal(byId.get(4).error.code, -32600); // no "jsonrpc": an invalid request
  assert.equal(s.replies.length, 7); // nothing for the notification
  assert.ok(s.stdout.split('\n').filter(Boolean).every((l) => JSON.parse(l).jsonrpc === '2.0'), 'only protocol messages on stdout');

  // 2025-03-26: the client's version back, and batches
  const b = await rawSession([init('2025-03-26'), '[{"jsonrpc":"2.0","id":2,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":3,"method":"tools/list"}]']);
  assert.equal(b.replies[0].result.protocolVersion, '2025-03-26');
  assert.ok(Array.isArray(b.replies[1]) && b.replies[1].length === 2 && b.replies[1][1].result.tools.length === 7);
  for (const v of ['2024-11-05', '2025-06-18', '2025-11-25']) assert.equal((await rawSession([init(v)])).replies[0].result.protocolVersion, v);
});

test('the validator: the keywords of the schemas', () => {
  const s = { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 9 }, e: { type: 'string', enum: ['a', 'b'] }, l: { type: 'array', items: { type: 'string', minLength: 1 } },
    u: { anyOf: [{ type: 'string', enum: ['auto'] }, { type: 'integer', minimum: 0 }] }, b: { type: 'boolean' } }, required: ['n'], additionalProperties: false };
  assert.equal(validate(s, { n: 3, e: 'a', l: ['x'], u: 2, b: true }), null);
  assert.equal(validate(s, {}), 'n: required');
  assert.equal(validate(s, { n: 1.5 }), 'n: expected an integer, got 1.5');
  assert.equal(validate(s, { n: 0 }), 'n: expected at least 1, got 0');
  assert.equal(validate(s, { n: 1, e: 'c' }), 'e: expected one of "a", "b", got "c"');
  assert.equal(validate(s, { n: 1, l: ['x', ''] }), 'l[1]: expected at least 1 character');
  assert.equal(validate(s, { n: 1, u: -1 }), 'u: expected "auto", or an integer >= 0, got -1');
  assert.equal(validate(s, { n: 1, b: 'yes' }), 'b: expected true or false, got "yes"');
  assert.equal(validate(s, [1]), 'arguments: expected an object, got an array');
});
