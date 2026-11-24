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
import { findChrome, launch, Page, checker, ROOT, sleep, testConditions } from './cdp.mjs';
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
// B with A's page: a cache on the way (a CDN, the HTTP cache) still serving the last deploy's index.html
const M = path.join(tmp, 'm');
fs.cpSync(B, M, { recursive: true });
fs.copyFileSync(path.join(A, 'index.html'), path.join(M, 'index.html'));
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
  await testConditions((m, a) => p.cmd(m, a)); // (cdp.mjs: scratch runs under another font, real scroll bars, a slower CPU)
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
        s = await y.read(`return { html: document.querySelector('meta[name="wuica-build"]')?.content ?? null, build: document.getElementById('build-id').textContent,
          note: !document.getElementById('update-note').hidden, mark: sessionStorage.getItem('wuica-update-reload'), ready: !document.getElementById('run').disabled };`,
        { ready: `document.getElementById('build-id') && document.getElementById('update-note') && document.getElementById('run')`, ms: 5000 });
      } catch { continue; }
      seen.add(`${name(s.html)}${s.note ? ' note' : ''}${s.mark ? ' mark' : ''}`);
      if (s.note || (s.mark === vB && s.html === vB && s.ready)) break;
    }
    check(s && (s.note || (s.mark === vB && s.html === vB && s.build === vB)), `round ${round}: a page whose start a new deploy's worker took over reloads into the new build (or says so)`, JSON.stringify({ last: s && { ...s, html: name(s.html), build: name(s.build) }, seen: [...seen] }));
    check(seen.has('A') || seen.has('A mark') || seen.has('A note'), `round ${round}: (the page started as the old build: the race happened)`, JSON.stringify([...seen]));
    // a read while the page replaces its document (as during its own reload): the new document's values, not a failure
    if (round === 1) {
      await y.eval(`setTimeout(() => location.reload(), 0); return 1;`);
      const r = await y.read(`return [document.getElementById('build-id').textContent, document.getElementById('update-note').hidden];`,
        { ready: `document.getElementById('run')?.disabled === false && document.getElementById('update-note') && document.getElementById('build-id')`, ms: 60000 }).catch((e) => e.message);
      check(Array.isArray(r) && r[0] === vB, 'a read during a reload waits for the new document (cdp.mjs readSettled)', JSON.stringify(r));
    }
    await browser.send('Target.disposeBrowserContext', { browserContextId: ctx });
  }
  // ---- a page opened on the first visit (it started without a worker): a later deploy still takes it into the new build
  // (it ignored every change of worker, taking the first one, its own build's, for the only one)
  {
    root = A;
    const { browserContextId: ctx } = await browser.send('Target.createBrowserContext');
    const f = await open(ctx);
    await f.goto(`${origin}/`);
    await f.ready();
    await f.waitFor(`navigator.serviceWorker.controller && (await caches.keys()).length === 1`, 'the worker of A in control', 60000);
    const quiet = await f.read(`return { note: !document.getElementById('update-note').hidden, mark: sessionStorage.getItem('wuica-update-reload') };`);
    check(!quiet.note && quiet.mark === null, 'a first visit: its own worker taking the page is no update (no note, no reload)', JSON.stringify(quiet));
    root = B;
    await f.eval(`await (await navigator.serviceWorker.getRegistration()).update().catch(() => {}); return 1;`);
    let s1 = null;
    for (let k = 0; k < 120 && !(s1 && s1.html === vB); k++) {
      await sleep(250);
      try { s1 = await f.read(`return { html: document.querySelector('meta[name="wuica-build"]').content, note: !document.getElementById('update-note').hidden };`, { ready: `document.getElementById('run')?.disabled === false && document.getElementById('update-note')`, ms: 5000 }); } catch { /* reloading */ }
    }
    check(s1?.html === vB, 'a page of a first visit: a later deploy takes it into the new build', JSON.stringify({ ...s1, html: name(s1?.html) }));
    await browser.send('Target.disposeBrowserContext', { browserContextId: ctx });
  }

  // ---- a deploy whose page is still the old one (M): its worker must not install (no build of A's page with B's files,
  // whose note a reload could never clear); once the host serves B's page, B installs and the page reloads into it
  {
    root = A;
    const { browserContextId: ctx } = await browser.send('Target.createBrowserContext');
    const z = await open(ctx);
    await z.goto(`${origin}/`);
    await z.ready();
    await z.waitFor(`navigator.serviceWorker.controller && (await caches.keys()).length === 1`, 'the worker of A in control', 60000);
    root = M;
    const t = await z.eval(`try { await (await navigator.serviceWorker.getRegistration()).update(); return 'installed'; } catch (e) { return 'refused: ' + e.message; }`);
    await sleep(4000);
    const READY = `document.getElementById('run')?.disabled === false && document.getElementById('update-note') && document.getElementById('build-id')`;
    const r = await z.read(`return { keys: (await caches.keys()).join(), note: !document.getElementById('update-note').hidden, build: document.getElementById('build-id').textContent, mark: sessionStorage.getItem('wuica-update-reload') };`, { ready: READY });
    check(r.keys === `wuica-${vA}` && !r.note && r.build === vA && r.mark === null, 'a deploy served with the last deploy\'s page: its worker does not install (A stays, no note, no reload)', JSON.stringify({ update: t, ...r, keys: r.keys.replace(vA, 'A').replace(vB, 'B'), build: name(r.build) }));
    root = B;
    await z.eval(`await (await navigator.serviceWorker.getRegistration()).update().catch(() => {}); return 1;`);
    let s2 = null;
    for (let k = 0; k < 120 && !(s2 && s2.build === vB && s2.html === vB); k++) {
      await sleep(250);
      try { s2 = await z.read(`return { build: document.getElementById('build-id').textContent, html: document.querySelector('meta[name="wuica-build"]').content, keys: (await caches.keys()).join() };`, { ready: READY, ms: 5000 }); } catch { /* reloading */ }
    }
    check(s2?.build === vB && s2?.html === vB && s2?.keys === `wuica-${vB}`, 'then the host serves B\'s page: B installs and the page reloads into it', JSON.stringify(s2));
    await browser.send('Target.disposeBrowserContext', { browserContextId: ctx });
  }

  // ---- a text longer than a link holds (200,000 characters: url-state.js): no automatic reload (it would lose the
  // text); the note instead
  {
    root = A;
    const { browserContextId: ctx } = await browser.send('Target.createBrowserContext');
    const w = await open(ctx);
    await w.goto(`${origin}/?nosw=0`);
    await w.ready();
    await w.waitFor(`navigator.serviceWorker.controller && (await caches.keys()).length === 1`, 'the worker of A in control', 60000);
    const len = await w.eval(`const c = document.getElementById('code'); if (document.getElementById('live').checked) document.getElementById('live').click();
      c.value = Array.from({ length: 21000 }, (_, i) => '  nop # ' + String(i).padStart(6, '0')).join('\\n'); c.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 800)); return c.value.length;`);
    root = B;
    await w.eval(`await (await navigator.serviceWorker.getRegistration()).update().catch(() => {}); return 1;`);
    let s3 = null;
    for (let k = 0; k < 60 && !s3?.note; k++) {
      await sleep(250);
      try { s3 = await w.read(`return { note: !document.getElementById('update-note').hidden, mark: sessionStorage.getItem('wuica-update-reload'), length: document.getElementById('code').value.length, build: document.getElementById('build-id').textContent };`, { ready: `document.getElementById('update-note') && document.getElementById('code')`, ms: 5000 }); } catch { /* reloading */ }
    }
    await sleep(3000); // (idle long enough for a reload, if one came)
    const s4 = await w.read(`return { note: !document.getElementById('update-note').hidden, mark: sessionStorage.getItem('wuica-update-reload'), length: document.getElementById('code').value.length, build: document.getElementById('build-id').textContent };`, { ready: `document.getElementById('update-note') && document.getElementById('code')` });
    check(len > 200000 && s4.note && s4.mark === null && s4.length === len && s4.build === vA, 'a text of over 200,000 characters: no automatic reload (the text would be lost), the note instead', JSON.stringify({ len, s3, s4: { ...s4, build: name(s4.build) } }));
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
