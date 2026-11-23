// Tests of the compare views' data handling and of the live scheduling (web/js/compare.js); with the real
// analyzer, if it has been built, also the sweep and the CPU table for the built-in examples.
// Usage: node tests-js/web_compare.mjs
import fs from 'node:fs';
import {
  summarize, compareRows, sweepData, sweepLayout, compareKey, sweepKey, resultKey, ResultCache, latestWins, SWEEP_OFFSETS,
} from '../web/js/compare.js';
import { WasmEngine, makeRequest, REQUEST_DEFAULTS } from '../web/js/engine.js';
import { archGroups } from '../web/js/archs.js';
import { EXAMPLES } from '../web/js/examples.js';
import { DEFAULT_STATE, encodeState, decodeState } from '../web/js/url-state.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = new URL('../', import.meta.url);

// --- summaries ------------------------------------------------------------------------------------------------------
{
  const ok = summarize({ tp: 2.5, bottlenecks: ['Ports'], mode: 'loop', rows: [] });
  check(ok.tp === 2.5 && ok.bottlenecks.join() === 'Ports' && ok.mode === 'loop' && !ok.error && !ok.mock, 'summarize: a result', JSON.stringify(ok));
  check(summarize({ error: 'x' }).error === 'x' && summarize({ error: 'y', trapped: true }).trapped, 'summarize: an error');
  check(summarize(null).error && summarize({ tp: 'abc' }).error && summarize({ tp: 1, mock: {} }).mock, 'summarize: no response, a bad one, mock data');
  check(summarize({ tp: 1 }).bottlenecks.length === 0, 'summarize: no bottlenecks');
}

// --- the table of all CPUs ------------------------------------------------------------------------------------------
{
  const items = ['SNB', 'HSW', 'SKL', 'ZEN3', 'ADL-P'].map((key) => ({ key, title: key, experimental: key === 'ZEN3' || key === 'ADL-P' }));
  const res = new Map([
    ['SNB', { tp: 3, bottlenecks: ['Ports'] }], ['HSW', { tp: 2.004, bottlenecks: [] }], ['SKL', { tp: 2, bottlenecks: ['Dependencies'] }],
    ['ADL-P', { error: 'failed' }],
  ]);
  const menu = compareRows(items, res, { current: 'SKL' });
  check(menu.map((r) => r.key).join() === 'SNB,HSW,SKL,ZEN3,ADL-P', 'cpus: menu order by default');
  check(menu.map((r) => r.state).join() === 'ok,ok,ok,pending,error' && menu[4].error === 'failed' && menu[3].tp === null, 'cpus: states');
  check(menu[0].bar === 1 && Math.abs(menu[2].bar - 2 / 3) < 1e-9 && menu[3].bar === 0 && menu[4].bar === 0, 'cpus: bars relative to the slowest', menu.map((r) => r.bar).join());
  check(menu.filter((r) => r.fastest).map((r) => r.key).join() === 'HSW,SKL', 'cpus: the fastest, at two decimals (2.004 = 2.00)');
  check(menu.filter((r) => r.current).map((r) => r.key).join() === 'SKL' && menu.find((r) => r.key === 'ZEN3').experimental, 'cpus: current and prototype');
  const fast = compareRows(items, res, { sort: 'tp' });
  check(fast.map((r) => r.key).join() === 'SKL,HSW,SNB,ZEN3,ADL-P', 'cpus: by throughput, rows without a result last', fast.map((r) => r.key).join());
  const slow = compareRows(items, res, { sort: 'tp-desc' });
  check(slow.map((r) => r.key).join() === 'SNB,HSW,SKL,ZEN3,ADL-P', 'cpus: slowest first', slow.map((r) => r.key).join());
  const ties = compareRows(items, new Map(items.map((it) => [it.key, { tp: 1, bottlenecks: [] }])), { sort: 'tp' });
  check(ties.map((r) => r.key).join() === 'SNB,HSW,SKL,ZEN3,ADL-P' && ties.every((r) => r.fastest), 'cpus: ties keep the menu order');
  const none = compareRows(items, new Map());
  check(none.every((r) => r.state === 'pending' && r.bar === 0 && !r.fastest), 'cpus: nothing yet');
  // a CPU that cannot decode part of the block (AVX2 on SNB): its result leaves those instructions out, so it is
  // marked and not the fastest; when every CPU skipped the same, the fastest is as usual
  check(summarize({ tp: 1, decodeErrors: 2 }).decodeErrors === 2 && summarize({ tp: 1 }).decodeErrors === 0, 'summarize: the undecodable positions');
  const skip = compareRows(items, new Map([['SNB', { tp: 1, bottlenecks: [], decodeErrors: 2 }], ['HSW', { tp: 2, bottlenecks: [], decodeErrors: 0 }], ['SKL', { tp: 2, bottlenecks: [] }]]));
  check(skip[0].decodeErrors === 2 && !skip[0].fastest && skip[1].fastest && skip[2].fastest && skip[2].decodeErrors === 0, 'cpus: a row with undecodable positions is marked and not the fastest', JSON.stringify(skip.map((r) => [r.key, r.decodeErrors, r.fastest])));
  const allSkip = compareRows(items, new Map([['SNB', { tp: 1, bottlenecks: [], decodeErrors: 1 }], ['HSW', { tp: 2, bottlenecks: [], decodeErrors: 1 }]]));
  check(allSkip[0].fastest && !allSkip[1].fastest, 'cpus: every row skipped the same: the fastest as usual');
}

// --- the alignment sweep --------------------------------------------------------------------------------------------
{
  const pts = Array.from({ length: 64 }, (_, i) => ({ tp: i === 7 || i === 40 ? 4 : i === 20 ? 1.996 : 2.25, bottlenecks: [] }));
  const d = sweepData(pts);
  check(d.complete && d.pending === 0 && d.values.length === 64 && d.min === 2 && d.max === 4 && !d.flat, 'sweep: min and max', JSON.stringify([d.min, d.max]));
  check(d.minAt.join() === '20' && d.maxAt.join() === '7,40', 'sweep: where they are', JSON.stringify([d.minAt, d.maxAt]));
  const flat = sweepData(Array.from({ length: 64 }, () => ({ tp: 1.5 })));
  check(flat.flat && flat.min === 1.5 && flat.max === 1.5 && flat.minAt.length === 64, 'sweep: flat');
  const partial = pts.slice(0, 10);
  partial[3] = { error: 'boom' };
  const p = sweepData(partial);
  check(!p.complete && p.pending === 54 && p.failed.join() === '3' && p.values[3] === null && p.values[12] === null && p.max === 4, 'sweep: pending and failed offsets', JSON.stringify([p.pending, p.failed]));
  const empty = sweepData([]);
  check(empty.min === null && empty.max === null && !empty.flat && empty.minAt.length === 0, 'sweep: nothing yet');
  const allFailed = sweepData(Array.from({ length: 64 }, () => ({ error: 'x' })));
  check(allFailed.failed.length === 64 && allFailed.min === null && allFailed.complete, 'sweep: everything failed');

  const L = sweepLayout(d, { width: 680, height: 120, left: 40, right: 0, top: 10, bottom: 10 });
  check(L.points.length === SWEEP_OFFSETS && L.step === 10 && L.points[0].x === 45 && L.points[63].x === 675, 'layout: columns', JSON.stringify([L.step, L.points[0].x, L.points[63].x]));
  check(L.points[7].y === 10 && L.points[20].y === 110 && L.points.every((q) => q.y >= 10 && q.y <= 110), 'layout: the maximum at the top, the minimum at the bottom', JSON.stringify([L.points[7].y, L.points[20].y]));
  const Lf = sweepLayout(flat, { width: 640, height: 100, top: 0, bottom: 0 });
  check(Lf.points.every((q) => q.y === 50), 'layout: a flat sweep is drawn in the middle');
  const Lp = sweepLayout(p, { width: 640, height: 100 });
  check(Lp.points[3].y === null && Lp.points[40].y === null && Lp.points[0].y !== null, 'layout: no point where there is no value');
}

// --- keys and the cache ---------------------------------------------------------------------------------------------
{
  const o = { ...REQUEST_DEFAULTS };
  const o5 = { ...o, alignmentOffset: 5 };
  check(compareKey('90', o) !== compareKey('90', o5) && compareKey('90', o) === compareKey('90', { ...o, includeTrace: true }), 'keys: the CPU table depends on the alignment, not on the trace flag');
  check(sweepKey('90', 'SKL', o) === sweepKey('90', 'SKL', o5) && sweepKey('90', 'SKL', o) !== sweepKey('90', 'HSW', o) && sweepKey('90', 'SKL', o) !== sweepKey('91', 'SKL', o), 'keys: the sweep depends on the CPU, not on the alignment');
  check(sweepKey('90', 'SKL', o) !== sweepKey('90', 'SKL', { ...o, noMacroFusion: true }), 'keys: options count');
  check(resultKey('90', 'SKL', o) !== resultKey('90', 'SKL', o5) && resultKey('90', 'SKL', o) === resultKey('90', 'SKL', Object.fromEntries(Object.entries(o).reverse())), 'keys: one result; the order of the options does not matter');
  const c = new ResultCache(3);
  c.set('a', 1); c.set('b', 2); c.set('c', 3); c.get('a'); c.set('d', 4);
  check(c.size === 3 && c.get('b') === undefined && c.get('a') === 1 && c.get('d') === 4, 'cache: bounded, least recently used goes first');
}

// --- open panels in the URL --------------------------------------------------------------------------------------------
{
  const both = { ...DEFAULT_STATE, mode: 'hex', cpus: 'all', cmpSweep: true, text: '90' };
  const f = encodeState(both);
  check(f === 'v=1&as=all&cmpsweep=1&c=OTA' && JSON.stringify(decodeState(f)) === JSON.stringify(both), 'url: the checked CPUs and the open sweep go into the fragment, before the code', f);
  check(encodeState({ ...DEFAULT_STATE, mode: 'hex', cmpSweep: true }) === 'v=1&cmpsweep=1' && encodeState(DEFAULT_STATE) === '', 'url: only an open sweep is written');
  const old = decodeState('v=1&a=ZEN3&al=5&c=OTA');
  check(old.cpus === '' && old.cmpSweep === false && old.arch === 'ZEN3' && old.alignmentOffset === 5, 'url: an old link opens no panel');
  check(decodeState('v=1&cmpcpu=1&cmpsweep=1').cpus === 'all' && !encodeState(decodeState('v=1&cmpcpu=1')).includes('cmpcpu'), 'url: an old link with the table of all CPUs open checks them all');
  check(decodeState('v=1&cmpcpu=yes&cmpsweep=0').cpus === '' && decodeState('v=1&cmpcpu=yes&cmpsweep=0').cmpSweep === false, 'url: bad values are ignored');
}

// --- latest-wins scheduling ------------------------------------------------------------------------------------------
{
  // debounce: many requests in a row give one run
  let runs = 0;
  const s = latestWins(async () => { runs++; });
  for (let i = 0; i < 10; i++) { s.schedule(20); await sleep(2); }
  check(runs === 0 && s.waiting, 'latest: nothing runs during the debounce');
  await s.idle();
  check(runs === 1 && !s.waiting && !s.running, 'latest: one run after the last request', String(runs));

  // a run in progress is not interrupted; the requests that come in meanwhile give exactly one more run, with the
  // latest input; the running one is told it is stale
  let input = 0;
  const seen = [];
  const stale = [];
  const t = latestWins(async ({ isStale }) => {
    const mine = input;
    await sleep(40);
    seen.push(mine);
    stale.push(isStale());
  });
  input = 1; t.schedule(0);
  await sleep(10);
  check(t.running, 'latest: running');
  for (let i = 2; i <= 6; i++) { input = i; t.schedule(0); await sleep(3); }
  await t.idle();
  check(seen.join() === '1,6' && stale.join() === 'true,false', 'latest: no queue; only the latest runs afterwards', JSON.stringify([seen, stale]));

  // a new request with a debounce while a run is waiting: the debounce decides (no extra run)
  const seen2 = [];
  const u = latestWins(async () => { seen2.push(input); await sleep(30); });
  input = 'a'; u.schedule(0); await sleep(5);
  input = 'b'; u.schedule(0); await sleep(1);  // would run right after 'a'
  input = 'c'; u.schedule(60);                 // replaces it: runs 60 ms from now
  await u.idle();
  check(seen2.join() === 'a,c', 'latest: a later debounce replaces a waiting run', seen2.join());

  // cancel drops what is waiting and marks the running one stale
  let sawStale = null, ran = 0;
  const v = latestWins(async ({ isStale }) => { ran++; await sleep(20); sawStale = isStale(); });
  v.schedule(0); await sleep(5); v.schedule(50); v.cancel();
  await v.idle();
  check(ran === 1 && sawStale === true && !v.waiting, 'latest: cancel', JSON.stringify([ran, sawStale]));

  // the signal aborts as soon as the run is stale (a new request or cancel), so a task can settle at once
  const signals = [];
  const sg = latestWins(async ({ signal }) => {
    signals.push(signal);
    await new Promise((r) => { const t = setTimeout(r, 200); signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
  });
  const t0 = Date.now();
  sg.schedule(0); await sleep(5);
  check(signals.length === 1 && !signals[0].aborted, 'latest: a running task\'s signal is not aborted');
  sg.schedule(0); await sleep(10);
  check(signals[0].aborted && signals.length === 2 && !signals[1].aborted, 'latest: a new request aborts it; the next run starts with a fresh signal');
  sg.cancel(); await sg.idle();
  check(signals[1].aborted && Date.now() - t0 < 100, 'latest: cancel aborts it', String(Date.now() - t0));

  // a failing task does not stop the scheduler
  const errors = [];
  let n = 0;
  const w = latestWins(async () => { n++; if (n === 1) throw new Error('boom'); }, { onError: (e) => errors.push(e.message) });
  w.schedule(0); await w.idle(); w.schedule(0); await w.idle();
  check(n === 2 && errors.join() === 'boom', 'latest: errors are reported and scheduling goes on');

  // injectable timers
  const fake = [];
  const x = latestWins(async () => {}, { timers: { setTimeout: (f, ms) => { fake.push(ms); return setTimeout(f, 0); }, clearTimeout } });
  x.schedule(200); await x.idle();
  check(fake.join() === '200', 'latest: uses the given timers');
}

// --- with the real analyzer: the CPU table and the sweep for the built-in examples -------------------------------------
const wasmPath = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (fs.existsSync(wasmPath) && fs.existsSync(new URL('data/uarch.json', root))) {
  const e = await WasmEngine.create(fs.readFileSync(wasmPath));
  const uarch = fs.readFileSync(new URL('data/uarch.json', root));
  await e.loadUarch(uarch);
  const items = archGroups(JSON.parse(uarch))[0].items;
  for (const it of items) await e.loadArch(it.table, fs.readFileSync(new URL(`data/arch/${it.table}.json`, root)));
  for (const ex of EXAMPLES) {
    const res = new Map();
    for (const it of items) res.set(it.key, summarize(await e.analyze(makeRequest(ex.hex, it.key))));
    const rows = compareRows(items, res, { current: ex.arch });
    check(rows.length === 15 && rows.every((r) => r.state === 'ok'), `real ${ex.id}: every CPU has a result`);
    const own = res.get(ex.arch).tp;
    check(rows.find((r) => r.current).tp === own, `real ${ex.id}: the row of its CPU`);
    const pts = [];
    for (let k = 0; k < SWEEP_OFFSETS; k++) pts.push(summarize(await e.analyze(makeRequest(ex.hex, ex.arch, { alignmentOffset: k }))));
    const d = sweepData(pts);
    check(d.complete && d.failed.length === 0 && d.values[0] === own && d.min <= own && d.max >= own, `real ${ex.id}: sweep (offset 0 is the plain result)`, JSON.stringify([d.min, d.max, own]));
  }
} else console.log('(no real module or data: the examples were not swept)');

console.log(`${count} compare checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
