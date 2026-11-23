import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/wuica.js');
const HEX = '4801d84801c349ffcf75f5';
const ASM = 'top:\n  add rax, rbx\n  add rbx, rax\n  dec r15\n  jnz top\n';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-cli-'));
const asmFile = path.join(tmp, 'block.s');
fs.writeFileSync(asmFile, ASM);
const hexFile = path.join(tmp, 'block.hex');
fs.writeFileSync(hexFile, '48 01 d8 48 01 c3\n49 ff cf 75 f5\n');
const rawFile = path.join(tmp, 'block.bin');
fs.writeFileSync(rawFile, Buffer.from(HEX, 'hex'));

function run(args, input) {
  const r = spawnSync(process.execPath, [BIN, ...args], { input: input ?? '', encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const reference = run([HEX, '-arch', 'SKL']);

test('hex argument prints the report', () => {
  assert.equal(reference.code, 0);
  assert.match(reference.out, /^Throughput \(in cycles per iteration\): 2\.00\nBottleneck: Dependencies\n/);
  assert.match(reference.out, /│ Total\n└/);
});

test('assembly file, stdin, -, hex file, raw file give the same report', () => {
  for (const [args, input] of [[[asmFile]], [[], ASM], [['-'], ASM], [['-hex', hexFile]], [['-hex'], '0x48,0x01,0xd8,0x48,0x01,0xc3,0x49,0xff,0xcf,0x75,0xf5'], [['-raw', rawFile]]]) {
    const r = run([...args, '-arch', 'SKL'], input);
    assert.equal(r.code, 0, `${args}: ${r.err}`);
    assert.equal(r.out, reference.out, String(args));
  }
});

test('-att', () => {
  const r = run(['-att', '-TPonly'], 'top: addq %rbx, %rax\naddq %rax, %rbx\ndecq %r15\njnz top\n');
  assert.equal(r.code, 0);
  assert.equal(r.out, '2.00\n');
});

test('-TPonly and -json', () => {
  assert.equal(run([HEX, '-TPonly', '-arch', 'ZEN3']).out, '2.00\n');
  const j = JSON.parse(run([asmFile, '-json', '-arch', 'ADL-P']).out);
  assert.equal(j.code, 0);
  assert.equal(j.arch, 'ADL-P');
  assert.equal(j.hex, HEX);
  assert.equal(typeof j.tp, 'number');
  assert.equal(j.trace, null);
  const t = JSON.parse(run([HEX, '-json', '-trace']).out);
  assert.ok(Array.isArray(t.trace.cycles));
});

test('simulation options', () => {
  const r = JSON.parse(run([HEX, '-json', '-noMacroFusion', '-alignmentOffset', '5', '-minIterations', '20', '-minCycles', '600', '-initPolicy', 'same', '-simpleFrontEnd', '-noMicroFusion']).out);
  assert.equal(r.rows[3].notes, '');
  assert.equal(run([HEX, '-minCycles', 'x']).code, 1);
});

test('-arch all prints a table', () => {
  const r = run([asmFile, '-arch', 'all']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.match(lines[0], /^Arch\s+Model\s+Year\s+TP\s+Bottlenecks$/);
  assert.match(r.out, /\nSKL\s+Skylake\s+2015\s+2\.00\s+Dependencies\n/);
  assert.match(r.out, /\nZEN3\s+AMD Zen 3\s+2020\s+2\.00\s+Dependencies\s+\[prototype\]\n/);
  assert.equal(lines.filter((l) => /\d\.\d\d/.test(l)).length, 15);
  const tp = run([HEX, '-arch', 'all', '-TPonly']);
  assert.equal(tp.out.trim().split('\n').length, 15);
  const j = JSON.parse(run([HEX, '-arch', 'all', '-json']).out);
  assert.equal(j.code, 0);
  assert.equal(j.results.length, 15);
});

test('-list and -arch list', () => {
  const r = run(['-list']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^SNB\s+Sandy Bridge \(2011\)\n/);
  assert.match(r.out, /\nADL-P\s+Alder Lake P-core \(2021\)\s+\[prototype\]\n$/);
  assert.equal(run(['-arch', 'list']).out, r.out);
  const j = JSON.parse(run(['-list', '-json']).out);
  assert.equal(j.length, 15);
  assert.equal(j[0].id, 'SNB');
});

test('errors: exit code = result code, message on stderr', () => {
  for (const [args, input, re, code] of [
    [[HEX, '-arch', 'K8'], '', /unknown microarchitecture: K8/, 1],
    [['-bogus'], '', /unknown option -bogus/, 1],
    [['/no/such/file.s'], '', /no such file/, 1],
    [[], 'nop\nfrobnicate rax\n', /^<input>:2:1: error: invalid instruction mnemonic 'frobnicate'\nfrobnicate rax\n\^~+\n$/, 2],
    [['-hex'], 'zz', /hex/, 1],
    [['-arch'], '', /-arch needs a value/, 1],
    [['-arch', 'all'], 'frob', /invalid instruction mnemonic/, 2],
    [[HEX, '-initPolicy', 'bad'], '', /option initPolicy: "bad" is not one of/, 1],
  ]) {
    const r = run(args, input);
    assert.equal(r.code, code, String(args));
    assert.equal(r.out, '');
    assert.match(r.err, re);
  }
});

test('-json on failure prints the error object', () => {
  const r = run(['-json'], 'frob\n');
  assert.equal(r.code, 2);
  const j = JSON.parse(r.out);
  assert.equal(j.code, 2);
  assert.equal(j.stderr[0].tag.line, 1);
});

test('-h', () => {
  const r = run(['-h']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: wuica/);
});
