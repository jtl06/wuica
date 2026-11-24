// Time to the first result of a fresh visit (the audit's method, docs/PORTING.md "Size of the modules"): a copy of
// web/dist served locally with brotli -q 2 for everything (close to what the site's host sends), headless Chrome, a new
// browser context per visit (empty cache, no service worker), the network throttled; the first result is the moment the
// headline's throughput appears. Also the bytes on the wire before it, and whether the assembler was fetched by then.
// Medians of N visits per condition: unthrottled, 10 Mbit/s with 40 ms latency, 4 Mbit/s with 80 ms.
//   node tools/first-result.mjs [DIST=web/dist] [N=10]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { findChrome, launch, sleep, ROOT } from '../tests-js/cdp.mjs';
import { TYPES } from '../tests-js/static-host.mjs';
const root = path.resolve(process.argv[2] || path.join(ROOT, 'web/dist')); const N = Number(process.argv[3] || 10);
const cache = new Map();
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  const br = /\bbr\b/.test(req.headers['accept-encoding'] ?? '');
  let body = fs.readFileSync(file);
  const headers = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' };
  if (br) {
    if (!cache.has(file)) cache.set(file, zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 2 } }));
    body = cache.get(file); headers['content-encoding'] = 'br';
  }
  res.writeHead(200, headers).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const { browser, close } = await launch(findChrome());
const OBSERVE = `(() => { const t = () => { if (document.querySelector('#result-body .tp .value, #result-body .ab-tp .value')) { window.__first = performance.now(); return true; } return false; };
  const go = () => { if (t()) return; new MutationObserver((_, o) => { if (t()) o.disconnect(); }).observe(document.documentElement, { childList: true, subtree: true }); };
  if (document.documentElement) go(); else addEventListener('DOMContentLoaded', go); })();`;
async function visit(cond) {
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => browser.send(m, p, sessionId);
  const reqs = new Map(); let navTs = null; const done = [];
  browser.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Network.requestWillBeSent') { reqs.set(m.params.requestId, m.params.request.url); if (navTs === null && m.params.type === 'Document') navTs = m.params.timestamp; }
    if (m.method === 'Network.loadingFinished') done.push({ url: reqs.get(m.params.requestId), ts: m.params.timestamp, bytes: m.params.encodedDataLength });
  });
  await s('Network.enable'); await s('Page.enable');
  await s('Network.setCacheDisabled', { cacheDisabled: true });
  if (cond) await s('Network.emulateNetworkConditions', { offline: false, latency: cond.latency, downloadThroughput: cond.mbit * 1e6 / 8, uploadThroughput: cond.mbit * 1e6 / 8 });
  await s('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE });
  await s('Page.navigate', { url: origin + '/' });
  let first = null;
  for (let i = 0; i < 600 && first === null; i++) {
    await sleep(50);
    try { first = (await s('Runtime.evaluate', { expression: 'window.__first ?? null', returnByValue: true })).result.value; } catch { /* navigating */ }
  }
  const cut = navTs + first / 1000;
  const before = done.filter((d) => d.ts <= cut + 0.001);
  const out = { ms: first, bytes: before.reduce((a, d) => a + d.bytes, 0), asm: before.some((d) => /wuica_asm\.wasm/.test(d.url)), asmEver: [...reqs.values()].some((u) => /wuica_asm\.wasm/.test(u)) };
  await browser.send('Target.closeTarget', { targetId });
  await browser.send('Target.disposeBrowserContext', { browserContextId });
  return out;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
for (const [name, cond] of [['unthrottled', null], ['10 Mbit/s, 40 ms', { mbit: 10, latency: 40 }], ['4 Mbit/s, 80 ms', { mbit: 4, latency: 80 }]]) {
  await visit(cond); // (a warm-up of Chrome itself)
  const runs = [];
  for (let i = 0; i < N; i++) runs.push(await visit(cond));
  console.log(`${name}: first result median ${Math.round(median(runs.map((r) => r.ms)))} ms (${runs.map((r) => Math.round(r.ms)).join(' ')}); bytes before it median ${median(runs.map((r) => r.bytes))}; assembler before it: ${runs.filter((r) => r.asm).length}/${N}`);
}
await close(); server.close(); process.exit(0);
