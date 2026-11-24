// The per-IP token bucket: unit behavior and through the server (CF-Connecting-IP, exemptions, compare cost, MCP).
import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { RateLimiter } from '../lib/ratelimit.js';
import { start, post, get, HEX } from './helpers.mjs';
import { WHAT_IF_VARIANTS } from 'wuica';

test('token bucket: burst, refill, per key, bounded map', () => {
  let now = 0;
  const l = new RateLimiter({ burst: 3, perMinute: 60, maxKeys: 2, now: () => now });
  try {
    assert.ok([1, 2, 3].every(() => l.take('a').ok));
    const r = l.take('a');
    assert.equal(r.ok, false);
    assert.equal(r.retryAfter, 1);
    assert.ok(l.take('b').ok);          // another key has its own bucket
    now += 1000;                        // 1 token per second
    assert.ok(l.take('a').ok);
    assert.equal(l.take('a').ok, false);
    assert.equal(l.take('a', 2).retryAfter, 2);
    l.take('c');                        // a third key evicts the least recently used one
    assert.equal(l.size, 2);
    now += 10_000;
    l.sweep();                          // full buckets are dropped
    assert.equal(l.size, 0);
    assert.ok(new RateLimiter({ burst: 0, perMinute: 0 }).take('x').ok); // disabled
  } finally { l.close(); }
});

test('server: 429 with Retry-After per CF-Connecting-IP; /healthz, / and preflight are exempt', async () => {
  const s = await start({ rateBurst: 3, ratePerMinute: 6, compareCost: 2 });
  try {
    const A = { 'CF-Connecting-IP': '203.0.113.1' }, B = { 'CF-Connecting-IP': '203.0.113.2' };
    for (let i = 0; i < 3; i++) assert.equal((await post(s.base, '/api/analyze/SKL', { hex: HEX }, A)).status, 200);
    const r = await post(s.base, '/api/analyze/SKL', { hex: HEX }, A);
    assert.equal(r.status, 429);
    assert.equal(r.json.code, 1);
    assert.match(r.json.error, /too many requests/);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal((await get(s.base, '/api/archs', A)).status, 429);
    assert.equal((await post(s.base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...A, Accept: 'application/json, text/event-stream' })).status, 429);
    // exempt
    assert.equal((await get(s.base, '/healthz', A)).status, 200);
    assert.equal((await get(s.base, '/', A)).status, 200);
    assert.equal((await fetch(s.base + '/api/archs', { method: 'OPTIONS', headers: A })).status, 204);
    // another client: its own bucket; a compare of every microarchitecture costs compareCost (2) tokens
    assert.equal((await post(s.base, '/api/compare', { hex: HEX }, B)).status, 200);
    assert.equal((await post(s.base, '/api/compare', { hex: HEX }, B)).status, 429);
    assert.equal((await post(s.base, '/api/analyze/SKL', { hex: HEX }, B)).status, 200);
  } finally { await s.close(); }
});

test('server: tokens in proportion to the analyses a request can start, the same in REST and /mcp', async () => {
  // 15 microarchitectures, compareCost 3: 0.2 tokens per analysis, at least 1 per request, at most the burst (30)
  const s = await start({ rateBurst: 30, ratePerMinute: 1, compareCost: 3 });
  const left = async (headers) => { let n = 0; while ((await post(s.base, '/api/analyze/SKL', { hex: HEX }, headers)).status === 200) n++; return n; };
  const mcp = (headers, name, args) => post(s.base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { ...headers, Accept: 'application/json, text/event-stream' });
  try {
    const ip = (k) => ({ 'CF-Connecting-IP': `203.0.113.${k}` });
    // what-if, the default variants: 11 analyses -> 3 tokens; align alone: 1 + 64 -> 13; with the default variants: 75 ->
    // 15; diff: 2 -> 1; a compare: compareCost (3), whatever it lists
    assert.equal((await post(s.base, '/api/what-if/SKL', { hex: HEX }, ip(10))).status, 200);
    assert.equal(await left(ip(10)), 27);
    assert.equal((await post(s.base, '/api/what-if/SKL', { hex: HEX, variants: ['align'] }, ip(11))).status, 200);
    assert.equal(await left(ip(11)), 17);
    assert.equal((await post(s.base, '/api/diff/SKL', { a: { hex: HEX }, b: { hex: HEX } }, ip(12))).status, 200);
    assert.equal(await left(ip(12)), 29);
    assert.equal((await post(s.base, '/api/what-if/SKL', { hex: HEX, variants: [...WHAT_IF_VARIANTS, 'align'] }, ip(14))).status, 200);
    assert.equal(await left(ip(14)), 15);
    assert.equal((await post(s.base, '/api/compare', { hex: HEX, archs: ['SKL', 'ZEN3', 'ICL', 'HSW', 'SNB'] }, ip(13))).status, 200);
    assert.equal(await left(ip(13)), 27);
    assert.equal((await post(s.base, '/api/compare', { hex: HEX, archs: ['SKL'] }, ip(15))).status, 200);
    assert.equal(await left(ip(15)), 27);
    // /mcp: the same costs
    assert.equal((await mcp(ip(20), 'what_if', { hex: HEX, variants: ['align'] })).status, 200);
    assert.equal(await left(ip(20)), 17);
    assert.equal((await mcp(ip(21), 'diff_blocks', { a: { hex: HEX }, b: { hex: HEX } })).status, 200);
    assert.equal(await left(ip(21)), 29);
    assert.equal((await mcp(ip(22), 'compare_archs', { hex: HEX, archs: ['SKL'] })).status, 200);
    assert.equal(await left(ip(22)), 27);
  } finally { await s.close(); }
});

test('server: a compare costs at least one token per job it can run at once', async () => {
  // 4 workers: a split compare runs up to 2 parts at once; compareCost 1
  const s = await start({ rateBurst: 30, ratePerMinute: 1, compareCost: 1, workers: 4 });
  const left = async (headers) => { let n = 0; while ((await post(s.base, '/api/analyze/SKL', { hex: HEX }, headers)).status === 200) n++; return n; };
  const mcp = (headers, name, args) => post(s.base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { ...headers, Accept: 'application/json, text/event-stream' });
  try {
    const ip = (k) => ({ 'CF-Connecting-IP': `203.0.113.${k}` });
    assert.equal(s.app.facade.compareLanes(['SKL', 'ZEN3', 'ICL']), 2);
    assert.equal(s.app.facade.compareLanes(undefined), 2);
    assert.equal(s.app.facade.compareLanes(['SKL', 'ZEN3']), 1, 'two microarchitectures: one job');
    assert.equal((await post(s.base, '/api/compare', { hex: HEX }, ip(30))).status, 200);
    assert.equal(await left(ip(30)), 28);
    assert.equal((await mcp(ip(31), 'compare_archs', { hex: HEX, archs: ['SKL', 'ZEN3', 'ICL'] })).status, 200);
    assert.equal(await left(ip(31)), 28);
    assert.equal((await post(s.base, '/api/compare', { hex: HEX, archs: ['SKL', 'ZEN3'] }, ip(32))).status, 200);
    assert.equal(await left(ip(32)), 29);
  } finally { await s.close(); }
});

test('server: a client out of tokens is refused before its body is read; an aborted request is logged once', async () => {
  const logs = [];
  const s = await start({ rateBurst: 2, ratePerMinute: 1, log: (o) => logs.push(o) });
  const { port } = new URL(s.base);
  // headers only, then nothing: the server answers without the body, or the request waits until the timeout below
  const headersOnly = (p, ip) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1000', 'CF-Connecting-IP': ip } });
    const timer = setTimeout(() => { req.destroy(); resolve(null); }, 1500);
    req.on('response', (res) => { clearTimeout(timer); res.resume(); res.on('end', () => { req.destroy(); resolve(res.statusCode); }); });
    req.on('error', (e) => { clearTimeout(timer); if (e.code === 'ECONNRESET') resolve(null); else reject(e); });
    req.flushHeaders();
  });
  const wait = async (until) => { for (let k = 0; k < 100 && !until(); k++) await new Promise((r) => setTimeout(r, 20)); };
  try {
    const A = '203.0.113.40';
    for (let i = 0; i < 2; i++) assert.equal((await post(s.base, '/api/analyze/SKL', { hex: HEX }, { 'CF-Connecting-IP': A })).status, 200);
    for (const p of ['/api/what-if/SKL', '/api/compare', '/api/diff/SKL', '/mcp']) assert.equal(await headersOnly(p, A), 429, p);
    // a client with tokens: its body is read (here it never comes: no answer)
    assert.equal(await headersOnly('/api/what-if/SKL', '203.0.113.41'), null);
    // every request one line: the aborted one with aborted and status 499, after the connection closed
    await wait(() => logs.length >= 7);
    assert.deepEqual(logs.map((l) => l.status), [200, 200, 429, 429, 429, 429, 499]);
    assert.equal(logs[6].aborted, true);
    assert.ok(logs.slice(0, 6).every((l) => l.aborted === undefined));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(logs.length, 7, 'one line per request');
    // a what-if aborted while it runs (64 offsets of ~20 ms each): logged once its work has stopped, with the jobs it ran
    const body = JSON.stringify({ hex: '48f7f1'.repeat(20), options: { minIterations: 200 }, variants: ['align'] });
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/what-if/SKL', method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.42' } });
      req.on('error', () => resolve(null));
      req.end(body);
      setTimeout(() => { req.destroy(); resolve(null); }, 150);
    });
    await wait(() => logs.length >= 8);
    const ab = logs[7];
    assert.equal(ab.status, 499);
    assert.equal(ab.aborted, true);
    assert.equal(ab.gone, true);
    assert.ok(ab.jobs >= 1 && ab.jobs < 65, JSON.stringify(ab));
  } finally { await s.close(); }
});

test('server: without trustCfHeader the socket address is the key', async () => {
  const s = await start({ rateBurst: 2, ratePerMinute: 1, trustCfHeader: false });
  try {
    assert.equal((await get(s.base, '/api/archs', { 'CF-Connecting-IP': '1.1.1.1' })).status, 200);
    assert.equal((await get(s.base, '/api/archs', { 'CF-Connecting-IP': '2.2.2.2' })).status, 200);
    assert.equal((await get(s.base, '/api/archs', { 'CF-Connecting-IP': '3.3.3.3' })).status, 429);
  } finally { await s.close(); }
});
