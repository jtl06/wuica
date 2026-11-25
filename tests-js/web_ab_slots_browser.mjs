// The issue slots per CPU in the CPU table while the bound view is open (web/js/cmp-slots.js), and of both sides in A–B mode (web/js/ab-slots.js): the shares per part against the details of the same
// analyses under Node; the fold is closed by default (no extra analysis), opens with both bars, stays open for the next
// result; no sideways scroll at 320 px. Headless Chrome (started with --headless and --remote-debugging-port through
// tests-js/cdp.mjs), the real analyzer. Skipped (exit 0) without Chrome.
//
//   node tests-js/web_ab_slots_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { enginePath, tablePath } from './dist-files.mjs';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';

const chrome = findChrome();
const check = checker('ab slots browser');
const { abSlotsDelta } = await import(pathToFileURL(path.join(ROOT, 'web/js/ab-slots.js')).href);
const { slotsTitle } = await import(pathToFileURL(path.join(ROOT, 'web/js/cmp-slots.js')).href);

// under Node: the delta of the parts
{
  const A = { width: 4, cycles: 10, iterations: 10, slots: { issued: 2, frontEnd: 2, rob: 0, rs: 0, other: 0 } };
  const B = { width: 4, cycles: 10, iterations: 10, slots: { issued: 3, frontEnd: 0, rob: 1, rs: 0, other: 0 } };
  const d = abSlotsDelta(A, B);
  check(d && d.map((x) => `${x.key}:${x.a}>${x.b}`).join() === 'issued:0.5>0.75,frontEnd:0.5>0,rob:0>0.25,rs:0>0,other:0>0' && d[0].delta === 0.25, 'delta of the slot shares', JSON.stringify(d));
  check(abSlotsDelta(A, null) === null && abSlotsDelta(null, { width: 0 }) === null, 'no delta without both');
}

if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(check.summary() ? 1 : 0); }

const dir = copyDist();
const { WasmEngine, makeRequest } = await import(pathToFileURL(path.join(ROOT, 'web/js/engine.js')).href);
const { CLASSIC_EXAMPLES } = await import(pathToFileURL(path.join(ROOT, 'web/js/examples.js')).href);
const { slotParts } = await import(pathToFileURL(path.join(ROOT, 'web/js/slots.js')).href);
const { encodeState } = await import(pathToFileURL(path.join(ROOT, 'web/js/url-state.js')).href);
const engine = await WasmEngine.create(fs.readFileSync(enginePath(dir, 'wuica_wasm.wasm')));
await engine.loadUarch(fs.readFileSync(enginePath(dir, 'data/uarch.json')));
await engine.loadArch('SKL', zlib.gunzipSync(fs.readFileSync(tablePath(dir, 'SKL'))));
await engine.loadArch('ZEN3', zlib.gunzipSync(fs.readFileSync(tablePath(dir, 'ZEN3'))));
const [d1, d4] = ['dot1', 'dot4'].map((id) => CLASSIC_EXAMPLES.find((e) => e.id === id));
const pctOf = async (ex) => slotParts((await engine.analyze({ ...makeRequest(ex.hex, 'SKL'), details: true })).details.issue).filter((p) => p.share >= 0.005).map((p) => `${p.name} ${Math.round(p.share * 100)}%`).join(',');
const want = [await pctOf(d1), await pctOf(d4)];

const srv = await serve(dir);
const { browser, close } = await launch(chrome);
try {
  const page = await Page.open(browser, { width: 1280, height: 900 });
  const frag = encodeState({ mode: 'hex', text: d1.text.hex, ab: true, bMode: 'hex', bText: d4.text.hex, arch: 'SKL' });
  await page.goto(`${srv.origin}/?nosw=1#${frag}`);
  await page.waitFor(`document.querySelector('#ab-slots')`, 'the A–B result', 60000);
  const r = await page.eval(`${HELPERS}
    const out = { closed: !$('ab-slots').open, after: $('ab-slots-row').previousElementSibling?.querySelector('.label')?.textContent, inDiff: !!$('ab-slots-row').closest('#ab-main'), empty: $('ab-slots').querySelector('.ab-slots').children.length };
    $('ab-slots').querySelector('summary').click();
    await until(() => $('ab-slots').querySelector('.ab-slots').dataset.state === 'done');
    const keys = (k) => [...$('ab-slots').querySelectorAll('.bd-slots')[k].querySelectorAll('.sl-k')].map((x) => x.textContent).join(',');
    out.tags = [...$('ab-slots').querySelectorAll('.bd-g')].map((x) => x.textContent).join();
    out.a = keys(0); out.b = keys(1); out.summary = $('ab-slots').querySelector('summary').textContent;
    // the next result: the fold stays open and is filled again
    const n = runId(); $('opt-align').value = '5'; $('opt-align').dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => runId() !== n);
    await until(() => $('ab-slots')?.querySelector('.ab-slots').dataset.state === 'done');
    out.again = [$('ab-slots').open, $('ab-slots').querySelectorAll('.bd-slots').length];
    return out;`);
  check(r.closed && r.empty === 0 && r.after === 'limits' && r.inDiff, 'closed by default, nothing fetched; in the diff tab, after the limits', JSON.stringify(r));
  check(r.tags === 'A,B' && r.a === want[0] && r.b === want[1], 'both bars: the shares of the details under Node', JSON.stringify([r, want]));
  check(/^issued \d+% → \d+%$/.test(r.summary), 'the summary: issued A → B', r.summary);
  check(r.again[0] && r.again[1] === 2, 'the next result: still open, both bars', JSON.stringify(r.again));
  // the A–B traces: both have the issue strip (the traces' analyses ask for the details: trace.js loadTrace)
  {
    await page.goto(`${srv.origin}/?nosw=1&t=1#${frag}&trace=1`);
    await page.waitFor(`document.querySelector('details.trace-ab')?.wuicaTraces`, 'the A–B traces', 60000);
    const t = await page.eval(`const w = document.querySelector('details.trace-ab').wuicaTraces; return [!!w.a.model.issue, !!w.b.model.issue, w.a.model.issue?.width];`);
    check(t[0] && t[1] && t[2] === 4, 'A–B traces: both sides have the issue strip', JSON.stringify(t));
  }
  // the CPU table: a slots column only while the bound view is open
  {
    const titles = {};
    for (const arch of ['SKL', 'ZEN3']) titles[arch] = slotsTitle((await engine.analyze({ ...makeRequest(d1.hex, arch), details: true })).details.issue);
    await page.size(1280, 900);
    await page.goto(`${srv.origin}/?nosw=1&c=1#${encodeState({ mode: 'hex', text: d1.text.hex, arch: 'SKL', cpus: 'SKL,ZEN3', bound: true })}`);
    await page.waitFor(`document.querySelectorAll('#cmp-cpus-body .cs-bar').length === 2`, 'the slots column', 60000);
    const c = await page.eval(`${HELPERS}
      const out = { head: [...document.querySelectorAll('#cmp-cpus-body thead th')].map((t) => t.textContent).pop(),
        bars: Object.fromEntries([...document.querySelectorAll('#cmp-cpus-body tbody tr')].map((tr) => [tr.dataset.arch, tr.querySelector('.cs-bar')?.title])) };
      document.querySelector('#bound summary').click();
      await until(() => !document.querySelector('#cmp-cpus-body .cs-col'));
      out.closed = document.querySelectorAll('#cmp-cpus-body .cs-col').length;
      document.querySelector('#bound summary').click();
      await until(() => document.querySelectorAll('#cmp-cpus-body .cs-bar').length === 2);
      out.reopened = document.querySelectorAll('#cmp-cpus-body .cs-bar').length;
      return out;`);
    check(c.head === 'slots' && c.bars.SKL === titles.SKL && c.bars.ZEN3 === titles.ZEN3 && /issued \d+%/.test(titles.SKL), 'CPU table: the slots per CPU, as the details under Node', JSON.stringify([c, titles]));
    check(c.closed === 0 && c.reopened === 2, 'CPU table: the column goes with the bound view and comes back', JSON.stringify(c));
  }
  await page.size(320, 700);
  const o = await page.eval(`${HELPERS} await wait(100); return overflow();`);
  check(o <= 0, 'no sideways scroll at 320 px', String(o));
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
