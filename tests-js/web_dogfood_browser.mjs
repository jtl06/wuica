// The bugs of the GUI dogfood of 0.1.10, in the built site with the real analyzer (headless Chrome, started with
// --headless and --remote-debugging-port through tests-js/cdp.mjs). Inputs: tests-js/fixtures/dogfood/ (clang -O2
// output of the report's kernels, and its test files). Each part is one bug of the report:
// - B3: no "[object HTMLSpanElement]" in A–B's headline (a list in a list of the caveat line), nor anywhere on the page
// No network: requests to godbolt.org are answered here. Skipped (exit 0) without Chrome.
//
//   node tests-js/web_dogfood_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';

const chrome = findChrome();
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('dogfood browser');
const fx = (name) => fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/dogfood', name), 'utf8');
const js = JSON.stringify;

// in the page: a paste into a box (the input event of a paste), a select's value, waiting for the result
const W = `${HELPERS}
  const pasteInto = (el, text) => { el.focus(); el.value = text; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })); };
  const pick = (id, v) => { const s = $(id); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); };
  const optionOf = (id, re) => [...$(id).options].find((o) => re.test(o.textContent))?.value;
  const settle = async () => { await wait(300); await until(() => !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale')); await wait(300); };
  const headline = () => document.querySelector('#result-body > .row.lead')?.innerText ?? '';
  const tabs = () => [...document.querySelectorAll('#result-body > .view-tabs > .view-tab')];
`;

// requests to godbolt.org: a short link that does not exist (404)
const intercept = (params, p) => {
  const status = params.request.method === 'OPTIONS' ? 204 : 404;
  p.cmd('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: status,
    responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }, { name: 'access-control-allow-origin', value: '*' },
      { name: 'access-control-allow-methods', value: 'POST, GET, OPTIONS' }, { name: 'access-control-allow-headers', value: 'Content-Type, Accept' }],
    body: Buffer.from(status === 404 ? '{}' : '').toString('base64') }).catch(() => {});
};

const srv = await serve(copyDist());
const { browser, close } = await launch(chrome);
const fresh = async (opts = {}) => {
  const page = await Page.open(browser, { width: 1440, height: 900, intercept, ...opts });
  page.ignore.push(/godbolt\.org/);
  await page.goto(`${srv.origin}/?nosw=1`);
  await page.ready();
  await page.waitFor(`document.getElementById('results').dataset.run`, 'the first result', 60000);
  return page;
};
try {
  // ---- B3: A–B's caveat line with a caveat of one side only -------------------------------------------------------------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      pasteInto($('code'), ${js(fx('scan_v2.s'))}); await settle();
      $('cmp-ab').click(); await settle();
      pasteInto($('code-b'), ${js(fx('saxpy.s'))}); await settle();
      pick('loop-chip-b', optionOf('loop-chip-b', /\\.LBB0_8\\b/)); await settle();
      set($('a-work'), '8'); set($('b-work'), '32'); pick('b-arch', 'ICL'); await settle();
      const head = headline();
      // every tab of the result, A's and B's views
      const seen = [document.body.innerText];
      for (const side of ['a', 'b']) {
        for (const t of tabs()) { t.click(); await wait(400); seen.push(document.body.innerText); }
        document.dispatchEvent(new CustomEvent('wuica:ab-side', { detail: 'b' })); await wait(300);
      }
      $('cmp-single').click(); await settle();
      for (const t of tabs()) { t.click(); await wait(400); seen.push(document.body.innerText); }
      return { head, single: !document.body.classList.contains('ab-on'), object: seen.filter((t) => /\\[object /.test(t)).map((t) => /.{0,80}\\[object .{0,40}/.exec(t)?.[0]) };`);
    check(/not modelled exit mispredict/.test(r.head), 'B3: the A–B headline has its caveat line', r.head);
    check(!/\[object /.test(r.head) && /exit mispredict\s*A\b/.test(r.head), 'B3: the caveat of one side is tagged with the side, no "[object …]"', r.head);
    check(r.single, 'B3: back in single mode', '');
    check(r.object.length === 0, 'B3: no "[object …]" anywhere on the page, in every tab of A–B and single mode', js(r.object));
    check(page.take().length === 0, 'B3: no errors', '');
    await page.close();
  }
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
