// End-to-end test of the cycle range of the trace (web/js/trace-range-view.js) in the built site (web/dist), in headless
// Chrome (--headless, --remote-debugging-port: tests-js/cdp.mjs) with the real analyzer: a drag over the head of the trace
// selects cycles, the bound view shows their ports and issue slots (checked against trace-range.js on the same trace made
// under Node), [ and ] select from the keyboard, Esc, × and closing the trace clear it. Run web/build.sh first.
//
//    node tests-js/web_trace_range_browser.mjs [--chrome PATH] [--shots DIR]
//
// Skips (exit 0) if Chrome is not found.
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, checker, copyDist, serve, launch, Page, HELPERS, DIST } from './cdp.mjs';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES } from '../web/js/examples.js';
import { loadTrace } from '../web/js/trace.js';
import { rangeStats } from '../web/js/trace-range.js';

const chrome = findChrome();
if (!fs.existsSync(path.join(DIST, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('trace range browser');
const shotsAt = process.argv.indexOf('--shots'), shots = shotsAt >= 0 ? process.argv[shotsAt + 1] : null;
const shot = async (name) => { if (!shots) return; fs.mkdirSync(shots, { recursive: true }); await page.screenshot(path.join(shots, name)); };
const b64 = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// the trace the page will make, made here
const ARCH = 'SKL';
const ex = EXAMPLES.find((e) => e.id === 'loadstore') ?? EXAMPLES[0];
const engine = await WasmEngine.create(fs.readFileSync(path.join(DIST, 'wuica_wasm.wasm')));
const uarchBytes = fs.readFileSync(path.join(DIST, 'data', 'uarch.json'));
await engine.loadUarch(uarchBytes);
await engine.loadArch(ARCH, fs.readFileSync(path.join(DIST, 'data', 'arch', `${ARCH}.json`)));
const request = makeRequest(ex.hex, ARCH);
const response = await engine.analyze(request);
const { model } = await loadTrace({ response, request }, { analyze: (q) => engine.analyze(q), config: () => JSON.parse(uarchBytes).configs[ARCH] });

const dir = copyDist();
const host = await serve(dir);
const { browser, close } = await launch(chrome);
const page = await Page.open(browser, { width: 1280, height: 900 });
const pageHelpers = `${HELPERS}
  const panel = () => document.querySelector('details.trace-panel');
  const viewer = () => panel()?.wuicaTrace;
  const bodyB = () => document.querySelector('#bound .bd-body');
  const rangeView = () => document.querySelector('#bound .tr-bd');
  const chip = () => viewer()?.root.querySelector('.trace-tools .tr-chip');
`;
const run = (expr) => page.eval(pageHelpers + expr);

try {
  await page.goto(`${host.origin}/?nosw=1#v=1&a=${ARCH}&c=${b64(ex.hex)}&trace=1&bound=1`);
  await page.ready();
  await run(`await until(() => viewer() && viewer().viewW > 0 && bodyB()?.querySelector('.bd-group'));`);
  const before = await run(`return { items: document.querySelectorAll('#bound button.bd-item').length, range: !!rangeView(), chip: chip()?.hidden, bound: $('results').querySelector('[data-bound]')?.dataset.bound ?? document.querySelector('[data-bound]')?.dataset.bound };`);
  check(before.items > 0 && !before.range && before.chip === true, 'steady state: the bound view, no range, the chip hidden', JSON.stringify(before));

  // a drag over the cycle axis, from cycle a to cycle b (real mouse events)
  const geo = await run(`
    const v = viewer();
    v.canvas.scrollIntoView({ block: 'center' });
    await wait(50);
    const span = v.c1 - v.c0;
    const a = v.c0 + Math.floor(span * 0.2), b = v.c0 + Math.floor(span * 0.7);
    const r = v.canvas.getBoundingClientRect();
    const sl = v.scroller.scrollLeft;
    const px = (c) => r.left + v.G + (c - v.c0) * v.scale - sl + v.scale / 2;
    return { a, b, xa: px(a), xb: px(b), xm: px((a + b) >> 1), y: r.top + 8, c0: v.c0, c1: v.c1 };`);
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.xa, y: geo.y });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.xa, y: geo.y, button: 'left', buttons: 1, clickCount: 1 });
  for (const x of [geo.xm, geo.xb]) await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: geo.y, button: 'left', buttons: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.xb, y: geo.y, button: 'left', buttons: 0, clickCount: 1 });
  // (the range follows the pointer once per frame: the last one comes after the release)
  await run(`try { await until(() => rangeView()?.dataset.range === '${geo.a}-${geo.b}', 5000); } catch { /* checked below */ }`);
  const got = await run(`
    const rv = rangeView();
    return { range: rv.dataset.range, chip: chip().hidden ? null : chip().querySelector('.tr-c').textContent, label: rv.querySelector('.tr-c').textContent,
      ports: Object.fromEntries([...rv.querySelectorAll('.tr-item')].map((x) => [x.dataset.port, x.querySelector('.bd-pct').textContent])),
      slots: [...rv.querySelectorAll('.sl-k')].map((x) => x.dataset.key + ' ' + x.textContent.replace(/^.* /, '')),
      shaded: document.querySelectorAll('table.uops tr.bd-hot').length, dataRange: viewer().root.dataset.range };`);
  await shot('range-drag.png');
  if (shots) {
    await run(`$('bound').scrollIntoView(); await wait(50);`); await shot('range-bound.png');
    await run(`document.documentElement.setAttribute('data-theme', 'light'); await wait(100);`); await shot('range-bound-light.png');
    await run(`document.documentElement.setAttribute('data-theme', 'dark'); await wait(100);`);
  }
  const want = rangeStats(model, geo.a, geo.b);
  const pct = (x) => `${Math.round(x * 100)}%`;
  check(got.range === `${geo.a}-${geo.b}` && got.dataRange === got.range, 'drag: the range of the dragged cycles', JSON.stringify([got.range, geo]));
  check(got.chip === `c ${geo.a}–${geo.b}` && got.label === got.chip, 'drag: the chip in the trace and in the bound view', JSON.stringify(got));
  check(JSON.stringify(got.ports) === JSON.stringify(Object.fromEntries(want.ports.map((p) => [p.name, pct(p.share)]))), 'bound view: the ports of the range', JSON.stringify([got.ports, want.ports]));
  const issued = want.slots.issued / (want.slots.width * want.slots.cycles);
  check(got.slots.some((s) => s === `issued ${pct(issued)}`), 'bound view: the issued slots of the range', JSON.stringify([got.slots, want.slots]));
  check(got.shaded === 0, 'bound view: no shading of the table for a range');

  // Esc on the focused timeline clears: the steady state again
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await run(`await until(() => !rangeView() && document.querySelector('#bound button.bd-item'));`);
  check(await run(`return chip().hidden && viewer().root.dataset.range === '';`), 'Esc: cleared, the steady state back');

  // keyboard: [ and ] with no uop focused (the first and the last cycle in view)
  await run(`const v = viewer(); v.canvas.focus(); v.active = -1; v.pinned = false;`);
  await page.key('[', { code: 'BracketLeft', keyCode: 219 });
  await run(`await until(() => rangeView());`);
  const kb = await run(`const v = viewer(); return { range: rangeView().dataset.range, v0: Math.max(v.c0, v.cycleAt(v.G)), v1: Math.min(v.c1, v.cycleAt(v.viewW - 1)) };`);
  check(kb.range === `${kb.v0}-${kb.v1}`, '[: from the first to the last cycle in view', JSON.stringify(kb));
  // cycles outside the issue log: lost slots without a cause, drawn in a colour of their own
  const unk = await run(`const k = rangeView().querySelector('.sl-k[data-key="unknown"] .sl-sw'); const seg = rangeView().querySelector('.sl-seg.sl-unknown');
    return k && seg ? [getComputedStyle(k).backgroundColor, getComputedStyle(seg).backgroundColor] : null;`);
  check(unk && unk.every((c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'), 'slots: lost outside the issue log, coloured', JSON.stringify(unk));
  // ] at a uop: the end moves to its dispatch
  const u = await run(`const v = viewer(); let r = 0; while (r < v.rows.length && v.model.uops[v.rows[r]].dispatched === null) r++; v.active = r; const x = v.model.uops[v.rows[r]]; return x.dispatched;`);
  await page.key(']', { code: 'BracketRight', keyCode: 221 });
  await run(`await until(() => rangeView()?.dataset.range === '${Math.min(kb.v0, u)}-${u}');`);
  check(true, ']: the end at the dispatch of the focused uop');

  // × in the bound view clears
  await run(`rangeView().querySelector('.tr-x').click(); await until(() => !rangeView());`);
  check(await run(`return chip().hidden;`), '×: cleared');
  // Esc in the bound view clears; the focus goes to its summary
  await run(`viewer().canvas.focus(); viewer().active = -1;`);
  await page.key('[', { code: 'BracketLeft', keyCode: 219 });
  await run(`await until(() => rangeView()); rangeView().querySelector('.tr-x').focus();`);
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  check(await run(`await until(() => !rangeView()); return chip().hidden && document.activeElement === document.querySelector('#bound summary');`), 'Esc in the bound view: cleared, the focus on its summary');

  // a range, then the trace closed: cleared, the steady state in the bound view
  await run(`viewer().canvas.focus(); viewer().active = -1;`);
  await page.key('[', { code: 'BracketLeft', keyCode: 219 });
  await run(`await until(() => rangeView()); panel().open = false; await until(() => !rangeView() && document.querySelector('#bound button.bd-item'));`);
  check(true, 'closing the trace clears the range');

  // narrow: no sideways scroll with a range in both places
  await run(`panel().open = true; await until(() => viewer() && viewer().viewW > 0); viewer().canvas.focus(); viewer().active = -1;`);
  await page.key('[', { code: 'BracketLeft', keyCode: 219 });
  await run(`await until(() => rangeView());`);
  for (const w of [320, 2560]) {
    await page.size(w, 900);
    const o = await run(`await wait(100); return overflow();`);
    check(o <= 0, `width ${w}: no sideways scroll with a range`, String(o));
    await shot(`range-${w}.png`);
  }
  await page.size(1280, 900);

  // SHA-256 (2,949 instructions, a large trace): a drag over the head, the bound view open, no task of 100 ms or more
  await run(`await done(() => set($('examples'), 'sha256')); await until(() => panel()?.querySelector('.trace-msg button') || viewer());
    panel().querySelector('.trace-msg button')?.click();
    await until(() => viewer() && viewer().viewW > 0 && viewer().model.nInstr > 2000, 120000);
    viewer().canvas.scrollIntoView({ block: 'center' }); await wait(300);`);
  const g2 = await run(`const v = viewer(), r = v.canvas.getBoundingClientRect();
    window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
    return { x0: r.left + v.G + 4, x1: r.right - 8, y: r.top + 8 };`);
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: g2.x0, y: g2.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let k = 1; k <= 20; k++) await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g2.x0 + ((g2.x1 - g2.x0) * k) / 20, y: g2.y, button: 'left', buttons: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g2.x1, y: g2.y, button: 'left', buttons: 0, clickCount: 1 });
  const s = await run(`await until(() => rangeView()); await wait(300); return { long: window.__long, range: rangeView().dataset.range, ports: rangeView().querySelectorAll('.tr-item').length };`);
  check(s.long.every((ms) => ms < 100) && s.ports > 0, 'SHA-256: selecting a range, no task of 100 ms or more', JSON.stringify(s));
  console.log(`SHA-256: range ${s.range}, long tasks while dragging ${JSON.stringify(s.long)} ms`);
  const problems = page.take();
  check(problems.length === 0, 'no console errors', JSON.stringify(problems));
} catch (e) {
  check(false, 'run', e.stack);
} finally {
  await close();
  await host.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(check.summary() ? 1 : 0);
