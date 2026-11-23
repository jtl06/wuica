// Tests of the assembler in a worker (web/js/assembler-rpc.js) with the real assembler (assembler/dist/wuica_asm.wasm)
// in Node worker threads (the page uses web workers; the messages are the same):
// - results equal WasmAssembler's on this thread (ok, errors with lines, warnings, the size cap)
// - aborting the running job stops it at once (a large .rept that takes seconds) and replaces the worker; the jobs behind
//   it (another caller's, e.g. a hex <-> asm conversion) still get their results
// - aborting a waiting job removes it without stopping the worker; an aborted signal rejects at once
// - the worker drops an instance that grew beyond the limit
// - PageAssembler: small sources without directives on this thread (no worker is started for them), the others in the
//   worker; without a worker, everything on this thread
// Skipped (exit 0) without the assembler module.
//
//   node tests-js/web_assembler_rpc.mjs [ASM_WASM]
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { WasmAssembler } from '../web/js/assembler.js';
import { WorkerAssembler, PageAssembler, CancelledError, createAssemblerHandler, onPageThread, SMALL_SOURCE } from '../web/js/assembler-rpc.js';

const asmPath = process.argv[2] || new URL('../assembler/dist/wuica_asm.wasm', import.meta.url);
if (!fs.existsSync(asmPath)) { console.log('the assembler module is missing: skipped'); process.exit(0); }
let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + String(detail).slice(0, 500) : ''}`); } }
const hex = (r) => (r?.ok ? Buffer.from(r.bytes).toString('hex') : null);
const ms = (t0) => performance.now() - t0;

// A web worker's interface over a Node worker thread running the same handler as web/js/assembler-worker.js.
const WORKER_SRC = `
  import { parentPort } from 'node:worker_threads';
  const { createAssemblerHandler } = await import(${JSON.stringify(new URL('../web/js/assembler-rpc.js', import.meta.url).href)});
  const handle = createAssemblerHandler({ memoryLimit: Number(process.env.WUICA_ASM_LIMIT) || undefined });
  parentPort.on('message', async (m) => parentPort.postMessage(await handle(m)));`;
let spawned = 0;
const live = new Set();
function spawn(env = {}) {
  spawned++;
  const w = new Worker(WORKER_SRC, { eval: true, env: { ...process.env, ...env } });
  live.add(w);
  const shim = {
    onmessage: null, onerror: null,
    postMessage: (m) => w.postMessage(m),
    terminate: () => { live.delete(w); w.terminate(); },
  };
  w.on('message', (data) => shim.onmessage?.({ data }));
  w.on('error', (e) => shim.onerror?.({ message: e.message }));
  return shim;
}

const module = await WebAssembly.compile(fs.readFileSync(asmPath));
const local = await WasmAssembler.create(module);
const wa = await WorkerAssembler.create(module, () => spawn());
check(spawned === 1, 'one worker at the start', spawned);

// 1. the same results as on this thread
const SOURCES = [
  ['loop:\n  add rax, 1\n  add rax, 1\n  dec r15\n  jnz loop', 'intel'],
  ['addq $1, %rax\ndecq %r15', 'att'],
  ['add rax, 1\nbogus rax\nmov eax, [rbx', 'intel'],
  ['add rax, 1 ; note', 'intel'],
  ['﻿{load} mov eax, ebx', 'intel'],
  ['.rept 300000\nnop\n.endr', 'intel'],    // a second run with a larger buffer
  ['.rept 2000000\nnop\n.endr', 'intel'],   // more than the cap: "Too much machine code"
  ['', 'intel'],
];
for (const [text, syntax] of SOURCES) {
  const [a, b] = [await local.assemble(text, syntax), await wa.assemble(text, syntax)];
  check(a.ok === b.ok && hex(a) === hex(b) && JSON.stringify(a.diagnostics) === JSON.stringify(b.diagnostics), `same result as on this thread: ${JSON.stringify(text.slice(0, 30))}`, JSON.stringify([a.diagnostics, b.diagnostics]));
}
let unknown = null;
try { await wa.assemble('nop', 'nasm'); } catch (e) { unknown = e; }
check(unknown instanceof Error && /unknown syntax/.test(unknown.message), 'an unknown syntax rejects', unknown);

// 2. aborting the running job: it stops at once, the worker is replaced, the job behind it is done by the new worker
const BIG = '.rept 3000000\nnop\n.endr'; // about 2 s on one run
{
  const t0 = performance.now();
  await wa.assemble(BIG, 'intel');
  const full = ms(t0);
  const ctrl = new AbortController();
  const before = spawned;
  const big = wa.assemble(BIG, 'intel', { signal: ctrl.signal });
  const other = wa.assemble('add rax, 1', 'intel'); // another caller's job, waiting behind it
  await new Promise((r) => setTimeout(r, Math.min(200, full / 4)));
  const t1 = performance.now();
  ctrl.abort();
  let err = null;
  try { await big; } catch (e) { err = e; }
  check(err instanceof CancelledError, 'the aborted running job rejects with CancelledError', err);
  const r = await other;
  const took = ms(t1);
  check(hex(r) === '4883c001', 'the job behind the aborted one gets its result', JSON.stringify(r));
  check(took < full / 2, `the abort did not wait for the running job (${took.toFixed(0)} ms after the abort, a full run takes ${full.toFixed(0)} ms)`);
  check(spawned === before + 1 && wa.stats.stopped === 1, 'the running worker was replaced once', JSON.stringify([spawned - before, wa.stats]));
}

// 3. aborting a waiting job: removed, the worker keeps running
{
  const before = spawned;
  const ctrl = new AbortController();
  const first = wa.assemble('nop', 'intel');
  const waiting = wa.assemble('add rax, 1', 'intel', { signal: ctrl.signal });
  ctrl.abort();
  let err = null;
  try { await waiting; } catch (e) { err = e; }
  check(err instanceof CancelledError && hex(await first) === '90', 'an aborted waiting job rejects; the running one finishes', err);
  check(spawned === before, 'no new worker for an aborted waiting job', spawned - before);
  let pre = null;
  try { await wa.assemble('nop', 'intel', { signal: AbortSignal.abort() }); } catch (e) { pre = e; }
  check(pre instanceof CancelledError, 'an already aborted signal rejects at once', pre);
  check(!wa.busy, 'idle at the end');
}

// 4. cancel(): everything stops; the next call starts a new worker
{
  const p = [wa.assemble(BIG, 'intel'), wa.assemble('nop', 'intel')];
  await new Promise((r) => setTimeout(r, 50));
  wa.cancel();
  const out = await Promise.allSettled(p);
  check(out.every((o) => o.status === 'rejected' && o.reason instanceof CancelledError), 'cancel() rejects every job', JSON.stringify(out.map((o) => o.status)));
  check(hex(await wa.assemble('nop', 'intel')) === '90', 'the next call works after cancel()');
}

// 5. the worker's side drops an instance that grew beyond its limit
{
  const handle = createAssemblerHandler({ memoryLimit: 64 * 2 ** 20 });
  await handle({ id: 1, op: 'init', module });
  const r = await handle({ id: 2, op: 'assemble', text: '.rept 1000000\nnop\n.endr', syntax: 'intel' });
  const again = await handle({ id: 3, op: 'assemble', text: 'nop', syntax: 'intel' });
  check(r.ok && r.value.ok && r.value.bytes.length === 1000000 && again.ok && hex(again.value) === '90', 'the handler assembles before and after dropping a grown instance', JSON.stringify([r.ok, r.value?.ok, again.value?.ok]));
  const h2 = createAssemblerHandler();
  const bad = await h2({ id: 1, op: 'assemble', text: 'nop', syntax: 'intel' });
  check(!bad.ok && /cannot assemble/.test(bad.error), 'assemble before init is an error answer', JSON.stringify(bad));
}

// 5b. a worker that fails while it runs a job: that job rejects, the one behind it goes to a new worker
{
  let last = null;
  const wf = await WorkerAssembler.create(module, () => (last = spawn()));
  const first = last;
  const running = wf.assemble(BIG, 'intel');
  const behind = wf.assemble('nop', 'intel');
  await new Promise((r) => setTimeout(r, 100));
  first.onerror({ message: 'boom' });
  let err = null;
  try { await running; } catch (e) { err = e; }
  check(err instanceof Error && !(err instanceof CancelledError) && /failed: boom/.test(err.message), 'a failing worker: its job rejects with the error', err);
  check(hex(await behind) === '90' && last !== first, 'a failing worker: the next job runs in a new worker');
  // a new worker that cannot start: the waiting jobs fail, no endless restarts
  let n = 0;
  const wb = await WorkerAssembler.create(module, () => { n++; const w = spawn(); if (n > 1) setTimeout(() => w.onerror?.({ message: 'no script' }), 0); return w; });
  const c = new AbortController();
  const p1 = wb.assemble(BIG, 'intel', { signal: c.signal });
  const p2 = wb.assemble('nop', 'intel');
  await new Promise((r) => setTimeout(r, 50));
  c.abort();
  const out = await Promise.allSettled([p1, p2]);
  await new Promise((r) => setTimeout(r, 200));
  check(out[1].status === 'rejected' && /no script/.test(out[1].reason?.message) && n === 2, 'a new worker that cannot start: the waiting job fails, one try', JSON.stringify([out.map((o) => o.status), n]));
}

// 6. PageAssembler
{
  check(onPageThread('loop:\n  add rax, 1\n  dec r15\n  jnz loop') && onPageThread('addq $1, %rax') && !onPageThread('.rept 3\nnop\n.endr')
    && !onPageThread('jmp .L1') && !onPageThread('nop\n'.repeat(SMALL_SOURCE)), 'onPageThread: small sources without a "." only');
  let made = 0;
  const pa = new PageAssembler(local, () => { made++; return WorkerAssembler.create(module, () => spawn()); });
  const small = await pa.assemble('add rax, 1', 'intel');
  check(hex(small) === '4883c001' && made === 0 && pa.worker === null, 'page: a small source on this thread, no worker started', JSON.stringify([small, made]));
  const t0 = performance.now();
  let blocked = 0, last = performance.now();
  const tick = setInterval(() => { const n = performance.now(); blocked = Math.max(blocked, n - last); last = n; }, 5);
  const big = await pa.assemble('.rept 1000000\nnop\n.endr', 'intel');
  clearInterval(tick);
  check(big.ok && big.bytes.length === 1000000 && made === 1, 'page: a .rept in the worker (started for it)', JSON.stringify([big.ok, made]));
  check(blocked < Math.max(250, (performance.now() - t0) / 3), `page: this thread was not blocked while it assembled (longest gap ${blocked.toFixed(0)} ms of ${(performance.now() - t0).toFixed(0)})`);
  const ctrl = new AbortController();
  const p = pa.assemble(BIG, 'intel', { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 100);
  let err = null;
  try { await p; } catch (e) { err = e; }
  check(err instanceof CancelledError && made === 1, 'page: a large source can be stopped', err);
  const none = new PageAssembler(local, async () => { throw new Error('no workers'); });
  check(hex(await none.assemble('.byte 0x90', 'intel')) === '90', 'page: without a worker, large sources on this thread');
}

for (const w of live) w.terminate();
console.log(`${count} assembler worker checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
