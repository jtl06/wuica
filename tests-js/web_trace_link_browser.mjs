// End-to-end test of the uop table linked to the trace, the wait column and the A–B traces (web/js/trace-link.js,
// web/js/trace.js) in the built site (web/dist), in headless Chrome over the DevTools protocol; no dependencies
// (Node 22+). Run web/build.sh first.
//
//    node tests-js/web_trace_link_browser.mjs [--chrome PATH] [--shots DIR]
//
// The expected values come from the trace JSON, made by this test with the analyzer under Node and read straight from
// its events (not with the view's model). --shots DIR saves screenshots (1440×900 and 375×812, dark and light). Skips
// (exit 0) if Chrome is not found.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostHandler } from './static-host.mjs';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { stopChrome } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'web', 'dist');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const shots = opt('--shots');
const chrome = opt('--chrome') || process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the blocks and their traces, made under Node ----------------------------------------------------------------------
// a loop with a register-merge uop (mov ah after mov ax), a stack-sync uop (push/pop), eliminated moves and a fused dec/jnz
const pat = ['4801d8', '480fafca', 'c5f458c2', '488b16', '488907', '4531c0', '4d89d1', '50', '59', '90', '4883c001', 'c5fc59c8', '66b80100', '88c4'];
const body = pat.join('') + '49ffcf';
const rel = (0x100000000 - (body.length / 2 + 6)).toString(16).padStart(8, '0').match(/../g).reverse().join('');
const HEX = body + '0f85' + rel;
const ARCH = 'SKL';
const engine = await WasmEngine.create(fs.readFileSync(path.join(dist, 'wuica_wasm.wasm')));
await engine.loadUarch(fs.readFileSync(path.join(dist, 'data', 'uarch.json')));
await engine.loadArch(ARCH, zlib.gunzipSync(fs.readFileSync(path.join(dist, 'data', 'arch', `${ARCH}.bin.gz`))));
const reference = await engine.analyze(makeRequest(HEX, ARCH, { includeTrace: true }));
const TRACE = reference.trace;
const dot = (id) => CLASSIC_EXAMPLES.find((e) => e.id === id).hex;
const TRACE_A = (await engine.analyze(makeRequest(dot('dot1'), ARCH, { includeTrace: true }))).trace;
const TRACE_B = (await engine.analyze(makeRequest(dot('dot4'), ARCH, { includeTrace: true }))).trace;

// Per (instrID, kind): the uops' issue, IDQ and retire cycles, from the events (rnd -> key -> {idq, issued, retired}).
function rawUops(trace) {
  const lam = new Map(), fused = new Map();
  const kind = (r) => (r.regMergeUop ? 'regMerge' : r.stackSyncUop ? 'stackSync' : 'instr');
  for (const cy of trace.cycles) {
    for (const r of cy.addedToIDQ ?? []) lam.set(`${r.rnd}/${r.instrID}/${r.lamUopID}`, cy.cycle);
    for (const r of cy.addedToRB ?? []) fused.set(`${r.rnd}/${r.instrID}/${r.lamUopID}/${r.fUopID}`, { rnd: r.rnd, instrID: r.instrID, kind: kind(r), issued: cy.cycle, lam: `${r.rnd}/${r.instrID}/${r.lamUopID}` });
    for (const r of cy.removedFromRB ?? []) { const f = fused.get(`${r.rnd}/${r.instrID}/${r.lamUopID}/${r.fUopID}`); if (f) f.retired = cy.cycle; }
  }
  // the unfused uops of each fused uop: they share its IDQ, issue and retire cycles
  const unfused = new Map();
  for (const cy of trace.cycles) {
    const all = [...(cy.addedToRS ?? []), ...Object.values(cy.dispatched ?? {}), ...(cy.executed ?? [])];
    for (const r of all) { const fk = `${r.rnd}/${r.instrID}/${r.lamUopID}/${r.fUopID}`; if (!unfused.has(fk)) unfused.set(fk, new Set()); unfused.get(fk).add(r.uopID); }
  }
  const out = [];
  for (const [fk, f] of fused) for (let k = 0; k < Math.max(1, unfused.get(fk)?.size ?? 0); k++) out.push({ ...f, idq: lam.get(f.lam) ?? null });
  return out;
}
// the first issue of each round
function roundStarts(trace) {
  const s = new Map();
  for (const cy of trace.cycles) for (const r of cy.addedToRB ?? []) if (!s.has(r.rnd)) s.set(r.rnd, cy.cycle);
  return s;
}

// ---- server and browser ------------------------------------------------------------------------------------------------
const server = http.createServer(hostHandler(dist));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-link-test-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  proc.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(0, 500))));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});
let seq = 0;
const pending = new Map(), handlers = [];
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to Chrome')); });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result); }
  else for (const h of handlers) h(msg);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, method }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

async function openPage({ width = 1440, height = 900, mobile = false } = {}) {
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
    await page.cmd('Page.navigate', { url: 'about:blank' });
    await sleep(50);
    await page.cmd('Page.navigate', { url });
    await sleep(150);
    for (let t = 0; t < 200; t++) { try { if (await page.eval(`return document.readyState === 'complete'`)) return; } catch { /* navigating */ } await sleep(100); }
    throw new Error('page did not load');
  };
  // a screenshot of the region from the top of element a to the bottom of element b (the whole width)
  page.shot = async (name, a = null, b = null) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    let clip;
    if (a) {
      const r = await page.eval(`const A = document.querySelector(${JSON.stringify(a)}).getBoundingClientRect(), B = document.querySelector(${JSON.stringify(b ?? a)}).getBoundingClientRect();
        return { y: Math.max(0, Math.min(A.top, B.top) + scrollY - 12), h: Math.max(A.bottom, B.bottom) - Math.min(A.top, B.top) + 24, w: innerWidth };`);
      clip = { x: 0, y: r.y, width: r.w, height: Math.min(r.h, 3000), scale: 1 };
    }
    const { data } = await page.cmd('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
  };
  page.theme = (t) => page.eval(`document.documentElement.dataset.theme = ${JSON.stringify(t)}; await new Promise((r) => setTimeout(r, 120)); return 1;`);
  for (const d of ['Runtime', 'Log', 'Page']) await page.cmd(`${d}.enable`);
  await page.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  return page;
}

const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 30000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + f); await wait(30); } };
  const panel = () => document.querySelector('#trace-slot details.trace-panel');
  const viewer = () => panel()?.wuicaTrace;
  const trs = () => [...document.querySelectorAll('table.uops tbody tr')];
  const gk = (u) => u.instrID + '/' + u.kind;
  const hash = () => location.hash;
  const over = (el) => el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const shownLabels = (v, k) => [...new Set(Array.from(v.rows).map((i) => v.model.uops[i]).filter((u) => gk(u) === k).map((u) => v.model.labels[u.instrID] + '|' + u.kind))];
  const overflow = () => document.documentElement.scrollWidth - innerWidth;
  // the table and the trace are tabs of the result (workspace.js): one shows at a time
  const tab = async (name) => { [...document.querySelectorAll('.view-tab')].find((b) => b.textContent === name).click(); await wait(50);
    if (name === 'trace') await until(() => panel().open && viewer() && viewer().viewW > 0); };
  const shownTab = () => document.querySelector('.view-tab[aria-selected="true"]')?.textContent;
  const inView = (el) => { const b = el?.getBoundingClientRect(); return !!b && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight; };
`;
const b64 = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const LINK = `#v=1&a=${ARCH}&c=${b64(HEX)}`;
const ROWS = reference.rows;
// the instruction of each table row, from the rows alone: [instrID, kind] (a macro-fused branch: the one before it)
const expectGroup = (row) => {
  let k = 0;
  for (let i = 0; i < row; i++) if (ROWS[i].kind === 'instr') k++;
  const x = ROWS[row];
  return x.kind === 'instr' && x.notes === 'M' ? `${k - 1}/instr` : `${k}/${x.kind}`;
};
const regMergeRow = ROWS.findIndex((x) => x.kind === 'regMerge');
const instrRow = ROWS.findIndex((x, i) => i > 2 && x.kind === 'instr' && x.label.startsWith('vaddps'));
const fusedRow = ROWS.findIndex((x) => x.notes === 'M');

try {
  // --- desktop: table -> trace ---------------------------------------------------------------------------------------------
  const page = await openPage();
  await page.goto(`${origin}/?nosw=1${LINK}`);
  const a = await page.eval(`${HELPERS}
    await until(() => document.querySelector('.tp .value'));
    const out = { tp: document.querySelector('.tp .value').textContent, closed: !panel().open && !viewer(), tabbable: trs().filter((t) => t.getAttribute('tabindex') === '0').length,
      linkable: document.querySelector('table.uops').classList.contains('tl-linkable'), waitsBox: !!document.querySelector('.tl-waits-box'), waitsOff: !document.querySelector('.tl-wait') };
    // hovering a row before the trace is loaded: nothing is loaded
    over(trs()[${instrRow}]); await wait(100);
    out.stillClosed = !panel().open && !viewer();
    // a click on a row selects it; the trace stays closed (another tab)
    trs()[${instrRow}].click(); await wait(100);
    out.notOpened = [!panel().open, !viewer(), shownTab()];
    // the trace tab: scrolled to the selected instruction
    await tab('trace');
    await wait(150);
    const v = viewer();
    out.open = panel().open; out.sel = v.selKey; out.hash = hash();
    const first = Array.from(v.rows).findIndex((i) => gk(v.model.uops[i]) === v.selKey);
    out.visible = first * 16 >= v.scroller.scrollTop && (first + 1) * 16 <= v.scroller.scrollTop + v.viewH - v.headH();
    out.labels = shownLabels(v, v.selKey);
    out.rowSel = trs()[${instrRow}].classList.contains('tl-sel') && trs()[${instrRow}].getAttribute('aria-current') === 'true';
    const tr = panel().getBoundingClientRect(); out.inView = tr.top < innerHeight && tr.bottom > 0;
    // the register-merge row selected in the table: the trace tab marks its uops (and only them)
    await tab('table'); trs()[${regMergeRow}].click(); await tab('trace'); await wait(50);
    out.merge = [v.selKey, shownLabels(v, v.selKey)];
    // the macro-fused branch: the uops of the instruction before it
    await tab('table'); trs()[${fusedRow}].click(); await tab('trace'); await wait(50);
    out.fused = [v.selKey, shownLabels(v, v.selKey)];
    // the row selected again; the link on an instruction name works as before: no selection
    await tab('table'); trs()[${instrRow}].click(); await wait(50);
    let navigated = 0; const stop = (e) => { if (e.target.closest('a')) { e.preventDefault(); navigated++; } };
    document.addEventListener('click', stop);
    const link = trs()[${instrRow + 1}].querySelector('a'); link.click(); await wait(30);
    document.removeEventListener('click', stop);
    out.anchor = [!!link, navigated, hash().includes('sel=${instrRow + 1}'), v.selKey];
    return out;`);
  check(a.tp === reference.tp.toFixed(2), 'the loop is analyzed', a.tp);
  check(a.closed && a.linkable && a.tabbable === 1 && a.waitsBox && a.waitsOff, 'the trace is closed; the rows are linkable, one is in the tab order; the wait column is off', JSON.stringify(a));
  check(a.stillClosed, 'hovering a row does not load the trace');
  check(a.notOpened[0] && a.notOpened[1] && a.notOpened[2] === 'table', 'a click on a row does not open the trace', JSON.stringify(a.notOpened));
  check(a.open && a.sel === expectGroup(instrRow) && a.visible && a.rowSel && a.inView, 'a click on a row selects it; the trace tab is scrolled to its instruction (in view)', JSON.stringify(a));
  check(a.labels.length === 1 && a.labels[0] === `${ROWS[instrRow].label}|instr`, 'the trace marks the uops of the row\'s instruction', JSON.stringify(a.labels));
  check(/trace=1/.test(a.hash) && new RegExp(`sel=${instrRow}(&|$)`).test(a.hash), 'the open trace and the selected row are in the URL', a.hash);
  check(a.merge[0] === expectGroup(regMergeRow) && a.merge[1].length === 1 && a.merge[1][0].endsWith('|regMerge'), 'a register-merge row marks its own uops', JSON.stringify(a.merge));
  check(a.fused[0] === expectGroup(fusedRow) && a.fused[1][0]?.startsWith('dec r15 + jnz'), 'the macro-fused branch marks the uops of its pair', JSON.stringify(a.fused));
  check(a.anchor[0] && a.anchor[1] === 1 && !a.anchor[2] && a.anchor[3] === expectGroup(instrRow), 'the link on an instruction name still works and does not select the row', JSON.stringify(a.anchor));

  // keyboard
  const k = await page.eval(`${HELPERS}
    const v = viewer(); const out = {};
    const t = trs()[${instrRow}]; t.focus(); await wait(30);
    out.focus = [document.activeElement === t, t.getAttribute('tabindex')];
    key(t, 'ArrowDown'); await wait(30);
    const n = trs()[${instrRow + 1}];
    out.down = [document.activeElement === n, n.getAttribute('tabindex'), t.getAttribute('tabindex')];
    key(n, 'Enter'); await wait(80);
    out.enter = [hash().includes('sel=${instrRow + 1}'), n.classList.contains('tl-sel')];
    await tab('trace'); out.enter.push(v.selKey, shownLabels(v, v.selKey).length);
    await tab('table'); n.focus();
    key(n, 'Escape'); await wait(30);
    out.esc = [hash().includes('sel='), document.querySelectorAll('tr.tl-sel').length];
    await tab('trace'); out.esc.push(v.selKey);
    await tab('table'); n.focus();
    key(n, 'Enter'); await wait(30);
    // the trace tab: Enter on a uop selects its row
    await tab('trace');
    v.canvas.focus();
    v.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    for (let i = 0; i < 3; i++) v.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await wait(30);
    const u = v.model.uops[v.rows[v.active]];
    out.traceKey = gk(u);
    v.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(50);
    out.traceEnter = [document.querySelector('tr.tl-sel')?.sectionRowIndex ?? -1, hash()];
    return out;`);
  check(k.focus[0] && k.focus[1] === '0', 'keyboard: a row takes the focus', JSON.stringify(k.focus));
  check(k.down[0] && k.down[1] === '0' && k.down[2] === '-1', 'keyboard: arrow down moves to the next row (one row in the tab order)', JSON.stringify(k.down));
  check(k.enter[0] && k.enter[1] && k.enter[2] === expectGroup(instrRow + 1) && k.enter[3] > 0, 'keyboard: Enter selects the row and the trace tab follows', JSON.stringify(k.enter));
  check(!k.esc[0] && k.esc[1] === 0 && k.esc[2] === null, 'keyboard: Escape clears the selection (in the trace too)', JSON.stringify(k.esc));
  const traceRow = ROWS.findIndex((_, i) => expectGroup(i) === k.traceKey && ROWS[i].notes !== 'M');
  check(k.traceEnter[0] === traceRow && k.traceEnter[1].includes(`sel=${traceRow}`), 'keyboard: Enter on a uop of the trace selects its row', JSON.stringify([k, traceRow]));

  // trace -> table with a real pointer
  const pt = await page.eval(`${HELPERS}
    const v = viewer(); v.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); v.canvas.blur(); let r = Array.from(v.rows).findIndex((i) => gk(v.model.uops[i]) === ${JSON.stringify(expectGroup(regMergeRow))});
    v.reveal(r); await wait(50);
    const u = v.model.uops[v.rows[r]]; const p = v.pointOf(r, u.dispatched ?? u.issued); let b = v.canvas.getBoundingClientRect();
    // the point in the viewport, wherever the trace is in the result (the page or the result pane scrolls)
    v.canvas.scrollIntoView({ block: 'center' }); await wait(50); b = v.canvas.getBoundingClientRect();
    const y = b.top + p.y; if (y < 0 || y > innerHeight) { v.canvas.scrollIntoView({ block: 'start' }); await wait(50); b = v.canvas.getBoundingClientRect(); }
    return { x: b.left + p.x, y: b.top + p.y };`);
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  await sleep(120);
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await sleep(150);
  // the table tab: the row selected, in view
  const clk = await page.eval(`${HELPERS} const before = document.querySelector('tr.tl-sel')?.sectionRowIndex ?? -1; await tab('table'); await wait(100);
    const t = document.querySelector('tr.tl-sel'); return [t?.sectionRowIndex ?? -1, hash(), inView(t), before];`);
  check(clk[3] === regMergeRow && clk[0] === regMergeRow && clk[1].includes(`sel=${regMergeRow}`) && clk[2], 'a click on a uop selects its row; the table tab shows it', JSON.stringify(clk));

  // screenshots: a marked pair (hover on a table row, the trace marks it)
  for (const theme of ['dark', 'light']) {
    await page.theme(theme);
    await page.eval(`${HELPERS} await tab('table'); trs()[${instrRow}].click(); await wait(100); await tab('trace'); await wait(80); return 1;`);
    await page.shot(`link-1440-${theme}.png`, '#trace-slot .trace-chart');
  }
  await page.theme('dark');

  // the wait column (the table tab)
  const w = await page.eval(`${HELPERS}
    await tab('table');
    const box = document.querySelector('.tl-waits-box'); box.click();
    await until(() => document.querySelector('th.tl-wait'));
    const v = viewer();
    const cells = [...document.querySelectorAll('table.uops tbody td.tl-wait')];
    const out = { hash: hash(), n: cells.length, rows: trs().length, relevant: v.model.relevant, delay: v.model.issueDispatchDelay,
      head: document.querySelector('th.tl-wait').textContent, legend: [...document.querySelectorAll('.tl-legend .tl-key')].map((e) => e.textContent),
      cells: cells.map((c) => ({ title: c.title, sr: c.querySelector('.vh')?.textContent ?? '', segs: [...c.querySelectorAll('.wbar > span')].map((s) => s.className) })) };
    // the result redrawn (another part opened): the column stays
    document.querySelector('details.report-wrap summary').click(); await wait(50); document.querySelector('details.report-wrap summary').click(); await wait(50);
    out.after = document.querySelectorAll('table.uops tbody td.tl-wait').length;
    return out;`);
  check(/waits=1/.test(w.hash) && w.n === w.rows && w.head === 'waits' && w.legend.join() === 'queue,delay,operands,port,execute,retire' && w.after === w.rows, 'the wait column: one cell per row, a legend, in the URL; it survives a redraw', JSON.stringify([w.hash, w.n, w.rows, w.legend, w.after]));
  {
    // expected: per instruction, the mean of retired − IDQ over the complete uops of the steady-state rounds, from the events
    const raw = rawUops(TRACE).filter((u) => u.rnd >= w.relevant.first && u.rnd <= w.relevant.last && u.retired !== undefined && u.idq !== null);
    const bad = [];
    let compared = 0;
    for (let row = 0; row < ROWS.length; row++) {
      const cell = w.cells[row];
      if (ROWS[row].notes === 'M') { if (cell.title !== 'macro-fused: with the row above' || cell.segs.length) bad.push(`row ${row}: fused`); continue; }
      const [id, kind] = expectGroup(row).split('/');
      const us = raw.filter((u) => u.instrID === Number(id) && u.kind === kind);
      if (!us.length) continue;
      const mean = us.reduce((s, u) => s + u.retired - u.idq, 0) / us.length;
      const got = Number(/^([\d.]+) cycles per uop/.exec(cell.title)?.[1]);
      const parts = cell.sr.replace(/^waits: /, '').split(' · ').map((p) => Number(p.split(' ').at(-1)));
      const sum = parts.reduce((s, x) => s + x, 0);
      const minDelay = Math.min(...us.map((u) => u.issued)) >= 0; // (always)
      compared++;
      if (!(Math.abs(got - mean) <= 0.051 && Math.abs(sum - got) <= 0.35 && parts.length === 6 && minDelay)) bad.push(`row ${row} ${ROWS[row].label}: ${cell.title} | ${cell.sr} vs mean ${mean.toFixed(2)}`);
    }
    check(compared >= 15 && bad.length === 0, `the wait column: every bar adds up to the mean IDQ → retire time of the trace's events (${compared} rows)`, bad.join('\n'));
    // the issue -> dispatch delay of SKL is in every scheduled uop's bar; eliminated moves have no delay
    const xor = w.cells[ROWS.findIndex((x) => x.label.startsWith('xor r8d'))];
    const imul = w.cells[ROWS.findIndex((x) => x.label.startsWith('imul'))];
    check(/delay 0\.0/.test(xor.sr) && /execute 0\.0/.test(xor.sr) && new RegExp(`delay ${w.delay}\\.0`).test(imul.sr) && imul.segs.includes('w-exec'), 'the wait column: an eliminated uop only waits; a scheduled one has the issue → dispatch delay', JSON.stringify([xor.sr, imul.sr, w.delay]));
  }
  for (const theme of ['dark', 'light']) {
    await page.theme(theme);
    await page.eval(`window.scrollTo(0, 0); return 1;`);
    await page.shot(`waits-1440-${theme}.png`, '#results .table-tools', 'table.uops');
  }
  await page.theme('dark');

  // the URL restores the trace (its tab), the selection and the wait column
  const h = await page.eval(`${HELPERS} await tab('trace'); return location.hash;`);
  await page.goto(`${origin}/?nosw=1${h}`);
  const re = await page.eval(`${HELPERS}
    await until(() => viewer() && document.querySelector('th.tl-wait'));
    await wait(100);
    const v = viewer();
    return [panel().open, v.selKey, document.querySelector('tr.tl-sel')?.sectionRowIndex ?? -1, document.querySelector('.tl-waits-box').checked, document.querySelectorAll('tbody td.tl-wait').length === trs().length];`);
  check(re[0] && re[1] === expectGroup(instrRow) && re[2] === instrRow && re[3] && re[4], 'a link restores the open trace, the selected row and the wait column', JSON.stringify(re));
  // an old link (no trace keys) is as before; a selection beyond the rows is dropped
  await page.goto(`${origin}/?nosw=1${LINK}&sel=999`);
  const old = await page.eval(`${HELPERS} await until(() => document.querySelector('.tp .value')); await wait(100); return [panel().open, !!viewer(), document.querySelectorAll('tr.tl-sel').length, hash().includes('sel='), !!document.querySelector('th.tl-wait')];`);
  check(!old[0] && !old[1] && old[2] === 0 && !old[3] && !old[4], 'an old link: trace closed, nothing selected, no wait column (a selection beyond the rows is dropped)', JSON.stringify(old));
  check(page.problems.length === 0, 'no console errors (desktop)', page.problems.join('\n'));
  await page.cmd('Page.close');

  // --- a long block: a uop of the trace whose row is not drawn (the table draws the rows near its view: vrows.js) ----------------
  {
    const p = await openPage();
    let long = '';
    for (let i = 0; i < 450; i++) long += ['4801d8', '4883c001', '480fafca'][i % 3];
    await p.goto(`${origin}/?nosw=1#v=1&a=${ARCH}&trace=1&c=${b64(long)}`);
    const lr = await p.eval(`${HELPERS}
      await until(() => viewer()); await wait(150);
      const drawnRows = () => [...document.querySelectorAll('table.uops tbody tr[data-row]')];
      const out = { drawn: drawnRows().length, has300: drawnRows().some((t) => t.dataset.row === '300') };
      const v = viewer(); const r = Array.from(v.rows).findIndex((i) => v.model.uops[i].instrID === 300);
      v.pick(r); await wait(200);
      await tab('table'); await wait(100);
      const t = document.querySelector('tr.tl-sel');
      out.after = [drawnRows().length, Number(t?.dataset.row ?? -1), t?.querySelector('th')?.textContent, hash().includes('sel=300'), inView(t)];
      return out;`);
    check(lr.drawn < 200 && !lr.has300 && lr.after[0] < 200 && lr.after[1] === 300 && lr.after[2] === 'add rax, rbx' && lr.after[3] && lr.after[4], 'a click on a uop whose row is not drawn: its row is drawn and selected (still only the rows near the view); the table tab shows it', JSON.stringify(lr));
    check(p.problems.length === 0, 'no console errors (long block)', p.problems.join('\n'));
    await p.cmd('Page.close');
  }

  // --- A–B: both traces on one time axis --------------------------------------------------------------------------------
  {
    const p = await openPage();
    await p.goto(`${origin}/?nosw=1`);
    const ab = await p.eval(`${HELPERS}
      await until(() => !$('run').disabled);
      let n = $('results').dataset.run; $('cmp-ab').click(); await until(() => $('results').dataset.run !== n && document.querySelector('.ab-tp'));
      const out = { slot: !$('trace-slot').hidden, more: getComputedStyle($('more')).display, closed: !panel().open };
      panel().querySelector('summary').click();
      await until(() => panel().wuicaTraces);
      await wait(200);
      const t = panel().wuicaTraces, A = t.a, B = t.b;
      out.window = t.window; out.hash = hash();
      out.scale = [A.scale, B.scale]; out.G = [A.G, B.G]; out.sizer = [A.sizer.offsetWidth, B.sizer.offsetWidth];
      out.rounds = [[A.fixed.from, A.fixed.to], [B.fixed.from, B.fixed.to]];
      out.firsts = [A.model.relevant.first, B.model.relevant.first];
      // cycle 0 of the axis: the first issue of the first shown iteration, on both sides
      out.zero = [A.x(t.window.a.origin), B.x(t.window.b.origin)];
      out.ends = [[...A.ends.values()], [...B.ends.values()]].map((e) => e.map((c) => c));
      // zoom in on A: B follows; scroll A: B follows
      document.querySelector('.trace-ab .trace-zoom[aria-label="zoom in"]').click(); await wait(50);
      A.zoomBy(1.6); await wait(50);
      out.zoomed = [A.scale, B.scale, A.sizer.offsetWidth === B.sizer.offsetWidth];
      A.scroller.scrollLeft = 120; await wait(100);
      out.scrolled = [A.scroller.scrollLeft, B.scroller.scrollLeft];
      B.scroller.scrollLeft = 40; await wait(100);
      out.scrolledB = [A.scroller.scrollLeft, B.scroller.scrollLeft];
      out.zeroAfter = [A.x(t.window.a.origin), B.x(t.window.b.origin)];
      // keyboard zoom on B
      B.canvas.focus(); B.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true })); await wait(50);
      out.keyZoom = [A.scale, B.scale];
      document.querySelector('.trace-ab .trace-zoom[aria-label^="fit"]').click(); await wait(50);
      out.overflow = overflow();
      return out;`);
    check(ab.slot && ab.more !== 'none' && ab.closed, 'A–B: the trace row is there (below the result), closed', JSON.stringify(ab));
    check(/ab=1/.test(ab.hash) && /trace=1/.test(ab.hash), 'A–B: the open trace is in the URL', ab.hash);
    const starts = [roundStarts(TRACE_A), roundStarts(TRACE_B)];
    const k = Math.min(ab.firsts[0], ab.firsts[1]);
    check(ab.rounds[0][0] === k && ab.rounds[1][0] === k && ab.rounds[0][1] === k + 2 && ab.rounds[1][1] === k + 2, 'A–B: the same three iterations on both sides, from the earlier steady state', JSON.stringify([ab.rounds, ab.firsts]));
    check(ab.window.a.origin === starts[0].get(k) && ab.window.b.origin === starts[1].get(k), 'A–B: cycle 0 is the first issue of that iteration on each side (from the events)', JSON.stringify([ab.window, starts[0].get(k), starts[1].get(k)]));
    check(ab.scale[0] === ab.scale[1] && ab.G[0] === ab.G[1] && ab.sizer[0] === ab.sizer[1] && Math.abs(ab.zero[0] - ab.zero[1]) < 0.01, 'A–B: one scale; cycle 0 at the same place in both', JSON.stringify([ab.scale, ab.G, ab.sizer, ab.zero]));
    check(Math.max(...ab.ends[1]) - ab.window.b.origin < Math.max(...ab.ends[0]) - ab.window.a.origin, 'A–B: B (four accumulators) retires the three iterations earlier', JSON.stringify([ab.ends, ab.window]));
    check(ab.zoomed[0] === ab.zoomed[1] && ab.zoomed[0] > ab.scale[0] && ab.zoomed[2] && ab.keyZoom[0] === ab.keyZoom[1] && ab.keyZoom[0] < ab.zoomed[0], 'A–B: zooming one zooms the other (buttons, keys)', JSON.stringify([ab.zoomed, ab.keyZoom]));
    check(ab.scrolled[0] === 120 && ab.scrolled[1] === 120 && ab.scrolledB[0] === 40 && ab.scrolledB[1] === 40 && Math.abs(ab.zeroAfter[0] - ab.zeroAfter[1]) < 0.01, 'A–B: scrolling one scrolls the other', JSON.stringify([ab.scrolled, ab.scrolledB, ab.zeroAfter]));
    check(ab.overflow <= 0, 'A–B: no sideways scrolling of the page', ab.overflow);
    // the rows: scrolled together where the diff lines them up (the lock), not when unlocked; B's strip compared with A's
    const lk = await p.eval(`${HELPERS}
      const t = panel().wuicaTraces, A = t.a, B = t.b, lock = document.querySelector('.trace-ab .trace-lock');
      const out = { same: t.same, note: !!document.querySelector('.trace-ab .trace-same'), compare: B.compare === A, pressed: [lock.getAttribute('aria-pressed')] };
      const r = Array.from(t.maps.aToB).findIndex((b, a) => a >= 6 && b >= 0);
      A.scroller.scrollTop = r * 16; await wait(150);
      out.follow = [r, t.maps.aToB[r], A.scroller.scrollTop, B.scroller.scrollTop, B.rows.length];
      lock.focus(); lock.click(); out.pressed.push(lock.getAttribute('aria-pressed'));
      const b0 = B.scroller.scrollTop; A.scroller.scrollTop = 0; await wait(150);
      out.unlocked = [A.scroller.scrollTop, B.scroller.scrollTop === b0];
      lock.click(); out.pressed.push(lock.getAttribute('aria-pressed')); await wait(150);
      out.relocked = [A.scroller.scrollTop, B.scroller.scrollTop];
      out.heights = [A.scroller.clientHeight, B.scroller.clientHeight];
      return out;`);
    const followed = lk.follow[1] * 16 === lk.follow[3] || lk.follow[3] >= lk.follow[4] * 16 - lk.heights[1] - 1; // (or at its end)
    check(!lk.same && !lk.note && lk.compare && lk.follow[0] > 0 && lk.follow[2] === lk.follow[0] * 16 && followed, 'A–B: scrolling A\'s rows scrolls B to the row the diff aligns', JSON.stringify(lk));
    check(lk.pressed.join() === 'true,false,true' && lk.unlocked[0] === 0 && lk.unlocked[1] && lk.relocked[1] === 0, 'A–B: the lock (a toggle button): unlocked, each scrolls alone; locked again, they line up', JSON.stringify(lk));
    check(lk.heights[0] > 160 && lk.heights[1] > 160, 'A–B: the two lists of rows share the pane\'s height', JSON.stringify(lk.heights));
    // "all": both from cycle 0
    const all = await p.eval(`${HELPERS}
      const sel = document.querySelector('.trace-ab-range'); sel.value = 'all'; sel.dispatchEvent(new Event('change')); await wait(100);
      const t = panel().wuicaTraces; return [t.window.a.origin, t.window.b.origin, t.a.fixed.from, t.b.fixed.from, t.a.scale === t.b.scale];`);
    check(all[0] === 0 && all[1] === 0 && all[2] === 0 && all[3] === 0 && all[4], 'A–B: "all iterations" starts both at cycle 0', JSON.stringify(all));
    await p.eval(`${HELPERS} const sel = document.querySelector('.trace-ab-range'); sel.value = 'steady'; sel.dispatchEvent(new Event('change')); await wait(100); return 1;`);
    for (const theme of ['dark', 'light']) {
      await p.theme(theme);
      await p.eval(`${HELPERS} panel().scrollIntoView({ block: 'start' }); await wait(80); return 1;`);
      await p.shot(`ab-1440-${theme}.png`, '#trace-slot', '#trace-slot');
    }
    // the traces of the other mode are not loaded in the background: a swap loads the two new ones; back in single
    // mode, one (counted: the analyses with includeTrace sent to the workers)
    const back = await p.eval(`${HELPERS}
      let traces = 0; const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...r) { if (JSON.stringify(m ?? null).includes('"includeTrace":true')) traces++; return post.call(this, m, ...r); };
      let n = $('results').dataset.run; $('ab-swap').click(); await until(() => $('results').dataset.run !== n);
      await until(() => panel().wuicaTraces); await wait(500);
      const swap = traces;
      n = $('results').dataset.run; $('cmp-single').click(); await until(() => $('results').dataset.run !== n);
      await until(() => viewer()); await wait(500);
      Worker.prototype.postMessage = post;
      return [panel().open, !panel().classList.contains('trace-ab'), swap, traces];`);
    check(back[0] && back[1], 'A–B → single: the single trace, still open', JSON.stringify(back));
    check(back[2] === 2 && back[3] === 3, 'the trace of the other mode is not loaded in the background (swap: 2 traces; single: 1)', JSON.stringify(back));
    check(p.problems.length === 0, 'no console errors (A–B)', p.problems.join('\n'));
    await p.cmd('Page.close');
  }

  // --- A–B with the same code: one trace, said so --------------------------------------------------------------------------
  {
    const p = await openPage();
    await p.goto(`${origin}/?nosw=1`);
    const same = await p.eval(`${HELPERS}
      await until(() => !$('run').disabled);
      let n = $('results').dataset.run; $('cmp-ab').click(); await until(() => $('results').dataset.run !== n && document.querySelector('.ab-tp'));
      panel().querySelector('summary').click(); await until(() => panel().wuicaTraces);
      n = $('results').dataset.run; $('ab-copy').click(); await until(() => $('results').dataset.run !== n);
      await until(() => panel().wuicaTraces?.same); await wait(200);
      const t = panel().wuicaTraces;
      return { same: t.same, one: t.a === t.b, canvases: panel().querySelectorAll('.trace-ab canvas').length, note: panel().querySelector('.trace-same')?.textContent,
        lock: !!panel().querySelector('.trace-lock'), bn: document.querySelector('.ab-bn')?.textContent ?? '' };`);
    check(same.same && same.one && same.canvases === 1 && same.note === 'A and B: the same trace' && !same.lock, 'A–B, A = B: one trace, "the same trace", no lock', JSON.stringify(same));
    check(/\(both\)$/.test(same.bn), 'A–B, A = B: the bottleneck said once, "(both)"', same.bn);
    // no named bottleneck (the stack example on SKL): "≈" the nearest limit, the words in its tooltip; once for both
    const near = await p.eval(`${HELPERS}
      let n = $('results').dataset.run; $('examples').value = 'stack'; $('examples').dispatchEvent(new Event('change')); await until(() => $('results').dataset.run !== n);
      n = $('results').dataset.run; $('ab-copy').click(); await until(() => $('results').dataset.run !== n); await wait(100);
      const bn = document.querySelector('.ab-bn'); return [bn?.textContent ?? '', bn?.querySelector('.hint')?.title ?? '', bn ? Math.round(bn.getBoundingClientRect().height) : 0, bn ? Math.round(parseFloat(getComputedStyle(bn).lineHeight)) : 0];`);
    check(/^bottleneck ≈ \S.* \d+\.\d\d \(both\)$/.test(near[0]) && /nearest limit/.test(near[1]) && near[2] <= near[3] * 1.5, 'A–B, no named bottleneck: "≈" the nearest limit (said in the tooltip), once for both', JSON.stringify(near));
    check(p.problems.length === 0, 'no console errors (A = B)', p.problems.join('\n'));
    await p.cmd('Page.close');
  }

  // --- phone width --------------------------------------------------------------------------------------------------------
  {
    const p = await openPage({ width: 375, height: 812, mobile: true });
    await p.goto(`${origin}/?nosw=1${LINK}&trace=1&waits=1&sel=${instrRow}`);
    const m = await p.eval(`${HELPERS}
      await until(() => viewer() && document.querySelector('th.tl-wait')); await wait(200);
      const trace = [shownTab(), overflow()];
      await tab('table'); await wait(100); // the linked table with the wait column
      return { overflow: Math.max(trace[1], overflow()), trace, table: overflow(), sel: viewer().selKey };`);
    check(m.overflow <= 0 && m.trace[0] === 'trace' && m.sel === expectGroup(instrRow), 'at 375px: the linked table, the wait column (the table tab) and the trace (its tab) do not widen the page', JSON.stringify(m));
    for (const theme of ['dark', 'light']) {
      await p.theme(theme);
      await p.eval(`${HELPERS} await tab('trace'); await wait(80); return 1;`);
      await p.shot(`link-375-${theme}.png`, '#trace-slot .trace-chart');
      await p.eval(`${HELPERS} await tab('table'); const w = document.querySelector('#results .table-wrap'); w.scrollLeft = document.querySelector('th.tl-wait').offsetLeft - 150; window.scrollTo(0, 0); return 1;`);
      await p.shot(`waits-375-${theme}.png`, '#results .table-tools', 'table.uops');
      await p.eval(`document.querySelector('#results .table-wrap').scrollLeft = 0; return 1;`);
    }
    // A–B on a phone: the demo pair (from the default example), the trace open from the link
    await p.theme('dark');
    await p.goto(`${origin}/?nosw=1#v=1&m=asm&trace=1`);
    const ab = await p.eval(`${HELPERS}
      await until(() => !$('run').disabled);
      let n = $('results').dataset.run; $('cmp-ab').click(); await until(() => $('results').dataset.run !== n && document.querySelector('.ab-tp'));
      await until(() => panel()?.wuicaTraces); await wait(200);
      const t = panel().wuicaTraces;
      return { overflow: overflow(), scale: [t.a.scale, t.b.scale], open: panel().open, code: $('code-b').value.includes('ymm3') };`);
    check(ab.open && ab.code && ab.overflow <= 0 && ab.scale[0] === ab.scale[1], 'at 375px: the A–B traces (the demo pair, open from the link) do not widen the page', JSON.stringify(ab));
    for (const theme of ['dark', 'light']) {
      await p.theme(theme);
      await p.shot(`ab-375-${theme}.png`, '#trace-slot', '#trace-slot');
    }
    check(p.problems.length === 0, 'no console errors (phone)', p.problems.join('\n'));
    await p.cmd('Page.close');
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  ws.close();
  server.close();
  await stopChrome(proc, [tmp]); // (after Chrome's exit: it writes to its profile until then)
}

console.log(`${count} trace link checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
