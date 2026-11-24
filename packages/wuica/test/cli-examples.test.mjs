// The built-in examples (the page's set, lib/web/examples.js) in the CLI and the library, and what a bare run on a
// terminal prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, bareTerminalRun, SHORT_USAGE, main } from '../lib/cli.js';
import { createWuica, examples, findExample } from '../lib/index.js';
import { EXAMPLES, CLASSIC_EXAMPLES, SHOWCASE_EXAMPLES, MOCK_EXAMPLES } from '../lib/web/examples.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../bin/wuica.js');
const run = (args, input = '') => {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const ARCHS = ['SKL', 'ZEN3', 'ADL-P'];

test('examples(): the page\'s basics, classic loops and showcase; not the mock entries', () => {
  const names = examples().map((e) => e.name);
  assert.deepEqual(names, [...EXAMPLES, ...CLASSIC_EXAMPLES, ...SHOWCASE_EXAMPLES].map((e) => e.id));
  assert.ok(MOCK_EXAMPLES.every((m) => !names.includes(m.id)));
  assert.equal(findExample('SaXpY').name, 'saxpy');
  assert.equal(findExample('nope'), null);
  assert.equal(findExample('sha256').instructions, 2949);
  assert.equal(findExample('sha256').intel, undefined);
});

test('every example analyzes on SKL, ZEN3 and ADL-P with the throughput of its machine code (as the page analyzes it)', async () => {
  const w = await createWuica();
  for (const e of examples()) {
    const c = JSON.parse(run(['-example', e.name, '-arch', ARCHS.join(','), '-json']).out);
    assert.equal(c.code, 0, e.name);
    for (const [k, arch] of ARCHS.entries()) {
      const page = await w.analyze(arch, { hex: e.hex });
      assert.equal(c.results[k].tp, page.tp, `${e.name} on ${arch}`);
    }
    if (e.att) assert.equal(JSON.parse(run(['-example', e.name, '-att', '-TPonly', '-json']).out).tp, c.results[0].tp, `${e.name}: its AT&T text`);
  }
  assert.equal((await w.analyze('SKL', { hex: findExample('sha256').hex })).tp, 744.25); // tests-js/web_modules.mjs
  await w.close();
});

test('-examples lists them; -example says which on stderr; -show round-trips; unknown names list the known', () => {
  const l = run(['-examples']);
  assert.equal(l.code, 0);
  assert.match(l.out, /^saxpy +saxpy \(AVX2 FMA\) +6 instructions$/m);
  assert.match(l.out, /^sha256 +SHA-256 block \(2,949 instr\) +2949 instructions$/m);
  assert.equal(JSON.parse(run(['-examples', '-json']).out).length, examples().length);
  const r = run(['-example', 'Dot1', '-TPonly']);
  assert.equal(r.out, '16.00\n');
  assert.match(r.err, /^example dot1: dot product, 1 accumulator, Intel syntax \(-example dot1 -show prints it\)$/m);
  for (const name of ['dot1', 'gemm', 'strlen']) {
    const shown = run(['-example', name, '-show']);
    assert.equal(shown.out, findExample(name).intel);
    assert.equal(run(['-', '-TPonly'], shown.out).out, run(['-example', name, '-TPonly']).out, name);
    assert.equal(run(['-', '-TPonly'], run(['-example', name, '-show', '-att']).out).out, run(['-example', name, '-TPonly']).out, `${name} (AT&T)`);
  }
  const sha = run(['-example', 'sha256', '-show']);
  assert.equal(run(['-hex', '-', '-TPonly'], sha.out).out, '744.25\n');
  assert.match(run(['-example', 'dot1', '-whatif']).out, /^What if \(SKL\)/m);
  assert.match(run(['-example', 'dot1', '-loops']).out, /^ {2}0 {2}loop /m);
  const bad = run(['-example', 'nope']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^wuica: unknown example: nope \(known: chain, loadstore, avx, stack, saxpy, dot1, dot4, popcnt, ptrchase, strlen, crc32, memcpy, gemm, sha256\)$/m);
  assert.equal(run(['-show']).code, 1);
  assert.equal(run(['-example', 'dot1', 'x.s']).code, 1);
});

test('a bare run on a terminal: the short usage, exit 1; piped stdin is read as before', async () => {
  const t = (args, tty) => bareTerminalRun(parseArgs(args), tty);
  assert.equal(t([], true), true);
  assert.equal(t(['-arch', 'ZEN3'], true), true);
  assert.equal(t([], false), false);
  assert.equal(t(['x.s'], true), false);
  assert.equal(t(['-example', 'saxpy'], true), false);
  assert.equal(t(['-examples'], true), false);
  assert.equal(t(['-raw', 'f.bin'], true), false);
  // main with a terminal on stdin (an object that says so; nothing is read from it)
  let out = '', err = '';
  const io = { stdin: { isTTY: true, [Symbol.asyncIterator]() { throw new Error('read'); } }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } };
  assert.equal(await main([], io), 1);
  assert.equal(out, '');
  assert.equal(err, SHORT_USAGE);
  assert.ok(SHORT_USAGE.trimEnd().split('\n').length <= 4 && SHORT_USAGE.trimEnd().endsWith('Try: wuica -example saxpy -arch SKL,ZEN3,ADL-P'));
  // piped and empty: unchanged
  const p = run([]);
  assert.equal(p.code, 1);
  assert.match(p.err, /no instructions/);
  assert.match(run(['-h']).out.split('\n').slice(0, 9).join('\n'), /-examples lists them, -example saxpy analyzes one/);
});
