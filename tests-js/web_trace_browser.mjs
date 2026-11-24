// End-to-end test of the trace view (web/js/trace.js) in the built site (web/dist), in headless Chrome over the
// DevTools protocol; no dependencies (Node 22+). Run web/build.sh first.
//
//    node tests-js/web_trace_browser.mjs [--chrome PATH] [--shots DIR]
//
// It opens a 50-instruction loop with the real analyzer, opens the trace, and checks the tooltip of some uops
// against the trace JSON, which this test makes itself with the same module under Node (independently of the
// view's model). --shots DIR saves screenshots. Skips (exit 0) if Chrome is not found.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';
import { hostHandler } from './static-host.mjs';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { FRAME_MS } from './cdp.mjs'; // (the bound of the "under a frame" check: looser on CI)

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const dist = path.join(repo, 'web', 'dist');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const shots = opt('--shots');
const chrome = findChrome(opt('--chrome'));
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the block, and its trace made under Node ------------------------------------------------------------------------
const pat = ['4801d8', '480fafca', 'c5f458c2', '488b16', '488907', '4531c0', '4d89d1', '50', '59', '90', '4883c001', 'c5fc59c8'];
let body = '';
for (let i = 0; i < 48; i++) body += pat[i % pat.length];
body += '49ffcf';
const rel = (0x100000000 - (body.length / 2 + 6)).toString(16).padStart(8, '0').match(/../g).reverse().join('');
const HEX = body + '0f85' + rel;
const ARCH = 'SKL';
const engine = await WasmEngine.create(fs.readFileSync(path.join(dist, 'wuica_wasm.wasm')));
await engine.loadUarch(fs.readFileSync(path.join(dist, 'data', 'uarch.json')));
await engine.loadArch(ARCH, fs.readFileSync(path.join(dist, 'data', 'arch', `${ARCH}.bin`)));
const reference = await engine.analyze(makeRequest(HEX, ARCH, { includeTrace: true }));
const TRACE = reference.trace;

// The events of one uop (key "rnd/instrID/lamUopID/fUopID/uopID"), read straight from the trace JSON.
function eventsOf(key) {
  const [rnd, instrID, lam, f, u] = key.split('/').map(Number);
  const is = (r, level) => r.rnd === rnd && r.instrID === instrID && r.lamUopID === lam && (level < 2 || r.fUopID === f) && (level < 3 || r.uopID === u);
  const out = { port: null };
  for (const cy of TRACE.cycles) {
    for (const r of cy.addedToIDQ ?? []) if (is(r, 1)) out.idq = cy.cycle;
    for (const r of cy.addedToRB ?? []) if (is(r, 2)) out.issued = cy.cycle;
    for (const r of cy.removedFromRB ?? []) if (is(r, 2)) out.retired = cy.cycle;
    for (const r of cy.readyForDispatch ?? []) if (is(r, 3)) out.ready = cy.cycle;
    for (const r of cy.executed ?? []) if (is(r, 3)) out.executed = cy.cycle;
    for (const r of cy.addedToRS ?? []) if (is(r, 3)) out.deps = r.dependsOn.map((d) => ({ name: d.stackSyncUop ? 'stack sync uop' : d.regMergeUop ? 'register merge uop' : TRACE.instructions[d.instrID].asm, rnd: d.rnd }));
    for (const [p, r] of Object.entries(cy.dispatched ?? {})) if (is(r, 3)) { out.dispatched = cy.cycle; out.port = p.replace(/^Port/, 'Port '); }
  }
  return out;
}

// ---- server and browser (as in web_browser.mjs, without the service worker parts) ----------------------------------------
// like the host (redirects /index.html to /, a 404 page, _headers): see static-host.mjs
const server = http.createServer(hostHandler(dist));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-trace-test-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  proc.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(0, 500))));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});

let ws, seq = 0;
const pending = new Map(), handlers = [];
ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to Chrome')); });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result); }
  else for (const h of handlers) h(msg);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, method }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

async function openPage({ width = 1280, height = 900, mobile = false } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const page = { sessionId, problems: [] };
  handlers.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') page.problems.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) page.problems.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) page.problems.push(`log ${m.params.entry.level}: ${m.params.entry.text}`);
  });
  page.cmd = (method, params) => send(method, params, sessionId);
  page.eval = async (expression) => {
    const r = await page.cmd('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  page.goto = async (url) => {
    await page.cmd('Page.navigate', { url });
    await sleep(150);
    for (let t = 0; t < 200; t++) { try { if (await page.eval(`return document.readyState === 'complete'`)) return; } catch { /* navigating */ } await sleep(100); }
    throw new Error('page did not load');
  };
  page.shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await page.cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
  };
  for (const d of ['Runtime', 'Log', 'Page']) await page.cmd(`${d}.enable`);
  await page.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  return page;
}

const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 20000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + f); await wait(30); } };
  const panel = () => document.querySelector('details.trace-panel');
  const viewer = () => panel()?.wuicaTrace;
  const tip = () => { const t = document.querySelector('.trace-tip'); return { hidden: t.hidden, key: t.dataset.key, text: t.innerText,
    stages: Object.fromEntries([...t.querySelectorAll('dd[data-stage]')].map((d) => [d.dataset.stage, d.textContent])),
    deps: [...t.querySelectorAll('.tt-deps li')].map((li) => li.textContent) }; };
  const key = (k) => viewer().canvas.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
`;
const b64 = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const LINK = `#v=1&a=${ARCH}&c=${b64(HEX)}`;

function compare(what, got, keyOf) {
  const want = eventsOf(keyOf);
  const num = (v) => (v === undefined || v === null ? '—' : String(v));
  const idq = (got.stages.idq ?? '').replace(/ \(.*\)$/, '');
  const ok = got.stages.port === (want.port ?? 'none (eliminated)') && num(want.issued) === got.stages.issued && num(want.ready) === got.stages.ready
    && num(want.dispatched) === got.stages.dispatched && num(want.executed) === got.stages.executed && num(want.retired) === got.stages.retired
    && (want.idq === undefined || idq === String(want.idq));
  check(ok, `${what}: the tooltip shows the port and cycles of the trace JSON (${keyOf})`, JSON.stringify({ got: got.stages, want }));
  if (want.deps) check(got.deps.length === want.deps.length && want.deps.every((d, i) => got.deps[i].startsWith(d.name) && got.deps[i].includes(`[it ${d.rnd}]`)), `${what}: what it waited for`, JSON.stringify([got.deps, want.deps]));
  return want;
}

try {
  // --- desktop: the view opens, renders, and its tooltip is right ---------------------------------------------------------
  {
    const page = await openPage();
    await page.goto(`${origin}/?nosw=1${LINK}`);
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.tp .value'));
      const out = { tp: document.querySelector('.tp .value').textContent };
      out.closed = !!panel() && !panel().open && !document.querySelector('.trace-viewer');
      out.label = panel()?.closest('.row')?.querySelector('.label')?.textContent;
      out.inResult = !!panel()?.closest('#more')?.closest('#results'); // the views are tabs of the result pane
      const t0 = performance.now();
      [...document.querySelectorAll('.view-tab')].find((b) => b.textContent === 'trace').click();
      await until(() => document.querySelector('.trace-viewer'));
      out.openMs = performance.now() - t0;
      // open, the trace takes the result pane's width
      out.wide = Math.abs(panel().getBoundingClientRect().width - document.getElementById('results').getBoundingClientRect().width) < 120 && panel().getBoundingClientRect().width > 0;
      await wait(200);
      const v = viewer();
      out.note = document.querySelector('.trace-note').textContent;
      out.range = document.querySelector('.trace-tools select').value;
      out.rows = v.rows.length; out.span = [v.c0, v.c1];
      out.rowRounds = [...new Set(Array.from(v.rows, (i) => v.model.uops[i].rnd))];
      out.relevant = v.model.relevant;
      out.canvas = [v.canvas.width, v.canvas.height, v.canvas.clientWidth];
      // something is drawn: pixels of more than a few colours in the body
      const img = v.canvas.getContext('2d').getImageData(0, 0, v.canvas.width, v.canvas.height).data;
      const colours = new Set(); for (let i = 0; i < img.length; i += 4 * 97) colours.add(img[i] + ',' + img[i + 1] + ',' + img[i + 2]);
      out.colours = colours.size;
      out.legend = [...document.querySelectorAll('.trace-legend li')].map((li) => li.textContent);
      // the legend: in a popover from "?" next to the zoom (closed at first); by keyboard: Enter opens it, Escape closes it
      const qb = document.querySelector('.trace-keybtn'), pop = document.querySelector('.trace-legend-pop');
      out.pop = [pop.hidden, qb.getAttribute('aria-expanded'), qb.closest('.trace-zoomtools') !== null];
      qb.focus(); qb.click(); await wait(30);
      out.pop.push(pop.hidden, qb.getAttribute('aria-expanded'), pop.getBoundingClientRect().height > 40);
      qb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(30);
      out.pop.push(pop.hidden, document.activeElement === qb);
      // the toggles: two buttons with aria-pressed (all ports: off; full waits: off)
      out.toggles = [...document.querySelectorAll('.trace-toggle')].map((b) => b.textContent + ':' + b.getAttribute('aria-pressed'));
      out.buildMs = +document.querySelector('.trace-viewer').dataset.buildMs; out.drawMs = +document.querySelector('.trace-viewer').dataset.drawMs;
      // keyboard: the first uop, then the sixth
      v.canvas.focus(); key('ArrowDown'); await wait(50);
      out.k1 = tip(); out.k1row = v.rows[0]; out.k1key = v.model.uops[v.rows[0]].key; out.live = document.querySelector('.trace-live').textContent;
      for (let i = 0; i < 5; i++) key('ArrowDown'); await wait(50);
      out.k6 = tip(); out.k6key = v.model.uops[v.rows[5]].key;
      // a uop with a dependency inside the shown rows: the tooltip names it and the row is highlighted
      let r = -1; for (let i = 0; i < v.rows.length; i++) { const u = v.model.uops[v.rows[i]]; if (u.deps.some((j) => v.rowSet.has(j)) && u.dispatched !== null) { r = i; break; } }
      key('Home'); for (let i = 0; i < r; i++) key('ArrowDown'); await wait(80);
      out.kd = tip(); out.kdkey = v.model.uops[v.rows[r]].key; out.kdActive = v.active === r;
      key('Escape'); await wait(30); out.escHidden = tip().hidden;
      return out;`);
    check(r.tp === '32.00', 'the 50-instruction loop is analyzed', r.tp);
    check(r.closed && r.label === 'trace' && r.inResult && r.wide, 'the trace panel is in the result, closed, and nothing is loaded until it is opened; open, it is the pane\'s width', JSON.stringify([r.closed, r.label, r.inResult, r.wide]));
    check(r.range === 'steady' && r.rowRounds.length === 3 && r.rowRounds[0] === r.relevant.first && /uops in cycles/.test(r.note), 'it opens on three steady-state iterations', JSON.stringify([r.range, r.rowRounds, r.relevant, r.note]));
    check(r.canvas[0] > 600 && r.canvas[1] > 200 && r.colours >= 5, 'the timeline is drawn', JSON.stringify([r.canvas, r.colours]));
    check(r.legend.length === 11 && r.legend.some((t) => /^7\s*iteration/.test(t)) && r.legend.some((t) => /shortened/.test(t)) && r.legend.some((t) => /ports busy/.test(t)), 'the legend: everything drawn (the iteration numbers, the shortened waits, the compact strip)', JSON.stringify(r.legend));
    check(r.pop.join() === 'true,false,true,false,true,true,true,true', 'the legend is a popover from "?" by the zoom; it opens and Escape closes it (the focus back on "?")', JSON.stringify(r.pop));
    check(r.toggles.join() === 'all ports:false,full waits:false', 'the strip is compact and long waits are short at first', JSON.stringify(r.toggles));
    check(!r.k1.hidden && r.k1.key === r.k1key, 'arrow down focuses the first uop and shows its tooltip', JSON.stringify(r.k1));
    compare('first uop', r.k1, r.k1key);
    check(r.live.includes('issued') && r.live.includes(r.k1.stages.issued), 'the keyboard focus is announced', r.live);
    check(r.k6.key === r.k6key, 'arrow keys move between uops', JSON.stringify([r.k6.key, r.k6key]));
    compare('sixth uop', r.k6, r.k6key);
    check(r.kd.key === r.kdkey && r.kdActive && r.kd.deps.length > 0, 'a uop with a dependency', JSON.stringify(r.kd));
    const kd = compare('uop with a dependency', r.kd, r.kdkey);
    check(kd.deps?.length === r.kd.deps.length, 'the tooltip lists every dependency');
    check(r.escHidden, 'Escape hides the tooltip');
    console.log(`open (second analysis + model + layout) ${r.openMs.toFixed(0)} ms; model ${r.buildMs} ms; first draw ${r.drawMs} ms; ${r.rows} rows`);
    await page.shot('trace-desktop.png');

    // mouse: a real pointer move over a row shows that row's uop
    const pt = await page.eval(`${HELPERS}
      const v = viewer(); const r = 4; const u = v.model.uops[v.rows[r]];
      v.reveal(r); await wait(50);
      const p = v.pointOf(r, u.dispatched ?? u.issued); const b = v.canvas.getBoundingClientRect();
      return { x: b.left + p.x, y: b.top + p.y, key: u.key };`);
    await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await sleep(150);
    const hov = await page.eval(`${HELPERS} return tip();`);
    check(!hov.hidden && hov.key === pt.key, 'hovering a row shows its uop', JSON.stringify([hov.key, pt.key]));
    compare('hovered uop', hov, pt.key);
    await page.shot('trace-hover.png');
    // the compact strip (one row per group of ports): hovering a cycle says how many of the group are busy, and with what
    const gs = await page.eval(`${HELPERS}
      const v = viewer(); const u = v.model.uops[v.rows[4]];
      const g = v.groups.findIndex((q) => q.ports.some((p) => p.id === u.port)); const b = v.canvas.getBoundingClientRect();
      return { x: b.left + v.x(u.dispatched) + v.scale / 2, y: b.top + 18 + g * 9 + 4, group: v.groups[g].name, c: u.dispatched, groups: v.groups.length, ports: v.ports.length };`);
    await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gs.x, y: gs.y });
    await sleep(150);
    const gst = await page.eval(`${HELPERS} return tip();`);
    check(gs.groups < gs.ports && new RegExp('^' + gs.group + ' \\(\\d+ of \\d+ busy\\), cycle ' + gs.c).test(gst.text) && !/none busy/.test(gst.text), 'the compact strip: fewer rows than ports; hovering names how many of the group are busy, and with what', JSON.stringify([gst.text.slice(0, 120), gs]));
    // "all ports": a row per port, as before
    const ps = await page.eval(`${HELPERS}
      [...document.querySelectorAll('.trace-toggle')].find((b) => b.textContent === 'all ports').click(); await wait(50);
      const v = viewer(); const u = v.model.uops[v.rows[4]];
      const p = v.ports.findIndex((q) => q.id === u.port); const b = v.canvas.getBoundingClientRect();
      return { x: b.left + v.x(u.dispatched) + v.scale / 2, y: b.top + 18 + p * 9 + 4, port: v.ports[p].name, c: u.dispatched, pressed: document.querySelector('.trace-toggle').getAttribute('aria-pressed') };`);
    check(ps.pressed === 'true', '"all ports" is pressed');
    await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ps.x, y: ps.y });
    await sleep(150);
    const pst = await page.eval(`${HELPERS} return tip();`);
    check(pst.text.startsWith(`${ps.port}, cycle ${ps.c}`) && pst.key === pt.key, 'hovering the port strip names the dispatched uop', JSON.stringify([pst.text.slice(0, 80), ps]));
    await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });

    // zoom, range, table, theme, re-render
    const z = await page.eval(`${HELPERS}
      const v = viewer(); const out = {};
      const s0 = v.scale; document.querySelector('.trace-zoom[aria-label="zoom in"]').click(); await wait(50); out.zoom = [s0, v.scale, document.querySelector('.trace-scale').textContent];
      key('-'); await wait(30); out.zoomKey = v.scale;
      const sel = document.querySelector('.trace-tools select');
      sel.value = 'all'; sel.dispatchEvent(new Event('change')); await wait(100);
      out.all = [v.rows.length, v.model.uops.length, v.c0, v.c1];
      // as it opens (the strip compact, the waits short); then every port and the waits in full
      const allPorts = [...document.querySelectorAll('.trace-toggle')].find((b) => b.textContent === 'all ports');
      allPorts.click(); await wait(50); out.compact = allPorts.getAttribute('aria-pressed');
      const times = [];
      for (let i = 0; i < 30; i++) { v.scroller.scrollTop += 150; v.scroller.scrollLeft += 40; v.draw(); times.push(v.lastDrawMs); }
      out.drawMax = Math.max(...times); out.drawAvg = times.reduce((a, b) => a + b) / times.length;
      // the same with the waits drawn in full (and every port: "all ports" is pressed above)
      const fw = [...document.querySelectorAll('.trace-toggle')].find((b) => b.textContent === 'full waits');
      allPorts.click(); fw.click(); await wait(50); v.scroller.scrollTop = 0;
      const tf = []; for (let i = 0; i < 30; i++) { v.scroller.scrollTop += 150; v.scroller.scrollLeft += 40; v.draw(); tf.push(v.lastDrawMs); }
      out.drawMaxFull = Math.max(...tf); out.fullPressed = fw.getAttribute('aria-pressed') + allPorts.getAttribute('aria-pressed');
      fw.click(); await wait(50);
      sel.value = 'steady'; sel.dispatchEvent(new Event('change')); await wait(50);
      document.querySelector('.trace-mode input[value=table]').click(); await wait(100);
      const rows = [...document.querySelectorAll('table.trace-table tbody tr')];
      out.table = [rows.length, v.rows.length, document.querySelectorAll('table.trace-table thead th').length, rows[0].children[1].textContent, rows[0].innerText.replace(/\\t+/g, '|')];
      out.chartHidden = document.querySelector('.trace-chart').hidden;
      let copied = null; navigator.clipboard.writeText = async (t) => { copied = t; };
      [...document.querySelectorAll('.trace-tabletools button')][0].click(); await wait(50);
      out.copied = copied ? copied.split('\\n').slice(0, 2) : null;
      document.querySelector('.trace-mode input[value=chart]').click(); await wait(100);
      // the theme: the canvas reads the page's custom properties again when they change
      document.documentElement.style.setProperty('--surface', 'rgb(250, 248, 240)');
      await wait(150);
      const px = v.canvas.getContext('2d').getImageData(2, 2, 1, 1).data;
      out.themed = [px[0], px[1], px[2]];
      document.documentElement.style.removeProperty('--surface');
      // other parts of the result are opened and closed (objdump, uiCA report): the panel stays open with its view
      // (the "hide empty columns" redraw this used is gone: empty columns are always hidden)
      const before = v.rows.length;
      for (const sel of ['details.listing-wrap summary', 'details.report-wrap summary']) { document.querySelector(sel).click(); await wait(50); document.querySelector(sel).click(); await wait(50); }
      out.redraw = [panel().open, viewer() === v, v.rows.length === before, !!document.querySelector('.trace-viewer canvas').isConnected];
      out.overflow = document.documentElement.scrollWidth - innerWidth;
      return out;`);
    check(z.zoom[1] > z.zoom[0] && /px per cycle|cycles per px/.test(z.zoom[2]) && z.zoomKey < z.zoom[1], 'zoom buttons and keys', JSON.stringify(z.zoom));
    check(z.all[0] === z.all[1] && z.all[2] === 0, '"all" shows every uop', JSON.stringify(z.all));
    check(z.compact === 'false' && z.drawMax < FRAME_MS, `drawing all ${z.all[0]} uops (compact strip, short waits) stays under a frame (max ${z.drawMax.toFixed(2)} ms; bound ${FRAME_MS} ms)`);
    check(z.fullPressed === 'truetrue' && z.drawMaxFull < FRAME_MS, `drawing all ${z.all[0]} uops with every port and the waits in full stays under a frame (max ${z.drawMaxFull.toFixed(2)} ms)`);
    check(z.table[0] === z.table[1] && z.table[2] === 11 && z.table[3].length > 0 && z.chartHidden, 'the table view lists the same uops', JSON.stringify(z.table));
    check(z.copied?.[0].startsWith('iteration\tinstruction\tport\tpredecoded\tIDQ\tissued') && z.copied[1].split('\t').length === 11, 'the table copies as tab-separated text', JSON.stringify(z.copied));
    check(z.themed.join() === '250,248,240', 'the canvas follows the theme\'s custom properties', JSON.stringify(z.themed));
    check(z.redraw.every(Boolean), 'the panel survives other parts of the result opening and closing', JSON.stringify(z.redraw));
    check(z.overflow <= 0, 'no sideways scrolling of the page at 1280px', z.overflow);
    console.log(`draw with all ${z.all[0]} uops (compact, short waits): avg ${z.drawAvg.toFixed(2)} ms, max ${z.drawMax.toFixed(2)} ms; all ports + waits in full: max ${z.drawMaxFull.toFixed(2)} ms`);

    // a new run replaces the trace (the open panel loads the new one)
    const n = await page.eval(`${HELPERS}
      const v = viewer(); const run = $('results').dataset.run;
      $('examples').value = 'chain'; $('examples').dispatchEvent(new Event('change'));
      await until(() => $('results').dataset.run !== run);
      await until(() => viewer() && viewer() !== v);
      return { rows: viewer().rows.length, tp: document.querySelector('.tp .value').textContent, labels: viewer().model.labels };`);
    check(n.tp === '2.00' && n.rows === 9 && n.labels[2] === 'dec r15 + jnz 0xfffffffffffffff5', 'a new analysis brings its own trace into the open panel', JSON.stringify(n));
    // Zen 3 names its ports (uarch.json portNames); the trace has letters
    const zen = await page.eval(`${HELPERS}
      const v = viewer(); const run = $('results').dataset.run;
      for (const b of document.querySelectorAll('#cpu-grid input')) b.checked = b.value === 'ZEN3'; // only ZEN3 (one change event)
      document.querySelector('#cpu-grid input').dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => $('results').dataset.run !== run, 30000);
      await until(() => viewer() && viewer() !== v);
      const w = viewer(); w.canvas.focus();
      const r = Array.from(w.rows).findIndex((i) => w.model.uops[i].dispatched !== null);
      key('Home'); for (let i = 0; i < r; i++) key('ArrowDown'); await wait(50);
      return { port: tip().stages.port, strips: w.ports.map((p) => p.short) };`);
    check(/^ALU\d$/.test(zen.port) && zen.strips.includes('ALU0') && !zen.strips.includes('a'), 'ZEN3: ports are shown by their names', JSON.stringify(zen));
    const problems = page.problems.filter((p) => !/willReadFrequently/.test(p)); // from this test's own readbacks
    check(problems.length === 0, 'no console errors (desktop)', problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- phone width ----------------------------------------------------------------------------------------------------------
  {
    const page = await openPage({ width: 375, height: 812, mobile: true });
    await page.goto(`${origin}/?nosw=1${LINK}`);
    const m = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.tp .value'));
      panel().querySelector('summary').click();
      await until(() => document.querySelector('.trace-viewer'));
      await wait(200);
      const v = viewer(); v.canvas.focus(); key('ArrowDown'); await wait(50);
      return { overflow: document.documentElement.scrollWidth - innerWidth, inner: innerWidth, client: document.documentElement.clientWidth, canvas: v.canvas.clientWidth, scroller: v.scroller.clientWidth, field: v.root.parentElement.getBoundingClientRect().width, tip: tip().hidden };`);
    check(m.overflow <= 0 && m.inner === 375 && m.canvas <= 375 && !m.tip, 'at 375px: the page does not scroll sideways; the trace scrolls in its box', JSON.stringify(m));
    await page.shot('trace-phone.png');
    check(page.problems.length === 0, 'no console errors (phone)', page.problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- mock mode: no traces --------------------------------------------------------------------------------------------------
  {
    const page = await openPage();
    await page.goto(`${origin}/?mock=1&nosw=1#v=1&c=NDggODMgYzAgMDEgNDggODMgYzAgMDEgNDkgZmYgY2YgNzUgZjM`);
    const k = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.tp .value'));
      panel().querySelector('summary').click(); await wait(300);
      return document.querySelector('.trace-body').innerText;`);
    check(/mock engine .* no traces/.test(k), 'mock mode says that it has no traces', k);
    await page.cmd('Page.close');
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  ws.close();
  proc.kill();
  server.close();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile */ }
}

console.log(`${count} trace browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
