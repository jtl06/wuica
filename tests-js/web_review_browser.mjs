// What the 0.1.10 review found, each against values the test makes itself (not the page's own generators):
// - a copy is of the result on screen: "copy all" after an edit (live off) has the analyzed code and a link to it, the
//   status says the result is stale; the table's copy is per element when the elements per iteration are given;
// - the trace tab never copies the previous result's trace while the new one is being made;
// - copies print branch targets as the table does (no 64-bit relative targets);
// - a jump to a row from bytes, bound and deps ends with the row drawn, in view and focused (SHA-256);
// - A–B's two tables (300 rows or fewer, a gap of 40 rows) scroll in step, row by row;
// - a long list of assembler messages scrolls in its own box at 1200 × 700, with its count, over nothing.
// Headless Chrome through tests-js/cdp.mjs; skipped without it. WUICA_TEST_DIST=DIR serves another build.
//
//   node tests-js/web_review_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';
import { encodeState } from '../web/js/url-state.js';
import { EXAMPLES } from '../web/js/examples.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { tableBytes } from './tables.mjs';

const chrome = findChrome();
const check = checker('review browser');
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(check.summary() ? 1 : 0); }

// the default example's throughput, from an analysis of the test's own
const chain = EXAMPLES.find((e) => e.id === 'chain');
const engine = await WasmEngine.create(fs.readFileSync(path.join(ROOT, 'web/dist/wuica_wasm.wasm')));
await engine.loadUarch(fs.readFileSync(path.join(ROOT, 'web/dist/data/uarch.json')));
await engine.loadArch('SKL', tableBytes('SKL'));
const chainTp = Number((await engine.analyze(makeRequest(chain.hex, 'SKL'))).tp);
const IMUL = 'loop:\n  imul rax, rax\n  imul rax, rax\n  dec r15\n  jnz loop\n';

const PRE = `${HELPERS}
  const idle = () => $('status-wrap').classList.contains('idle') && !$('results').hasAttribute('aria-busy');
  const settle = async (ms = 300) => { await wait(100); await until(idle, 180000); await wait(ms); };
  const tab = (n) => [...document.querySelectorAll('.view-tab')].find((b) => b.dataset.tab === n).click();
  window.__copied = null;
  navigator.clipboard.writeText = async (t) => { window.__copied = t; };
  // a click on a copy control: what reached the clipboard (null: nothing) and the status line
  const copyBy = async (el) => { window.__copied = null; el.click(); await wait(300); return { text: window.__copied, status: $('status').textContent }; };
  const tabCopy = () => document.querySelector('#result-body .view-tabs .ws-copy');
  const inView = (tr) => { const r = tr.getBoundingClientRect(), w = tr.closest('.table-wrap').getBoundingClientRect(); return r.height > 0 && r.top >= Math.max(0, w.top) - 1 && r.bottom <= Math.min(innerHeight, w.bottom) + 1; };
  const frames = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };`;

const dir = process.env.WUICA_TEST_DIST || copyDist();
const srv = await serve(dir);
const { browser, close } = await launch(chrome);
try {
  // ---- 1, 3: a copy is of the result shown; per element ----
  {
    const p = await Page.open(browser, { width: 1440, height: 900 });
    await p.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'asm', syntax: 'intel', text: chain.text.intel, aWork: 4 })}`);
    await p.ready();
    const r = await p.eval(`${PRE}
      await until(() => tp(), 60000); await settle();
      if ($('live').checked) $('live').click();
      tab('table'); await settle(100);
      const table = await copyBy(tabCopy());
      // an edit, not analyzed (live is off)
      set($('code'), ${JSON.stringify(IMUL)});
      await wait(300);
      const all = await copyBy(document.querySelector('.copy-all'));
      const { decodeState } = await import('/js/url-state.js');
      const link = /\\[open in wuica\\]\\(([^)]*)\\)/.exec(all.text ?? '')?.[1] ?? '';
      const linked = link.includes('#') ? decodeState(link.slice(link.indexOf('#') + 1)) : null;
      const fence = /\\x60{3}asm\\n([\\s\\S]*?)\\x60{3}/.exec(all.text ?? '')?.[1] ?? '';
      return { screen: tp(), table: table.text?.split('\\n')[0], all: all.text?.split('\\n')[0], fence, linkText: linked?.text ?? null, linkWork: linked?.aWork ?? null, status: all.status };`);
    const want = (chainTp / 4).toFixed(2);
    check(r.screen === want && r.table?.startsWith(`**${want} cycles/element**`), `the table's copy is per element as the screen (${want} cycles/element with 4 elements per iteration)`, JSON.stringify(r));
    check(r.all?.startsWith(`**${want} cycles/element**`) && r.fence === chain.text.intel && !r.fence.includes('imul'), '"copy all" after an edit: the analyzed code, not the editor\'s', JSON.stringify(r));
    check(r.linkText === chain.text.intel && r.linkWork === 4, '"copy all" after an edit: the link opens the analyzed code (and its elements per iteration)', JSON.stringify([r.linkText, r.linkWork]));
    check(/stale/.test(r.status), 'a copy of a stale result says so in the status line', r.status);
    check(p.problems.length === 0, 'no console errors (copy of the result shown)', p.problems.join('\n'));
    await p.close();
  }

  // ---- 2, 7, 5: SHA-256 after the default example ----
  {
    const p = await Page.open(browser, { width: 1440, height: 900 });
    await p.goto(`${srv.origin}/?nosw=1`);
    await p.ready();
    const r = await p.eval(`${PRE}
      await until(() => tp(), 60000); await settle();
      tab('trace'); await until(() => document.querySelector('details.trace-panel')?.wuicaTrace, 60000); await settle(200);
      const first = await copyBy(tabCopy());
      // another result: until its trace is made, the old one is never copied
      set($('examples'), 'sha256');
      await until(() => tp() === '744.25', 120000);
      const during = await copyBy(tabCopy());
      return { first: first.text?.includes('add rax, 0x1') ?? false, during: during.text === null ? null : during.text.slice(0, 120), status: during.status };`, { timeout: 300000 });
    check(r.first, 'the trace tab copies the trace of the result shown', JSON.stringify(r));
    check(r.during === null && !/^copied/.test(r.status), 'the next result: its trace not made yet, the old trace is not copied (the status says why)', JSON.stringify(r));

    // the labels: as the table shows them, in every copy
    const l = await p.eval(`${PRE}
      await settle();
      const t = document.querySelector('#result-body table.uops');
      const last = t.vr.count - 1;
      tab('table'); await settle(100);
      const label = t.vr.reveal(last).cells[0].textContent.trim();
      const out = { label };
      for (const name of ['bytes', 'bound', 'deps']) {
        tab(name); await settle(200);
        if (name === 'deps') await until(() => ['done', 'error'].includes(document.querySelector('#deps .dp-body')?.dataset.state), 120000);
        const c = await copyBy(tabCopy());
        out[name] = { raw: /0x[0-9a-f]{9,}/.test(c.text ?? ''), has: (c.text ?? '').includes('\\x60' + label + '\\x60'), n: (c.text ?? '').length };
      }
      return out;`, { timeout: 300000 });
    check(/^j/.test(l.label) && !/0x[0-9a-f]{9,}/.test(l.label), 'SHA-256: the table shows its last branch with a label', l.label);
    for (const name of ['bytes', 'bound', 'deps']) check(l[name].n > 0 && !l[name].raw, `${name}: the copy has no 64-bit branch targets`, JSON.stringify(l[name]));
    check(l.bytes.has && l.deps.has, 'bytes, deps: the last branch is copied as the table shows it', JSON.stringify(l));

    // jumps: the row drawn, in view and focused (after the layout has settled)
    const j = await p.eval(`${PRE}
      const t = () => document.querySelector('#result-body table.uops');
      const at = async () => { await wait(150); await frames(6); const a = document.activeElement; const tr = a?.closest?.('table.uops tbody tr[data-row]'); return { row: tr ? Number(tr.dataset.row) : -1, inView: tr ? inView(tr) : false }; };
      const out = { count: t().vr.count };
      // bytes: the last instruction, by keys (End, Enter)
      tab('bytes'); await settle(200);
      const ly = document.querySelector('#codemap .ly-map'); ly.focus();
      for (const key of ['End', 'Enter']) ly.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      out.bytes = await at();
      out.bytesWant = Number(document.querySelector('#codemap .ly-ins.sel')?.dataset.i ?? -1);
      // deps: the last instruction
      tab('deps'); await settle(200);
      const dp = document.querySelector('#deps .dp-map'); dp.focus();
      for (const key of ['End', 'Enter']) dp.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      out.deps = await at();
      // bound: the chain's first row
      tab('bound'); await settle(200);
      document.querySelector('.bd-item[data-id="Dependencies"]')?.click(); await wait(200);
      document.querySelector('.bd-row')?.click();
      out.bound = await at();
      out.boundTab = document.querySelector('#result-body .view-tab[aria-selected="true"]')?.dataset.tab;
      return out;`, { timeout: 300000 });
    check(j.bytes.row === j.count - 1 && j.bytes.inView, 'bytes: a jump to the last instruction ends with its row drawn, in view and focused', JSON.stringify(j));
    check(j.deps.row === j.count - 1 && j.deps.inView, 'deps: a jump to the last instruction ends with its row drawn, in view and focused', JSON.stringify(j));
    check(j.bound.row >= 0 && j.bound.inView && j.boundTab === 'table', 'bound: a jump ends with its row drawn, in view and focused', JSON.stringify(j));
    check(p.problems.length === 0, 'no console errors (SHA-256)', p.problems.join('\n'));
    await p.close();
  }

  // ---- 6: A–B, 300 rows or fewer, B with 40 rows more on top: the tables scroll in step ----
  {
    const add = '4883c001'.repeat(150), inc = '48ffc1'.repeat(40);
    const p = await Page.open(browser, { width: 1440, height: 900 });
    await p.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'hex', text: add, ab: true, bMode: 'hex', bText: inc + add, arch: 'SKL' })}`);
    await p.ready();
    const r = await p.eval(`${PRE}
      await until(() => document.querySelectorAll('#ab-main .ab-col > .table-wrap table.uops').length === 2, 120000); await settle();
      const [wa, wb] = [...document.querySelectorAll('#ab-main .ab-col > .table-wrap')];
      const ta = wa.querySelector('table.uops'), tb = wb.querySelector('table.uops');
      const out = { rows: [ta.vr.count, tb.vr.count], windowed: [ta.vr.windowed, tb.vr.windowed], gaps: [] };
      await until(() => wa.scrollHeight > wa.clientHeight + 100 && wb.scrollHeight > wb.clientHeight + 100, 10000).catch(() => {}); // (fitted)
      // A's row k and B's row k + 40 (the same instruction): how far apart in height in their boxes
      const gap = (k) => (tb.vr.el(k + 40).getBoundingClientRect().top - wb.getBoundingClientRect().top) - (ta.vr.el(k).getBoundingClientRect().top - wa.getBoundingClientRect().top);
      for (const k of [60, 100, 130]) {
        const b0 = wb.scrollTop;
        wa.scrollTop = ta.vr.el(k).getBoundingClientRect().top - ta.vr.el(0).getBoundingClientRect().top + 5;
        await until(() => wb.scrollTop !== b0, 3000).catch(() => {}); // (B follows on A's scroll event)
        await frames(2);
        out.gaps.push(Math.round(gap(k) * 10) / 10);
      }
      return out;`, { timeout: 300000 });
    check(r.rows[0] <= 300 && r.rows[1] <= 300 && !r.windowed[0] && !r.windowed[1] && r.gaps.every((g) => Math.abs(g) < 1.5), 'A–B: short tables scroll in step (the same instruction at the same height in both)', JSON.stringify(r));
    check(p.problems.length === 0, 'no console errors (A–B)', p.problems.join('\n'));
    await p.close();
  }

  // ---- 8: 200 lines the assembler rejects, at 1200 × 700 ----
  {
    const bad = Array.from({ length: 200 }, (_, i) => `  frobnicate r${i}`).join('\n') + '\n';
    const p = await Page.open(browser, { width: 1200, height: 700 });
    await p.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'asm', syntax: 'intel', text: bad })}`);
    await p.ready();
    const r = await p.eval(`${PRE}
      await until(() => msgs().length >= 20, 120000); await settle();
      const box = document.querySelector('#input-messages > ul'), last = box.lastElementChild;
      const center = (e) => { const b = e.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); };
      const out = { n: msgs().length, count: document.querySelector('#input-messages .msg-count')?.textContent ?? '', own: box.scrollHeight > box.clientHeight + 4, h: box.clientHeight,
        run: center($('run')) === $('run'), cpu: $('cpus').contains(center(document.querySelector('#cpu-grid input') ?? $('cpus'))),
        above: $('input-messages').getBoundingClientRect().bottom <= $('cpus').getBoundingClientRect().top + 1, page: document.documentElement.scrollHeight - innerHeight };
      box.scrollTop = box.scrollHeight; await wait(100);
      const lb = last.getBoundingClientRect(), bb = box.getBoundingClientRect();
      out.lastShown = lb.bottom <= bb.bottom + 1 && lb.top >= bb.top - 1 && lb.bottom <= innerHeight;
      return out;`, { timeout: 300000 });
    check(r.n >= 20 && r.count.startsWith(`${r.n} messages`), 'messages: their count', JSON.stringify(r));
    check(r.own && r.h < 200 && r.lastShown, 'messages: a box of their own that scrolls to the last one', JSON.stringify(r));
    check(r.run && r.cpu && r.above && r.page <= 0, 'messages: nothing is drawn over the CPUs or Analyze; the page does not scroll', JSON.stringify(r));
    check(p.problems.length === 0, 'no console errors (messages)', p.problems.join('\n'));
    await p.close();
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
