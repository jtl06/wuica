// Robustness of the page with large inputs, in headless Chrome (started with --headless and --remote-debugging-port
// through tests-js/cdp.mjs) with the real analyzer and assembler:
// - the assembler runs in a worker: a .rept that takes seconds to assemble does not freeze the page; a new edit in live
//   mode stops it and analyzes the new input at once; Cancel stops it; asm -> hex conversion still works
// - analyzer memory: after a block that grows the WebAssembly memory beyond 512 MB, the analyzer's worker and the pool's
//   workers are replaced (the memory never shrinks otherwise); the next runs work, on the same and on other CPUs
// - hex input: more than 1 MiB of machine code is refused with one line, as assembly is (side A and side B of A–B)
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

// The size of every WebAssembly memory in the page's dedicated workers that run engine-worker.js, in MB.
async function engineMemory(page) {
  const sessions = [];
  const h = (m) => { if (m.method === 'Target.attachedToTarget' && m.sessionId === page.sessionId) sessions.push(m.params); };
  page.browser.on(h);
  await page.cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await new Promise((r) => setTimeout(r, 300));
  const out = [];
  for (const s of sessions) {
    if (s.targetInfo.type !== 'worker' || !/engine-worker\.js/.test(s.targetInfo.url)) continue;
    const send = (method, params) => page.browser.send(method, params, s.sessionId);
    const proto = await send('Runtime.evaluate', { expression: 'WebAssembly.Memory.prototype' });
    const objs = await send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
    const r = await send('Runtime.callFunctionOn', { objectId: objs.objects.objectId, functionDeclaration: 'function () { return this.map((m) => m.buffer.byteLength); }', returnByValue: true });
    out.push(Math.round(Math.max(0, ...r.result.value) / 2 ** 20));
    await page.browser.send('Target.detachFromTarget', { sessionId: s.sessionId }).catch(() => {});
  }
  await page.cmd('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  return out;
}

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
  // ---- 2. analyzer memory: 5,000 `div rcx` grow the analyzer to about 800 MB (and the pool's worker for the CPU table)
  {
    await page.goto(link({ mode: 'hex', text: CHAIN.text.hex, cpus: 'HSW,SKL' }));
    await page.ready();
    await page.waitFor(`document.querySelector('#result-body .tp .value')`, 'the first result', 60000);
    const big = '48f7f1'.repeat(5000);
    const r2 = await page.eval(`${HELPERS}
      await done(() => { set($('code'), '${big}'); $('run').click(); }, 120000);
      const out = { tp: tp() };
      // the CPU table's other row (HSW) comes from the pool
      await until(() => [...document.querySelectorAll('#cmp-cpus-body tr')].some((r) => /HSW/.test(r.textContent) && /\\d\\.\\d\\d/.test(r.textContent)), 120000);
      await wait(1500);
      out.poolRecycles = window.__wuicaPool?.counts.memoryRecycles;
      return out;`, { timeout: 300000 });
    // the replacement waits until nothing else uses the worker: poll (a busy machine can take a while)
    let after = await engineMemory(page);
    for (let t0 = Date.now(); !(after.length >= 1 && after.every((mb) => mb < 512)) && Date.now() - t0 < 30000;) {
      await new Promise((r) => setTimeout(r, 1000));
      after = await engineMemory(page);
    }
    check(r2.tp === '16000.00' || Number(r2.tp) > 1000, 'a huge block: a result', JSON.stringify(r2));
    // (a replaced pool worker starts again with its next job: it may not be running now)
    check(after.length >= 1 && after.every((mb) => mb < 512), `after a huge block every analyzer worker is below 512 MB (MB: ${after.join(', ')})`);
    check(r2.poolRecycles >= 1, 'the pool replaced its grown worker', JSON.stringify(r2));
    const r3 = await page.eval(`${HELPERS}
      await done(() => { set($('code'), ${JSON.stringify(CHAIN.text.hex)}); $('run').click(); });
      const out = { skl: tp() };
      await done(() => cpus('HSW', 'SKL', 'ZEN3'));
      const rows = () => [...document.querySelectorAll('#cmp-cpus-body tr')].filter((r) => /\\d\\.\\d\\d/.test(r.textContent)).length;
      await until(() => rows() >= 3, 60000).catch(() => {});
      return { ...out, rows: rows() };`);
    check(r3.skl === '2.00', 'the next run after the analyzer was replaced works', JSON.stringify(r3));
    check(r3.rows >= 3, 'the CPU table works afterwards (pool workers replaced)', JSON.stringify(r3));
  }
  // ---- 3. the size limit of hex input (1 MiB, as for assembly), in single mode and on both sides of A–B
  {
    await page.goto(link({ mode: 'hex', text: CHAIN.text.hex }));
    await page.ready();
    await page.waitFor(`document.querySelector('#result-body .tp .value')`, 'the first result', 60000);
    const r4 = await page.eval(`${HELPERS}
      const out = {};
      const big = '90'.repeat(1048577);
      if ($('live').checked) $('live').click();
      set($('code'), big);
      let t0 = performance.now();
      $('run').click();
      await until(() => msgs().length > 0, 120000);
      out.a = msgs().join(' | '); out.aMs = performance.now() - t0; out.aBusy = $('run').textContent;
      // A–B: A the example, B too large
      set($('code'), ${JSON.stringify(CHAIN.text.hex)});
      $('cmp-ab').click();
      await wait(200);
      $('b-mode-hex').click();
      set($('code-b'), big);
      t0 = performance.now();
      await done(() => $('run').click(), 120000).catch(() => {});
      await until(() => /Too much/.test($('b-messages')?.textContent ?? ''), 120000);
      out.b = $('b-messages').textContent; out.bMs = performance.now() - t0;
      $('cmp-single').click();
      if (!$('live').checked) $('live').click();
      return out;`, { timeout: 300000 });
    check(r4.a === 'Too much machine code: 1,048,577 bytes (at most 1,048,576)' && r4.aBusy === 'Analyze', 'hex: more than 1 MiB is refused with one line', JSON.stringify(r4));
    check(r4.aMs < 5000, `hex: ... at once (${Math.round(r4.aMs)} ms), the analyzer is not started`);
    check(/^Too much machine code: 1,048,577 bytes/.test(r4.b), 'A–B: side B has the same limit', JSON.stringify(r4));
  }
  const problems = page.take();
  check(problems.length === 0, 'no console errors', problems.join('\n'));
  await page.close();
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
