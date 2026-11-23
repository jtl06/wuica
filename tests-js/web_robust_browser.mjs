// Robustness of the page with large inputs, in headless Chrome (started with --headless and --remote-debugging-port
// through tests-js/cdp.mjs) with the real analyzer and assembler:
// - the assembler runs in a worker: a .rept that takes seconds to assemble does not freeze the page; a new edit in live
//   mode stops it and analyzes the new input at once; Cancel stops it; asm -> hex conversion still works
// Skipped (exit 0) without Chrome.
//
//   node tests-js/web_robust_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';

const chrome = findChrome();
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('robust browser');
const dir = copyDist();
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const { encodeState, DEFAULT_STATE } = await import(pathToFileURL(path.join(ROOT, 'web/js/url-state.js')).href);
const { EXAMPLES } = await import(pathToFileURL(path.join(ROOT, 'web/js/examples.js')).href);
const CHAIN = EXAMPLES[0];

// In the page: the longest time without a timer tick (the page's thread was blocked) while f() runs.
const GAPS = `
  const gaps = async (f) => {
    let last = performance.now(), max = 0;
    const t = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n; }, 10);
    try { await f(); } finally { clearInterval(t); }
    return Math.max(max, performance.now() - last);
  };`;
const BIG = '.rept 10000000\\nnop\\n.endr'; // about 3.5 s in one run of the assembler, then "Too much machine code"

const srv = await serve(dir);
const { browser, close } = await launch(chrome);
try {
  const page = await Page.open(browser);
  const link = (state) => `${srv.origin}/#${encodeState({ ...DEFAULT_STATE, ...state })}`;

  if (!manifest.assembler) {
    console.log('this build has no assembler: the assembler checks are skipped');
  } else {
    // ---- 1. the assembler in a worker
    await page.goto(link({ text: CHAIN.text.intel }));
    await page.ready();
    await page.waitFor(`document.querySelector('#result-body .tp .value')`, 'the first result', 60000);
    const r1 = await page.eval(`${HELPERS} ${GAPS}
      const out = {};
      // live mode: a huge .rept is assembled in the worker; the page keeps running
      out.gap = await gaps(async () => {
        set($('code'), '${BIG}');
        await until(() => msgs().some((m) => /Too much machine code/.test(m)), 120000);
      });
      out.msg = msgs().join(' | ');
      // a new edit while it assembles: the assembly stops, the new input is analyzed at once
      set($('code'), '${BIG}');
      await wait(700);
      out.busyText = $('run').textContent;
      const n = runId();
      const t0 = performance.now();
      set($('code'), ${JSON.stringify(CHAIN.text.intel)});
      await until(() => runId() !== n && !$('results').hasAttribute('aria-busy'), 120000);
      out.supersede = performance.now() - t0;
      out.tp = tp();
      out.after = msgs().join(' | ');
      // Cancel while it assembles (the button says Cancel)
      if ($('live').checked) $('live').click();
      set($('code'), '${BIG}');
      $('run').click();
      await wait(600);
      out.cancelText = $('run').textContent;
      const t1 = performance.now();
      $('run').click();
      await until(() => $('run').textContent === 'Analyze', 10000);
      out.cancel = performance.now() - t1;
      out.status = $('status').textContent;
      await wait(300);
      out.afterCancel = msgs().join(' | ');
      // the assembler still works after being stopped twice, and the conversion asm -> hex uses it
      set($('code'), ${JSON.stringify(CHAIN.text.intel)});
      await done(() => $('run').click());
      out.tp2 = tp();
      $('mode-hex').click();
      await until(() => /48 83 c0 01/.test($('code').value), 20000);
      out.hex = $('code').value.split('\\n').filter((l) => l.trim()).length;
      if (!$('live').checked) $('live').click();
      return out;`, { timeout: 300000 });
    check(/Too much machine code/.test(r1.msg), 'a huge .rept: the size message', r1.msg);
    check(r1.gap < 1000, `a huge .rept does not block the page (longest gap ${r1.gap.toFixed(0)} ms; it took seconds on the page's thread)`);
    check(r1.busyText === 'Cancel', 'a long assembly shows Cancel', r1.busyText);
    check(r1.tp === '2.00' && r1.after === '', 'an edit during a long assembly: the new input is analyzed', JSON.stringify(r1));
    check(r1.supersede < 2500, `... without waiting for the old assembly (${r1.supersede.toFixed(0)} ms)`);
    check(r1.cancelText === 'Cancel' && r1.cancel < 1000 && /cancelled/.test(r1.status) && r1.afterCancel === '', `Cancel stops a long assembly (${r1.cancel.toFixed(0)} ms)`, JSON.stringify(r1));
    check(r1.tp2 === '2.00' && r1.hex === 4, 'the assembler works afterwards; asm -> hex conversion', JSON.stringify(r1));
  }
  const problems = page.take();
  check(problems.length === 0, 'no console errors', problems.join('\n'));
  await page.close();
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
