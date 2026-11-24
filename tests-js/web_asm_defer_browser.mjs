// The first visit does not wait for the assembler (web/js/app.js, asm-shipped.js): the default example's result is shown
// from its machine code with the assembler held back by the server; the assembler is asked for after that result; an
// edit made before it is there waits for it (the status names it, no error, the old result marked as out of date) and
// then gets its own result; a built-in example picked meanwhile needs no assembler; A–B waits for it; a link with other
// code asks for it at once, a link in hex mode not at all. Headless Chrome through tests-js/cdp.mjs; skipped without it.
//
//   node tests-js/web_asm_defer_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT, sleep } from './cdp.mjs';
import { hostHandler } from './static-host.mjs';
import { encodeState } from '../web/js/url-state.js';

const chrome = findChrome();
const check = checker('deferred assembler browser');
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(check.summary() ? 1 : 0); }
const dir = copyDist();
if (!fs.existsSync(path.join(dir, 'wuica_asm.wasm'))) { console.log('this build has no assembler: skipped'); process.exit(check.summary() ? 1 : 0); }

// the assembler's requests: when they came, and held until released
let hold = false;
const held = [], asked = [];
const host = hostHandler(() => dir);
const srv = await serve(dir, {
  extra: (req, res) => {
    if (!/\/wuica_asm\.wasm(\?|$)/.test(req.url)) return false;
    asked.push(Date.now());
    if (hold) { held.push([req, res]); return true; }
    return false;
  },
});
const release = () => { hold = false; for (const [req, res] of held.splice(0)) host(req, res); };
// the moment the first result is on the page (wall clock, to compare with the server's)
const FIRST = `(() => { const t = () => { if (document.querySelector('#result-body .tp .value, #result-body .ab-tp .value')) { window.__first = Date.now(); return true; } return false; };
  const go = () => { if (t()) return; new MutationObserver((_, o) => { if (t()) o.disconnect(); }).observe(document.documentElement, { childList: true, subtree: true }); };
  if (document.documentElement) go(); else addEventListener('DOMContentLoaded', go); })();`;
const open = async () => { const p = await Page.open(browser, { width: 1440, height: 900 }); await p.cmd('Page.addScriptToEvaluateOnNewDocument', { source: FIRST }); return p; };

const { browser, close } = await launch(chrome);
try {
  // a fresh visit, the assembler held back
  {
    hold = true; asked.length = 0;
    const page = await open();
    await page.goto(`${srv.origin}/?nosw=1`);
    const r = await page.eval(`${HELPERS}
      await until(() => window.__first && tp(), 60000);
      await wait(300);
      return { tp: tp(), first: window.__first, messages: $('input-messages').textContent, code: $('code').value.split('\\n')[1] };`);
    await page.waitFor('true', 'tick');
    for (let i = 0; i < 50 && !asked.length; i++) await sleep(100);
    check(r.tp === '2.00' && r.messages === '' && asked.length >= 1 && asked[0] >= r.first, 'a fresh visit: the default example\'s result from its machine code, the assembler asked for only after it', JSON.stringify({ ...r, asked: asked.map((t) => t - r.first) }));
    // an edit before the assembler is there: it waits for it, then gets its own result
    const w = await page.eval(`${HELPERS}
      const run = runId();
      set($('code'), 'loop:\\n  add rax, 1\\n  dec r15\\n  jnz loop\\n');
      $('run').click();
      await wait(1500);
      return { run: runId() === run, tp: tp(), status: $('status').textContent, stale: $('result-body').classList.contains('stale') || $('results').hasAttribute('aria-busy'), errors: [...document.querySelectorAll('#input-messages li')].map((l) => l.textContent) };`);
    check(w.run && w.tp === '2.00' && /assembler/.test(w.status) && w.stale && w.errors.length === 0, 'an edit before the assembler is there: it waits (the status names the assembler; the old result marked; no error)', JSON.stringify(w));
    release();
    const after = await page.eval(`${HELPERS} await until(() => tp() === '1.00', 60000); return { tp: tp(), stale: $('result-body').classList.contains('stale') };`);
    check(after.tp === '1.00' && !after.stale, 'then the edit gets its own result', JSON.stringify(after));
    check(page.problems.length === 0, 'no console errors (fresh visit)', page.problems.join('\n'));
    await page.close();
  }

  // a fresh visit: an example picked from the menu, and A–B, before the assembler is there
  {
    hold = true; asked.length = 0;
    const page = await open();
    await page.goto(`${srv.origin}/?nosw=1`);
    const r = await page.eval(`${HELPERS}
      await until(() => tp(), 60000); await wait(200);
      const run = runId();
      $('examples').value = 'dot4'; $('examples').dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => runId() !== run, 30000); await wait(100);
      const out = { tp: tp(), dot4: $('code').value.includes('ymm3') };
      const run2 = runId();
      $('cmp-ab').click(); await wait(500);
      await until(() => /assembler/.test($('status').textContent), 8000).catch(() => {}); // (after the last result's message)
      out.ab = { waited: runId() === run2, status: $('status').textContent, errors: [...document.querySelectorAll('#input-messages li, #b-messages li')].map((l) => l.textContent) };
      return out;`);
    check(r.dot4 && /^\d+\.\d\d$/.test(r.tp ?? ''), 'an example picked before the assembler is there: its result at once', JSON.stringify(r));
    check(r.ab.waited && /assembler/.test(r.ab.status) && r.ab.errors.length === 0, 'A–B before the assembler is there: it waits for it (the status names it)', JSON.stringify(r.ab));
    release();
    const ab = await page.eval(`${HELPERS} await until(() => document.querySelector('.ab-tp .value'), 60000); return document.querySelectorAll('.ab-tp .value').length;`);
    check(ab === 2, 'A–B: its result once the assembler is there', ab);
    check(page.problems.length === 0, 'no console errors (example, A–B)', page.problems.join('\n'));
    await page.close();
  }

  // a link with other code: the assembler at once (the first result needs it); a link in hex mode: never asked for
  {
    hold = false; asked.length = 0;
    const page = await open();
    await page.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'asm', text: 'loop:\n  imul rax, rax\n  dec r15\n  jnz loop\n' })}`);
    const first = await page.eval(`${HELPERS} await until(() => window.__first && tp(), 60000); return { first: window.__first, tp: tp() };`);
    check(asked.length >= 1 && asked[0] < first.first && first.tp === '3.00', 'a link with other code: the assembler is asked for at once', JSON.stringify({ ...first, asked: asked.map((t) => t - first.first) }));
    asked.length = 0;
    await page.goto(`${srv.origin}/?nosw=1#${encodeState({ mode: 'hex', text: '4883c001 49ffcf 75f6' })}`);
    await page.eval(`${HELPERS} await until(() => window.__first && tp(), 60000); await wait(1500); return 1;`);
    check(asked.length === 0, 'a link in hex mode: the assembler is not asked for', asked.length);
    check(page.problems.length === 0, 'no console errors (links)', page.problems.join('\n'));
    await page.close();
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  release();
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
