// A new deploy whose service worker takes over while a page is starting (headless Chrome, --headless and
// --remote-debugging-port through tests-js/cdp.mjs): tab X has the build A open, the host now serves B; tab Y starts (its
// main thread held for a few seconds, as on a slow machine) and X's update check (as any tab's register() does) installs
// B's worker, which claims Y mid-start. Y's HTML and first modules are A's (the old worker answered them), its later
// requests B's (manifest.json among them) and no controllerchange comes any more. The page knows its own build
// (index.html, stamped by build.sh: app.js PAGE_BUILD): it must reload into B (or say so), not stay a mix. Before
// app.js compared them, Y stayed A's code with B's manifest, without the note (as web_browser.mjs's deploy check saw on
// a slow CI runner: {"keys":["wuica-feedfacecafe"],"note":null,"build":"feedfacecafe","mark":null}).
//   node tests-js/web_sw_update_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { findChrome, launch, Page, checker, ROOT, sleep } from './cdp.mjs';
import { hostHandler } from './static-host.mjs';

const chrome = findChrome();
const check = checker('service worker update browser');
const dist = path.join(ROOT, 'web/dist');
if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(check.summary() ? 1 : 0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-swupd-'));
const A = path.join(tmp, 'a'), B = path.join(tmp, 'b');
fs.cpSync(dist, A, { recursive: true });
fs.cpSync(dist, B, { recursive: true });
const vA = JSON.parse(fs.readFileSync(path.join(A, 'manifest.json'), 'utf8')).version, vB = 'feedfacecafe';
// the second deploy: the same files with another version, where build.sh writes it (the manifest, the worker, the page)
for (const f of ['manifest.json', 'sw.js', 'index.html']) fs.writeFileSync(path.join(B, f), fs.readFileSync(path.join(B, f), 'utf8').replaceAll(vA, vB));
let root = A;
const server = http.createServer(hostHandler(() => root));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const { browser, close } = await launch(chrome);
const name = (v) => (v === vA ? 'A' : v === vB ? 'B' : String(v));
async function open(ctx) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
  const p = new Page();
  p.browser = browser; p.targetId = targetId;
  p.sessionId = (await browser.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  for (const d of ['Runtime', 'Page']) await p.cmd(`${d}.enable`);
  return p;
}
try {
  for (let round = 1; round <= 2; round++) {
    root = A;
    const { browserContextId: ctx } = await browser.send('Target.createBrowserContext');
    const x = await open(ctx);
    await x.goto(`${origin}/`);
    await x.ready();
    await x.waitFor(`navigator.serviceWorker.controller && (await caches.keys()).length === 1`, 'the worker of A in control', 60000);
    root = B;
    const y = await open(ctx);
    await y.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.protocol === 'http:' && !sessionStorage.getItem('held')) { sessionStorage.setItem('held', '1'); const t = Date.now(); while (Date.now() - t < 6000); }` });
    await y.cmd('Page.navigate', { url: `${origin}/` });
    await sleep(500);
    await x.eval(`await (await navigator.serviceWorker.getRegistration()).update(); return 1;`); // another tab's update check
    // Y: it reloads itself into B (or shows the note); then it is B, all of it
    const seen = new Set();
    let s = null;
    for (let t = 0; t < 240; t++) {
      await sleep(250);
      try {
        s = await y.eval(`return { html: document.querySelector('meta[name="wuica-build"]')?.content ?? null, build: document.getElementById('build-id')?.textContent ?? null,
          note: !document.getElementById('update-note').hidden, mark: sessionStorage.getItem('wuica-update-reload'), ready: !document.getElementById('run').disabled };`, { timeout: 5000 });
      } catch { continue; }
      seen.add(`${name(s.html)}${s.note ? ' note' : ''}${s.mark ? ' mark' : ''}`);
      if (s.note || (s.mark === vB && s.html === vB && s.ready)) break;
    }
    check(s && (s.note || (s.mark === vB && s.html === vB && s.build === vB)), `round ${round}: a page whose start a new deploy's worker took over reloads into the new build (or says so)`, JSON.stringify({ last: s && { ...s, html: name(s.html), build: name(s.build) }, seen: [...seen] }));
    check(seen.has('A') || seen.has('A mark') || seen.has('A note'), `round ${round}: (the page started as the old build: the race happened)`, JSON.stringify([...seen]));
    await browser.send('Target.disposeBrowserContext', { browserContextId: ctx });
  }
} catch (e) {
  check(false, 'the test ran to the end', e?.stack ?? String(e));
} finally {
  await close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(check.summary() ? 1 : 0);
