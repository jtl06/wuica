#!/usr/bin/env node
// What the host's analytics script sends from the live page. Run by hand before a release that keeps the script
// allowed (docs/SPEC.md, "Analytics"); not part of check.sh, since it depends on a script the host injects and may
// change at any time.
//
//   node scripts/beacon-capture.mjs [--url https://wuica.jacen.li/] [--chrome PATH] [--json] [--deployed-policy]
//
// It opens the page in headless Chrome under this checkout's content policy (web/index.html, and the same as a response
// header plus frame-ancestors, as web/_headers sends it) in place of the deployed one, so the injected script runs
// whether or not the deployed policy allows it, and a violation of the checkout's policy fails the run.
// --deployed-policy keeps the deployed policy. It pauses every request. The page's own files and the injected script go
// through; everything else (the beacon's reports, wherever they go) is recorded and answered with 204, so nothing
// reaches the host. Three cases: a visit, edits of the code, and leaving the page. It fails (exit 1) if a report
// holds any part of the fragment (the user's code), or if editing sends reports.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { findChrome, launch, Page, ROOT, sleep } from '../tests-js/cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args[i + 1]; };
const BASE = new URL(opt('--url', 'https://wuica.jacen.li/'));
const JSON_OUT = args.includes('--json');
const SCRIPT_HOST = 'static.cloudflareinsights.com';
const POLICY = args.includes('--deployed-policy') ? null
  : fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
const CODE = (n) => `; beacon capture ${n}\nloop:\n  vaddps ymm0, ymm0, [rdi+rax*4]\n  add rax, ${8 + n}\n  cmp rax, rsi\n  jb loop\n`;

const { browser, close } = await launch(findChrome(args));
const reports = []; // every request that is not a GET of the page's own files or of the injected script
const scripts = new Set();
const violations = [];
let failed = false;
const fail = (msg) => { failed = true; console.log('FAIL ' + msg); };

async function open() {
  const p = await Page.open(browser);
  p.ignore.push(/./); // the page's own problems are not this script's subject
  await p.cmd('Network.setBypassServiceWorker', { bypass: true }); // every request is then the page's, and paused here
  await p.cmd('Network.setCacheDisabled', { cacheDisabled: true });
  await p.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('securitypolicyviolation', (e) => (window.__violations ??= []).push(e.violatedDirective + ' ' + e.blockedURI));` });
  await p.cmd('Fetch.enable', { patterns: [{ urlPattern: '*' }, ...(POLICY ? [{ urlPattern: BASE.origin + '/*', resourceType: 'Document', requestStage: 'Response' }] : [])] });
  browser.on((m) => {
    if (m.sessionId !== p.sessionId || m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    const url = new URL(request.url);
    if (m.params.responseStatusCode !== undefined) { // the page as the host sent it (with the injected script): the checkout's policy in place of its own
      (async () => {
        const got = await p.cmd('Fetch.getResponseBody', { requestId });
        const html = Buffer.from(got.body, got.base64Encoded ? 'base64' : 'utf8').toString('utf8');
        const meta = /(http-equiv="Content-Security-Policy" content=")[^"]*"/;
        if (!meta.test(html)) return p.cmd('Fetch.continueResponse', { requestId }); // not the page (a redirect, an error)
        p.policySet = true;
        const headers = m.params.responseHeaders.filter((h) => !/^(content-security-policy|content-length|content-encoding)$/i.test(h.name));
        headers.push({ name: 'Content-Security-Policy', value: `${POLICY}; frame-ancestors 'none'` });
        await p.cmd('Fetch.fulfillRequest', { requestId, responseCode: m.params.responseStatusCode, responseHeaders: headers, body: Buffer.from(html.replace(meta, `$1${POLICY}"`)).toString('base64') });
      })().catch((e) => fail('the page with the checkout\'s policy: ' + e.message));
      return;
    }
    const own = url.origin === BASE.origin && !url.pathname.startsWith('/cdn-cgi/');
    if (url.hostname === SCRIPT_HOST) scripts.add(url.origin + url.pathname);
    if (request.method === 'GET' && (own || url.hostname === SCRIPT_HOST || url.protocol === 'data:' || url.protocol === 'blob:')) {
      p.cmd('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    reports.push({ when: p.phase, method: request.method, url: request.url, headers: request.headers, body: request.postData ?? '' });
    p.cmd('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }] }).catch(() => {});
  });
  return p;
}
const settled = (p) => p.waitFor(`document.querySelector('.tp .value') && !document.getElementById('results').hasAttribute('aria-busy')`, 'a result', 90000);
const leave = async (p) => { // what a tab switch and then closing the tab do
  await p.eval(`
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));`);
  await sleep(1500);
  await p.cmd('Page.navigate', { url: 'about:blank' });
  await sleep(2500);
};

const fragments = [];
try {
  // 1: a plain visit, then edits of the code (each one rewrites the fragment), then leaving
  let p = await open();
  p.phase = 'visit';
  await p.goto(BASE.href);
  await p.ready(); await settled(p);
  const tag = await p.eval(`const s = document.querySelector('script[src*="cloudflareinsights"]'); return s ? { src: s.src, config: s.dataset.cfBeacon?.replace(/"token":"[^"]*"/, '"token":"…"') } : null;`);
  if (!tag) fail(`${BASE.href} has no injected analytics script: nothing to capture`);
  if (POLICY && !p.policySet) fail('the checkout\'s policy was not put in place');
  const policy = await p.eval(`return document.querySelector('meta[http-equiv=Content-Security-Policy]')?.content;`);
  await sleep(3000); // the report of the load
  const afterLoad = reports.length;
  p.phase = 'edit';
  for (let n = 1; n <= 5; n++) {
    const before = await p.eval('return location.hash;');
    await p.eval(`const c = document.getElementById('code'); c.focus(); c.select();`);
    await p.type(CODE(n));
    await p.waitFor(`location.hash !== ${JSON.stringify(before)}`, 'the fragment of edit ' + n, 30000);
    await settled(p);
    fragments.push(await p.eval('return location.hash;'));
    await sleep(1200);
  }
  const duringEdits = reports.length - afterLoad;
  violations.push(...(await p.eval('return window.__violations ?? [];')));
  if (POLICY && violations.length) fail(`the checkout's policy blocks something: ${violations.join(', ')}`);
  p.phase = 'leave';
  await leave(p);
  await p.close();

  // 2: a visit by a link that holds code, then leaving
  p = await open();
  p.phase = 'link';
  await p.goto(BASE.href + fragments.at(-1));
  await p.ready(); await settled(p);
  await sleep(3000);
  p.phase = 'link-leave';
  await leave(p);
  await p.close();

  // the fragment, or a piece of it, anywhere in a report: its address, its headers or its body, raw or percent-encoded
  const needles = new Set();
  for (const f of fragments) {
    const value = f.replace(/^#/, '');
    const c = new URLSearchParams(value).get('c') ?? value;
    for (const s of [value, c, c.slice(0, 24), c.slice(Math.floor(c.length / 2), Math.floor(c.length / 2) + 24), c.slice(-24)]) {
      if (s.length >= 16) { needles.add(s); needles.add(encodeURIComponent(s)); }
    }
  }
  needles.add('v=1&c='); needles.add('v%3D1%26c%3D'); needles.add('beacon capture'); needles.add('vaddps');
  const posts = reports.filter((r) => /\/cdn-cgi\/rum/.test(r.url));
  const other = reports.filter((r) => !/\/cdn-cgi\/rum/.test(r.url));
  for (const r of reports) {
    const hay = [r.url, JSON.stringify(r.headers), r.body].join('\n');
    const hit = [...needles].find((n) => hay.includes(n));
    if (hit) fail(`a report (${r.when}, ${r.method} ${r.url.split('?')[0]}) holds part of the fragment: ${hit.slice(0, 40)}`);
    if (/#/.test(r.url)) fail(`a report's address has a fragment: ${r.url}`);
  }
  if (duringEdits > 0) fail(`${duringEdits} report(s) were sent while editing (5 edits): one per change of the fragment?`);
  if (other.length) fail(`requests to somewhere else: ${[...new Set(other.map((r) => r.method + ' ' + r.url.split('?')[0]))].join(', ')}`);
  if (!posts.length && tag) fail('no report was captured: the capture does not see what the script sends');

  const locations = new Set();
  const keys = new Set();
  for (const r of posts) {
    try {
      const j = JSON.parse(r.body);
      for (const k of Object.keys(j)) keys.add(k);
      for (const k of ['location', 'referrer']) if (typeof j[k] === 'string') locations.add(`${k}: ${JSON.stringify(j[k])}`);
    } catch { keys.add('(a body that is not JSON)'); }
  }
  const summary = {
    page: BASE.href,
    script: [...scripts],
    config: tag?.config ?? null,
    reportsTo: [...new Set(posts.map((r) => { const u = new URL(r.url); return `${r.method} ${u.origin}${u.pathname}`; }))],
    reports: Object.fromEntries(['visit', 'edit', 'leave', 'link', 'link-leave'].map((w) => [w, reports.filter((r) => r.when === w).length])),
    fields: [...keys].sort(),
    addressesSent: [...locations],
    policy: POLICY ? 'this checkout\'s: ' + policy : 'the deployed one: ' + policy,
    policyViolations: violations,
    failed,
  };
  if (JSON_OUT) console.log(JSON.stringify({ summary, reports: posts.map((r) => ({ when: r.when, url: r.url.replace(/token=[^&]*/, 'token=…'), body: r.body.replace(/"siteToken":"[^"]*"/, '"siteToken":"…"') })) }, null, 1));
  else console.log(JSON.stringify(summary, null, 1));
  console.log(failed ? 'beacon capture: FAILED' : 'beacon capture: ok (no part of the fragment in any report, none while editing)');
} finally {
  await Promise.race([close(), sleep(8000)]);
}
process.exit(failed ? 1 : 0);
