// The per-IP token bucket: unit behavior and through the server (CF-Connecting-IP, exemptions, compare cost, MCP).
import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { RateLimiter } from '../lib/ratelimit.js';
import { start, post, get, HEX } from './helpers.mjs';
import { WHAT_IF_VARIANTS } from 'wuica';

// a refill so slow that no token comes back while a test runs, however slow the machine
const NO_REFILL = 1e-9;

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
  const s = await start({ rateBurst: 3, ratePerMinute: NO_REFILL, compareCost: 2 });
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
  const s = await start({ rateBurst: 30, ratePerMinute: NO_REFILL, compareCost: 3 });
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
    // a batch costs the sum of its calls: 2 what_if align (13 each) 26; 3 of them (39) more than the burst (30): refused,
    // nothing taken
    const call = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'what_if', arguments: { hex: HEX, variants: ['align'] } } });
    const batch = (headers, n) => post(s.base, '/mcp', Array.from({ length: n }, (_, k) => call(k + 1)), { ...headers, Accept: 'application/json, text/event-stream' });
    assert.equal((await batch(ip(23), 2)).status, 200);
    assert.equal(await left(ip(23)), 4);
    const big = await batch(ip(24), 3);
    assert.equal(big.status, 400);
    assert.equal(big.json.error.message, 'this batch costs 39 tokens, more than the 30 a client can have at once: send its calls in smaller batches');
    assert.equal(await left(ip(24)), 30);
  } finally { await s.close(); }
});

test('server: a compare costs at least one token per job it can run at once', async () => {
  // 4 workers: a split compare runs up to 2 parts at once; compareCost 1
  const s = await start({ rateBurst: 30, ratePerMinute: NO_REFILL, compareCost: 1, workers: 4 });
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
  const all = [];
  const s = await start({ rateBurst: 2, ratePerMinute: NO_REFILL, log: (o) => all.push(o) });
  const logs = { get length() { return all.filter((l) => l.method).length; } };
  const lines = () => all.filter((l) => l.method); // the requests' lines (the pool logs its workers too)
  const { port } = new URL(s.base);
  // (no wall clock: each step waits for an event of the server, at most 60 s)
  const until = async (cond) => { for (let k = 0; k < 6000 && !cond(); k++) await new Promise((r) => setTimeout(r, 10)); assert.ok(cond(), 'waited 60 s'); };
  const received = () => new Promise((resolve) => s.app.server.once('request', () => resolve(null)));
  // headers only: the server's answer (it needs no body), or null when the request is dropped once the server has it
  const headersOnly = (p, ip, { drop = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1000', 'CF-Connecting-IP': ip } });
    if (drop) received().then(() => setImmediate(() => { req.destroy(); resolve(null); }));
    req.on('response', (res) => { res.resume(); res.on('end', () => { req.destroy(); resolve(res.statusCode); }); });
    req.on('error', (e) => { if (e.code === 'ECONNRESET') resolve(null); else reject(e); });
    req.flushHeaders();
  });
  try {
    const A = '203.0.113.40';
    for (let i = 0; i < 2; i++) assert.equal((await post(s.base, '/api/analyze/SKL', { hex: HEX }, { 'CF-Connecting-IP': A })).status, 200);
    for (const p of ['/api/what-if/SKL', '/api/compare', '/api/diff/SKL', '/mcp']) assert.equal(await headersOnly(p, A), 429, p);
    // a client with tokens: its body is read (here it never comes, and the client goes)
    assert.equal(await headersOnly('/api/what-if/SKL', '203.0.113.41', { drop: true }), null);
    // every request one line: the aborted one with aborted and status 499, after the connection closed
    await until(() => logs.length >= 7);
    assert.deepEqual(lines().map((l) => l.status), [200, 200, 429, 429, 429, 429, 499]);
    assert.equal(lines()[6].aborted, true);
    assert.equal(lines()[6].error, undefined, 'a body cut off is no server error');
    assert.ok(lines().slice(0, 6).every((l) => l.aborted === undefined));
    // a what-if aborted while a job of it runs (each job ~300 ms on an M-series Mac, 65 of them): logged once its work
    // has stopped, with the jobs it ran; the client goes once a worker has the job
    const body = JSON.stringify({ hex: '48f7f1'.repeat(200), options: { minIterations: 200 }, variants: ['align'] });
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/what-if/SKL', method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.42' } });
      req.on('error', () => resolve(null));
      req.end(body);
      until(() => s.app.pool.busy > 0).then(() => { req.destroy(); resolve(null); });
    });
    await until(() => logs.length >= 8);
    const ab = lines()[7];
    assert.equal(ab.status, 499);
    assert.equal(ab.aborted, true);
    assert.equal(ab.gone, true);
    assert.ok(ab.jobs >= 1 && ab.jobs < 65, JSON.stringify(ab));
    // one line each: the next request's line is the ninth
    assert.equal((await post(s.base, '/api/version', undefined, { 'CF-Connecting-IP': '203.0.113.43' })).status, 405);
    await until(() => logs.length >= 9);
    assert.equal(logs.length, 9);
    assert.equal(lines()[8].path, '/api/version');
  } finally { await s.close(); }
});

test('server: without trustCfHeader the socket address is the key', async () => {
  const s = await start({ rateBurst: 2, ratePerMinute: NO_REFILL, trustCfHeader: false });
  try {
    assert.equal((await get(s.base, '/api/archs', { 'CF-Connecting-IP': '1.1.1.1' })).status, 200);
    assert.equal((await get(s.base, '/api/archs', { 'CF-Connecting-IP': '2.2.2.2' })).status, 200);
    assert.equal((await get(s.base, '/api/archs', { 'CF-Connecting-IP': '3.3.3.3' })).status, 429);
  } finally { await s.close(); }
});
