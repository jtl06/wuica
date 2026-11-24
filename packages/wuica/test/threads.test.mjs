// compare() on worker threads (lib/threads.js) gives byte for byte the response of the sequential compare (threads: 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWuica } from '../lib/index.js';
import { ThreadPool, threadLimit, threadOption, threadsForWork, workMs, WORK, maxMemoryBytes } from '../lib/threads.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HEX = '4801d84801c349ffcf75f5';
const ASM = 'top:\n  add rax, rbx\n  add rbx, rax\n  dec r15\n  jnz top\n';
// a block of ~100 instructions (several kinds of instructions, a loop)
const MIX = '4883c001' + '488906' + '8b06' + 'c4e2d5aaf4' + '4c03d1' + '4d0fafc0' + 'c5fc100c87' + 'c4e27da80c86' + 'c5fc110c86'
  + 'f3480fb80cc7' + '4801ca' + 'f2480f38f104cf' + '660f6f0f' + '660f74c8' + '660fd7c1' + '488b00' + 'c4626db8c0' + '4839d0';
const BIG = MIX.repeat(6) + '49ffcf0f85' + 'f8fdffff';

const seq = await createWuica({ threads: 1 });
const par = await createWuica({ threads: 4 });
// norm: for a trap's message, whose "N GB in use" depends on what the instance did before (also without threads)
const same = async (request, norm = (s) => s) => {
  const a = await seq.compare(request);
  const b = await par.compare(request);
  assert.equal(norm(JSON.stringify(b)), norm(JSON.stringify(a)), JSON.stringify(request).slice(0, 200));
  return b;
};

test('threads: the same response as one after another', async () => {
  const all = await same({ hex: BIG });
  assert.equal(all.results.length, 15);
  assert.ok(all.results.every((r) => r.code === 0));
  assert.ok(par.threads > 1 && par.threads <= 4, `threads: ${par.threads}`);
  await same({ hex: HEX });
  await same({ hex: BIG, options: { noMacroFusion: true, alignmentOffset: 5, minIterations: 20, initPolicy: 'same' } });
  // ids as given (an alias, a duplicate: once, an unknown one, an ablation variant), assembly with a warning
  const c = await same({ source: '.warning "careful"\n' + ASM, archs: ['adlp', 'SKL', 'K8', 'zen3', 'SKL', 'CLX_noLSD', 'CLX'] });
  assert.deepEqual(c.results.map((r) => [r.arch, r.code]), [['ADL-P', 0], ['SKL', 0], ['K8', 1], ['ZEN3', 0], ['CLX_noLSD', 0], ['CLX', 0]]);
  assert.equal(c.stderr[0].tag.severity, 'warning');
  // failures before any analysis
  await same({ source: 'frob' });
  await same({ hex: HEX, archs: 'SKL' });
  await same({ hex: HEX, bogus: 1 });
});

test('threads: a table that cannot be loaded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-threads-'));
  fs.mkdirSync(path.join(dir, 'arch'));
  fs.copyFileSync(path.join(ROOT, 'data/uarch.json'), path.join(dir, 'uarch.json'));
  for (const t of ['SKL', 'ICL']) fs.copyFileSync(path.join(ROOT, 'packages/wuica/dist/data/arch', `${t}.bin.br`), path.join(dir, 'arch', `${t}.bin.br`));
  const s = await createWuica({ dataDir: dir, threads: 1 });
  const p = await createWuica({ dataDir: dir, threads: 3 });
  const request = { hex: HEX, archs: ['SKL', 'TGL', 'ICL'] };
  const a = await s.compare(request), b = await p.compare(request);
  assert.equal(JSON.stringify(b), JSON.stringify(a));
  assert.deepEqual(b.results.map((r) => r.code), [0, 3, 0]);
  assert.match(b.results[1].error, /could not load the instruction table for TGL/);
  await p.close();
});

// An input on which the analyzer runs out of memory (as in trap.test.mjs): in a thread it traps at the thread's lower
// memory limit, and the main thread does it again; the rows (the trap's message included) are the sequential ones.
test('threads: an input that traps', async () => {
  const gb = (s) => s.replace(/out of memory, \d+\.\d GB in use/g, 'out of memory, N GB in use');
  const r = await same({ hex: '48f7f1'.repeat(200), archs: ['SKL', 'ZEN3'], options: { minIterations: 10000, minCycles: 100000 } }, gb);
  assert.equal(r.results[0].code, 3);
  assert.equal((await par.compare({ hex: HEX })).results.length, 15); // and the threads work afterwards
});

test('close() stops the threads; the next compare starts them again', async () => {
  assert.ok(par.threads > 0);
  await par.close();
  assert.equal(par.threads, 0);
  await same({ hex: HEX, archs: ['SKL', 'ICL'] });
  assert.equal(par.threads, 2); // one per table, not the limit
  await par.close();
});

test('threads are not used for one table, nor with threads: 1', async () => {
  const w = await createWuica({ threads: 8 });
  await w.compare({ hex: HEX, archs: ['SKL', 'skl'] });
  assert.equal(w.threads, 0);
  await seq.compare({ hex: HEX });
  assert.equal(seq.threads, 0);
});

test('a pool whose threads cannot start gives every job back', async () => {
  const empty = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]); // a valid module without the analyzer's exports
  const pool = new ThreadPool({ wasm: empty, uarch: fs.readFileSync(path.join(ROOT, 'data/uarch.json')), dataDir: path.join(ROOT, 'data'), limit: 2 });
  const out = await pool.run([{ table: 'SKL', request: { hex: HEX, arch: 'SKL' } }, { table: 'ICL', request: { hex: HEX, arch: 'ICL' } }]);
  assert.deepEqual(out, [null, null]);
  assert.equal(pool.broken, true);
  await pool.close();
});

test('threadLimit, threadsForWork and maxMemoryBytes', () => {
  assert.equal(threadOption(undefined, {}), 'auto');
  assert.equal(threadOption(0, {}), 'auto');
  assert.equal(threadOption(undefined, { WUICA_THREADS: '3' }), '3');
  // the default by work: a small block on every CPU, 50 small blocks on 3 CPUs: none; the SHA-256 block (2,949
  // instructions, 23,204 hex digits) on every CPU, or 20 of them on one: 4; never more than 8, the cores but one, the jobs
  const ARCHS = ['SNB', 'IVB', 'HSW', 'BDW', 'SKL', 'KBL', 'CFL', 'SKX', 'CLX', 'ICL', 'TGL', 'RKL', 'ICX', 'ADL-P', 'ZEN3'];
  const job = (table, n) => ({ table, request: { hex: 'x'.repeat(n) } });
  const small = 50, sha = 23204;
  assert.equal(threadsForWork(ARCHS.map((a) => job(a, small)), 16, 12), 1);
  assert.equal(threadsForWork(Array.from({ length: 50 }, (_, i) => job(['SKL', 'ZEN3', 'ADL-P'][i % 3], small)).flatMap((j) => [j, j, j]), 16, 12), 1);
  assert.equal(threadsForWork(ARCHS.map((a) => job(a, sha)), 16, 12), 4);
  assert.equal(threadsForWork(Array.from({ length: 20 }, () => job('SKL', sha)), 16, 12), 4);
  assert.equal(threadsForWork(Array.from({ length: 200 }, () => job('SKL', sha)), 16, 12), WORK.max);
  assert.equal(threadsForWork(Array.from({ length: 200 }, () => job('SKL', sha)), 16, 4), 3);
  assert.equal(threadsForWork(Array.from({ length: 200 }, () => job('SKL', sha)), 2, 12), 2);
  assert.equal(threadsForWork([job('SKL', 10 ** 7)], 16, 12), 1); // one job: no threads
  assert.ok(workMs(ARCHS.map((a) => job(a, small))) < WORK.minMs);
  assert.equal(threadLimit(3, {}), 3);
  assert.equal(threadLimit(1, { WUICA_THREADS: '6' }), 1);
  assert.equal(threadLimit(undefined, { WUICA_THREADS: '6' }), 6);
  assert.equal(threadLimit(undefined, {}), os.availableParallelism());
  assert.equal(threadLimit('auto', {}), os.availableParallelism());
  assert.throws(() => threadLimit(-1, {}), /threads/);
  assert.throws(() => threadLimit(undefined, { WUICA_THREADS: 'x' }), /WUICA_THREADS/);
  assert.equal(maxMemoryBytes(15, 26 * 2 ** 30), Math.floor(26 * 2 ** 30 / 4 / 15 / 65536) * 65536);
  assert.equal(maxMemoryBytes(16, 8 * 2 ** 30), 256 * 2 ** 20);
  assert.equal(maxMemoryBytes(1, 64 * 2 ** 30), 1024 * 2 ** 20);
});

test('createWuica rejects a bad threads option', async () => {
  await assert.rejects(createWuica({ threads: 'many' }), /threads/);
});
