// A fresh visit (no state in the link) analyzes the default example once the analyzer is ready, without a click; a link
// with state keeps its own behaviour; with live mode off the fresh visit is analyzed too, once. Headless Chrome (started
// with --headless and --remote-debugging-port through tests-js/cdp.mjs), the real analyzer and assembler; the expected
// value comes from the same module under Node. Skipped (exit 0) without Chrome.
//
//   node tests-js/web_autorun_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';

const chrome = findChrome();
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('autorun browser');

const dir = copyDist();
const { WasmEngine, makeRequest } = await import(pathToFileURL(path.join(ROOT, 'web/js/engine.js')).href);
const { EXAMPLES } = await import(pathToFileURL(path.join(ROOT, 'web/js/examples.js')).href);
const { encodeState } = await import(pathToFileURL(path.join(ROOT, 'web/js/url-state.js')).href);
const engine = await WasmEngine.create(fs.readFileSync(path.join(dir, 'wuica_wasm.wasm')));
await engine.loadUarch(fs.readFileSync(path.join(dir, 'data/uarch.json')));
await engine.loadArch('SKL', fs.readFileSync(path.join(dir, 'data/arch/SKL.json')));
const want = Number((await engine.analyze(makeRequest(EXAMPLES[0].hex, 'SKL'))).tp).toFixed(2);

const srv = await serve(dir);
const { browser, close } = await launch(chrome);
try {
  const page = await Page.open(browser, { width: 1280, height: 900 });
  // the long tasks of the start, from the first byte of the page
  await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.__longs = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longs.push(e.duration); }).observe({ type: 'longtask', buffered: true });` });

  // 1. a fresh visit: the result comes without a click, once
  await page.goto(srv.origin + '/');
  await page.waitFor(`document.querySelector('#result-body .tp .value')`, 'the first result', 60000);
  const a = await page.eval(`${HELPERS} await wait(300); return { tp: tp(), run: runId(), code: $('code').value, busy: $('results').getAttribute('aria-busy'), longs: window.__longs, hash: location.hash };`);
  check(a.hash === '', 'fresh visit: the address keeps no fragment while nothing was changed', a.hash);
  check(a.tp === want, 'fresh visit: the default example is analyzed without a click', `${a.tp} vs ${want}`);
  check(a.code === EXAMPLES[0].text.intel, 'fresh visit: the input is the default example');
  check(a.run === '1' && a.busy === null, 'fresh visit: one run, not busy', JSON.stringify(a));
  check(a.longs.every((d) => d < 100), 'fresh visit: no long task of 100 ms or more', JSON.stringify(a.longs));
  // the editor answers at once: typing replaces the result by a live run of the new code
  const b = await page.eval(`${HELPERS} const n = runId(); set($('code'), 'l:\\nadd rax, 1\\nadd rax, 1\\ndec r15\\njnz l\\n'); await until(() => runId() !== n); return tp();`);
  check(Number(b) >= 2, 'fresh visit: an edit after it is analyzed live', b);

  // 2. live mode off: the fresh visit is still analyzed once
  await page.eval(`localStorage.setItem('wuica-live', 'off'); return 1;`);
  await page.goto(srv.origin + '/?nosw=1');
  await page.waitFor(`document.querySelector('#result-body .tp .value')`, 'the first result with live off', 60000);
  const c = await page.eval(`${HELPERS} return { tp: tp(), run: runId(), live: $('live').checked };`);
  check(c.tp === want && c.run === '1' && c.live === false, 'live off: the fresh visit is analyzed once', JSON.stringify(c));
  await page.eval(`localStorage.removeItem('wuica-live'); return 1;`);

  // 3. a link with state: analyzed as before (its own code, not the default example)
  const frag = encodeState({ mode: 'hex', text: '48 01 d8 48 01 d8', arch: 'SKL' });
  await page.goto(`${srv.origin}/?nosw=1&l=1#${frag}`);
  await page.waitFor(`document.querySelector('#result-body .tp .value')`, 'the result of the link', 60000);
  const d = await page.eval(`${HELPERS} await wait(200); return { tp: tp(), run: runId(), code: $('code').value };`);
  const linkTp = Number((await engine.analyze(makeRequest('4801d84801d8', 'SKL'))).tp).toFixed(2);
  check(d.tp === linkTp && d.run === '1' && d.code.includes('48 01 d8'), 'link with state: its own code, one run', JSON.stringify(d));

  const problems = page.take();
  check(problems.length === 0, 'no console errors', problems.join('\n'));
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? e);
} finally {
  await close();
  await srv.stop();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile */ }
}
process.exit(check.summary() ? 1 : 0);
