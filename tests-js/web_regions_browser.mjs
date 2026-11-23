// End-to-end test of marked regions and .loc lines of pasted assembly (web/js/asm-regions.js, region-chip.js, srcmap.js)
// in the built site (web/dist), in headless Chrome over the DevTools protocol; no dependencies (Node 22+). Run
// web/build.sh first.
//
//    node tests-js/web_regions_browser.mjs [--chrome PATH] [--shots DIR]
//
// A listing with llvm-mca markers analyzes the loop between them (3 rows, the chip "▣ hot"); without the markers the
// whole listing (6 rows, no chip); a gcc -g -S listing with src=1 shows its source rows as dot.c:N; a phone width has no
// sideways scrolling. Skips (exit 0) without Chrome.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';
import { hostHandler } from './static-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const dist = path.join(repo, 'web', 'dist');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const shots = opt('--shots');
const chrome = findChrome(opt('--chrome'));
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
if (!fs.existsSync(path.join(dist, 'wuica_asm.wasm'))) { console.log('no assembler in web/dist: skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARKED = `  mov rcx, 100
  xor eax, eax
  .p2align 4
# LLVM-MCA-BEGIN hot
.L1:
  add rax, 1
  dec rcx
  jne .L1
# LLVM-MCA-END
  ret
# LLVM-MCA-BEGIN cold
  nop
# LLVM-MCA-END
`;
const GCC = `\t.file 1 "dot.c"
\t.text
dot:
\t.loc 1 3 3 view .LVU2
\ttestq\t%rdx, %rdx
\tjle\t.L4
\txorl\t%eax, %eax
\tpxor\t%xmm0, %xmm0
.L3:
\t.loc 1 4 5 view .LVU3
\tmovsd\t(%rdi,%rax,8), %xmm1
\tmulsd\t(%rsi,%rax,8), %xmm1
\t.loc 1 3 28 discriminator 3 view .LVU4
\taddq\t$1, %rax
\t.loc 1 4 7 is_stmt 0 discriminator 3 view .LVU5
\taddsd\t%xmm1, %xmm0
\t.loc 1 3 3 is_stmt 1 discriminator 3 view .LVU6
\tcmpq\t%rax, %rdx
\tjne\t.L3
\tret
.L4:
\tret
`;
const GCC_LOOP = GCC.replace('.L3:\n', '# wuica-begin\n.L3:\n').replace('\tret\n.L4:', '# wuica-end\n\tret\n.L4:');

// ---- server and browser (as in web_trace_browser.mjs) ---------------------------------------------------------------------
// like the host (redirects /index.html to /, a 404 page, _headers): see static-host.mjs
const server = http.createServer(hostHandler(dist));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-regions-test-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  proc.on('exit', () => reject(new Error('Chrome exited: ' + err.slice(0, 500))));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});

let seq = 0;
const pending = new Map(), handlers = [];
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to Chrome')); });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result); }
  else for (const h of handlers) h(msg);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, method }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

async function openPage({ width = 1280, height = 900, mobile = false } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const page = { sessionId, problems: [] };
  handlers.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') page.problems.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) page.problems.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) page.problems.push(`log ${m.params.entry.level}: ${m.params.entry.text}`);
  });
  page.cmd = (method, params) => send(method, params, sessionId);
  page.eval = async (expression) => {
    const r = await page.cmd('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  page.goto = async (url) => {
    await page.cmd('Page.navigate', { url });
    await sleep(150);
    for (let t = 0; t < 200; t++) { try { if (await page.eval(`return document.readyState === 'complete'`)) return; } catch { /* navigating */ } await sleep(100); }
    throw new Error('page did not load');
  };
  page.shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await page.cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
  };
  for (const d of ['Runtime', 'Log', 'Page']) await page.cmd(`${d}.enable`);
  await page.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  return page;
}

const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 30000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + f); await wait(30); } };
  const done = async (start) => { const n = $('results').dataset.run; start(); await until(() => $('results').dataset.run !== n); };
  const instrRows = () => [...document.querySelectorAll('table.uops tbody tr:not(.extra)')];
  const chip = () => { const c = $('region-chip'); return c && !c.hidden ? c.textContent : null; };
  const setCode = (v) => { const c = $('code'); c.value = v; c.dispatchEvent(new Event('input', { bubbles: true })); };
`;
const b64 = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

try {
  // --- a marked listing from a link: the first region; the chip; without markers the whole listing -----------------------
  {
    const page = await openPage();
    await page.goto(`${origin}/?nosw=1#v=1&m=asm&c=${b64(MARKED)}`);
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.tp .value') && instrRows().length);
      const out = { rows: instrRows().length, chip: chip(), title: $('region-chip')?.title ?? '', messages: $('input-messages').textContent };
      // the chip selects the region's BEGIN line, by keyboard too
      $('region-chip').focus();
      $('region-chip').click();
      const c = $('code');
      out.sel = c.value.slice(c.selectionStart, c.selectionEnd);
      // the markers removed: the whole listing, no chip
      setCode(c.value.replace(/^# LLVM-MCA-.*$/gm, ''));
      await done(() => $('run').click());
      out.after = { rows: instrRows().length, chip: chip() };
      // back: the region again
      setCode(${JSON.stringify(MARKED)});
      await done(() => $('run').click());
      out.again = { rows: instrRows().length, chip: chip() };
      // asm -> hex -> asm keeps the result (the same machine code): the chip goes in hex and comes back
      $('mode-hex').click();
      await until(() => !c.readOnly && !/LLVM-MCA/.test(c.value) && c.value.trim() !== '');
      out.hex = { chip: chip(), lines: c.value.trim().split('\\n').length };
      $('mode-asm').click();
      await until(() => !c.readOnly && c.value === ${JSON.stringify(MARKED)});
      out.back = { chip: chip(), rows: instrRows().length };
      return out;`);
    check(r.rows === 3 && r.chip === '▣ hot 1/2', 'marked: the 3 instructions of the first region, the chip', JSON.stringify(r));
    check(/LLVM-MCA-BEGIN/.test(r.title) && /IACA/.test(r.title) && r.messages === '', 'the chip\'s tooltip lists the markers; no messages', JSON.stringify(r));
    check(r.sel === '# LLVM-MCA-BEGIN hot', 'a click on the chip selects the BEGIN line', JSON.stringify(r.sel));
    check(r.after.rows > 6 && r.after.chip === null, 'no markers: the whole listing, no chip', JSON.stringify(r.after));
    check(r.again.rows === 3 && r.again.chip === '▣ hot 1/2', 'markers again: the region', JSON.stringify(r.again));
    check(r.hex.chip === null && r.hex.lines === 3, 'to hex: the region\'s 3 instructions, no chip', JSON.stringify(r.hex));
    check(r.back.chip === '▣ hot 1/2' && r.back.rows === 3, 'back to asm: the marked text, the chip again', JSON.stringify(r.back));
    await page.shot('regions-marked.png');
    check(page.problems.length === 0, 'no console errors', page.problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- gcc -g -S with .loc, src=1: the source rows; the loop marked ------------------------------------------------------
  {
    const page = await openPage();
    await page.goto(`${origin}/?nosw=1#v=1&m=asm&s=att&src=1&c=${b64(GCC_LOOP)}`);
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.tp .value') && instrRows().length && $('srcmap-row') && !$('srcmap-row').hidden && $('srcmap').open && document.querySelector('.sm-list'));
      const items = [...document.querySelectorAll('#srcmap .sm-list > li')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim());
      const out = { rows: instrRows().length, chip: chip(), items, hint: document.querySelector('.sm-hint')?.textContent, messages: $('input-messages').textContent,
        tabs: [...document.querySelectorAll('.view-tab')].map((b) => b.textContent), branch: instrRows().at(-1)?.cells[0].textContent };
      // a click on a line jumps to its costliest row: the table tab shows, the row flashes
      document.querySelector('#srcmap button.sm-l')?.click();
      await wait(50);
      out.hash = location.hash;
      out.jump = { tab: document.querySelector('.view-tab[aria-selected="true"]')?.textContent, open: $('srcmap').open, flash: instrRows().some((tr) => tr.classList.contains('rj-flash')) };
      // the whole listing (no markers): all its instructions, the lines of the function (the source tab again)
      setCode(${JSON.stringify(GCC)});
      await done(() => $('run').click());
      [...document.querySelectorAll('.view-tab')].find((b) => b.textContent === 'source').click();
      await until(() => document.querySelector('.sm-list'));
      out.whole = { rows: instrRows().length, items: [...document.querySelectorAll('#srcmap .sm-list > li')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim()), hidden: $('srcmap-row').hidden,
        branches: instrRows().map((tr) => tr.cells[0].textContent).filter((t) => /^j/.test(t)) };
      // hex mode: no source rows
      return out;`);
    check(r.rows === 6 && r.chip === '▣ region', 'gcc -g, the loop marked: its 6 instructions', JSON.stringify(r));
    check(r.items.length === 2 && /^3 .*dot\.c:3$/.test(r.items[0]) && /^4 .*dot\.c:4$/.test(r.items[1]) && r.messages === '', 'the source rows: dot.c:3 and dot.c:4', JSON.stringify(r.items));
    check(/line \d+ \d+%/.test(r.hint ?? ''), 'the summary hint names the costliest line', r.hint);
    check(r.jump.tab === 'table' && !r.jump.open && r.jump.flash, 'a click on a source line: the table tab, the row flashes', JSON.stringify(r.jump));
    check(r.branch === 'jnz .L3' && r.whole.branches.join() === 'jle dot+0x23,jnz dot+0xb', 'branch targets as labels: the marked loop\'s own label; in the whole function, the function\'s label and the offset', JSON.stringify([r.branch, r.whole.branches]));
    check(r.tabs.at(-1) === 'source' && r.tabs.slice(0, -1).join() === 'table,bound,try,bytes,deps,mca,sweep,trace', 'the source tab comes last: the other tabs keep their places', JSON.stringify(r.tabs));
    check(r.whole.rows === 12 && !r.whole.hidden && r.whole.items.length === 2, 'the whole function: 12 instructions, lines 3 and 4', JSON.stringify(r.whole));
    await page.shot('regions-loc.png');
    check(page.problems.length === 0, 'no console errors (.loc)', page.problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- phone width, dark: no sideways scrolling ----------------------------------------------------------------------------
  {
    const page = await openPage({ width: 320, height: 700, mobile: true });
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await page.goto(`${origin}/?nosw=1#v=1&m=asm&c=${b64(MARKED.replace('hot', 'a-rather-long-region-name-that-does-not-fit-on-a-phone'))}`);
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.tp .value') && chip());
      const c = $('region-chip').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth - innerWidth, right: c.right, width: innerWidth, color: getComputedStyle($('region-chip')).color };`);
    check(r.overflow <= 0 && r.right <= r.width, 'phone: no sideways scrolling, the chip fits', JSON.stringify(r));
    await page.shot('regions-phone-dark.png');
    check(page.problems.length === 0, 'no console errors (phone)', page.problems.join('\n'));
    await page.cmd('Page.close');
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  ws.close();
  proc.kill();
  server.close();
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be writing its profile */ }
}

console.log(`${count} region browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
