// A sweep over the page's features in headless Chrome (started with --headless and --remote-debugging-port through
// tests-js/cdp.mjs), with the real analyzer and assembler, each result compared with the same module run in Node:
// - every example in every input format (Intel, AT&T, hex) on several CPUs
// - the CPU table with a CPU that cannot decode part of the block; the alignment sweep against single analyses
// - A–B: the demo pair, swap, B's own CPU and scale
// - keyboard: Ctrl+Enter, a CPU box with the space bar, Escape in the options
// - back/forward between two links; copy link and open the copied link in a new tab
// - both themes and widths from 320 to 2560 pixels without horizontal scrolling
// - errors (bad hex, bad assembly, nothing to analyze, a huge block) never leave the page stuck
// Skipped (exit 0) without Chrome.
//
//   node tests-js/web_qa_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT, sleep } from './cdp.mjs';

const chrome = findChrome();
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('qa browser');

const dir = copyDist();
const { WasmEngine, makeRequest } = await import(pathToFileURL(path.join(ROOT, 'web/js/engine.js')).href);
const { EXAMPLES, CLASSIC_EXAMPLES } = await import(pathToFileURL(path.join(ROOT, 'web/js/examples.js')).href);
const engine = await WasmEngine.create(fs.readFileSync(path.join(dir, 'wuica_wasm.wasm')));
const uarchBytes = fs.readFileSync(path.join(dir, 'data/uarch.json'));
await engine.loadUarch(uarchBytes);
const configs = JSON.parse(uarchBytes).configs;
async function ref(hex, arch, options = {}) {
  const table = configs[arch].name;
  if (!engine.hasArch(table)) await engine.loadArch(table, fs.readFileSync(path.join(dir, 'data/arch', `${table}.bin`)));
  return engine.analyze(makeRequest(hex, arch, options));
}
const tp2 = (r) => Number(r.tp).toFixed(2);

const srv = await serve(dir);
const origin = srv.origin;
const { browser, close } = await launch(chrome);
try {
  const page = await Page.open(browser);
  await page.goto(`${origin}/?nosw=1`);
  await page.ready();
  await page.eval(`${HELPERS} if ($('live').checked) $('live').click(); return 1;`); // one explicit run at a time

  // ---- every example, every format, several CPUs ----------------------------------------------------------------------
  {
    const all = [...EXAMPLES, ...CLASSIC_EXAMPLES];
    let n = 0;
    for (const arch of ['SKL', 'ZEN3', 'ADL-P', 'SNB']) {
      for (const ex of all) {
        const want = await ref(ex.hex, arch);
        for (const fmt of arch === 'SKL' ? ['intel', 'att', 'hex'] : [['intel', 'att', 'hex'][n % 3]]) {
          n++;
          const r = await page.eval(`${HELPERS}
            if (focused() !== ${JSON.stringify(arch)} || checkedCpus() !== ${JSON.stringify(arch)}) cpus(${JSON.stringify(arch)});
            $(${JSON.stringify(fmt === 'hex' ? 'mode-hex' : 'mode-asm')}).click();
            if (${JSON.stringify(fmt)} !== 'hex' && $('syntax').value !== ${JSON.stringify(fmt)}) { $('syntax').value = ${JSON.stringify(fmt)}; $('syntax').dispatchEvent(new Event('change')); }
            await done(() => set($('examples'), ${JSON.stringify(ex.id)}));
            return { tp: tp(), err: errorBox(), msgs: msgs(), focus: focused(), code: $('code').value, caveat: document.querySelector('#result-body .caveat[role=alert]')?.textContent ?? '' };`);
          const code = fmt === 'hex' ? ex.text.hex : ex.text[fmt];
          check(r.tp === tp2(want) && r.focus === arch && !r.err && r.msgs.length === 0 && r.code === code && (want.decodeErrors > 0) === /undecodable/.test(r.caveat),
            `example ${ex.id} (${fmt}) on ${arch}: the result of the module in Node`, JSON.stringify([tp2(want), want.decodeErrors, r]));
        }
      }
    }
    // the syntax switch translates an untouched example
    const s = await page.eval(`${HELPERS} $('mode-asm').click(); $('syntax').value = 'intel'; $('syntax').dispatchEvent(new Event('change'));
      await done(() => set($('examples'), 'chain')); const a = $('code').value;
      $('syntax').value = 'att'; $('syntax').dispatchEvent(new Event('change')); const b = $('code').value;
      $('syntax').value = 'intel'; $('syntax').dispatchEvent(new Event('change')); return [a, b, $('code').value];`);
    check(s[0] === EXAMPLES[0].text.intel && s[1] === EXAMPLES[0].text.att && s[2] === s[0], 'syntax: an untouched example follows the syntax', JSON.stringify(s));
    console.log(`examples: ${n} runs`);
  }

  // ---- the CPU table: a CPU that cannot decode part of the block ---------------------------------------------------------
  {
    const saxpy = CLASSIC_EXAMPLES.find((e) => e.id === 'saxpy') ?? CLASSIC_EXAMPLES.find((e) => /avx|fma|ymm/i.test(e.text.intel));
    const [snb, skl] = [await ref(saxpy.hex, 'SNB'), await ref(saxpy.hex, 'SKL')];
    const r = await page.eval(`${HELPERS}
      cpus('SKL'); $('mode-hex').click(); await done(() => set($('examples'), ${JSON.stringify(saxpy.id)}));
      cpus('SNB', 'SKL');
      await until(() => !$('cmp-cpus').hidden && $('cmp-cpus').dataset.state === 'done');
      const row = (k) => document.querySelector('table.cmp-cpus tr[data-arch="' + k + '"]');
      return { snb: [row('SNB').querySelector('.cmp-tp').textContent, row('SNB').querySelector('.cmp-bn').textContent, row('SNB').classList.contains('fastest')],
        skl: [row('SKL').querySelector('.cmp-tp').textContent, row('SKL').querySelector('.cmp-bn').textContent, row('SKL').classList.contains('fastest')] };`);
    check(snb.decodeErrors > 0 && r.snb[0] === tp2(snb) && new RegExp(`${snb.decodeErrors} undecodable skipped`).test(r.snb[1]) && !r.snb[2]
      && r.skl[0] === tp2(skl) && !/undecodable/.test(r.skl[1]) && r.skl[2], 'table: SNB, which skips the AVX instructions, is marked and not the fastest', JSON.stringify([snb.decodeErrors, r]));
  }

  // ---- the alignment sweep against single analyses ---------------------------------------------------------------------------
  {
    const ex = CLASSIC_EXAMPLES[0];
    const r = await page.eval(`${HELPERS}
      cpus('SKL'); await done(() => set($('examples'), ${JSON.stringify(ex.id)}));
      const d = $('cmp-sweep'); if (!d.open) d.querySelector('summary').click();
      await until(() => d.dataset.state === 'done', 120000);
      const pts = [...document.querySelectorAll('.sweep-chart rect.hit')].map((e) => [Number(e.dataset.offset), e.querySelector('title')?.textContent ?? '']);
      const info = document.querySelector('#cmp-sweep-body .sweep-head')?.textContent ?? '';
      d.querySelector('summary').click();
      return { info, pts: pts.slice(0, 64) };`);
    const want = [];
    for (let k = 0; k < 64; k++) want.push(tp2(await ref(ex.hex, 'SKL', { alignmentOffset: k })));
    const min = Math.min(...want.map(Number)).toFixed(2), max = Math.max(...want.map(Number)).toFixed(2);
    check(r.info.includes(min) && r.info.includes(max), `sweep: the range of the 64 offsets is the one of single analyses (${min}–${max})`, JSON.stringify(r.info));
    check(r.pts.length === 64 && r.pts.every(([k, t]) => t === `offset ${k}: ${want[k]} cycles/iteration`), 'sweep: each point is the single analysis at its offset', JSON.stringify([r.pts.slice(0, 3), want.slice(0, 3)]));
  }

  // ---- A–B ---------------------------------------------------------------------------------------------------------------------
  {
    const [d1, d4] = ['dot1', 'dot4'].map((id) => CLASSIC_EXAMPLES.find((e) => e.id === id));
    const r = await page.eval(`${HELPERS}
      cpus('SKL'); $('mode-asm').click(); await done(() => set($('examples'), 'chain'));
      await done(() => $('cmp-ab').click());
      const text = () => $('result-body').textContent;
      const out = { demo: [$('code').value.trim().split('\\n').length, $('code-b')?.value.trim().split('\\n').length, text().slice(0, 300)] };
      await done(() => $('ab-swap').click());
      out.swapped = [$('code').value === ${JSON.stringify(d4.text.intel)}, $('code-b')?.value === ${JSON.stringify(d1.text.intel)}];
      await done(() => set($('b-arch'), 'ZEN3'));
      out.bArch = [$('b-arch').value, [...document.querySelectorAll('#result-body .ab-side')].map((e) => e.textContent).join(' | ')];
      set($('b-work'), '4'); // (no new analysis: the result is weighed again)
      out.scale = [document.querySelector('.ab-tp .unit')?.textContent, document.querySelectorAll('.ab-tp .value')[1]?.title];
      await done(() => $('cmp-single').click());
      out.single = [!!$('cmp-cpus'), focused()];
      return out;`);
    check(r.demo[0] > 2 && r.demo[1] > 2 && /\d+\.\d\d/.test(r.demo[2]), 'A–B: the demo pair is analyzed', JSON.stringify(r.demo));
    check(r.swapped[0] && r.swapped[1], 'A–B: swap exchanges the two sides', JSON.stringify(r.swapped));
    check(r.bArch[0] === 'ZEN3' && /B ZEN3/.test(r.bArch[1]) && /A SKL/.test(r.bArch[1]), 'A–B: side B on its own CPU', JSON.stringify(r.bArch));
    check(r.scale[0] === 'cycles/element' && / ÷ 4$/.test(r.scale[1]), 'A–B: B does 4 elements per iteration: per element', JSON.stringify(r.scale));
  }

  // ---- keyboard ------------------------------------------------------------------------------------------------------------------
  {
    await page.eval(`${HELPERS} cpus('SKL'); $('mode-hex').click(); set($('code'), '48 01 d8 48 01 c3'); $('code').focus(); window.__n = runId(); return 1;`);
    await page.key('Enter', { code: 'Enter', keyCode: 13, modifiers: process.platform === 'darwin' ? 4 : 2 });
    await page.waitFor(`document.getElementById('results').dataset.run !== window.__n`, 'Ctrl+Enter to run');
    const k1 = await page.eval(`${HELPERS} return tp();`);
    // Tab to the ZEN3 box, space: checked and focused
    await page.eval(`${HELPERS} window.__n = runId(); document.querySelector('#cpu-grid input[value=ZEN3]').focus(); return 1;`);
    await page.key(' ', { code: 'Space', keyCode: 32 });
    await page.waitFor(`document.getElementById('results').dataset.run !== window.__n`, 'a run after the space bar on a CPU box');
    const k2 = await page.eval(`${HELPERS} return [focused(), checkedCpus(), document.activeElement?.value];`);
    // Escape closes the options popover
    await page.eval(`${HELPERS} document.querySelector('#advanced summary').click(); $('opt-align').focus(); return 1;`);
    await page.key('Escape', { code: 'Escape', keyCode: 27 });
    const k3 = await page.eval(`${HELPERS} return [$('advanced').open, document.activeElement?.tagName];`);
    check(k1 === tp2(await ref('4801d84801c3', 'SKL')), 'keyboard: Ctrl/⌘+Enter analyzes', k1);
    check(k2[0] === 'ZEN3' && k2[1] === 'SKL,ZEN3' && k2[2] === 'ZEN3', 'keyboard: the space bar checks a CPU box, which becomes the focused CPU; the keyboard focus stays', JSON.stringify(k2));
    check(k3[0] === false && k3[1] === 'SUMMARY', 'keyboard: Escape closes the options and returns to their summary', JSON.stringify(k3));
    await page.eval(`${HELPERS} cpus('SKL'); return 1;`);
  }

  // ---- back/forward between links; copy link into a new tab ------------------------------------------------------------------
  {
    const enc = (t) => Buffer.from(t).toString('base64url');
    const l1 = `#v=1&m=hex&a=ICL&c=${enc('48 01 d8')}`;
    const l2 = `#v=1&m=asm&a=ZEN3&al=7&c=${enc('add rax, rbx\nadd rbx, rax\n')}`;
    await page.goto(`${origin}/?nosw=1${l1}`);
    await page.waitFor(`document.querySelector('#result-body .tp .value')`, 'the first link');
    await page.eval(`${HELPERS} window.__n = runId(); location.hash = ${JSON.stringify(l2)}; return 1;`);
    await page.waitFor(`document.getElementById('results').dataset.run !== window.__n`, 'the second link');
    const b2 = await page.eval(`${HELPERS} return [focused(), $('mode-asm').checked, $('opt-align').value, tp()];`);
    await page.eval(`${HELPERS} window.__n = runId(); history.back(); return 1;`);
    await page.waitFor(`document.getElementById('results').dataset.run !== window.__n`, 'back');
    const b1 = await page.eval(`${HELPERS} return [focused(), $('mode-hex').checked, $('opt-align').value, tp(), $('code').value];`);
    await page.eval(`${HELPERS} window.__n = runId(); history.forward(); return 1;`);
    await page.waitFor(`document.getElementById('results').dataset.run !== window.__n`, 'forward');
    const f2 = await page.eval(`${HELPERS} return [focused(), $('mode-asm').checked, $('opt-align').value, tp()];`);
    const [w1, w2] = [await ref('4801d8', 'ICL'), await ref('4801d84801c3', 'ZEN3', { alignmentOffset: 7 })];
    check(JSON.stringify(b2) === JSON.stringify(['ZEN3', true, '7', tp2(w2)]) && JSON.stringify(b1) === JSON.stringify(['ICL', true, '0', tp2(w1), '48 01 d8'])
      && JSON.stringify(f2) === JSON.stringify(b2), 'back/forward: each link restores its input, CPU, options and result', JSON.stringify([b2, b1, f2]));

    // copy link: the copied URL opens the same state in a new tab
    const st = await page.eval(`${HELPERS}
      cpus('SKL', 'ZEN3', 'ICL'); await until(() => $('cmp-cpus').dataset.state === 'done');
      set($('opt-iter'), '17'); document.querySelector('input[name=init][value=same]').click(); if (!$('opt-nma').checked) $('opt-nma').click();
      await done(() => $('run').click());
      // (the clipboard is stubbed: the real one is the machine's, shared with everything else)
      let url = null; navigator.clipboard.writeText = async (t) => { url = t; };
      $('copy-link').click(); await until(() => url !== null, 5000);
      return { url, state: [focused(), checkedCpus(), $('code').value, $('opt-iter').value, document.querySelector('input[name=init]:checked').value, $('opt-nma').checked, tp()] };`);
    const p2 = await Page.open(browser);
    await p2.goto(st.url);
    await p2.waitFor(`document.querySelector('#result-body .tp .value') && document.getElementById('cmp-cpus').dataset.state === 'done'`, 'the copied link');
    const st2 = await p2.eval(`${HELPERS} return [focused(), checkedCpus(), $('code').value, $('opt-iter').value, document.querySelector('input[name=init]:checked').value, $('opt-nma').checked, tp()];`);
    check(st.url.startsWith(origin) && JSON.stringify(st2) === JSON.stringify(st.state), 'copy link: the copied link opens the same state and result in a new tab', JSON.stringify([st.url, st.state, st2]));
    check(p2.take().length === 0, 'copy link: no console errors in the new tab');
    await p2.close();
  }

  // ---- themes and widths ---------------------------------------------------------------------------------------------------------
  {
    await page.goto(`${origin}/?nosw=1`);
    await page.ready();
    await page.eval(`${HELPERS}
      cpus('SKL', 'ZEN3', 'ADL-P', 'ICL'); $('mode-hex').click(); await done(() => set($('examples'), 'gemm'));
      await until(() => $('cmp-cpus').dataset.state === 'done');
      for (const d of document.querySelectorAll('#result-body details')) d.open = true;
      return 1;`);
    const themes = [];
    for (const theme of ['light', 'dark']) {
      themes.push(await page.eval(`${HELPERS}
        if ($('theme-toggle').textContent !== ${JSON.stringify(theme)}) $('theme-toggle').click(); // the shown theme (the system's, until one is chosen)
        await wait(50);
        return [document.documentElement.getAttribute('data-theme'), getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).color, $('theme-toggle').textContent, localStorage.getItem('wuica-theme')];`));
    }
    // the first step may show the system's light theme without a choice (no data-theme, nothing stored); the second is a choice
    check(themes[0][3] === 'light' && themes[1][0] === 'dark' && themes[1][3] === 'dark' && themes[1][4] === 'dark' && themes[0][1] !== themes[1][1] && themes[0][2] !== themes[1][2],
      'theme: the toggle switches the colors and remembers the choice', JSON.stringify(themes));
    await page.reload();
    await page.ready();
    const kept = await page.eval(`return document.documentElement.getAttribute('data-theme');`);
    check(kept === 'dark', 'theme: the choice survives a reload', kept);
    await page.eval(`${HELPERS}
      cpus('SKL', 'ZEN3', 'ADL-P', 'ICL'); $('mode-hex').click(); await done(() => set($('examples'), 'gemm'));
      await until(() => $('cmp-cpus').dataset.state === 'done');
      for (const d of document.querySelectorAll('#result-body details')) d.open = true;
      return 1;`);
    const wide = [];
    for (const theme of ['dark', 'light']) {
      await page.eval(`${HELPERS} if (document.documentElement.getAttribute('data-theme') !== ${JSON.stringify(theme)}) $('theme-toggle').click(); return 1;`);
      for (const w of [320, 360, 375, 414, 600, 768, 1024, 1280, 1440, 1920, 2560]) {
        await page.size(w, 900, w < 768);
        const o = await page.eval(`${HELPERS} await wait(80);
          const off = [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > innerWidth + 1 && !e.closest('.table-wrap, pre, .trace-panel, .sweep-chart, [data-scroll]'); }).slice(0, 3).map((e) => e.tagName + '.' + e.className + '#' + e.id);
          return [overflow(), off];`);
        wide.push([theme, w, ...o]);
      }
    }
    await page.size(1280, 900);
    const bad = wide.filter((x) => x[2] > 0);
    check(bad.length === 0, 'widths 320–2560, both themes: no horizontal scrolling (result, CPU table and text views open)', JSON.stringify(bad));
  }

  // ---- errors never leave the page stuck ----------------------------------------------------------------------------------------
  {
    const cases = [
      ['hex', 'zz top', /Not hex/], ['hex', '48 8', /Odd number/], ['hex', '', /No bytes/], ['asm', 'frobnicate rax', /invalid instruction mnemonic/],
      ['asm', '', /No code/], ['asm', '# only a comment', /No machine code/], ['asm', 'movq %rax, [rbx]', /unknown token|invalid operand|unexpected token/],
      ['hex', 'ff ff ff ff', /no instructions found/], ['asm', '.rept 100000\nnop\n.endr', null], ['asm', '.rept 2000000\nnop\n.endr', /Too much machine code: 2,000,000 bytes/],
      ['asm', '.zero 1000000000', /assembler failed/],
    ];
    const out = [];
    for (const [mode, text, re] of cases) {
      const t0 = Date.now();
      const r = await page.eval(`${HELPERS}
        $(${JSON.stringify(mode === 'hex' ? 'mode-hex' : 'mode-asm')}).click(); set($('code'), ${JSON.stringify(text)});
        const n = runId(); $('run').click();
        await until(() => (runId() !== n || msgs().length) && !$('results').hasAttribute('aria-busy'), 60000);
        return { shown: (msgs().join(' ') + ' ' + errorBox()).trim(), tp: tp(), button: $('run').textContent, disabled: $('run').disabled };`);
      out.push([text.slice(0, 20), Date.now() - t0, r]);
      check((re ? re.test(r.shown) : r.tp !== undefined) && r.button === 'Analyze' && !r.disabled, `errors: ${JSON.stringify(text.slice(0, 30))} (${mode}) gives a clear message and the page stays usable`, JSON.stringify(r));
    }
    const after = await page.eval(`${HELPERS} $('mode-hex').click(); set($('code'), '48 01 d8'); await done(() => $('run').click()); return tp();`);
    check(after === tp2(await ref('4801d8', 'SKL')), 'errors: an analysis after them works', after);
  }

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
