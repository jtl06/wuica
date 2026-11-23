import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX = '4801d84801c349ffcf75f5';
const ASM = 'top:\n  add rax, rbx\n  add rbx, rax\n  dec r15\n  jnz top\n';

let client;
before(async () => {
  client = new Client({ name: 'wuica-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(DIR, 'bin/wuica.js'), 'mcp'], stderr: 'pipe' }));
});
after(async () => { await client?.close(); });

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  let json = null;
  try { json = JSON.parse(r.content[0].text); } catch { /* text */ }
  return { ...r, json };
};

test('initialize: server info and instructions', () => {
  assert.equal(client.getServerVersion().name, 'wuica');
  assert.match(client.getInstructions(), /cycles per iteration/);
});

test('tools/list', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['analyze', 'assemble', 'compare_archs', 'list_archs']);
  const analyze = tools.find((t) => t.name === 'analyze');
  assert.match(analyze.description, /cycles per iteration/);
  assert.match(analyze.description, /L1/);
  assert.match(analyze.description, /prototype/);
  assert.ok(analyze.inputSchema.properties.options.properties.minIterations);
  for (const k of ['source', 'hex', 'arch', 'syntax', 'options', 'format']) assert.ok(analyze.inputSchema.properties[k], k);
});

test('analyze (source, SKL)', async () => {
  const r = await call('analyze', { source: ASM, arch: 'SKL' });
  assert.equal(r.isError, undefined);
  assert.equal(r.json.code, 0);
  assert.equal(r.json.tp, 2);
  assert.equal(r.json.arch, 'SKL');
  assert.equal(r.json.name, 'Skylake');
  assert.equal(r.json.year, 2015);
  assert.equal(r.json.mode, 'loop');
  assert.deepEqual(r.json.bottlenecks, ['Dependencies']);
  assert.ok(r.json.limits.some((l) => l.name === 'Dependencies' && l.tp === 2));
  assert.equal(r.json.hex, HEX);
  assert.equal(r.json.instructions.length, 4);
  assert.equal(r.json.instructions[0].instr, 'add rax, rbx');
  assert.equal(r.json.instructions[0].bytes, '4801d8');
  assert.ok(r.json.instructions[0].ports['Port 0'] > 0);
  assert.equal(r.json.instructions[3].notes, 'M');
  assert.match(r.content[1].text, /^Throughput \(in cycles per iteration\): 2\.00/);
});

test('analyze formats and options', async () => {
  const t = await call('analyze', { hex: HEX, format: 'text' });
  assert.equal(t.content.length, 1);
  assert.match(t.content[0].text, /^Throughput/);
  const o = await call('analyze', { hex: HEX, format: 'json', options: { noMacroFusion: true } });
  assert.equal(o.json.instructions[3].notes, undefined);
  const r = await call('analyze', { hex: HEX, arch: 'zen3', format: 'json' });
  assert.equal(r.json.arch, 'ZEN3');
  assert.equal(r.json.prototype, true);
  assert.equal(r.content.length, 1);
  assert.ok('ALU0' in r.json.instructions[0].ports);
});

test('analyze errors are tool errors', async () => {
  const r = await call('analyze', { source: 'frobnicate rax', arch: 'SKL' });
  assert.equal(r.isError, true);
  assert.equal(r.json.code, 2);
  assert.match(r.json.error, /invalid instruction mnemonic/);
  assert.deepEqual(r.json.stderr[0].tag, { line: 1, column: 1, severity: 'error', text: "invalid instruction mnemonic 'frobnicate'" });
  const u = await call('analyze', { hex: HEX, arch: 'K8' });
  assert.equal(u.isError, true);
  assert.equal(u.json.code, 1);
  assert.match(u.json.error, /unknown microarchitecture/);
  const v = await call('analyze', { hex: HEX, options: { minIterations: 'many' } });
  assert.equal(v.isError, true);
  const x = await call('analyze', { hex: HEX, options: { minIteration: 5 } });
  assert.equal(x.isError, true);
  const y = await call('analyze', { hex: HEX, minIterations: 50 }); // not silently dropped
  assert.equal(y.isError, true);
  assert.match(y.content[0].text, /minIterations/);
});

test('compare_archs', async () => {
  const all = await call('compare_archs', { hex: HEX });
  assert.equal(all.json.results.length, 15);
  assert.equal(all.json.code, 0);
  assert.ok(all.json.results.every((r) => r.tp === 2 && r.code === 0));
  const some = await call('compare_archs', { source: ASM, archs: ['SKL', 'ADL-P'] });
  assert.deepEqual(some.json.results.map((r) => [r.arch, r.prototype]), [['SKL', false], ['ADL-P', true]]);
  assert.equal(some.json.hex, HEX);
});

test('list_archs', async () => {
  const r = await call('list_archs', {});
  assert.equal(r.json.length, 15);
  assert.deepEqual(r.json.find((a) => a.id === 'ICX'), { id: 'ICX', name: 'Ice Lake server', year: 2021, prototype: true });
  const f = await call('list_archs', { fields: ['id', 'xedChip'] });
  assert.deepEqual(f.json[0], { id: 'SNB', xedChip: 'SANDYBRIDGE' });
});

test('assemble', async () => {
  const r = await call('assemble', { source: 'addq %rbx, %rax', syntax: 'att' });
  assert.deepEqual(r.json, { code: 0, hex: '4801d8', length: 3, stderr: [] });
  const e = await call('assemble', { source: 'nop\nmov rax,' });
  assert.equal(e.isError, true);
  assert.equal(e.json.code, 2);
  assert.equal(e.json.stderr[0].tag.line, 2);
});
