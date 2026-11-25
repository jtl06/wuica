// The workspace of 0.1.6 in the built site, headless Chrome (started with --headless and --remote-debugging-port
// through tests-js/cdp.mjs), the real analyzer:
// - the folded input pane is a labelled strip the window's height ("input ▸"), kept across a reload; "\" unfolds it
// - the uop table: ports shown as P0.., the instruction column stays in view while the ports scroll sideways
// - phones: only the checked CPUs, the rest behind "more"; the result starts within the first screen
// - A–B: the table per CPU per element (as Node's analyzer gives it); the sweep and mca tabs of one side, the switch
// - A–B: a pasted side dims an out-of-date result at once; typing dims it only after a pause
// - the review's cases: small per-element values, the counts swapped, B on its own CPU, a side without a result, the
//   focus on the switch and a row's button; every port fits (GEMM); the diff tab's marks; the status; single mode's count
// Skipped (exit 0) without Chrome.
//
//   node tests-js/web_workspace_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { enginePath, tablePath } from './dist-files.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';

const chrome = findChrome();
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('workspace browser');

const dir = copyDist();
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'web/js', f)).href);
const { WasmEngine, makeRequest } = await imp('engine.js');
const { CLASSIC_EXAMPLES } = await imp('examples.js');
const { encodeState } = await imp('url-state.js');
const engine = await WasmEngine.create(fs.readFileSync(enginePath(dir, 'wuica_wasm.wasm')));
const uarchBytes = fs.readFileSync(enginePath(dir, 'data/uarch.json'));
await engine.loadUarch(uarchBytes);
const configs = JSON.parse(uarchBytes).configs;
async function tpOf(hex, arch) {
  const t = configs[arch].name;
  if (!engine.hasArch(t)) await engine.loadArch(t, zlib.gunzipSync(fs.readFileSync(tablePath(dir, t))));
  return Number((await engine.analyze(makeRequest(hex, arch))).tp);
}
const ex = (id) => CLASSIC_EXAMPLES.find((e) => e.id === id);
const W = `${HELPERS}
  const rect = (el) => (typeof el === 'string' ? document.querySelector(el) : el).getBoundingClientRect();
  const settled = () => !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale') && !!$('results').dataset.run;
  const tabNames = () => [...document.querySelectorAll('#result-body > .view-tabs > .view-tab')].map((b) => b.dataset.tab);
  const pick = async (name) => { document.querySelector('.view-tab[data-tab="' + name + '"]').click(); await until(() => document.querySelector('.view-tab[data-tab="' + name + '"]')?.getAttribute('aria-selected') === 'true'); };
`;

const srv = await serve(dir);
const { browser, close } = await launch(chrome);
try {
  const saxpy = encodeState({ mode: 'asm', text: ex('saxpy').text.intel, arch: 'ADL-P' });
  // ---- the folded input: a labelled strip, kept across a reload ------------------------------------------------------------
  {
    const page = await Page.open(browser, { width: 1440, height: 900 });
    await page.goto(`${srv.origin}/?nosw=1#${saxpy}`);
    await page.waitFor(`document.getElementById('results').dataset.run && document.querySelector('#result-body .tp .value')`, 'the result', 60000);
    const open = await page.eval(`${W} const b = $('input-fold'); return [b.textContent, b.getAttribute('aria-expanded'), Math.round(rect('#results').left)];`);
    await page.eval(`${W} $('input-fold').click(); return 1;`);
    const fold = async () => page.eval(`${W} const b = $('input-fold'), r = rect(b);
      return { text: b.textContent, expanded: b.getAttribute('aria-expanded'), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), code: $('code').offsetParent === null,
        results: Math.round(rect('#results').left), color: getComputedStyle(b).color !== getComputedStyle(document.body).backgroundColor };`);
    const f = await fold();
    await page.reload();
    await page.waitFor(`document.getElementById('results').dataset.run`, 'the result after a reload', 60000);
    const g = await fold();
    await page.eval(`document.activeElement?.blur(); return 1;`);
    await page.key('\\', { code: 'Backslash', keyCode: 220 });
    const u = await page.eval(`${W} return [$('input-fold').textContent, $('code').offsetParent !== null];`);
    check(open[0] === '◂' && open[1] === 'true', 'fold: open, a small button', JSON.stringify(open));
    check(f.text === 'input ▸' && f.expanded === 'false' && f.w >= 18 && f.h > 600 && f.code && f.results < open[2] && f.results >= f.left + f.w && f.color, 'fold: folded, a labelled strip the window\'s height ("input ▸") beside the result', JSON.stringify(f));
    check(g.text === 'input ▸' && g.h > 600 && g.code, 'fold: kept across a reload, the strip as before', JSON.stringify(g));
    check(u[0] === '◂' && u[1], 'fold: \\ unfolds it', JSON.stringify(u));

    // ---- the uop table: P0.., the instruction column in view while the ports scroll ----------------------------------------
    await page.size(1200, 800);
    const t = await page.eval(`${W} const wrap = document.querySelector('#result-body .table-wrap'), th = wrap.querySelector('tbody th.first');
      const head = [...wrap.querySelectorAll('thead th')].map((x) => x.textContent + (x.dataset.col && x.dataset.col !== x.textContent ? '=' + x.dataset.col : ''));
      const before = Math.round(rect(th).left - rect(wrap).left);
      wrap.scrollLeft = wrap.scrollWidth; await wait(50);
      return { head, sticky: getComputedStyle(th).position, before, after: Math.round(rect(th).left - rect(wrap).left), scrolled: wrap.scrollLeft,
        bg: getComputedStyle(th).backgroundColor, last: rect(wrap.querySelector('thead th:last-child')).right <= rect(wrap).right + 1 };`);
    check(t.head.includes('P0=Port 0') && t.head.includes('9=Port 9') && t.head[0] === 'Instruction', 'uop table: ports under one P, one number each (the full name kept)', JSON.stringify(t.head));
    check(t.sticky === 'sticky' && Math.abs(t.before - t.after) <= 1 && t.last && !/rgba\(.*, 0\)/.test(t.bg), 'uop table: the instruction column stays in view (opaque) while the ports scroll', JSON.stringify(t));
    check(page.take().length === 0, 'fold and table: no console errors');
    await page.close();
  }

  // ---- phones: the checked CPUs only, "more"; the result within the first screen -----------------------------------------------
  {
    const page = await Page.open(browser, { width: 375, height: 812, mobile: true });
    for (const [name, frag] of [['single', encodeState({ mode: 'asm', text: ex('saxpy').text.intel, arch: 'SKL', cpus: 'SKL,ZEN3' })],
      ['A–B', encodeState({ mode: 'asm', text: ex('dot1').text.intel, arch: 'SKL', cpus: 'SKL,ZEN3', ab: true, bMode: 'asm', bText: ex('dot4').text.intel })]]) {
      await page.goto(`${srv.origin}/?nosw=1#${frag}`);
      await page.waitFor(`document.getElementById('results').dataset.run && !document.getElementById('results').hasAttribute('aria-busy')`, `the ${name} result on a phone`, 60000);
      const r = await page.eval(`${W}
        const boxes = () => [...document.querySelectorAll('#cpu-grid label.cpu')].filter((l) => l.offsetParent).map((l) => l.textContent.replace('p', ''));
        const out = { shown: boxes(), more: $('cpu-more').offsetParent !== null && $('cpu-more').textContent, top: Math.round(rect('#results').top + scrollY), h: innerHeight, over: overflow() };
        $('cpu-more').click(); await wait(50);
        out.all = boxes().length; out.less = $('cpu-more').textContent; out.expanded = $('cpu-more').getAttribute('aria-expanded');
        $('cpu-more').click(); await wait(50);
        out.again = boxes().length;
        return out;`);
      check(r.shown.join() === 'SKL,ZEN3' && r.more === 'more' && r.all === 15 && r.less === 'less' && r.expanded === 'true' && r.again === 2 && r.over <= 0, `phone (${name}): only the checked CPUs, the rest behind "more"`, JSON.stringify(r));
      check(r.top < r.h, `phone (${name}): the result starts within the first screen`, JSON.stringify([r.top, r.h]));
    }
    check(page.take().length === 0, 'phone: no console errors');
    await page.close();
  }

  // ---- A–B: per element per CPU; the sweep and mca of one side; pasted code dims at once ----------------------------------------
  {
    const a = ex('dot1'), b = ex('dot4');
    const want = { SKL: [await tpOf(a.hex, 'SKL'), await tpOf(b.hex, 'SKL')], ZEN3: [await tpOf(a.hex, 'ZEN3'), await tpOf(b.hex, 'ZEN3')] };
    const page = await Page.open(browser, { width: 1440, height: 900 });
    await page.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'asm', text: a.text.intel, arch: 'SKL', cpus: 'SKL,ZEN3', ab: true, bMode: 'asm', bText: b.text.intel, aWork: 8, bWork: 32 })}`);
    await page.waitFor(`document.getElementById('ab-cpus')?.dataset.state === 'done' && document.querySelector('.ab-tp')`, 'the A–B result', 60000);
    const c = await page.eval(`${W} return { rows: [...document.querySelectorAll('#ab-cpus tbody tr')].map((tr) => [tr.dataset.arch, tr.cells[1].textContent, tr.cells[2].textContent, tr.classList.contains('current'),
        tr.cells[3].textContent, tr.cells[4].textContent, tr.cells[3].classList.contains('ab-better') ? 'better' : tr.cells[3].classList.contains('ab-worse') ? 'worse' : 'same']),
      unit: document.querySelector('.ab-tp .unit').textContent, work: [$('a-work').value, $('b-work').value] };`);
    const per = (arch) => [(want[arch][0] / 8).toFixed(2), (want[arch][1] / 32).toFixed(2)];
    // Δ, speedup and verdict from the unrounded values per element, as the page should give them
    const expect = (arch) => {
      const x = want[arch][0] / 8, y = want[arch][1] / 32;
      const same = Math.abs(y - x) <= 0.0025 * Math.max(x, y), p = 100 * (y - x) / x, sp = x / y;
      const pct = same ? '0' : `${p < 0 ? '−' : '+'}${Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : Math.round(Math.abs(p))}%`;
      return [pct, same ? '' : sp >= 1 ? `${sp.toFixed(2)}×` : `${(1 / sp).toFixed(2)}× slower`, same ? 'same' : y < x ? 'better' : 'worse'];
    };
    check(c.rows.length === 2 && c.rows.every(([arch, x, y]) => x === per(arch)[0] && y === per(arch)[1]) && c.rows[0][3] && c.unit === 'cycles/element' && c.work.join() === '8,32',
      'A–B: the table per CPU per element (8 and 32 elements per iteration, from a link)', JSON.stringify([c, want]));
    check(c.rows.every((r) => JSON.stringify(r.slice(4)) === JSON.stringify(expect(r[0]))), 'A–B: the table per CPU: Δ, speedup and verdict as computed here', JSON.stringify([c.rows, expect('SKL'), expect('ZEN3')]));

    // the sweep tab of B: B's alignment sweep; mca's tab is of the side too
    const s = await page.eval(`${W}
      await pick('sweep'); await until(() => $('cmp-sweep').dataset.state === 'done', 60000);
      const at0 = () => document.querySelector('.sweep-chart rect.hit')?.textContent ?? '';
      const out = { a: [document.querySelector('.ws-side-btn.on')?.textContent, at0()] };
      const n = Number($('cmp-sweep').dataset.runs || 0);
      document.querySelector('.ws-side-btn[data-tab="side-b"]').click();
      await until(() => Number($('cmp-sweep').dataset.runs || 0) > n && $('cmp-sweep').dataset.state === 'done', 60000);
      out.b = [document.querySelector('.ws-side-btn.on')?.textContent, at0(), document.body.dataset.abSide];
      await pick('trace'); out.traceSwitch = !!document.querySelector('.ws-side');
      await pick('mca'); out.mca = [!!document.querySelector('.ws-side'), document.querySelector('.ws-side-btn.on')?.textContent];
      document.querySelector('.ws-side-btn[data-tab="side-a"]').click(); await wait(50);
      await pick('diff');
      return out;`);
    const t0 = (v) => Number((/(\d+\.\d\d)/.exec(v) ?? [])[1]);
    check(s.a[0] === 'A' && t0(s.a[1]) === Number(want.SKL[0].toFixed(2)) && s.b[0] === 'B' && s.b[2] === 'b' && t0(s.b[1]) === Number(want.SKL[1].toFixed(2)),
      'A–B: the sweep tab is of one side; the switch shows B\'s', JSON.stringify([s, want.SKL]));
    check(!s.traceSwitch && s.mca[0] && s.mca[1] === 'B', 'A–B: the switch is there for the views of one side (mca), not for the traces of both', JSON.stringify(s));

    // pasted code dims an out-of-date result at once; typed code only after a pause (no flicker while typing)
    const d = await page.eval(`${W}
      await until(settled);
      const bc = $('code-b'), op = () => getComputedStyle($('result-body')).opacity;
      if (!$('live').checked) $('live').click(); // (live: typing re-runs after a pause; the result dims only if it stays old)
      const n0 = $('results').dataset.run;
      bc.value = bc.value + ' '; bc.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
      await new Promise((f) => requestAnimationFrame(() => requestAnimationFrame(f))); // (two frames: what is painted)
      const typed = [$('result-body').classList.contains('stale'), $('result-body').classList.contains('stale-now'), op(), getComputedStyle($('result-body')).transitionDelay];
      await until(() => $('results').dataset.run !== n0 && !$('result-body').classList.contains('stale'), 30000); // the live run
      bc.value = bc.value.slice(0, -1); bc.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      await until(() => !$('result-body').classList.contains('stale') && !$('results').hasAttribute('aria-busy'), 30000);
      await until(() => op() === '1', 5000).catch(() => {});
      const back = [$('result-body').classList.contains('stale'), op()];
      if ($('live').checked) $('live').click(); // (the paste below: no new result until Analyze)
      bc.value = ${JSON.stringify(a.text.intel)}; bc.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      const pasted = [$('result-body').classList.contains('stale'), $('result-body').classList.contains('stale-now'), op()];
      await done(() => $('run').click());
      await until(() => op() === '1', 5000).catch(() => {}); // (it brightens in 0.1 s)
      const after = [$('result-body').classList.contains('stale'), $('result-body').classList.contains('stale-now'), op()];
      return { typed, back, pasted, after };`);
    check(d.typed[0] && !d.typed[1] && d.typed[2] === '1' && d.typed[3] === '0.6s' && !d.back[0] && d.back[1] === '1', 'A–B: typed into B (live): stale, not dimmed at once (dims only after a 0.6 s pause); the new result bright', JSON.stringify(d));
    check(d.pasted[0] && d.pasted[1] && Number(d.pasted[2]) < 0.6, 'A–B: pasted into B: dimmed at once', JSON.stringify(d));
    check(!d.after[0] && !d.after[1] && d.after[2] === '1', 'A–B: the new result: not dimmed', JSON.stringify(d));
    check(page.take().length === 0, 'A–B: no console errors');
    await page.close();
  }

  // ---- review: small values per element; a swap of the counts; B's own CPU; a side without a result; the focus ------------
  {
    const m = ex('memcpy');
    const tp = { SKL: await tpOf(m.hex, 'SKL'), ZEN3: await tpOf(m.hex, 'ZEN3') };
    const page = await Page.open(browser, { width: 1440, height: 900 });
    await page.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'asm', text: m.text.intel, arch: 'SKL', cpus: 'SKL,ZEN3', ab: true, bMode: 'asm', bText: m.text.intel, aWork: 128, bWork: 160 })}`);
    await page.waitFor(`document.getElementById('ab-cpus')?.dataset.state === 'done' && document.querySelector('.ab-tp')`, 'memcpy A–B', 60000);
    const read = `return { vals: [...document.querySelectorAll('.ab-tp .value')].map((v) => v.textContent), delta: document.querySelector('.ab-delta')?.textContent, verdict: document.querySelector('.ab-delta')?.dataset.verdict,
      sr: document.querySelector('#result-body p.ab-sr')?.textContent, rows: [...document.querySelectorAll('#ab-cpus tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent.replace('p', '')).join('|')),
      work: [$('a-work').value, $('b-work').value], run: $('results').dataset.run };`;
    const r1 = await page.eval(`${W} ${read}`);
    const sig = (v) => (v < 0.1 ? v.toPrecision(3) : v.toFixed(2));
    check(r1.vals.join() === `${sig(tp.SKL / 128)},${sig(tp.SKL / 160)}` && r1.verdict === 'better' && /\(−20%\) · 1\.25× faster/.test(r1.delta) && /per element/.test(r1.sr),
      'small values per element: three significant digits; B better −20%, 1.25× (relative, unrounded)', JSON.stringify(r1));
    check(r1.rows.join(' / ') === `SKL|${sig(tp.SKL / 128)}|${sig(tp.SKL / 160)}|−20%|1.25× / ZEN3|${sig(tp.ZEN3 / 128)}|${sig(tp.ZEN3 / 160)}|−20%|1.25×`, 'small values per element: the table per CPU too', JSON.stringify(r1.rows));
    // swap with the same code: the counts change sides, and so does the verdict (no new analysis needed)
    await page.eval(`${W} $('ab-swap').click(); await wait(300); return 1;`);
    const r2 = await page.eval(`${W} ${read}`);
    check(r2.work.join() === '160,128' && r2.verdict === 'worse' && /\(\+25%\)/.test(r2.delta) && r2.vals.join() === `${sig(tp.SKL / 160)},${sig(tp.SKL / 128)}`, 'a swap of the counts reweighs the result shown', JSON.stringify(r2));
    // A → B: B gets A's count
    await page.eval(`${W} $('ab-copy').click(); await wait(300); return 1;`);
    const r3 = await page.eval(`${W} ${read}`);
    check(r3.work.join() === '160,160' && r3.verdict === 'same', 'A → B: the counts and the result agree', JSON.stringify(r3));

    // B on a CPU of its own: no row is the comparison's; a row puts both sides on its CPU
    const c = ex('crc32');
    await page.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'asm', text: ex('dot1').text.intel, arch: 'SKL', cpus: 'SKL,ZEN3', ab: true, bMode: 'asm', bText: ex('dot4').text.intel, bArch: 'ZEN3' })}`);
    await page.waitFor(`document.getElementById('ab-cpus')?.dataset.state === 'done' && document.querySelector('.ab-tp')`, 'B on ZEN3', 60000);
    const own = await page.eval(`${W} return { current: [...document.querySelectorAll('#ab-cpus tbody tr.current')].length, meta: document.querySelector('#result-body .meta').textContent };`);
    const pk = await page.eval(`${W} const b = document.querySelector('#ab-cpus tr[data-arch="SKL"] button.pick'); b.focus();
      await done(() => b.click()); await until(() => $('ab-cpus').dataset.state === 'done');
      const tr = document.querySelector('#ab-cpus tr.current');
      return { bArch: $('b-arch').value, current: tr?.dataset.arch, row: [tr?.cells[1].textContent, tr?.cells[2].textContent], head: [...document.querySelectorAll('.ab-tp .value')].map((v) => v.textContent),
        focus: document.activeElement?.getAttribute('data-focus') ?? document.activeElement?.tagName };`);
    check(own.current === 0 && /A SKL .*B ZEN3/.test(own.meta), 'B on its own CPU: no row is marked', JSON.stringify(own));
    check(pk.bArch === '' && pk.current === 'SKL' && pk.row.join() === pk.head.join(), 'a row: both sides on its CPU (B as A); the marked row is the headline', JSON.stringify(pk));
    check(pk.focus === 'abcpu-SKL', 'a row\'s button keeps the focus', JSON.stringify(pk));

    // the side switch keeps the focus; a side without a result: one line, not the other side's views
    const sw = await page.eval(`${W}
      await pick('bound'); await until(() => document.querySelector('.bd-item'));
      const b = document.querySelector('.ws-side-btn[data-tab="side-b"]'); b.focus(); b.click(); await wait(200);
      const out = { focus: document.activeElement?.dataset.tab ?? document.activeElement?.tagName };
      set($('code-b'), 'loop:\\n  frobnicate rax\\n'); await done(() => $('run').click()).catch(() => {}); await wait(300);
      out.empty = [$('ab-side-empty')?.offsetParent !== null ? $('ab-side-empty').textContent : null, $('bound-row').offsetParent === null, document.querySelector('.ws-side-btn.on')?.textContent];
      document.querySelector('.ws-side-btn[data-tab="side-a"]').click(); await wait(200);
      out.a = [$('ab-side-empty')?.offsetParent === null, $('bound-row').offsetParent !== null];
      return out;`);
    check(sw.focus === 'side-b', 'the side switch keeps the focus', JSON.stringify(sw));
    check(sw.empty[0] === 'B: no result' && sw.empty[1] && sw.empty[2] === 'B' && sw.a[0] && sw.a[1], 'B without a result: one line for its views (never A\'s); A\'s views for A', JSON.stringify(sw));
    check(page.take().length === 0, 'review: no console errors');
    await page.close();
  }

  // ---- every port column fits: GEMM, and a block on all 13 ports of ZEN3; single and A–B (both uop tables and the Δ
  // table, opened), ZEN3 and ADL-P, 1440 and 1920, the input open ------------------------------------------------------------
  {
    const g = ex('gemm').text.intel;
    const ALL13 = 'loop:\n  vmovdqu ymm0, ymmword ptr [rdi+rax*4]\n  vpmuludq ymm1, ymm0, ymm2\n  vpsrlq ymm3, ymm0, 32\n  vpmuludq ymm3, ymm3, ymm2\n'
      + '  vpshufd ymm1, ymm1, 0xf5\n  vpblendd ymm1, ymm1, ymm3, 0xaa\n  vpaddd ymm4, ymm4, ymm1\n  vmovdqu ymmword ptr [rsi+rax*4], ymm1\n'
      + '  mov ecx, dword ptr [rdx+rax*4]\n  imul rcx, r8\n  add r9, rcx\n  add rax, 8\n  cmp rax, r10\n  jb loop\n';
    const bad = [];
    let ports13 = 0;
    const page = await Page.open(browser, { width: 1440, height: 900 });
    for (const [name, text] of [['GEMM', g], ['13 ports', ALL13]]) for (const [w, hh] of [[1440, 900], [1920, 1080]]) for (const arch of ['ZEN3', 'ADL-P']) for (const abOn of [false, true]) {
      await page.size(w, hh);
      await page.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'asm', text, arch, ...(abOn ? { ab: true, bMode: 'asm', bText: text } : {}) })}`);
      await page.waitFor(`document.getElementById('results').dataset.run && !document.getElementById('results').hasAttribute('aria-busy') && document.querySelector('table.uops')`, name, 60000);
      const r = await page.eval(`${W} document.querySelectorAll('#result-body details.ab-fold').forEach((d) => { d.open = true; });
        for (let k = 0; k < 4; k++) await new Promise((f) => requestAnimationFrame(f));
        return { folded: document.documentElement.classList.contains('input-folded'), ports: document.querySelectorAll('#result-body table.uops thead th.pg').length,
          wraps: [...document.querySelectorAll('.table-wrap')].filter((x) => x.querySelector(':scope > table.uops, :scope > table.ab-diff') && x.offsetParent)
            .map((x) => [x.querySelector('table').classList.contains('ab-diff') ? 'diff' : 'uops', x.querySelector('table').scrollWidth, x.clientWidth]) };`);
      if (name === '13 ports' && arch === 'ZEN3' && !abOn) ports13 = Math.max(ports13, r.ports);
      if (r.folded || !r.wraps.length || (abOn && !r.wraps.some((x) => x[0] === 'diff')) || r.wraps.some(([, sw, cw]) => sw > cw)) bad.push({ name, w, arch, abOn, ...r });
    }
    check(ports13 >= 12, 'the block uses every port column ZEN3 shows (ALU0–3, AGU0–2, FP0–3, SD0)', String(ports13));
    check(bad.length === 0, 'every port column fits, exactly (GEMM and 13 ports; 1440 and 1920; single and A–B with the Δ table; ZEN3 and ADL-P; the input open)', JSON.stringify(bad));
    // the diff tab shows what differs: dot product, one accumulator against four, on ZEN3
    await page.size(1440, 900);
    await page.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'asm', text: ex('dot1').text.intel, arch: 'ZEN3', ab: true, bMode: 'asm', bText: ex('dot4').text.intel })}`);
    await page.waitFor(`document.querySelector('#ab-main table.uops')`, 'the diff tab', 60000);
    const dm = await page.eval(`${W} const side = (s) => document.querySelector('#ab-main .ab-col[data-side="' + s + '"] table.uops');
      const marks = (s) => ({ rows: [...side(s).tBodies[0].rows].map((tr) => tr.classList.contains('abd-chg') ? 'c' : tr.classList.contains('abd-only') ? 'o' : '-').join(''), cells: side(s).querySelectorAll('td.abd-cell').length });
      const changed = [...document.querySelectorAll('.ab-diff tbody tr')].map((tr) => tr.className.replace('ab-', '')[0]);
      return { a: marks('a'), b: marks('b'), bar: getComputedStyle(side('a').querySelector('tr.abd-chg > th.first') ?? document.body).boxShadow, diff: changed.join('') };`);
    check(dm.a.rows.includes('c') && dm.b.rows.includes('c') && dm.a.cells > 0 && dm.b.cells > 0 && dm.a.rows.replace(/-/g, '').length === dm.diff.replace(/s/g, '').length && /3px/.test(dm.bar),
      'the diff tab: the rows that differ are marked (a bar), their differing cells framed', JSON.stringify(dm));
    // A–B says its summary on top only, not in the status; single mode's status is clear of the CPU table
    const st = await page.eval(`${W} await done(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))); await wait(100);
      const ab = $('status-wrap').classList.contains('idle') || !/cycles per/.test($('status').textContent);
      return ab;`);
    await page.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'asm', text: ex('saxpy').text.intel, arch: 'ADL-P', cpus: 'SKL,ZEN3,ADL-P' })}`);
    await page.waitFor(`document.getElementById('cmp-cpus')?.dataset.state === 'done'`, 'the CPU table', 60000);
    const st2 = await page.eval(`${W} await done(() => $('run').click()); await wait(100);
      const s = rect('#status-wrap'), t = rect('#cmp-cpus');
      return { text: $('status').textContent, idle: $('status-wrap').classList.contains('idle'), overlap: !(s.bottom <= t.top || s.top >= t.bottom || s.right <= t.left || s.left >= t.right), s: [s.top, s.bottom, s.left, s.right], t: [t.top, t.bottom] };`);
    check(st, 'A–B: the status does not repeat the summary', JSON.stringify(st));
    check(!st2.idle && /cycles\/iteration/.test(st2.text) && !st2.overlap, 'single: the status is clear of the CPU table', JSON.stringify(st2));
    // elements per iteration in single mode: per element in the headline and the CPU table; a new example: 1 again
    const want = { ADLP: await tpOf(ex('saxpy').hex, 'ADL-P'), SKL: await tpOf(ex('saxpy').hex, 'SKL') };
    const el = await page.eval(`${W} const f = $('a-work'); f.value = '8'; f.dispatchEvent(new Event('input', { bubbles: true })); await wait(100);
      const out = { field: f.offsetParent !== null, value: document.querySelector('#result-body .tp .value').textContent, title: document.querySelector('#result-body .tp .value').title,
        unit: document.querySelector('#result-body .tp .unit').textContent, skl: document.querySelector('table.cmp-cpus tr[data-arch="SKL"] .cmp-tp')?.textContent };
      await until(() => /aw=8/.test(location.hash));
      await done(() => set($('examples'), 'chain'));
      out.reset = [f.value, document.querySelector('#result-body .tp .unit').textContent, /aw=/.test(location.hash)];
      return out;`);
    const sig = (v) => (v < 0.1 ? v.toPrecision(3) : v.toFixed(2));
    check(el.field && el.value === sig(want.ADLP / 8) && el.unit === 'cycles/element' && / ÷ 8$/.test(el.title) && el.skl === sig(want.SKL / 8),
      'single mode: elements per iteration: per element in the headline and the CPU table', JSON.stringify([el, want]));
    check(el.reset[0] === '1' && el.reset[1] === 'cycles/iteration' && !el.reset[2], 'single mode: an example: 1 element again', JSON.stringify(el.reset));
    check(page.take().length === 0, 'fit and single: no console errors');
    await page.close();
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? e);
} finally {
  await close();
  await srv.stop();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing */ }
}
process.exit(check.summary() ? 1 : 0);
