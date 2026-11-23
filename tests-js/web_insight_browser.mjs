// End-to-end test of the insight views (web/js/insight-view.js) in the built site (web/dist), in headless Chrome over the
// DevTools protocol; no dependencies (Node 22+). Run web/build.sh first.
//
//    node tests-js/web_insight_browser.mjs [--chrome PATH] [--shots DIR]
//
// The critical chain of the "chain" example is marked; the cost column of every example equals analyses that this test
// makes itself under Node, of blocks it cuts from the examples' objdump listings (not with the page's own code); large
// blocks wait for a click; mock mode has no cost column. --shots DIR saves screenshots. Skips (exit 0) without Chrome.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';
import { hostHandler } from './static-host.mjs';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES } from '../web/js/examples.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const dist = path.join(repo, 'web', 'dist');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const shots = opt('--shots');
const chrome = findChrome(opt('--chrome'));
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the expected values, under Node ---------------------------------------------------------------------------------
const engine = await WasmEngine.create(fs.readFileSync(path.join(dist, 'wuica_wasm.wasm')));
await engine.loadUarch(fs.readFileSync(path.join(dist, 'data', 'uarch.json')));
for (const t of new Set(EXAMPLES.map((e) => e.arch))) await engine.loadArch(t, fs.readFileSync(path.join(dist, 'data', 'arch', `${t}.json`)));
const tpOf = async (hex, arch) => (await engine.analyze(makeRequest(hex, arch)));
const fmt = (d) => (d === 0 ? '0.00' : `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`);
const NOP = { 2: '6690', 3: '0f1f00', 4: '0f1f4000' };

// The cost column of an example as text: the instructions are the lines of its objdump listing; the loop's branch is
// "—" (none of the examples has a macro-fused pair other than the one with the branch).
async function expectedCost(ex, variant) {
  const lines = ex.text.hex.trimEnd().split('\n').map((l) => l.split(/:\s+/)[1].split(/\s{2,}/)[0].replace(/ /g, ''));
  const base = await tpOf(ex.hex, ex.arch);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1) { out.push('—'); continue; }
    const hex = lines.map((b, k) => (k !== i ? b : variant === 'nop' ? NOP[b.length / 2] : '')).join('');
    const r = await tpOf(hex, ex.arch);
    out.push(r.mode === base.mode ? fmt((Math.round(r.tp * 100) - Math.round(base.tp * 100)) / 100) : '—');
  }
  return out;
}
const CHAIN = EXAMPLES.find((e) => e.id === 'chain');
// hard-coded, as a check of the listing-based computation above
const CHAIN_REMOVE = await Promise.all(['4883c00149ffcf75f3', '4883c00149ffcf75f3', '4883c0014883c00175f3'].map((x) => tpOf(x, 'SKL')));
const CHAIN_NOP = await Promise.all(['0f1f40004883c00149ffcf75f3', '4883c0010f1f400049ffcf75f3', '4883c0014883c0010f1f0075f3'].map((x) => tpOf(x, 'SKL')));
const want = {};
for (const ex of EXAMPLES) want[ex.id] = { remove: await expectedCost(ex, 'remove'), nop: await expectedCost(ex, 'nop') };
check(JSON.stringify(want.chain.remove.slice(0, 3)) === JSON.stringify(CHAIN_REMOVE.map((r) => fmt(r.tp - 2))), 'node: the chain example, removal', JSON.stringify([want.chain.remove, CHAIN_REMOVE.map((r) => r.tp)]));
check(JSON.stringify(want.chain.nop.slice(0, 3)) === JSON.stringify(CHAIN_NOP.map((r) => fmt(Math.round((r.tp - 2) * 100) / 100))), 'node: the chain example, NOPs', JSON.stringify([want.chain.nop, CHAIN_NOP.map((r) => r.tp)]));

// a large block: 1000 adds; dec r15; jnz (rel32): about 100 times the budget of 2 s (0.2 s per analysis today). The adds
// cycle through 49 different ones (add r64, r64 without rsp), so that the 1000 blocks without one of them all differ (equal
// blocks are analyzed once).
const ADDS = Array.from({ length: 64 }, (_, i) => i).filter((i) => (i & 7) !== 4 && (i >> 3) !== 4).map((i) => '4801' + (0xc0 + i).toString(16));
const BIG_BODY = Array.from({ length: 1000 }, (_, i) => ADDS[i % ADDS.length]).join('') + '49ffcf';
const BIG = BIG_BODY + '0f85' + (0x100000000 - (BIG_BODY.length / 2 + 6)).toString(16).padStart(8, '0').match(/../g).reverse().join('');

// ---- server and browser (as in web_trace_browser.mjs) ---------------------------------------------------------------------
// like the host (redirects /index.html to /, a 404 page, _headers): see static-host.mjs
const server = http.createServer(hostHandler(dist));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-insight-test-'));
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
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const body = () => $('result-body');
  // the cost column of a block estimated over its budget (from the main analysis's time, so also for a small block on a slow
  // machine) waits for a click: where a test only needs the result, click it
  const runAnyway = () => { for (const b of document.querySelectorAll('.ins-cost-status button')) b.click(); };
  const done = async (start) => { const n = $('results').dataset.run; start(); await until(() => $('results').dataset.run !== n); };
  const costDone = async (start) => { await start(); await until(() => (runAnyway(), body().dataset.cost === 'done')); }; // the state changes at once on a change
  const instrRows = () => [...document.querySelectorAll('table.uops tbody tr:not(.extra)')];
  const cost = () => instrRows().map((tr) => tr.querySelector('td.ins-cost')?.textContent ?? null);
  const top = () => instrRows().map((tr, i) => tr.querySelector('td.ins-cost.top') ? i : -1).filter((i) => i >= 0);
  const head = () => [...document.querySelectorAll('table.uops thead th')].map((th) => th.textContent);
  const rowText = () => [...document.querySelectorAll('table.uops tbody tr')].map((tr) => tr.innerText.trim().replace(/\\t+/g, '|'));
  const focused = () => $('cpus').dataset.focus; // the CPU with the details
  const cpus = (...keys) => { const boxes = [...document.querySelectorAll('#cpu-grid input')]; for (const b of boxes) b.checked = keys.includes(b.value); boxes[0].dispatchEvent(new Event('change', { bubbles: true })); };
`;
const b64 = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

try {
  // --- the chain example with the cost column, from a link -----------------------------------------------------------------
  {
    const page = await openPage();
    await page.goto(`${origin}/?nosw=1#v=1&cost=1&c=${b64(CHAIN.text.hex)}`);
    const r = await page.eval(`${HELPERS}
      await until(() => (runAnyway(), document.querySelector('.tp .value') && body().dataset.cost === 'done'));
      const out = { tp: document.querySelector('.tp .value').textContent, cost: cost(), top: top(), head: head(), hash: location.hash };
      const chain = document.querySelector('.ins-chain-row');
      out.chain = [chain?.querySelector('.label').textContent, chain?.querySelector('.field').innerText.replace(/\\s+/g, ' ').trim()];
      out.afterLimits = chain?.previousElementSibling?.querySelector('.limits') !== null;
      out.marked = instrRows().map((tr) => tr.classList.contains('ins-on-chain') ? tr.cells[0].dataset.chain : '');
      out.title = instrRows()[0].cells[0].title;
      out.arrows = [...document.querySelectorAll('.ins-arrow')].map((a) => a.title);
      out.costTitle = instrRows()[0].querySelector('td.ins-cost').title;
      out.marker = getComputedStyle(instrRows()[0].cells[0], '::after').content;
      // the NOP variant
      await costDone(() => set(document.querySelector('.ins-variant'), 'nop'));
      out.nop = cost(); out.nopHash = location.hash;
      // the cost column off: the table is the plain one again (the chain marker adds no text)
      document.querySelector('.ins-cost-box').click(); await wait(50);
      out.off = { head: head(), rows: rowText(), hash: location.hash, state: body().dataset.cost, select: document.querySelector('.ins-variant').hidden };
      // on again: from the cache, at once
      document.querySelector('.ins-cost-box').click();
      out.again = [body().dataset.cost, cost()];
      return out;`);
    check(r.tp === '2.00' && r.head[2] === 'Δ' && r.head[0] === 'Instruction' && r.head[1] === 'Notes', 'cost: a Δ column after the notes', JSON.stringify(r.head));
    check(JSON.stringify(r.cost) === JSON.stringify(want.chain.remove), 'cost: the chain example equals independent analyses of the blocks without each instruction', JSON.stringify([r.cost, want.chain.remove]));
    check(r.top.join() === '0,1' && /removed: 1\.00 cycles\/iteration \(−1\.00\)/.test(r.costTitle), 'cost: the largest saving is marked; the tooltip has the throughput', JSON.stringify([r.top, r.costTitle]));
    check(r.chain[0] === 'chain' && r.chain[1] === 'add rax, 0x1 → add rax, 0x1 ↻ 2.00 cycles/iteration' && r.afterLimits, 'chain: a line under the limits', JSON.stringify(r.chain));
    check(r.marked.join('|') === '← rax|← rax||' && /^critical dependency chain: 2\.00 cycles\/iteration\nreads rax from add rax, 0x1 \(1 cycle, previous iteration\)/.test(r.title) && r.marker === '" ← rax"', 'chain: its rows are marked, with the edges in the tooltip', JSON.stringify([r.marked, r.title, r.marker]));
    check(r.arrows[0] === 'rax, 1 cycle' && r.arrows[1] === 'rax, 1 cycle, into the next iteration', 'chain: the arrows say what flows', JSON.stringify(r.arrows));
    check(/[#&]cost=1(&|$)/.test(r.hash), 'cost: in the fragment', r.hash);
    check(JSON.stringify(r.nop) === JSON.stringify(want.chain.nop) && /cost=1&costnop=1/.test(r.nopHash), 'cost: the NOP variant equals independent analyses; remembered', JSON.stringify([r.nop, want.chain.nop, r.nopHash]));
    check(!r.off.head.includes('Δ') && r.off.head.length === 9 && r.off.rows[0] === 'add rax, 0x1|1|1|1|0.22|0.22|0.29|0.27' && r.off.rows[3] === 'jnz 0xfffffffffffffff5|M' && !/cost/.test(r.off.hash) && r.off.state === 'off' && r.off.select, 'cost: off, the table is as before and the fragment forgets it', JSON.stringify(r.off));
    check(r.again[0] === 'done' && JSON.stringify(r.again[1]) === JSON.stringify(want.chain.nop), 'cost: on again, from the cache', JSON.stringify(r.again));
    await page.shot('insight-chain.png');

    // the other examples, while the column is on (live: a new input recomputes it)
    const e = await page.eval(`${HELPERS}
      if (document.querySelector('.ins-variant').value !== 'remove') await costDone(() => set(document.querySelector('.ins-variant'), 'remove'));
      const out = {};
      for (const [id, arch] of [['loadstore', 'ZEN3'], ['avx', 'ADL-P'], ['stack', 'SKL']]) {
        if (focused() !== arch) await done(() => cpus(arch));
        await costDone(() => done(() => set($('examples'), id)));
        out[id] = { cost: cost(), extra: document.querySelectorAll('table.uops tr.extra td.ins-cost').length, chain: !!document.querySelector('.ins-chain-row') };
      }
      return out;`);
    for (const id of ['loadstore', 'avx', 'stack']) {
      check(JSON.stringify(e[id].cost) === JSON.stringify(want[id].remove), `cost: the "${id}" example equals independent analyses`, JSON.stringify([e[id].cost, want[id].remove]));
    }
    check(e.stack.extra === 1 && e.stack.cost.length === 8, 'cost: an inserted uop gets an empty cell', JSON.stringify(e.stack));
    await page.shot('insight-stack.png');
    check(page.problems.length === 0, 'no console errors', page.problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- a large block waits for a click -------------------------------------------------------------------------------------
  {
    const page = await openPage();
    await page.goto(`${origin}/?nosw=1#v=1&cost=1&c=${b64(BIG)}`);
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.tp .value') && body().dataset.cost === 'waiting');
      const b = document.querySelector('.ins-cost-status button');
      const out = { button: b?.textContent, cells: cost().slice(0, 2) };
      b.click();
      await until(() => body().dataset.cost === 'running' && cost().some((c) => /\\d/.test(c)));
      out.running = cost().filter((c) => /\\d/.test(c)).length > 0;
      document.querySelector('.ins-cost-box').click(); // off: it stops
      await wait(100);
      out.off = body().dataset.cost;
      return out;`);
    check(r.button === 'compute (1001 analyses)' && r.cells.join() === '…,…' && r.running && r.off === 'off', 'cost: a large block waits for a click, then runs; off stops it', JSON.stringify(r));
    check(page.problems.length === 0, 'no console errors (large block)', page.problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- phone width, dark theme --------------------------------------------------------------------------------------------
  {
    const page = await openPage({ width: 375, height: 812, mobile: true });
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await page.goto(`${origin}/?nosw=1#v=1&cost=1&a=SKL&c=${b64(EXAMPLES.find((x) => x.id === 'stack').text.hex)}`);
    const r = await page.eval(`${HELPERS}
      await until(() => (runAnyway(), document.querySelector('.tp .value') && body().dataset.cost === 'done'));
      const topCell = document.querySelector('td.ins-cost.top');
      return { overflow: document.documentElement.scrollWidth - innerWidth, top: topCell ? getComputedStyle(topCell).color : null, bg: getComputedStyle(document.documentElement).backgroundColor };`);
    check(r.overflow <= 0 && r.top === 'rgb(152, 251, 152)' && r.bg === 'rgb(9, 10, 9)', 'phone, dark: no sideways scrolling; the largest saving in the heading colour', JSON.stringify(r));
    await page.shot('insight-phone-dark.png');
    check(page.problems.length === 0, 'no console errors (phone)', page.problems.join('\n'));
    await page.cmd('Page.close');
  }

  // --- mock mode: no cost column ---------------------------------------------------------------------------------------------
  {
    const page = await openPage();
    await page.goto(`${origin}/?mock=1&nosw=1#v=1&cost=1&c=${b64(CHAIN.text.hex)}`);
    const r = await page.eval(`${HELPERS}
      await until(() => document.querySelector('.tp .value') && body().dataset.cost);
      const box = document.querySelector('.ins-cost-box');
      return { state: body().dataset.cost, disabled: box.disabled, title: box.closest('label').title, head: head().includes('Δ'), chain: !!document.querySelector('.ins-chain-row') };`);
    check(r.state === 'unavailable' && r.disabled && r.title === 'not with mock data' && !r.head && !r.chain, 'mock: no cost column and no chain', JSON.stringify(r));
    await page.cmd('Page.close');
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  ws.close();
  proc.kill();
  server.close();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`${count} insight browser checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
