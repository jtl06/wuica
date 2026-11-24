// Copying as text (web/js/copy-view.js): the control at the end of the tab row copies the shown tab's text, the same text
// its generator gives (the view's provider: markdown.js), for every tab; Shift+click copies
// CSV where the view has it; the key c does what the control does; "copy all" copies the whole result; a long block's
// table is copied with every row (the table draws only some: vrows.js); without a clipboard the status says so and
// nothing breaks. The clipboard is stubbed. Headless Chrome through tests-js/cdp.mjs; skipped without it.
//
//   node tests-js/web_copy_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';

const chrome = findChrome();
const check = checker('copy browser');
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(check.summary() ? 1 : 0); }

const PRE = `${HELPERS}
  const idle = () => $('status-wrap').classList.contains('idle') && !$('results').hasAttribute('aria-busy');
  const settle = async (ms = 400) => { await wait(100); await until(idle, 180000); await wait(ms); };
  const tab = (n) => [...document.querySelectorAll('.view-tab')].find((b) => b.dataset.tab === n).click();
  const reg = await import('/js/copy-view.js');
  window.__copied = null;
  navigator.clipboard.writeText = async (t) => { window.__copied = t; };
  const copied = async (start) => { window.__copied = null; start(); await until(() => window.__copied !== null, 20000); return window.__copied; };
  const ready = { trace: () => document.querySelector('details.trace-panel')?.wuicaTrace || document.querySelector('details.trace-ab')?.wuicaTraces,
    deps: () => ['done', 'error'].includes(document.querySelector('#deps .dp-body')?.dataset.state), mca: () => document.querySelector('.mca-head'),
    sweep: () => document.querySelector('.sweep-head') && !/ pending/.test(reg.getCopy('sweep')?.md().split('\\n')[0] ?? ' pending'),
    try: () => ['done', 'waiting'].includes(document.querySelector('#whatif-row .wi-body')?.dataset.state) };`;

const { CLASSIC_EXAMPLES } = await import(pathToFileURL(path.join(ROOT, 'web/js/examples.js')).href);
const { encodeState } = await import(pathToFileURL(path.join(ROOT, 'web/js/url-state.js')).href);
const [d1, d4] = ['dot1', 'dot4'].map((id) => CLASSIC_EXAMPLES.find((e) => e.id === id));
const srv = await serve(copyDist());
const { browser, close } = await launch(chrome);
try {
  const p = await Page.open(browser, { width: 1440, height: 900 });
  await p.goto(`${srv.origin}/?nosw=1`);
  await p.ready();
  const r = await p.eval(`${PRE}
    await settle();
    const out = { tabs: {} };
    for (const name of [...document.querySelectorAll('.view-tab')].map((b) => b.dataset.tab)) {
      tab(name); await settle();
      if (ready[name]) await until(ready[name], 120000);
      await settle(200);
      const control = document.querySelector('#result-body .view-tabs .ws-copy');
      const got = await copied(() => control.click()).catch(() => null);
      const want = reg.getCopy(name)?.md() ?? null;
      out.tabs[name] = { same: got !== null && got === want, head: (got ?? '').split('\\n')[0].slice(0, 60), lines: (got ?? '').split('\\n').length, status: $('status').textContent, last: control === [...control.parentElement.children].at(-1) };
    }
    // the table: CSV on Shift+click; the key c
    tab('table'); await settle();
    out.csv = (await copied(() => document.querySelector('.ws-copy').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))).split('\\r\\n')[0];
    document.body.focus();
    out.key = await copied(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))) === reg.getCopy('table').md();
    // the whole result
    const all = reg.getCopy('all') ? await copied(() => document.querySelector('.copy-all').click()) : null;
    out.all = all !== null && all === reg.getCopy('all').md() && /^\\*\\*/.test(all) && /\\[open in wuica\\]/.test(all) && /\\n\\x60{3}asm\\nloop:\\n/.test(all) ? true : (all ?? 'no provider').slice(0, 200);
    // no clipboard: a message, no error
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    document.execCommand = () => false;
    document.querySelector('.ws-copy').click(); await wait(200);
    out.denied = [$('status').textContent, !document.querySelector('.error-box')];
    return out;`, { timeout: 900000 });
  for (const [name, t] of Object.entries(r.tabs)) {
    check(t.same && t.lines > 1 && /^copied/.test(t.status) && t.last, `${name}: the control (the end of the tab row) copies the tab's text, as its generator makes it; the status says so`, JSON.stringify(t));
  }
  check(/^instruction,opcode,notes/.test(r.csv), 'the table: Shift+click copies CSV', r.csv);
  check(r.key === true, 'the key c copies the shown tab');
  check(r.all === true, '"copy all" copies the whole result', String(r.all));
  check(/copy failed/.test(r.denied[0]) && r.denied[1], 'no clipboard: the status says so, nothing breaks', JSON.stringify(r.denied));

  // a long block: every row of the table, whichever rows are drawn
  const long = await p.eval(`${PRE}
    $('examples').value = 'sha256'; $('examples').dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => (document.querySelector('#result-body .meta')?.title ?? '').startsWith('2949 instructions'), 120000); await settle();
    tab('table'); await settle();
    const text = await copied(() => document.querySelector('.ws-copy').click());
    const t = document.querySelector('#result-body table.uops');
    return { rows: text.split('\\n').filter((l) => /^\\| /.test(l)).length, count: t.vr.count, drawn: t.querySelectorAll('tbody tr[data-row]').length };`, { timeout: 300000 });
  check(long.rows >= long.count + 2 && long.drawn < 200, 'a long block: the copied table has every row (2 lines more: the head and the total), though few are drawn', JSON.stringify(long));
  // several CPUs: "copy all" adds their table; A–B: the diff tab and "copy all" (the comparison, then each side)
  await p.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'hex', text: d1.text.hex, arch: 'SKL', cpus: 'SKL,ZEN3' })}`);
  await p.ready();
  const cpus = await p.eval(`${PRE}
    await settle(); await until(() => reg.getCopy('cpus') && !reg.getCopy('all').md().includes('not analyzed yet') && /\\| ZEN3 /.test(reg.getCopy('all').md()), 120000);
    const t = await copied(() => document.querySelector('.copy-all').click());
    const c = await copied(() => document.querySelector('#cmp-cpus .cmp-copy').click());
    return { same: t === reg.getCopy('all').md(), cpus: /\\| CPU +\\| Model/.test(t) && /\\| SKL +\\| Skylake +\\| 2015 /.test(t) && /\\| ZEN3 /.test(t),
      table: c === reg.getCopy('cpus').md() && t.includes(c.split('\\n')[0]), status: $('status').textContent };`, { timeout: 300000 });
  check(cpus.same && cpus.cpus, 'several CPUs: "copy all" has the table of the checked CPUs', JSON.stringify(cpus));
  check(cpus.table && /^copied: the table of the checked CPUs/.test(cpus.status), 'several CPUs: the table\'s own control copies it (markdown.js cpuTable)', JSON.stringify(cpus));
  await p.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'hex', text: d1.text.hex, ab: true, bMode: 'hex', bText: d4.text.hex, arch: 'SKL' })}`);
  await p.ready();
  const ab = await p.eval(`${PRE}
    await until(() => document.querySelector('#ab-main') && reg.getCopy('diff'), 120000); await settle();
    tab('diff'); await settle(200);
    const d = await copied(() => document.querySelector('#result-body .view-tabs .ws-copy').click());
    const a = await copied(() => document.querySelector('.copy-all').click());
    return { diff: d === reg.getCopy('diff').md(), head: d.split('\\n')[0], all: a === reg.getCopy('all').md(), sides: /^## A$/m.test(a) && /^## B$/m.test(a) && a.startsWith(d.split('\\n')[0]) && (a.match(/^\\x60{3}/gm) ?? []).length === 4, status: $('status').textContent };`, { timeout: 300000 });
  check(ab.diff && /^\*\*A [\d.]+ · B [\d.]+ cycles per iteration\*\*/.test(ab.head), 'A–B: the diff tab copies the comparison (markdown.js compare)', JSON.stringify(ab));
  check(ab.all && ab.sides && /^copied: the whole A–B result/.test(ab.status), 'A–B: "copy all" copies the comparison, then A and B', JSON.stringify(ab));
  check(p.problems.length === 0, 'no console errors', p.problems.join('\n'));
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
