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
    // another client: its own bucket; a compare costs 2 tokens
    assert.equal((await post(s.base, '/api/compare', { hex: HEX, archs: ['SKL'] }, B)).status, 200);
    assert.equal((await post(s.base, '/api/compare', { hex: HEX, archs: ['SKL'] }, B)).status, 429);
    assert.equal((await post(s.base, '/api/analyze/SKL', { hex: HEX }, B)).status, 200);
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
