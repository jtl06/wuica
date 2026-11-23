// Traps, timeouts, memory limits, a full queue, concurrent load and shutdown: the server must keep serving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWuica } from 'wuica';
import http from 'node:http';
import { start, post, postHttp, get, HEX, ASM, TRAP, plain, fixtureSources, rest } from './helpers.mjs';

const HEAVY = { hex: '4801d8'.repeat(3000), options: { minIterations: 1000 } }; // seconds and GBs of analyzer memory

const w = await createWuica();

test('trap input (caps raised so that it reaches the analyzer): code 3, and the server keeps serving', async () => {
  const s = await start({ workers: 1, maxMinIterations: 10_000, maxMinCycles: 100_000 });
  try {
    const before = await post(s.base, '/api/analyze/ZEN3', { hex: HEX });
    const r = await post(s.base, '/api/analyze/SKL', TRAP);
    assert.equal(r.status, 200);
    assert.equal(r.json.code, 3);
    assert.equal(typeof r.json.error, 'string');
    assert.ok(r.json.trapped || r.json.timedOut, JSON.stringify(r.json));
    for (const arch of ['SKL', 'ZEN3']) {
      const ok = await post(s.base, `/api/analyze/${arch}`, { hex: HEX });
      assert.equal(ok.json.code, 0);
    }
    assert.deepEqual((await post(s.base, '/api/analyze/ZEN3', { hex: HEX })).json, before.json);
    assert.equal((await get(s.base, '/healthz')).json.ready, 1);
  } finally { await s.close(); }
});

test('a job over the time budget: code 3 timedOut, the worker is replaced, the server keeps serving', async () => {
  const s = await start({ workers: 1, timeoutMs: 300 });
  try {
    const t0 = performance.now();
    const r = await post(s.base, '/api/analyze/SKL', HEAVY);
    assert.ok(performance.now() - t0 < 1500, 'answered at the deadline');
    assert.equal(r.status, 200);
    assert.equal(r.json.code, 3);
    assert.equal(r.json.timedOut, true);
    assert.match(r.json.error, /longer than 0\.3 s/);
    assert.equal(s.app.pool.stats.timeouts, 1);
    // queued behind the replacement worker's start-up, then answered
    const ok = await post(s.base, '/api/analyze/SKL', { hex: HEX });
    assert.deepEqual(ok.json, rest(await w.analyze('SKL', { hex: HEX })));
    assert.equal((await get(s.base, '/healthz')).json.ready, 1);
  } finally { await s.close(); }
});

test('the analyzer\'s memory limit turns a huge simulation into a trap; grown workers are recycled', async () => {
  const s = await start({ workers: 1, analyzerMemoryMb: 192, recycleMemoryMb: 16 });
  try {
    const r = await post(s.base, '/api/analyze/SKL', HEAVY);
    assert.equal(r.json.code, 3);
    assert.equal(r.json.trapped, true);
    // a moderately large block grows the analyzer by more than 16 MB: answered, then the worker is replaced
    const mid = { hex: '4801d8'.repeat(300), options: { minIterations: 200 } };
    const m = await post(s.base, '/api/analyze/SKL', mid);
    assert.equal(m.json.code, 0);
    assert.deepEqual(m.json, rest(await w.analyze('SKL', mid)));
    assert.ok(s.app.pool.stats.recycled >= 1, JSON.stringify(s.app.pool.stats));
    assert.equal((await post(s.base, '/api/analyze/SKL', { hex: HEX })).json.code, 0);
  } finally { await s.close(); }
});

test('a compare that traps on every microarchitecture holds one capped analyzer memory at a time', async () => {
  const s = await start({ workers: 1, analyzerMemoryMb: 256, timeoutMs: 60_000 });
  try {
    const base = process.memoryUsage.rss();
    let peak = base;
    const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 5);
    const r = await post(s.base, '/api/compare', HEAVY);
    clearInterval(iv);
    assert.equal(r.json.code, 0);
    assert.equal(r.json.results.length, 15);
    for (const row of r.json.results) {
      assert.equal(row.code, 3, row.arch);
      assert.match(row.error, /trapped/, row.arch); // each microarchitecture ran (on a fresh instance) and trapped
    }
    // without the forced GC, the 15 dropped instances add up to ~2 GB
    assert.ok(peak - base < 768 * 2 ** 20, `peak ${Math.round((peak - base) / 2 ** 20)} MB above the start`);
    assert.equal((await post(s.base, '/api/analyze/SKL', { hex: HEX })).json.code, 0);
  } finally { await s.close(); }
});

test('200 parallel requests: all answered, equal to the library', async () => {
  const s = await start({ workers: 4, maxQueue: 1000 });
  try {
    const archs = w.archs().map((a) => a.id);
    const fx = fixtureSources();
    const reqs = Array.from({ length: 200 }, (_, i) => {
      const arch = archs[i % archs.length];
      if (i % 10 === 9) return { path: '/api/compare', body: { hex: HEX, archs: [arch, 'SKL'] }, lib: () => w.compare({ hex: HEX, archs: [arch, 'SKL'] }) };
      if (i % 10 === 8) return { path: '/api/assemble', body: { source: fx[i % fx.length].source }, lib: () => w.assemble(fx[i % fx.length].source) };
      const body = i % 3 === 0 ? { hex: HEX } : i % 3 === 1 ? { source: ASM } : { source: fx[i % fx.length].source };
      return { path: `/api/analyze/${arch}`, body, lib: () => w.analyze(arch, body) };
    });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });
    const results = await Promise.all(reqs.map((r) => postHttp(agent, s.base, r.path, r.body)));
    agent.destroy();
    for (let i = 0; i < reqs.length; i++) {
      assert.equal(results[i].status, 200, `${i}: ${results[i].text.slice(0, 200)}`);
      const lib = await reqs[i].lib();
      assert.deepEqual(results[i].json, reqs[i].path.startsWith('/api/analyze/') ? rest(lib) : plain(lib), `request ${i}`);
    }
  } finally { await s.close(); }
});

test('full queue: 503 with Retry-After; the rest are answered', async () => {
  const s = await start({ workers: 1, maxQueue: 2 });
  try {
    const mid = { hex: '4801d8'.repeat(300), options: { minIterations: 300 } };
    const results = await Promise.all(Array.from({ length: 8 }, () => post(s.base, '/api/analyze/SKL', mid)));
    const busy = results.filter((r) => r.status === 503);
    const ok = results.filter((r) => r.status === 200);
    assert.ok(busy.length >= 1, results.map((r) => r.status).join(','));
    assert.ok(ok.length >= 3);
    assert.ok(Number(busy[0].headers.get('retry-after')) >= 1);
    assert.equal(busy[0].json.code, 1);
    assert.match(busy[0].json.error, /busy/);
    assert.ok(ok.every((r) => r.json.code === 0));
    assert.equal((await post(s.base, '/api/analyze/SKL', { hex: HEX })).status, 200);
  } finally { await s.close(); }
});

test('graceful shutdown: a running request is answered, then the server stops', async () => {
  const s = await start({ workers: 1 });
  const slow = post(s.base, '/api/analyze/SKL', { hex: '4801d8'.repeat(300), options: { minIterations: 1000 } });
  await new Promise((r) => setTimeout(r, 50));
  const closing = s.app.close(5000);
  const r = await slow;
  assert.equal(r.status, 200);
  assert.equal(r.json.code, 0);
  await closing;
  await assert.rejects(fetch(s.base + '/healthz'));
});
