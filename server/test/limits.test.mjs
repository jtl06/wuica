// Per-request limits: body, source, instructions, simulation options, compare.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start, post, HEX, TRAP } from './helpers.mjs';
import { createWuica, whatIfText } from 'wuica';
import { Facade } from '../lib/facade.js';
import { resolveConfig } from '../lib/config.js';
import { timeoutFailure } from '../lib/pool.js';

let s;
before(async () => { s = await start(); });
after(() => s.close());

test('body larger than 256 KB: 413 (declared length and chunked)', async () => {
  const big = JSON.stringify({ source: 'nop\n'.repeat(70_000) });
  assert.ok(big.length > 256 * 1024);
  const r = await post(s.base, '/api/analyze/SKL', big);
  assert.equal(r.status, 413);
  assert.equal(r.json.code, 1);
  assert.match(r.json.error, /256 KB/);
  // chunked (no Content-Length)
  const status = await new Promise((resolve, reject) => {
    const u = new URL(s.base + '/api/analyze/SKL');
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    for (let i = 0; i < 40; i++) req.write('x'.repeat(8192));
    req.end();
  });
  assert.equal(status, 413);
  // also on /mcp
  assert.equal((await post(s.base, '/mcp', big, { Accept: 'application/json, text/event-stream' })).status, 413);
});

test('source larger than 64 KB, hex longer than 64 K characters: 413', async () => {
  const r = await post(s.base, '/api/analyze/SKL', { source: 'nop\n'.repeat(17_000) });
  assert.equal(r.status, 413);
  assert.equal(r.json.code, 1);
  assert.match(r.json.error, /`source` is larger than 64 KB/);
  assert.equal((await post(s.base, '/api/analyze/SKL', { hex: '90'.repeat(33_000) })).status, 413);
  assert.equal((await post(s.base, '/api/assemble', { source: 'nop\n'.repeat(17_000) })).status, 413);
  assert.equal((await post(s.base, '/api/compare', { source: 'nop\n'.repeat(17_000) })).status, 413);
});

test('more than 10,000 instructions: 400', async () => {
  // hex: 10,001 one-byte instructions
  const h = await post(s.base, '/api/analyze/SKL', { hex: '90'.repeat(10_001) });
  assert.equal(h.status, 400);
  assert.equal(h.json.code, 1);
  assert.match(h.json.error, /too many instructions: 10001/);
  // exactly 10,000: accepted
  const ok = await post(s.base, '/api/analyze/SKL', { hex: '90'.repeat(10_000) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.code, 0);
  // 3,334 three-byte instructions (> 10,000 bytes, decoded and counted): accepted
  assert.equal((await post(s.base, '/api/analyze/SKL', { hex: '4801d8'.repeat(3334) })).json.code, 0);
  // assembly that expands (.rept), small source
  const rept = await post(s.base, '/api/analyze/SKL', { source: '.rept 20000\nadd rax, rbx\n.endr\n' });
  assert.equal(rept.status, 400);
  assert.match(rept.json.error, /too many instructions: 20000/);
  // GNU as's {load} hint is removed at the start of a line, before the directive
  const hinted = await post(s.base, '/api/analyze/SKL', { source: '{load}.rept 20000\nnop\n{load}.endr\n' });
  assert.equal(hinted.status, 400, hinted.text.slice(0, 200));
  assert.match(hinted.json.error, /too many instructions: 20000/);
  // expands to more than 15 bytes per allowed instruction: refused without decoding
  const fill = await post(s.base, '/api/analyze/SKL', { source: '.fill 200000, 1, 0x90\n' });
  assert.equal(fill.status, 400);
  assert.match(fill.json.error, /too many instructions: 200000 bytes of machine code/);
  // compare too
  assert.equal((await post(s.base, '/api/compare', { source: '.rept 10001\nnop\n.endr' })).status, 400);
  // MCP: a tool error
  const m = await mcpCall('analyze', { arch: 'SKL', hex: '90'.repeat(10_001) });
  assert.equal(m.result.isError, true);
  assert.match(m.result.content[0].text, /too many instructions/);
});

test('minIterations / minCycles above the caps: 400 (not clamped)', async () => {
  for (const options of [{ minIterations: 1001 }, { minCycles: 20_001 }, TRAP.options]) {
    const r = await post(s.base, '/api/analyze/SKL', { hex: HEX, options });
    assert.equal(r.status, 400, JSON.stringify(options));
    assert.equal(r.json.code, 1);
    assert.match(r.json.error, /the limit of this server is (1000|20000)/);
  }
  // at the caps: accepted
  const ok = await post(s.base, '/api/analyze/SKL', { hex: HEX, options: { minIterations: 1000, minCycles: 20_000 } });
  assert.equal(ok.json.code, 0);
  // compare and MCP use the same caps
  assert.equal((await post(s.base, '/api/compare', { hex: HEX, options: { minCycles: 50_000 } })).status, 400);
  const m = await mcpCall('analyze', { arch: 'SKL', hex: HEX, options: { minIterations: 5000 } });
  assert.equal(m.result.isError, true);
  assert.match(m.result.content[0].text, /minIterations/);
});

test('the trap input of the package\'s tests is refused by the caps', async () => {
  const r = await post(s.base, '/api/analyze/SKL', TRAP);
  assert.equal(r.status, 400);
  assert.equal((await post(s.base, '/api/analyze/SKL', { hex: HEX })).json.code, 0);
});

test('compare: at most all listed microarchitectures', async () => {
  const r = await post(s.base, '/api/compare', { hex: HEX, archs: Array(16).fill('SKL') });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /at most 15/);
  assert.equal((await post(s.base, '/api/compare', { hex: HEX, archs: Array(15).fill('SKL') })).json.code, 0);
});

async function mcpCall(name, args) {
  const r = await post(s.base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { Accept: 'application/json, text/event-stream' });
  assert.equal(r.status, 200);
  return r.json;
}

test('what-if and diff: the server\'s caps, nothing started for a client that has gone, a base that cannot finish', async () => {
  const s = await start({ timeoutMs: 300, workers: 1 });
  try {
    // the caps apply to every analysis of what-if and to both blocks of a diff (checked before either is analyzed)
    const capped = await post(s.base, '/api/what-if/SKL', { hex: HEX, options: { minCycles: 30000 } });
    assert.equal(capped.status, 400);
    const b = await post(s.base, '/api/diff/SKL', { a: { hex: 'zz' }, b: { hex: HEX, options: { minIterations: 5000 } } });
    assert.equal(b.status, 400);
    assert.match(b.json.error, /^B: `options.minIterations` is 5000/);
    // the options both blocks share: the request's, no block named
    const o = await post(s.base, '/api/diff/SKL', { a: { hex: HEX }, b: { hex: HEX }, options: { minCycles: 50000 } });
    assert.equal(o.status, 400);
    assert.equal(o.json.error, '`options.minCycles` is 50000; the limit of this server is 20000');
    const ob = await post(s.base, '/api/diff/SKL', { a: { hex: HEX }, b: { hex: HEX, options: { minCycles: 50000 } }, options: { minCycles: 100 } });
    assert.equal(ob.json.error, 'B: `options.minCycles` is 50000; the limit of this server is 20000');
    // through REST, a base that cannot finish within 300 ms on any machine (2000 divisions, 1000 iterations: seconds;
    // a loaded machine is only slower): the failure, for what-if and for diff
    const HUGE = { hex: '48f7f1'.repeat(2000), options: { minIterations: 1000 } };
    const f = await post(s.base, '/api/what-if/SKL', { ...HUGE, variants: ['simpleFrontEnd'] });
    assert.equal(f.json.code, 3);
    assert.equal(f.json.error, 'the what-if took longer than 0.3 s, the limit of this server for all its analyses');
    assert.equal(f.json.notRun, undefined);
    const d = await post(s.base, '/api/diff/SKL', { a: HUGE, b: { hex: HEX } });
    assert.equal(d.json.code, 3);
    assert.equal(d.json.error, 'the diff took longer than 0.3 s, the limit of this server for all its analyses: neither block was analyzed');
    // a client that has gone: no job is started
    const ctx = { gone: true };
    const g = await s.app.facade.whatIf('SKL', { hex: HEX }, ctx);
    assert.equal(g.code, 1);
    assert.equal(ctx.jobs, 0);
  } finally { await s.close(); }
});

// A Facade on a clock of its own and a pool that runs each job on the main thread and takes exactly 10 ms of that clock
// (a job given less than that times out, as the worker pool's would): every state of the one deadline, the same on any
// machine.
async function clocked(timeoutMs) {
  const local = await createWuica({ threads: 1 });
  const clock = { t: 0 };
  const pool = {
    size: 1, idle: 1, queued: 0,
    async run(op, args, { timeoutMs: left }) {
      if (left < 10) { clock.t += left; return { result: timeoutFailure(timeoutMs), timedOut: true, queueMs: 0, runMs: left, meta: {} }; }
      clock.t += 10;
      const result = op === 'analyze' ? await local.analyze(args.arch, args.req) : await local.assemble(args.source, args.syntax);
      return { result, queueMs: 0, runMs: 10, meta: {} };
    },
  };
  return new Facade(local, pool, { ...resolveConfig({ timeoutMs }), now: () => clock.t });
}

test('what-if and diff: one deadline for all their analyses, in each state (a clock of the test\'s own)', async () => {
  const req = { hex: HEX, variants: ['unroll2', 'simpleFrontEnd', 'align'] };
  // the deadline before the base has finished: the failure; nothing more started
  let ctx = {};
  const f = /** @type {any} */ (await (await clocked(5)).whatIf('SKL', req, ctx));
  assert.equal(f.code, 3);
  assert.equal(f.error, 'the what-if took longer than 0.005 s, the limit of this server for all its analyses');
  assert.equal(f.notRun, undefined);
  assert.equal(ctx.jobs, 1);
  assert.equal(ctx.timedOut, true);
  // between variants: the base and unroll2 (20 ms) finish, the deadline has passed before simpleFrontEnd starts
  ctx = {};
  const m = /** @type {any} */ (await (await clocked(20)).whatIf('SKL', req, ctx));
  assert.equal(m.code, 0);
  assert.equal(m.notRun, 'deadline');
  assert.equal(ctx.jobs, 2);
  assert.ok(m.variants[0].tp > 0 && m.variants[0].id === 'unroll2');
  assert.deepEqual(m.variants.slice(1).map((v) => [v.id, v.error]), [['simpleFrontEnd', 'not run: deadline'], ['align', 'not run: deadline']]);
  assert.deepEqual(m.stderr.map((l) => l.text), ['Warning: 2 of 3 variant(s) not run: deadline']);
  const mt = whatIfText(m);
  assert.match(mt, /^ {2}simple front end +- {2}not run: deadline$/m);
  assert.match(mt, /^ {2}alignment 0-63 +- {2}not run: deadline$/m);
  assert.match(mt, /^ {2}warning: 2 of 3 variant\(s\) not run: deadline$/m);
  // inside align: the base, unroll2, simpleFrontEnd and offsets 0-4 finish (80 ms), offset 5 gets 5 ms and times out
  ctx = {};
  const a = /** @type {any} */ (await (await clocked(85)).whatIf('SKL', req, ctx));
  assert.equal(a.code, 0);
  assert.equal(a.notRun, 'deadline');
  assert.equal(ctx.jobs, 9);
  assert.ok(a.variants.slice(0, 2).every((v) => v.tp > 0), JSON.stringify(a.variants));
  assert.equal(a.variants[2].error, 'not run: deadline (5 of the 64 offsets analyzed)');
  assert.deepEqual(a.stderr.map((l) => l.text), ['Warning: 1 of 3 variant(s) not run: deadline']);
  const at = whatIfText(a);
  assert.match(at, /^ {2}alignment 0-63 +- {2}not run: deadline \(5 of the 64 offsets analyzed\)$/m);
  assert.match(at, /^ {2}warning: 1 of 3 variant\(s\) not run: deadline$/m);
  // all within the budget: no notRun
  const ok = /** @type {any} */ (await (await clocked(10 * 67)).whatIf('SKL', req, {}));
  assert.equal(ok.notRun, undefined);
  assert.ok(ok.variants.every((v) => v.error === undefined), JSON.stringify(ok.variants));
  // diff: a deadline is a failure, which says how far it got
  const two = { a: { hex: HEX }, b: { hex: HEX } };
  ctx = {};
  const d = (await (await clocked(15)).diff('SKL', two, ctx)).failure;
  assert.equal(d.code, 3);
  assert.equal(d.error, 'the diff took longer than 0.015 s, the limit of this server for all its analyses: A was analyzed, B was not');
  assert.equal(ctx.jobs, 2);
  const d2 = (await (await clocked(5)).diff('SKL', two, {})).failure;
  assert.equal(d2.error, 'the diff took longer than 0.005 s, the limit of this server for all its analyses: neither block was analyzed');
  const d3 = await (await clocked(20)).diff('SKL', two, {});
  assert.equal(d3.result.code, 0);
});
