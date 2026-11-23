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
  assert.deepEqual(tools.map((t) => t.name).sort(), ['analyze', 'assemble', 'compare_archs', 'list_archs', 'what_if']);
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

test('what_if: every variant against analyses of the library', async () => {
  const { createWuica } = await import('../lib/index.js');
  const w = await createWuica({ threads: 1 });
  const r = await call('what_if', { source: ASM, arch: 'SKL' });
  assert.equal(r.isError, undefined);
  assert.equal(r.json.code, 0);
  assert.equal(r.json.tp, 2);
  assert.deepEqual(r.json.variants.map((v) => v.id), ['unroll2', 'unroll4', 'unroll8', 'simpleFrontEnd', 'noMacroFusion', 'noMicroFusion', 'nochain']);
  // the body (the two adds) n times, then dec r15; jnz once
  const body = '4801d84801c3', tail = '49ffcf75f5';
  for (const n of [2, 4, 8]) {
    const a = await w.analyze('SKL', { hex: body.repeat(n) + tail });
    const v = r.json.variants.find((x) => x.id === `unroll${n}`);
    assert.equal(v.tp, Math.round((a.tp / n) * 100) / 100, `unroll${n}`);
    assert.equal(v.speedup, Math.round((2 / (a.tp / n)) * 100) / 100);
  }
  const s = await w.analyze('SKL', { hex: HEX, options: { simpleFrontEnd: true } });
  assert.equal(r.json.variants.find((x) => x.id === 'simpleFrontEnd').tp, s.tp);
  const nochain = r.json.variants.find((x) => x.id === 'nochain');
  assert.equal(nochain.estimate, true);
  assert.ok(nochain.tp < 2 && nochain.delta < 0);
  // a subset; a block that is not a loop; an unknown variant
  const sub = await call('what_if', { hex: HEX, variants: ['nochain', 'unroll2'] });
  assert.deepEqual(sub.json.variants.map((v) => v.id), ['unroll2', 'nochain']);
  const flat = await call('what_if', { hex: '4801d8', variants: ['unroll2', 'noMacroFusion'] });
  assert.equal(flat.json.variants[0].error, 'not a loop');
  assert.equal(typeof flat.json.variants[1].tp, 'number');
  // hex with 0x prefixes and commas, as the library accepts it: the same variants
  const pre = await call('what_if', { hex: HEX.match(/../g).map((b) => '0x' + b).join(','), arch: 'SKL' });
  assert.deepEqual(pre.json, r.json);
    const bad = await call('what_if', { hex: HEX, variants: ['unroll3'] });
  assert.equal(bad.isError, true);
  await w.close();
});

test('analyze with details: allowed ports, latencies, front end; port set and issue slots', async () => {
  const r = await call('analyze', { hex: '48030649ffcf75f9', format: 'json', details: true });
  assert.equal(r.json.code, 0);
  const add = r.json.instructions[0];
  assert.equal(add.allowedPorts, '1*p0156+1*p23');
  assert.ok(add.latencies.includes('RAX->RAX:1') && add.latencies.includes('[RSI]->RAX:6'), JSON.stringify(add.latencies));
  assert.deepEqual(add.frontEnd, { length: 3, offset: 0 });
  assert.deepEqual(r.json.insights.portSet, { ports: ['Port 6'], uops: 1, cycles: 1, instructions: [{ index: 1, instr: 'dec r15', uops: 1 }] });
  assert.equal(r.json.insights.issueSlots.width, 4);
  const plain = await call('analyze', { hex: '48030649ffcf75f9', format: 'json' });
  assert.equal(plain.json.instructions[0].allowedPorts, undefined);
  assert.equal(plain.json.insights.portSet, undefined);
  assert.deepEqual({ ...plain.json, instructions: null, insights: null }, { ...r.json, instructions: null, insights: null });
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
