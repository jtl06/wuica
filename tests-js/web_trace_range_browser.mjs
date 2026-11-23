// End-to-end test of the cycle range of the trace (web/js/trace-range-view.js) in the built site (web/dist), in headless
// Chrome (--headless, --remote-debugging-port: tests-js/cdp.mjs) with the real analyzer: a drag over the head of the trace
// selects cycles, the bound view shows their ports and issue slots (checked against trace-range.js on the same trace made
// under Node), [ and ] select from the keyboard, Esc and × clear it. The trace and the bound view are tabs of the result
// (workspace.js): the range picked in the trace tab shows in the bound tab, and stays when the trace is closed.
// Run web/build.sh first.
//
//    node tests-js/web_trace_range_browser.mjs [--chrome PATH] [--shots DIR]
//
// Skips (exit 0) if Chrome is not found.
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, checker, copyDist, serve, launch, Page, HELPERS, DIST, LONG_TASK_MS } from './cdp.mjs';
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
  // the trace and the bound view are tabs of the result (workspace.js): one shows at a time
  const tab = (name) => run(`[...document.querySelectorAll('.view-tab')].find((b) => b.textContent === '${name}').click();
    await until(() => document.querySelector('.view-tab[aria-selected="true"]')?.textContent === '${name}');
    ${name === 'trace' ? `await until(() => panel().open && viewer() && viewer().viewW > 0);` : name === 'bound' ? `await until(() => $('bound').open && bodyB()?.querySelector('.bd-group'));` : ''}
    await wait(50);`);
  await page.goto(`${host.origin}/?nosw=1#v=1&a=${ARCH}&c=${b64(ex.hex)}&trace=1`);
  await page.ready();
  await run(`await until(() => viewer() && viewer().viewW > 0);`);
  const chip0 = await run(`return chip()?.hidden;`);
  await tab('bound');
  const before = await run(`return { items: document.querySelectorAll('#bound button.bd-item').length, range: !!rangeView(), trace: panel().open };`);
  check(before.items > 0 && !before.range && chip0 === true && !before.trace, 'steady state: the bound view, no range, the chip hidden', JSON.stringify([before, chip0]));

  // a drag over the cycle axis of the trace tab, from cycle a to cycle b (real mouse events)
  await tab('trace');
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
  await run(`try { await until(() => viewer().root.dataset.range === '${geo.a}-${geo.b}', 5000); } catch { /* checked below */ }`);
  const inTrace = await run(`return { chip: chip().hidden ? null : chip().querySelector('.tr-c').textContent, dataRange: viewer().root.dataset.range };`);
  await shot('range-drag.png');
  // the bound tab: the range's ports and slots
  await tab('bound');
  await run(`try { await until(() => rangeView()?.dataset.range === '${geo.a}-${geo.b}', 5000); } catch { /* checked below */ }`);
  const got = await run(`
    const rv = rangeView();
    return { range: rv?.dataset.range, label: rv?.querySelector('.tr-c').textContent,
      ports: Object.fromEntries([...(rv?.querySelectorAll('.tr-item') ?? [])].map((x) => [x.dataset.port, x.querySelector('.bd-pct').textContent])),
      slots: [...(rv?.querySelectorAll('.sl-k') ?? [])].map((x) => x.dataset.key + ' ' + x.textContent.replace(/^.* /, '')),
      shaded: document.querySelectorAll('table.uops tr.bd-hot').length };`);
  if (shots) {
    await shot('range-bound.png');
    await run(`document.documentElement.setAttribute('data-theme', 'light'); await wait(100);`); await shot('range-bound-light.png');
    await run(`document.documentElement.setAttribute('data-theme', 'dark'); await wait(100);`);
  }
  const want = rangeStats(model, geo.a, geo.b);
  const pct = (x) => `${Math.round(x * 100)}%`;
  check(inTrace.dataRange === `${geo.a}-${geo.b}` && got.range === inTrace.dataRange, 'drag: the range of the dragged cycles (in the trace, then in the bound tab)', JSON.stringify([inTrace, got.range, geo]));
  check(inTrace.chip === `c ${geo.a}–${geo.b}` && got.label === inTrace.chip, 'drag: the chip in the trace and in the bound view', JSON.stringify([inTrace, got]));
  check(JSON.stringify(got.ports) === JSON.stringify(Object.fromEntries(want.ports.map((p) => [p.name, pct(p.share)]))), 'bound view: the ports of the range', JSON.stringify([got.ports, want.ports]));
  const issued = want.slots.issued / (want.slots.width * want.slots.cycles);
  check(got.slots.some((s) => s === `issued ${pct(issued)}`), 'bound view: the issued slots of the range', JSON.stringify([got.slots, want.slots]));
  check(got.shaded === 0, 'bound view: no shading of the table for a range');

  // Esc on the focused timeline clears: the steady state again (in the bound tab too)
  await tab('trace');
  await run(`viewer().canvas.focus();`);
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await run(`await until(() => viewer().root.dataset.range === '');`);
  const esc = await run(`return chip().hidden;`);
  await tab('bound');
  check(esc && await run(`return !rangeView() && !!document.querySelector('#bound button.bd-item');`), 'Esc: cleared, the steady state back');

  // keyboard: [ and ] with no uop focused (the first and the last cycle in view)
  await tab('trace');
  await run(`const v = viewer(); v.canvas.focus(); v.active = -1; v.pinned = false;`);
  await page.key('[', { code: 'BracketLeft', keyCode: 219 });
  await run(`await until(() => viewer().root.dataset.range);`);
  const kb = await run(`const v = viewer(); return { range: v.root.dataset.range, v0: Math.max(v.c0, v.cycleAt(v.G)), v1: Math.min(v.c1, v.cycleAt(v.viewW - 1)) };`);
  check(kb.range === `${kb.v0}-${kb.v1}`, '[: from the first to the last cycle in view', JSON.stringify(kb));
  // the bound tab shows it; cycles outside the issue log: lost slots without a cause, drawn in a colour of their own
  await tab('bound');
  await run(`await until(() => rangeView()?.dataset.range === '${kb.range}');`);
  const unk = await run(`const k = rangeView().querySelector('.sl-k[data-key="unknown"] .sl-sw'); const seg = rangeView().querySelector('.sl-seg.sl-unknown');
    return k && seg ? [getComputedStyle(k).backgroundColor, getComputedStyle(seg).backgroundColor] : null;`);
  check(unk && unk.every((c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'), 'slots: lost outside the issue log, coloured', JSON.stringify(unk));
  // ] at a uop (back in the trace tab): the end moves to its dispatch
  await tab('trace');
  await run(`viewer().canvas.focus();`);
  const u = await run(`const v = viewer(); let r = 0; while (r < v.rows.length && v.model.uops[v.rows[r]].dispatched === null) r++; v.active = r; const x = v.model.uops[v.rows[r]]; return x.dispatched;`);
  await page.key(']', { code: 'BracketRight', keyCode: 221 });
  const kbRange = `${Math.min(kb.v0, u)}-${u}`;
  await run(`await until(() => viewer().root.dataset.range === '${kbRange}');`);
  check(true, ']: the end at the dispatch of the focused uop');
  await tab('bound');
  await run(`await until(() => rangeView()?.dataset.range === '${kbRange}');`);

  // × in the bound view clears
  await run(`rangeView().querySelector('.tr-x').click(); await until(() => !rangeView());`);
  check(await run(`return chip().hidden;`), '×: cleared');
  // Esc in the bound view clears; the focus goes to its tab (its summary is hidden while it is open)
  await tab('trace');
  await run(`viewer().canvas.focus(); viewer().active = -1;`);
  await page.key('[', { code: 'BracketLeft', keyCode: 219 });
  await run(`await until(() => viewer().root.dataset.range);`);
  await tab('bound');
  await run(`await until(() => rangeView()); rangeView().querySelector('.tr-x').focus();`);
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  check(await run(`await until(() => !rangeView()); const a = document.activeElement; return chip().hidden && a?.matches('.view-tab[aria-selected="true"]') && a.textContent === 'bound';`), 'Esc in the bound view: cleared, the focus on its tab');

  // a range, then the trace closed (the table tab): the range stays, the bound tab shows it
  await tab('trace');
  await run(`viewer().canvas.focus(); viewer().active = -1;`);
  await page.key('[', { code: 'BracketLeft', keyCode: 219 });
  const kept = await run(`await until(() => viewer().root.dataset.range); return viewer().root.dataset.range;`);
  await tab('table');
  const closed = await run(`return !panel().open && !$('bound').open && viewer().root.dataset.range;`);
  await tab('bound');
  check(closed === kept && await run(`await until(() => rangeView()); return rangeView().dataset.range;`) === kept, 'closing the trace keeps the range: the bound tab shows it', JSON.stringify([kept, closed]));

  // narrow and wide: no sideways scroll with a range, in the bound tab and in the trace tab
  for (const w of [320, 2560]) {
    await page.size(w, 900);
    for (const t of ['bound', 'trace']) {
      await tab(t);
      const o = await run(`await wait(100); return overflow();`);
      check(o <= 0, `width ${w}: no sideways scroll with a range (${t})`, String(o));
      await shot(`range-${w}-${t}.png`);
    }
  }
  await page.size(1280, 900);

  // SHA-256 (2,949 instructions, a large trace): a drag over the head, no task of 100 ms or more; the bound tab shows it
  await tab('trace');
  await run(`set($('examples'), 'sha256'); await until(() => document.querySelector('#result-body .tp .value')?.textContent === '744.25' && !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale'), 120000); await until(() => panel()?.querySelector('.trace-msg button') || viewer());
    panel().querySelector('.trace-msg button')?.click();
    await until(() => viewer() && viewer().viewW > 0 && viewer().model.nInstr > 2000, 120000);
    viewer().canvas.scrollIntoView({ block: 'center' }); await wait(300);`);
  const g2 = await run(`const v = viewer(), r = v.canvas.getBoundingClientRect();
    window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
    return { x0: r.left + v.G + 4, x1: r.right - 8, y: r.top + 8 };`);
  await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: g2.x0, y: g2.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let k = 1; k <= 20; k++) await page.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g2.x0 + ((g2.x1 - g2.x0) * k) / 20, y: g2.y, button: 'left', buttons: 1 });
  await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g2.x1, y: g2.y, button: 'left', buttons: 0, clickCount: 1 });
  await run(`await until(() => viewer().root.dataset.range); await wait(300);`);
  // the bound tab paints the range: in the long-task count too
  await tab('bound');
  const s = await run(`await until(() => rangeView()); await wait(300); return { long: window.__long, range: rangeView().dataset.range, ports: rangeView().querySelectorAll('.tr-item').length };`);
  check(s.long.every((ms) => ms < LONG_TASK_MS) && s.ports > 0, `SHA-256: selecting a range, then the bound tab: no task of ${LONG_TASK_MS} ms or more`, JSON.stringify(s));
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
