// The llvm-mca view (web/js/mca.js) in headless Chrome (--headless, --remote-debugging-port: tests-js/cdp.mjs), with the
// module's download held back or failed by the test's server:
// - wait: while the module loads, the view says so and its copy says "not ready yet"; then the text and its copy;
// - error: a module that cannot be loaded: a message, nothing to copy; the next opening tries again and works;
// - clear: another result while the view is closed: its copy is gone (not the text of the code before);
// - the earlier code again (dot4 -> dot1 -> dot4 with the view closed), the view opened: its copy is dot4's text, not
//   "nothing to copy here" (the key of the shown text was kept while its copy was cleared).
//   node tests-js/web_mca_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';
import { hostHandler } from './static-host.mjs';

const chrome = findChrome();
const check = checker('mca browser');
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(check.summary() ? 1 : 0); }
const dir = copyDist();
if (!fs.existsSync(path.join(dir, 'wuica_mca.wasm'))) { console.log('this build has no llvm-mca (mca/dist): skipped'); process.exit(check.summary() ? 1 : 0); }

// the module's download: 'ok', 'hold' (answered when released) or 'fail' (HTTP 500)
let mode = 'ok';
const held = [];
const host = hostHandler(() => dir);
const release = () => { mode = 'ok'; for (const [req, res] of held.splice(0)) host(req, res); };
const srv = await serve(dir, {
  extra(req, res) {
    if (!req.url.startsWith('/wuica_mca.wasm')) return false;
    if (mode === 'hold') { held.push([req, res]); return true; }
    if (mode === 'fail') { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('test: not now'); return true; }
    return false;
  },
});

const PRE = `${HELPERS}
  const idle = () => $('status-wrap').classList.contains('idle') && !$('results').hasAttribute('aria-busy');
  const settle = async (ms = 300) => { await wait(100); await until(idle, 120000); await wait(ms); };
  const tab = (n) => [...document.querySelectorAll('.view-tab')].find((b) => b.dataset.tab === n).click();
  const example = async (id) => { $('examples').value = id; $('examples').dispatchEvent(new Event('change', { bubbles: true })); await wait(200); await settle(); };
  const reg = await import('/js/copy-view.js');
  window.__copied ??= null;
  navigator.clipboard.writeText = async (t) => { window.__copied = t; };
  // the copy control of the shown tab: what it copied (null: nothing) and the status line
  const copy = async () => { window.__copied = null; const before = $('status').textContent; document.querySelector('#result-body .view-tabs .ws-copy').click();
    await until(() => window.__copied !== null || $('status').textContent !== before, 10000); await wait(50); return { text: window.__copied, status: $('status').textContent }; };
  const body = () => document.querySelector('#mca .mca-body')?.textContent ?? '';
  const head = () => document.querySelector('#mca .mca-head');`;

const { browser, close } = await launch(chrome);
try {
  // ---- wait, then the text
  mode = 'hold';
  let p = await Page.open(browser, { width: 1440, height: 900 });
  await p.goto(`${srv.origin}/?nosw=1`);
  await p.ready();
  let r = await p.eval(`${PRE} await settle(); await example('dot4'); tab('mca'); await until(() => reg.getCopy('mca')?.waiting, 20000); await wait(200);
    return { body: body(), copy: await copy(), open: $('mca').open };`);
  check(r.open && /llvm-mca: loading/.test(r.body), 'wait: while the module loads, the view says so', JSON.stringify(r));
  check(r.copy.text === null && /not copied: llvm-mca's text is not ready yet/.test(r.copy.status), 'wait: its copy says it is not ready', JSON.stringify(r.copy));
  check(held.length >= 1, 'wait: the module was asked for (and held back)', held.length);
  release();
  r = await p.eval(`${PRE} await until(head, 120000); await settle(); return { head: head().textContent, copy: await copy() };`);
  check(/cycles\/iteration/.test(r.head) && r.copy.text?.startsWith('**llvm-mca** · ') && /Iterations:/.test(r.copy.text) && /^copied/.test(r.copy.status), 'wait: then the text, and its copy', JSON.stringify({ head: r.head, copy: r.copy.text?.slice(0, 80), status: r.copy.status }));
  const dot4 = r.copy.text;

  // ---- clear: another result while the view is closed; the earlier code again, then the view (N1)
  r = await p.eval(`${PRE} tab('table'); await settle(); const closed = !$('mca').open; await example('dot1');
    const cleared = reg.getCopy('mca'); await example('dot4'); const again = reg.getCopy('mca');
    tab('mca'); await settle(); await until(() => head() && !reg.getCopy('mca')?.waiting, 120000); await settle();
    return { closed, cleared: cleared === null, again: again === null, copy: await copy(), body: body().slice(0, 200) };`);
  check(r.closed, 'the table tab closes the llvm-mca view', JSON.stringify(r));
  check(r.cleared && r.again, 'clear: another result while the view is closed: nothing to copy (not the text of other code)', JSON.stringify(r));
  check(r.copy.text === dot4 && /^copied/.test(r.copy.status), 'dot4 -> dot1 -> dot4 with the view closed, then the view: its copy is dot4\'s text (not "nothing to copy here")', JSON.stringify({ copy: r.copy.text?.slice(0, 80), status: r.copy.status, body: r.body }));
  // open while another result comes: the new text (not dot4's)
  r = await p.eval(`${PRE} await example('dot1'); await until(() => head() && !reg.getCopy('mca')?.waiting, 120000); await settle(); return { copy: await copy() };`);
  check(r.copy.text?.startsWith('**llvm-mca** · ') && r.copy.text !== dot4, 'another result while the view is open: its own text', r.copy.text?.slice(0, 80));
  // a loop whose exit branch goes to a label outside it (memchr, from a user test): llvm-mca reads all five instructions
  // (the exit was a .byte line to it: 4 instructions, and "uiCA 2.00 (llvm-mca −50%)" compared another loop)
  const memchr = '  testq %rdx, %rdx\n  je .LBB0_1\n  movq %rdi, %rax\n  .p2align 4\n.LBB0_4:\n  cmpb %sil, (%rax)\n  je .LBB0_2\n  incq %rax\n  decq %rdx\n  jne .LBB0_4\n.LBB0_1:\n  xorl %eax, %eax\n.LBB0_2:\n  retq\n';
  r = await p.eval(`${PRE} set($('code'), ${JSON.stringify(memchr)}); await wait(300); await done(() => $('run').click()); await settle();
    await until(() => head() && /byte ptr \\[rax\\], sil/.test(document.querySelector('#mca .mca-out')?.textContent ?? ''), 120000); await settle();
    return { head: head().textContent, out: document.querySelector('#mca .mca-out')?.textContent ?? '' };`);
  check(/^Instructions:\s+5000$/m.test(r.out) && /\bje\s+out$/m.test(r.out), 'memchr: the exit branch reaches llvm-mca (5 instructions per iteration)', r.out.slice(0, 900));
  check(/uiCA 2\.00 \(llvm-mca [+-]\d+%\)/.test(r.head) && !/not compared/.test(r.head), 'memchr: compared with uiCA', r.head);
  await p.close();

  // ---- error: the module cannot be loaded; the next opening tries again
  mode = 'fail';
  p = await Page.open(browser, { width: 1440, height: 900 });
  p.ignore.push(/wuica_mca\.wasm|500/);
  await p.goto(`${srv.origin}/?nosw=1`);
  await p.ready();
  r = await p.eval(`${PRE} await settle(); tab('mca'); await until(() => /could not be loaded/.test(body()), 60000); await wait(100);
    return { body: body(), provider: reg.getCopy('mca'), copy: await copy() };`);
  check(/llvm-mca could not be loaded: .*HTTP 500/.test(r.body), 'error: the view says the module could not be loaded', r.body);
  check(r.provider === null && r.copy.text === null && /nothing to copy here/.test(r.copy.status), 'error: nothing to copy', JSON.stringify(r.copy));
  mode = 'ok';
  r = await p.eval(`${PRE} tab('table'); await settle(); tab('mca'); await until(head, 120000); await settle(); return { head: head().textContent, copy: await copy() };`);
  check(/cycles\/iteration/.test(r.head) && r.copy.text?.startsWith('**llvm-mca** · '), 'error: the next opening tries again and works', JSON.stringify({ head: r.head, copy: r.copy.text?.slice(0, 60) }));
  check(p.take().length === 0, 'no console errors (error)');
  await p.close();
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
