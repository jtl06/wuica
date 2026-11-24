// The per-IP token bucket: unit behavior and through the server (CF-Connecting-IP, exemptions, compare cost, MCP).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../lib/ratelimit.js';
import { start, post, get, HEX } from './helpers.mjs';

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
    // what-if, the default variants: 11 analyses -> 3 tokens; with align: 1 + 64 -> 13; diff: 2 -> 1; compare of 5 -> 1
    assert.equal((await post(s.base, '/api/what-if/SKL', { hex: HEX }, ip(10))).status, 200);
    assert.equal(await left(ip(10)), 27);
    assert.equal((await post(s.base, '/api/what-if/SKL', { hex: HEX, variants: ['align'] }, ip(11))).status, 200);
    assert.equal(await left(ip(11)), 17);
    assert.equal((await post(s.base, '/api/diff/SKL', { a: { hex: HEX }, b: { hex: HEX } }, ip(12))).status, 200);
    assert.equal(await left(ip(12)), 29);
    assert.equal((await post(s.base, '/api/compare', { hex: HEX, archs: ['SKL', 'ZEN3', 'ICL', 'HSW', 'SNB'] }, ip(13))).status, 200);
    assert.equal(await left(ip(13)), 29);
    // /mcp: the same costs
    assert.equal((await mcp(ip(20), 'what_if', { hex: HEX, variants: ['align'] })).status, 200);
    assert.equal(await left(ip(20)), 17);
    assert.equal((await mcp(ip(21), 'diff_blocks', { a: { hex: HEX }, b: { hex: HEX } })).status, 200);
    assert.equal(await left(ip(21)), 29);
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
