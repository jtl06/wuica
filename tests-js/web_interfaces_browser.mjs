// Differential test of the page against Node (the other interfaces are compared with each other in
// tests-js/interfaces.mjs): the same random requests (tests-js/fuzz-cases.mjs) through
//   module  the analyzer module of web/dist in headless Chrome (web/js/engine.js, the browser's WebAssembly engine)
//   page    the page itself: hex in the box, the options and the CPU set with the controls, Analyze; the throughput,
//           bottlenecks, limits, uop table size and the uiCA report are read from the result
// against the same module run by web/js/engine.js in Node. Chrome is started with --headless and
// --remote-debugging-port (tests-js/cdp.mjs); skipped (exit 0) without Chrome.
//
//   node tests-js/web_interfaces_browser.mjs [MODULE_CASES] [PAGE_CASES] [--seed N]   (default 300 and 30, seed 1)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';
import { fuzzCases, essence, firstDiff } from './fuzz-cases.mjs';

const args = process.argv.slice(2);
const seedAt = args.indexOf('--seed');
const SEED = seedAt >= 0 ? Number(args[seedAt + 1]) : 1;
const nums = args.filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--seed').map(Number);
const [MODULE_CASES, PAGE_CASES] = [nums[0] ?? 300, nums[1] ?? 30];
const chrome = findChrome(args);
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('page interface');

const dir = copyDist();
const { WasmEngine, makeRequest } = await import(pathToFileURL(path.join(ROOT, 'web/js/engine.js')).href);
const engine = await WasmEngine.create(fs.readFileSync(path.join(dir, 'wuica_wasm.wasm')));
const uarchBytes = fs.readFileSync(path.join(dir, 'data/uarch.json'));
await engine.loadUarch(uarchBytes);
const uarch = JSON.parse(uarchBytes);
async function reference(c) {
  const table = uarch.configs[c.arch].name;
  if (!engine.hasArch(table)) await engine.loadArch(table, fs.readFileSync(path.join(dir, 'data/arch', `${table}.bin`)));
  return engine.analyze(makeRequest(c.hex, c.arch, c.options));
}

const srv = await serve(dir);
const { browser, close } = await launch(chrome);
let exitCode = 0;
try {
  const page = await Page.open(browser);
  await page.goto(`${srv.origin}/?nosw=1`);
  await page.ready();

  // ---- the module in the browser
  const mcases = fuzzCases({ seed: SEED, count: MODULE_CASES });
  // in chunks: one evaluation returns every response by value, and a very large one never arrives
  await page.eval(`
    const { WasmEngine, makeRequest } = await import('/js/engine.js');
    const bytes = async (p) => new Uint8Array(await (await fetch(p)).arrayBuffer());
    const e = await WasmEngine.create(await bytes('/wuica_wasm.wasm'));
    const uarchBytes = await bytes('/data/uarch.json');
    await e.loadUarch(uarchBytes);
    const configs = JSON.parse(new TextDecoder().decode(uarchBytes)).configs;
    window.__qaRun = async (cases) => {
      const out = [];
      for (const c of cases) {
        const t = configs[c.arch].name;
        if (!e.hasArch(t)) await e.loadArch(t, await bytes('/data/arch/' + t + '.bin'));
        out.push(await e.analyze(makeRequest(c.hex, c.arch, c.options)));
      }
      return out;
    };
    return 1;`);
  const got = [];
  for (let i = 0; i < mcases.length; i += 50) got.push(...await page.eval(`return window.__qaRun(${JSON.stringify(mcases.slice(i, i + 50))});`, { timeout: 300000 }));
  let ok = 0;
  for (const [i, c] of mcases.entries()) {
    const want = await reference(c);
    if (want.error === undefined) ok++;
    const d = firstDiff(essence(want), essence(got[i]));
    check(!d, `module: the browser differs from Node on case ${c.id} (${c.arch} ${JSON.stringify(c.options)} hex ${c.hex.slice(0, 60)})`, JSON.stringify(d));
  }
  console.log(`module: ${mcases.length} cases (seed ${SEED}), ${ok} with a result`);

  // ---- the page: the controls
  await page.eval(`${HELPERS} if ($('live').checked) $('live').click(); $('mode-hex').click(); return 1;`);
  const pcases = fuzzCases({ seed: SEED + 1000, count: PAGE_CASES });
  for (const c of pcases) {
    const want = await reference(c);
    const o = { alignmentOffset: 0, initPolicy: 'diff', simpleFrontEnd: false, noMicroFusion: false, noMacroFusion: false, minIterations: 10, minCycles: 500, ...c.options };
    const r = await page.eval(`${HELPERS}
      const o = ${JSON.stringify(o)};
      if (focused() !== ${JSON.stringify(c.arch)} || checkedCpus() !== ${JSON.stringify(c.arch)}) cpus(${JSON.stringify(c.arch)});
      set($('opt-align'), String(o.alignmentOffset)); set($('opt-iter'), String(o.minIterations)); set($('opt-cycles'), String(o.minCycles));
      const radio = document.querySelector('input[name=init][value=' + o.initPolicy + ']'); if (!radio.checked) radio.click();
      for (const [id, k] of [['opt-sfe', 'simpleFrontEnd'], ['opt-nmi', 'noMicroFusion'], ['opt-nma', 'noMacroFusion']]) if ($(id).checked !== o[k]) $(id).click();
      set($('code'), ${JSON.stringify(c.hex)});
      await done(() => $('run').click());
      const body = $('result-body');
      return { tp: tp() ?? null, error: errorBox(), focus: focused(), report: body.querySelector('pre.report')?.textContent ?? null,
        bn: body.querySelector('.bn')?.textContent ?? '', limits: [...body.querySelectorAll('.limits .lim')].map((l) => l.querySelector('.name').textContent + '=' + l.querySelector('.val').textContent),
        caveat: [...body.querySelectorAll('.caveat[role=alert]')].map((e) => e.textContent).join(' '), url: location.hash };`);
    const where = `page: case ${c.id} (${c.arch} ${JSON.stringify(c.options)} hex ${c.hex.slice(0, 60)})`;
    if (want.error !== undefined) {
      check(r.tp === null && /failed|crashed/i.test(r.error), `${where}: the failure is shown`, JSON.stringify([want.error, r]));
      continue;
    }
    check(r.focus === c.arch && r.tp === Number(want.tp).toFixed(2), `${where}: the throughput`, JSON.stringify([want.tp, r.tp, r.focus]));
    check(r.report === want.text, `${where}: the uiCA report`, JSON.stringify(firstDiff(want.text, r.report)));
    check(r.bn === want.bottlenecks.join(', ') || (want.bottlenecks.length === 0 && r.bn === ''), `${where}: the bottlenecks`, JSON.stringify([want.bottlenecks, r.bn]));
    check(JSON.stringify(r.limits) === JSON.stringify(want.limits.map((l) => `${l.name}=${Number(l.tp).toFixed(2)}`)), `${where}: the limits`, JSON.stringify([want.limits, r.limits]));
    check((want.decodeErrors > 0) === /undecodable position/.test(r.caveat), `${where}: the decode-error warning`, JSON.stringify([want.decodeErrors, r.caveat]));
  }
  console.log(`page: ${pcases.length} cases through the controls`);
  const problems = page.take();
  check(problems.length === 0, 'no console errors', problems.join('\n'));
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? e);
} finally {
  await close();
  await srv.stop();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile */ }
}
exitCode = check.summary() ? 1 : 0;
process.exit(exitCode);
