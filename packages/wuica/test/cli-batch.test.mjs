// Several inputs in one run (wuica a.s b.s ..., -files LIST): the table, -TPonly lines, -json with an entry per file
// that is what a single run prints, the worst status as the exit status; the library's analyzeMany / compareMany equal
// analyze / compare, on the threads too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWuica } from '../lib/index.js';
import { tmpDir } from './tmpdir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../bin/wuica.js');
const FX = path.resolve(HERE, '../../../tests-js/fixtures/cli');
const run = (args, input = '') => {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8', cwd: FX });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const json = (args, input) => { const r = run([...args, '-json'], input); return { code: r.code, doc: JSON.parse(r.out) }; };
// (divmod.hsw.s: the default is its unrolled main loop, .LBB0_13, the larger of two scalar loops; .LBB0_7, its remainder,
// was the default before loop-find.js's defaultLoop: 22.00 on SKL, 13.00 on ZEN3)
const GOOD = ['dot.hsw.s', 'divmod.hsw.s', 'hist.hsw.s'];

test('one CPU: a row per file; a failing file says why, and the worst status is the exit status', () => {
  const r = run([...GOOD, 'nope.s', 'mixed.s']);
  assert.equal(r.code, 2); // mixed.s: an assembler error (2) beats the missing file (1)
  const lines = r.out.split('\n');
  assert.match(lines[0], /^File +Loop +TP +Bottlenecks +Notes$/);
  assert.match(lines[1], /^dot\.hsw\.s +\.LBB0_9 \(dot\) +32\.00 +Dependencies$/);
  assert.match(lines[2], /^divmod\.hsw\.s +\.LBB0_13 \(sum_mod\) +94\.00 +- \(nearest Issue\) +both paths; exit mispredict$/);
  assert.match(lines[4], /^nope\.s +- +- +error: no such file: nope\.s$/);
  assert.match(lines[5], /^mixed\.s +- +- +error: assembly failed: line 3: unknown token in expression$/);
  assert.match(r.err, /^nope\.s: no such file: nope\.s$/m);
  assert.match(r.err, /^mixed\.s:3:8: error: unknown token in expression$/m);
  assert.equal(run(GOOD).code, 0);
  assert.equal(run(['dot.hsw.s', 'nope.s']).code, 1);
});

test('-json: {code, files}; each entry is the single run\'s document with its file name (one CPU and several)', () => {
  for (const extra of [[], ['-per', '4', '-whatif'], ['-arch', 'SKL,ZEN3,ADL-P', '-per', '8'], ['-arch', 'SKL,ZEN3', '-whatif']]) {
    const b = json([...GOOD, 'nope.s', ...extra]);
    assert.equal(b.code, 1);
    assert.equal(b.doc.code, b.code);
    assert.deepEqual(b.doc.files.map((f) => f.file), [...GOOD, 'nope.s']);
    for (const [k, f] of GOOD.entries()) {
      const { file, ...entry } = b.doc.files[k];
      assert.equal(file, f);
      assert.deepEqual(entry, json([f, ...extra]).doc, `${f} ${extra.join(' ')}`);
    }
    const { file, ...missing } = b.doc.files[3];
    assert.deepEqual(missing, { code: 1, error: 'no such file: nope.s', stderr: [{ text: 'no such file: nope.s' }] });
  }
});

test('several CPUs: a row per file and CPU; -TPonly: tab-separated lines; -report and -whatif after the table', () => {
  const r = run([...GOOD, '-arch', 'SKL,ZEN3']);
  const lines = r.out.split('\n');
  assert.match(lines[0], /^File +Loop +CPU +TP +Bottlenecks +Notes$/);
  assert.match(lines[1], /^dot\.hsw\.s +\.LBB0_9 \(dot\) +SKL +32\.00 +Dependencies$/);
  assert.match(lines[2], /^ +ZEN3 +32\.00 +Dependencies +\[prototype\]$/);
  // 80 columns but for the notes, which come last (two caveats and [prototype] can be longer)
  assert.ok(lines.every((l) => l.replace(/ {2}(?:both paths|store forwarding|\[prototype\]).*$/, '').length <= 80), lines.find((l) => l.length > 80));
  assert.equal(run(['dot.hsw.s', 'divmod.hsw.s', '-TPonly']).out, 'dot.hsw.s\t32.00\ndivmod.hsw.s\t94.00\n');
  assert.equal(run(['dot.hsw.s', 'divmod.hsw.s', '-TPonly', '-arch', 'SKL,ZEN3', '-per', '2']).out,
    'dot.hsw.s\tSKL\t32.00\t16.00\ndot.hsw.s\tZEN3\t32.00\t16.00\ndivmod.hsw.s\tSKL\t94.00\t47.00\ndivmod.hsw.s\tZEN3\t52.00\t26.00\n');
  const wt = run(['dot.hsw.s', 'nope.s', '-TPonly', '-whatif']).out.split('\n');
  assert.equal(wt[0], 'dot.hsw.s\t32.00');
  assert.ok(wt.includes('dot.hsw.s\tacc2\t16.00') && wt.includes('nope.s\terror'), wt.join('|'));
  const rep = run(['dot.hsw.s', 'divmod.hsw.s', '-report']).out;
  assert.match(rep, /\n==> dot\.hsw\.s <==\nThroughput \(in cycles per iteration\): 32\.00\n/);
  assert.match(rep, /\n==> divmod\.hsw\.s <==\nThroughput \(in cycles per iteration\): 94\.00\n/);
  assert.match(run(['dot.hsw.s', 'divmod.hsw.s', '-report', '-arch', 'SKL,ZEN3']).out, /\n==> divmod\.hsw\.s \(ZEN3\) <==\nThroughput \(in cycles per iteration\): 52\.00\n/);
  assert.match(run(['dot.hsw.s', 'divmod.hsw.s', '-whatif']).out, /\n==> dot\.hsw\.s <==\nWhat if \(SKL\), cycles per original iteration \(base 32\.00\):\n/);
});

test('-files LIST and -files -: the names from a file or stdin, with the arguments', () => {
  const dir = tmpDir('wuica-files-');
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, `# kernels\n${path.join(FX, 'divmod.hsw.s')}\n\n${path.join(FX, 'hist.hsw.s')}\n`);
  assert.equal(run(['dot.hsw.s', '-files', list, '-TPonly']).out, `dot.hsw.s\t32.00\n${path.join(FX, 'divmod.hsw.s')}\t94.00\n${path.join(FX, 'hist.hsw.s')}\t11.95\n`);
  assert.equal(run(['-files', '-', '-TPonly'], 'dot.hsw.s\ndivmod.hsw.s\n').out, 'dot.hsw.s\t32.00\ndivmod.hsw.s\t94.00\n');
  assert.equal(run(['-files', '-', '-', '-TPonly'], 'x').code, 1); // stdin once
  fs.writeFileSync(list, '\n# none\n');
  assert.match(run(['-files', list]).err, /no file names in it/);
  const l = run(['dot.hsw.s', 'duplabel.s', '-loops']).out;
  assert.match(l, /^==> dot\.hsw\.s <==\n/);
  assert.match(l, /\n==> duplabel\.s <==\n {2}#  label +function/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('analyzeMany / compareMany: the results of analyze / compare, on this thread and on the threads', async () => {
  const reqs = GOOD.map((f) => ({ source: fs.readFileSync(path.join(FX, f), 'utf8') }));
  reqs.push({ hex: '4801d84801c349ffcf75f5' }, { source: 'frob rax' }, 'nope');
  for (const threads of [1, 4]) {
    const w = await createWuica({ threads });
    const many = await w.analyzeMany('ZEN3', reqs);
    for (const [k, r] of reqs.entries()) assert.deepEqual(many[k], await w.analyze('ZEN3', r), `analyze ${k} (threads ${threads})`);
    const cm = await w.compareMany(reqs, { archs: ['SKL', 'ADL-P', 'bogus'] });
    for (const [k, r] of reqs.entries()) {
      if (typeof r === 'object') assert.deepEqual(cm[k], await w.compare({ ...r, archs: ['SKL', 'ADL-P', 'bogus'] }), `compare ${k} (threads ${threads})`);
      else assert.equal(cm[k].error, 'the request must be an object');
    }
    await w.close();
  }
});
