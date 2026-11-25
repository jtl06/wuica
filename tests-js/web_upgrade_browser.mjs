// A deploy whose engine files (the analyzer, uarch.json, the instruction tables) differ from the last one's, in headless
// Chrome (--headless, --remote-debugging-port, through tests-js/cdp.mjs) on one origin served like the host
// (static-host.mjs; a deploy replaces the whole file set at once). The rule: a page computes only with the engine files of
// its own build; if it cannot get them it shows an error (and the update path reloads it), never a number of a mix.
//
// Two builds from this source (web/build.sh into temporary folders, WUICA_DATA): A with data/ as it is, B with ZEN3's
// and ICX's IMUL r64, r64 slower in their tables, ZEN3 without move elimination in uarch.json, and the analyzer with one
// more custom section (the same code, other bytes). For the block Z on ZEN3 the four mixes of uarch.json and table give
// four numbers (A 3, B 6, 4 and 5), for I on ICX A and B differ (3, 10). B+L is B with the legacy files of A
// (scripts/fetch-legacy.mjs from the host serving A, WUICA_LEGACY_DIR), A+L A with B's (a rollback that keeps them).
// The scenarios of the upgrade test of 0.1.11, each in a fresh profile, without and with the legacy files:
//   1 an A tab under A's worker uses a table that is not in its cache after the host switched (no update check)
//   2 B's worker takes over an A tab, whose reload waits (the user is busy): the tab uses tables it has not loaded
//   3 a link opened in a new tab mid-swap: (a) its manifest.json answered by B's worker, (b) a table not in A's cache
//   4 a rollback to A (B's worker gone, A's takes over a B tab that is busy)
//   5 Data Saver (no prefetch: nothing but the first table is cached) after the switch
//   6 offline: a visit from the cache; a table that is not cached (an error, then a later try works)
// Every number a page shows (sampled every 100 ms) must be one its own build gives (its build: the page's stamped
// build id, read in the same evaluation); each probe of Z@ZEN3 and I@ICX must give the own build's number or an error
// (and then no number); without legacy files the page then reloads into the build that is live; a path that answered
// 404 is not requested again and again.
//   node tests-js/web_upgrade_browser.mjs [--chrome PATH]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { findChrome, launch, Page, checker, ROOT, sleep, HELPERS, testConditions } from './cdp.mjs';
import { hostHandler } from './static-host.mjs';
import { enginePath } from './dist-files.mjs';
import { encodeState, DEFAULT_STATE } from '../web/js/url-state.js';
import { EXAMPLES } from '../web/js/examples.js';
import { parseHexInput } from '../web/js/hex-input.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';

const chrome = findChrome();
const check = checker('upgrade browser');
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const WASM = process.env.WUICA_WASM ?? path.join(ROOT, 'target/wasm32-unknown-unknown/release/wuica_wasm.wasm');
const DATA = path.join(ROOT, 'data');
if (!fs.existsSync(WASM) || !fs.existsSync(path.join(DATA, 'uarch.json'))) { console.log('the analyzer or data/ is missing (./build-wasm.sh, data/)'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-upgrade-'));
const log = (...a) => console.log(...a);

// ---- the two builds
function dataDir(dir, change) {
  fs.mkdirSync(path.join(dir, 'arch'), { recursive: true });
  const uarch = JSON.parse(fs.readFileSync(path.join(DATA, 'uarch.json'), 'utf8'));
  if (change) uarch.configs.ZEN3.moveEliminationGPRSlots = 0;
  fs.writeFileSync(path.join(dir, 'uarch.json'), JSON.stringify(uarch));
  for (const f of fs.readdirSync(path.join(DATA, 'arch')).filter((f) => f.endsWith('.json'))) {
    const name = f.slice(0, -5), add = change ? { ZEN3: 2, ICX: 7 }[name] : 0;
    if (!add) { fs.symlinkSync(path.join(DATA, 'arch', f), path.join(dir, 'arch', f)); continue; }
    const t = JSON.parse(fs.readFileSync(path.join(DATA, 'arch', f), 'utf8'));
    for (const p of new Set(t.instrData.IMUL_GPRv_GPRv.map((e) => e.perfData))) t.perfData[p].lat = Object.fromEntries(Object.entries(t.perfData[p].lat).map(([k, v]) => [k, v + add]));
    fs.writeFileSync(path.join(dir, 'arch', f), JSON.stringify(t));
  }
  return dir;
}
const leb = (n) => { const b = []; do { let x = n & 127; n >>>= 7; if (n) x |= 128; b.push(x); } while (n); return Buffer.from(b); };
const wasmB = path.join(tmp, 'wuica_wasm_b.wasm');
{ const name = Buffer.from('wuica-test'), body = Buffer.concat([leb(name.length), name, Buffer.from('build B')]); fs.writeFileSync(wasmB, Buffer.concat([fs.readFileSync(WASM), Buffer.from([0]), leb(body.length), body])); }
function build(label, data, wasm, legacy = null) {
  const out = path.join(tmp, `dist-${label}`);
  const t0 = Date.now();
  const r = spawnSync(path.join(ROOT, 'web/build.sh'), [], { encoding: 'utf8', env: { ...process.env, WUICA_OUT: out, WUICA_DATA: data, WUICA_WASM: wasm, WUICA_ZOPFLI: '0', ...(legacy ? { WUICA_LEGACY_DIR: legacy } : {}) } });
  if (r.status !== 0) throw new Error(`web/build.sh (${label}): ${r.stderr.slice(-800)}`);
  log(`build ${label}: ${r.stdout.trim().split('\n').at(-1)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return out;
}
const ROOTS = {};
ROOTS.A = build('A', dataDir(path.join(tmp, 'data-a'), false), WASM);
ROOTS.B = build('B', dataDir(path.join(tmp, 'data-b'), true), wasmB);
const versionOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
const VER = { A: versionOf(ROOTS.A), B: versionOf(ROOTS.B) };
const nameOf = (v) => (v === VER.A ? 'A' : v === VER.B ? 'B' : `?${v}`);

// ---- the numbers: every analysis the probes can show, for each build and each mix of uarch.json and table
const Z = '48 89 c3 48 0f af c3'; // mov rbx, rax; imul rax, rbx
const I = '48 0f af c0';          // imul rax, rax
const DEFAULT_HEX = parseHexInput(EXAMPLES[0].text.hex);
const BLOCKS = { Z, I, example: [...DEFAULT_HEX.bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ') };
const ARCHS = ['SKL', 'ZEN3', 'ICX'];
const REF = {}; // REF[`${uarchBuild}${tableBuild}`][`${block}@${arch}`]
for (const u of 'AB') for (const t of 'AB') {
  const e = await WasmEngine.create(fs.readFileSync(enginePath(ROOTS[u], 'wuica_wasm.wasm')));
  await e.loadUarch(fs.readFileSync(enginePath(ROOTS[u], 'data/uarch.json')));
  for (const a of ARCHS) await e.loadArch(a, zlib.gunzipSync(fs.readFileSync(enginePath(ROOTS[t], `data/arch/${a}.bin.gz`))));
  const r = (REF[u + t] = {});
  for (const [b, hex] of Object.entries(BLOCKS)) for (const a of ARCHS) { const x = await e.analyze(makeRequest(hex, a)); r[`${b}@${a}`] = x.error ? 'error' : Number(x.tp.toFixed(2)); }
}
const own = (build, key) => REF[build + build][key];
// what a page can show in these scenarios: the default example (on SKL) and the probes' blocks (a probe empties the code
// before it switches the CPU, so no block runs on another CPU)
const SHOWN = ['example@SKL', 'Z@ZEN3', 'I@ICX'];
const ALLOWED = { A: new Set(SHOWN.map((k) => REF.AA[k])), B: new Set(SHOWN.map((k) => REF.BB[k])) };
log('numbers (uarch.json, table): ' + ['Z@ZEN3', 'I@ICX'].map((k) => `${k} ${Object.entries(REF).map(([m, r]) => `${m} ${r[k]}`).join(', ')}`).join('; '));
log(`A shows only ${[...ALLOWED.A].join(', ')}; B only ${[...ALLOWED.B].join(', ')}`);
{
  const z = Object.values(REF).map((r) => r['Z@ZEN3']);
  check(new Set(z).size === 4 && own('A', 'I@ICX') !== own('B', 'I@ICX'), 'the builds differ: Z@ZEN3 has four numbers (A, B and two mixes), I@ICX two', JSON.stringify(z));
  // (a mix or the other build's number for the probes is never one the page's own build shows anywhere in the test)
  for (const [x, y] of [['A', 'B'], ['B', 'A']]) {
    const foreign = ['Z@ZEN3', 'I@ICX'].flatMap((k) => Object.entries(REF).filter(([m]) => m !== x + x).map(([, r]) => r[k])).filter((n) => n !== own(x, 'Z@ZEN3') && n !== own(x, 'I@ICX'));
    check(foreign.every((n) => !ALLOWED[x].has(n)), `the numbers of mixes and of ${y} are not among those ${x} shows`, JSON.stringify(foreign));
  }
}

// ---- the host: one server per variant (two run side by side), its root switched by label
const legacyOk = fs.existsSync(path.join(ROOT, 'scripts/fetch-legacy.mjs'));
check(legacyOk, 'scripts/fetch-legacy.mjs exists');
function makeServer() {
  const srv = { label: 'A', log: [], up: false };
  const handler = hostHandler(() => ROOTS[srv.label]);
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const t = Date.now(), label = srv.label, p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    res.on('finish', () => srv.log.push({ t, path: p, label, status: res.statusCode }));
    handler(req, res);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  let port = 0;
  srv.start = () => new Promise((r) => server.listen(port, '127.0.0.1', () => { port = server.address().port; srv.up = true; r(); }));
  srv.stop = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => { srv.up = false; r(); }); });
  Object.defineProperty(srv, 'origin', { get: () => `http://127.0.0.1:${port}` });
  return srv;
}
const servers = [makeServer(), makeServer()];
for (const s of servers) await s.start();
function legacyFrom(label, srv) {
  const dir = path.join(tmp, `legacy-of-${label}`);
  srv.label = label;
  const r = spawnSync('node', [path.join(ROOT, 'scripts/fetch-legacy.mjs'), '--site', srv.origin, dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fetch-legacy (${label}): ${r.stdout.slice(-400)} ${r.stderr.slice(-800)}`);
  log(`legacy of ${label}: ${r.stdout.trim().split('\n').at(-1)}`);
  return dir;
}
if (legacyOk) {
  ROOTS['B+L'] = build('B+L', path.join(tmp, 'data-b'), wasmB, legacyFrom('A', servers[0]));
  ROOTS['A+L'] = build('A+L', path.join(tmp, 'data-a'), WASM, legacyFrom('B', servers[0]));
  check(versionOf(ROOTS['B+L']) === VER.B && versionOf(ROOTS['A+L']) === VER.A, 'the legacy files do not change the build id');
}

// ---- the browser
const { browser, close } = await launch(chrome);
async function open(ctx, label, { init = null } = {}) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
  const p = new Page();
  p.browser = browser; p.targetId = targetId; p.label = label;
  p.sessionId = (await browser.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  for (const d of ['Runtime', 'Page']) await p.cmd(`${d}.enable`);
  await testConditions((m, a) => p.cmd(m, a));
  if (init) await p.cmd('Page.addScriptToEvaluateOnNewDocument', { source: init });
  return p;
}
const SAVE_DATA = `Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => ({ saveData: true, effectiveType: '4g', addEventListener() {}, removeEventListener() {} }) });`;
const SNAPSHOT = `const html = document.querySelector('meta[name="wuica-build"]')?.content ?? null;
  const box = document.querySelector('#result-body .error-box');
  const snap = { doc: performance.timeOrigin, html, tp: document.querySelector('#result-body .tp .value')?.textContent ?? null, err: box ? box.textContent : '',
    note: document.getElementById('update-note') ? !document.getElementById('update-note').hidden : null, status: document.getElementById('status')?.textContent ?? '',
    statusError: !!document.getElementById('status-wrap')?.classList.contains('error'), focus: document.getElementById('cpus')?.dataset.focus ?? null,
    ready: document.getElementById('run') ? !document.getElementById('run').disabled : false };`;
// every number a page shows, against the numbers its own build gives
function watch(p, sink) {
  let on = true;
  const seen = [];
  const loop = (async () => {
    let last = '';
    while (on) {
      let s = null;
      try { s = await p.eval(`${SNAPSHOT} return snap;`, { timeout: 5000 }); } catch { /* navigating */ }
      if (s && s.html) {
        const b = nameOf(s.html);
        const line = `${b} ${s.tp ?? '-'}${s.err ? ' error' : ''}${s.note ? ' note' : ''}`;
        if (line !== last) { seen.push(line); last = line; }
        if (s.tp !== null && !(ALLOWED[b]?.has(Number(s.tp)))) sink.bad.push(`${p.label}: page ${b} showed ${s.tp} (focus ${s.focus})`);
        if (s.tp !== null) sink.numbers++;
      }
      await sleep(100);
    }
  })();
  return async () => { on = false; await loop; return seen; };
}
// Z@ZEN3 or I@ICX: no code, the CPU, then the code (a block runs on no other CPU than its own)
const PROBE = (block, arch) => `${HELPERS}
  if (!$('mode-hex').checked) { $('mode-hex').click(); await wait(300); }
  set($('code'), ''); await wait(100);
  cpus(${JSON.stringify(arch)}); await wait(100);
  set($('code'), ${JSON.stringify(BLOCKS[block])});
  const t0 = Date.now(); let last = null, same = 0;
  while (Date.now() - t0 < 20000) {
    const v = (tp() ?? '') + '|' + errorBox();
    const settled = focused() === ${JSON.stringify(arch)} && !$('results').hasAttribute('aria-busy') && (errorBox() !== '' || (tp() && !$('result-body').classList.contains('stale')));
    if (settled && v === last) { if (++same >= 6) break; } else same = 0;
    last = v; await wait(150);
  }
  ${SNAPSHOT} return snap;`;
// one probe; a page that reloads meanwhile (the update path) is probed again once it has loaded
async function probe(p, block, arch) {
  for (let i = 0; i < 3; i++) {
    try {
      const s = await p.eval(PROBE(block, arch), { timeout: 40000 });
      if (s.html) return { ...s, build: nameOf(s.html), reloads: i };
    } catch (e) { if (!/context|navigat|target/i.test(e.message)) return { failed: e.message.slice(0, 200) }; }
    await p.waitFor(`document.readyState === 'complete' && (document.getElementById('run')?.disabled === false || document.querySelector('.error-box'))`, 'the page after a reload', 60000).catch(() => {});
  }
  return { failed: 'the page kept reloading' };
}
// a probe's result: its build's number, or an error and no number
function expectProbe(what, r, { block, arch, want = null }) {
  const key = `${block}@${arch}`;
  if (r.failed) { check(false, `${what}: ${key} probed`, r.failed); return r; }
  const ok = r.err ? r.tp === null : r.tp !== null && Number(r.tp) === own(r.build, key);
  check(ok, `${what}: ${key} on page ${r.build}: its own number (${own(r.build, key)}) or an error, and no number with an error`, JSON.stringify({ tp: r.tp, err: r.err.slice(0, 160), status: r.status }));
  if (want === 'error') check(!!r.err && r.statusError && /no longer|not this version|out of date/i.test(r.status), `${what}: ${key}: an error in the result and the status line`, JSON.stringify({ build: r.build, tp: r.tp, err: r.err.slice(0, 160), status: r.status, statusError: r.statusError }));
  if (want === 'own') check(!r.err && r.tp !== null, `${what}: ${key}: a number (page ${r.build})`, JSON.stringify({ tp: r.tp, err: r.err.slice(0, 160) }));
  return r;
}
const READY = `document.readyState === 'complete' && document.getElementById('run')?.disabled === false`;
async function settleOn(p, build, what, ms = 30000) {
  const ok = await p.waitFor(`${READY} && document.querySelector('meta[name="wuica-build"]')?.content === ${JSON.stringify(VER[build])}`, `${what}: page ${build}`, ms).then(() => true, () => false);
  check(ok, `${what}: the page reloads into ${build} by itself`, ok ? '' : JSON.stringify(await p.eval(`${SNAPSHOT} return snap;`).catch((e) => e.message)));
  return ok;
}
// a fresh profile on `build`: the page, its worker in control with its cache, the idle prefetch done (or Data Saver:
// only the first table), then loaded again under the worker
async function prep(srv, ctx, label, build, { saveData = false } = {}) {
  const p = await open(ctx, label, { init: saveData ? SAVE_DATA : null });
  await p.goto(`${srv.origin}/`);
  await p.waitFor(`${READY} && navigator.serviceWorker.controller && (await caches.keys()).includes('wuica-${VER[build]}')`, `${label}: ${build}'s worker in control`, 60000);
  await p.waitFor(saveData ? `/^ready/.test(document.getElementById('status').textContent) && document.getElementById('results').dataset.run` : `/works offline/.test(document.getElementById('status').textContent)`, `${label}: prefetch`, 90000);
  await p.reload();
  await p.waitFor(READY, `${label}: ready again`, 60000);
  // the browser's update check after the navigation, while the host still serves this build: no later one of its own
  await p.eval(`await (await navigator.serviceWorker.getRegistration()).update(); return 1;`);
  await sleep(300);
  return p;
}
const removeTables = (p, build) => p.eval(`const c = await caches.open('wuica-${VER[build]}'); const gone = [];
  for (const k of await c.keys()) if (/\\/data\\/arch\\/(ZEN3|ICX)[.]/.test(new URL(k.url).pathname)) { await c.delete(k); gone.push(new URL(k.url).pathname); } return gone;`);
const hold = (p) => p.eval(`(window.__holds ??= []).push(setInterval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true })), 200)); return 1;`);
const release = (p) => p.eval(`for (const i of window.__holds ?? []) clearInterval(i); window.__holds = []; return 1;`).catch(() => {});
// a path that answered 404 is not requested again and again (no retry loop)
function noLoop(srv, since, what) {
  const gone = new Map();
  for (const r of srv.log) if (r.t >= since && r.status === 404) gone.set(r.path, 0);
  for (const r of srv.log) if (r.t >= since && gone.has(r.path)) gone.set(r.path, gone.get(r.path) + 1);
  const many = [...gone].filter(([, n]) => n > 2);
  check(many.length === 0, `${what}: no path that answered 404 is requested more than twice`, JSON.stringify(many));
  return [...gone.keys()];
}
async function withContext(fn) {
  const { browserContextId: ctx } = await browser.send('Target.createBrowserContext');
  try { return await fn(ctx); } finally { await browser.send('Target.disposeBrowserContext', { browserContextId: ctx }).catch(() => {}); }
}
// runs a scenario for each host variant at once (the two servers); returns their reports
const VARIANTS = legacyOk ? [['B', 'without legacy files'], ['B+L', 'with legacy files']] : [['B', 'without legacy files']];
const report = [];
async function both(name, fn, variants = VARIANTS) {
  const t0 = Date.now();
  const out = await Promise.all(variants.map(async ([to, how], i) => {
    const srv = servers[i], sink = { bad: [], numbers: 0 }, since = Date.now();
    srv.label = 'A';
    const what = `${name} (${how})`;
    let lines = [];
    try { lines = await withContext((ctx) => fn({ srv, ctx, to, what, sink, legacy: to.endsWith('+L') })); } catch (e) { check(false, `${what}: ran`, e.stack); }
    check(sink.bad.length === 0, `${what}: every number shown is one of the page's own build (${sink.numbers} samples with a number)`, JSON.stringify(sink.bad.slice(0, 6)));
    const gone = noLoop(srv, since, what);
    return [`${what}:`, ...lines.map((l) => `  ${l}`), ...(gone.length ? [`  404: ${gone.join(' ')}`] : [])];
  }));
  for (const lines of out) { report.push(...lines); for (const l of lines) log(l); }
  log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
const fmt = (r) => (r.failed ? `failed: ${r.failed}` : `page ${r.build}: ${r.err ? `error "${r.err.slice(0, 90)}" / status "${r.status.slice(0, 90)}"` : r.tp}${r.reloads ? ' (after a reload)' : ''}`);

try {
  // 1: an A tab under A's worker, two tables not in its cache, the host now on B; no update check
  await both('1 old worker, tables not cached', async ({ srv, ctx, to, what, sink, legacy }) => {
    const x = await prep(srv, ctx, 'X', 'A');
    const gone = await removeTables(x, 'A');
    check(gone.length === 2, `${what}: ZEN3's and ICX's tables removed from A's cache`, JSON.stringify(gone));
    const stop = watch(x, sink);
    srv.label = to;
    const z = expectProbe(what, await probe(x, 'Z', 'ZEN3'), { block: 'Z', arch: 'ZEN3', want: legacy ? 'own' : null });
    const i = expectProbe(what, await probe(x, 'I', 'ICX'), { block: 'I', arch: 'ICX', want: legacy ? 'own' : null });
    const lines = [`Z@ZEN3 ${fmt(z)}`, `I@ICX ${fmt(i)}`];
    if (legacy) check(z.build === 'A' && i.build === 'A', `${what}: the A tab computes with A's files from the legacy paths`, JSON.stringify([z.build, i.build]));
    else {
      check(z.build === 'B' || (z.build === 'A' && !!z.err), `${what}: Z@ZEN3: an error on A's page (its table is gone), or B after the reload`, fmt(z));
      if (await settleOn(x, 'B', what)) { const r = expectProbe(what, await probe(x, 'Z', 'ZEN3'), { block: 'Z', arch: 'ZEN3', want: 'own' }); lines.push(`then Z@ZEN3 ${fmt(r)}`); }
    }
    lines.push(`seen: ${(await stop()).join(' > ')}`);
    return lines;
  });

  // 2: B's worker takes over an A tab whose reload waits for a pause in the user's typing; the tab uses tables it has
  // not loaded (B's worker deleted A's cache)
  await both('2 new worker takes over before the reload', async ({ srv, ctx, to, what, sink, legacy }) => {
    const x = await prep(srv, ctx, 'X', 'A');
    const stop = watch(x, sink);
    await hold(x);
    srv.label = to;
    const z = await open(ctx, 'Z');
    await z.cmd('Page.navigate', { url: `${srv.origin}/` });
    await x.waitFor(`(await caches.keys()).join() === 'wuica-${VER.B}'`, 'B in control', 60000);
    const a = expectProbe(what, await probe(x, 'Z', 'ZEN3'), { block: 'Z', arch: 'ZEN3', want: legacy ? 'own' : 'error' });
    const b = expectProbe(what, await probe(x, 'I', 'ICX'), { block: 'I', arch: 'ICX', want: legacy ? 'own' : 'error' });
    check(a.build === 'A' && b.build === 'A', `${what}: (the reload waited: the probes ran on A's page)`, JSON.stringify([a.build, b.build]));
    const lines = [`taken over, busy: Z@ZEN3 ${fmt(a)}`, `I@ICX ${fmt(b)}`];
    await release(x);
    if (await settleOn(x, 'B', what)) {
      const r = expectProbe(what, await probe(x, 'Z', 'ZEN3'), { block: 'Z', arch: 'ZEN3', want: 'own' });
      const s = expectProbe(what, await probe(x, 'I', 'ICX'), { block: 'I', arch: 'ICX', want: 'own' });
      lines.push(`released: Z@ZEN3 ${fmt(r)}`, `I@ICX ${fmt(s)}`);
    }
    lines.push(`seen: ${(await stop()).join(' > ')}`);
    return lines;
  });

  // 3: a link (Z on ZEN3) opened in a new tab mid-swap; (a) the page's manifest.json is answered once B's worker has
  // taken it over (a slow start), (b) ZEN3's table is not in A's cache
  for (const variant of ['a', 'b']) {
    const HOOK = `(() => { if (location.protocol !== 'http:' || sessionStorage.getItem('hooked')) return; sessionStorage.setItem('hooked', '1');
      const orig = window.fetch; let done = false;
      window.fetch = async function (input, init) { const u = String(input?.url ?? input);
        if (!done && /manifest\\.json$/.test(u)) { done = true; await new Promise((r) => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 20000); }); await new Promise((r) => setTimeout(r, 200)); }
        return orig.call(this, input, init); }; })();`;
    await both(`3${variant} a link in a new tab mid-swap${variant === 'a' ? ', its manifest answered by B\'s worker' : ', its table not cached'}`, async ({ srv, ctx, to, what, sink }) => {
      const x = await prep(srv, ctx, 'X', 'A');
      if (variant === 'b') check((await removeTables(x, 'A')).length === 2, `${what}: tables removed from A's cache`);
      await x.close();
      srv.label = to;
      const y = await open(ctx, 'Y', { init: variant === 'a' ? HOOK : null });
      const stop = watch(y, sink);
      await y.cmd('Page.navigate', { url: `${srv.origin}/#${encodeState({ ...DEFAULT_STATE, mode: 'hex', text: Z, arch: 'ZEN3', cpus: 'ZEN3' })}` });
      const ok = await settleOn(y, 'B', what);
      let lines = [];
      if (ok) {
        await y.waitFor(`document.querySelector('#result-body .tp .value') || document.querySelector('#result-body .error-box')`, 'a result', 30000).catch(() => {});
        await sleep(1000);
        const s = await y.eval(`${SNAPSHOT} return snap;`);
        check(s.tp !== null && Number(s.tp) === own('B', 'Z@ZEN3'), `${what}: the link ends as B's page with B's number`, JSON.stringify(s));
        lines.push(`ends on page ${nameOf(s.html)}: ${s.tp}`);
      }
      lines.push(`seen: ${(await stop()).join(' > ')}`);
      return lines;
    });
  }

  // 4: a rollback: the host back on A (without, or with, B's legacy files); A's worker takes over a B tab that is busy
  await both('4 rollback', async ({ srv, ctx, what, sink, legacy }) => {
    srv.label = 'B';
    const x = await prep(srv, ctx, 'X', 'B');
    const stop = watch(x, sink);
    await hold(x);
    srv.label = legacy ? 'A+L' : 'A';
    const z = await open(ctx, 'Z');
    await z.cmd('Page.navigate', { url: `${srv.origin}/` });
    await x.waitFor(`(await caches.keys()).join() === 'wuica-${VER.A}'`, 'A in control', 60000);
    const a = expectProbe(what, await probe(x, 'Z', 'ZEN3'), { block: 'Z', arch: 'ZEN3', want: legacy ? 'own' : 'error' });
    const b = expectProbe(what, await probe(x, 'I', 'ICX'), { block: 'I', arch: 'ICX', want: legacy ? 'own' : 'error' });
    check(a.build === 'B' && b.build === 'B', `${what}: (the reload waited: the probes ran on B's page)`, JSON.stringify([a.build, b.build]));
    const lines = [`taken over, busy: Z@ZEN3 ${fmt(a)}`, `I@ICX ${fmt(b)}`];
    await release(x);
    if (await settleOn(x, 'A', what)) { const r = expectProbe(what, await probe(x, 'Z', 'ZEN3'), { block: 'Z', arch: 'ZEN3', want: 'own' }); lines.push(`released: Z@ZEN3 ${fmt(r)}`); }
    lines.push(`seen: ${(await stop()).join(' > ')}`);
    return lines;
  });

  // 5: Data Saver: no prefetch, so only SKL's table is cached; the host switches; the A tab uses ZEN3 and ICX
  await both('5 Data Saver', async ({ srv, ctx, to, what, sink, legacy }) => {
    const since = Date.now();
    const x = await prep(srv, ctx, 'X', 'A', { saveData: true });
    const tables = [...new Set(srv.log.filter((r) => r.t >= since && r.path.startsWith('/data/arch/')).map((r) => r.path))];
    check(tables.length === 1 && /\/SKL[.]/.test(tables[0]), `${what}: no prefetch (only SKL's table was fetched)`, JSON.stringify(tables));
    const stop = watch(x, sink);
    srv.label = to;
    const z = expectProbe(what, await probe(x, 'Z', 'ZEN3'), { block: 'Z', arch: 'ZEN3', want: legacy ? 'own' : null });
    const i = expectProbe(what, await probe(x, 'I', 'ICX'), { block: 'I', arch: 'ICX', want: legacy ? 'own' : null });
    const lines = [`Z@ZEN3 ${fmt(z)}`, `I@ICX ${fmt(i)}`];
    if (!legacy) {
      check(z.build === 'B' || (z.build === 'A' && !!z.err), `${what}: Z@ZEN3: an error on A's page, or B after the reload`, fmt(z));
      if (await settleOn(x, 'B', what)) { const r = expectProbe(what, await probe(x, 'I', 'ICX'), { block: 'I', arch: 'ICX', want: 'own' }); lines.push(`then I@ICX ${fmt(r)}`); }
    }
    lines.push(`seen: ${(await stop()).join(' > ')}`);
    return lines;
  });

  // 6: offline. (a) a new tab of an A profile (everything cached) with the host gone; (b) Data Saver, offline: a table
  // that is not cached is an error (not final: it works once the host is back)
  await both('6 offline', async ({ srv, ctx, what, sink }) => {
    const lines = [];
    {
      const x = await prep(srv, ctx, 'X', 'A');
      await x.close();
      await srv.stop();
      const y = await open(ctx, 'Y');
      const stop = watch(y, sink);
      await y.goto(`${srv.origin}/`);
      await y.waitFor(READY, 'offline page', 30000);
      const z = expectProbe(`${what} (a)`, await probe(y, 'Z', 'ZEN3'), { block: 'Z', arch: 'ZEN3', want: 'own' });
      const i = expectProbe(`${what} (a)`, await probe(y, 'I', 'ICX'), { block: 'I', arch: 'ICX', want: 'own' });
      lines.push(`(a) all cached: Z@ZEN3 ${fmt(z)}`, `I@ICX ${fmt(i)}`, `seen: ${(await stop()).join(' > ')}`);
      await y.close();
      await srv.start();
    }
    return lines;
  }, VARIANTS.slice(0, 1));
  await both('6b offline, Data Saver', async ({ srv, ctx, what, sink }) => {
    const x = await prep(srv, ctx, 'X', 'A', { saveData: true });
    const stop = watch(x, sink);
    await srv.stop();
    const z = expectProbe(what, await probe(x, 'Z', 'ZEN3'), { block: 'Z', arch: 'ZEN3' });
    check(z.build === 'A' && !!z.err && z.tp === null, `${what}: a table that is not cached, offline: an error`, fmt(z));
    await srv.start();
    const again = expectProbe(what, await probe(x, 'Z', 'ZEN3'), { block: 'Z', arch: 'ZEN3', want: 'own' });
    check(again.build === 'A' && !again.err && Number(again.tp) === own('A', 'Z@ZEN3'), `${what}: back online, the table loads and A's number shows`, fmt(again));
    return [`offline: Z@ZEN3 ${fmt(z)}`, `online again: ${fmt(again)}`, `seen: ${(await stop()).join(' > ')}`];
  }, VARIANTS.slice(0, 1));
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  await close();
  for (const s of servers) if (s.up) await s.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(check.summary() ? 1 : 0);
