// A compare spread over the idle workers (lib/facade.js): the same response as the library's sequential compare, and
// one job when the workers are busy.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createWuica } from 'wuica';
import { start, post, HEX, ASM, plain } from './helpers.mjs';
import { PART_ARCHS } from '../lib/facade.js';

let s, w;
before(async () => { [s, w] = await Promise.all([start({ workers: 2 }), createWuica({ threads: 1 })]); });
after(() => s.close());

const jobs = () => s.app.pool.stats.jobs;
const BIG = { hex: '4801d84801c3c5fc100c87c4e27da80c86f3480fb80cc7'.repeat(40) + '49ffcf75f5' };

test('idle workers: a compare in parts, the same response as one after another', async () => {
  for (const req of [
    { hex: HEX }, BIG, { source: ASM, archs: ['adlp', 'SKL', 'K8', 'zen3', 'SKL', 'CLX_noLSD'] },
    { hex: HEX, archs: ['ICL', 'TGL', 'RKL'], options: { noMacroFusion: true, alignmentOffset: 7 } }, { hex: HEX, archs: [] },
  ]) {
    const n = jobs();
    const r = await post(s.base, '/api/compare', req);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, plain(await w.compare(req)), JSON.stringify(req).slice(0, 100));
    const archs = req.archs?.length ? req.archs.length : 15;
    assert.equal(jobs() - n, archs <= PART_ARCHS ? 1 : Math.ceil(archs / PART_ARCHS), 'parts');
  }
  // failures: the same as the library's (and as one job)
  for (const req of [{ source: 'frob' }, { hex: HEX, bogus: 1 }, { hex: 'zz' }]) {
    const r = await post(s.base, '/api/compare', req);
    assert.deepEqual(r.json, plain(await w.compare(req)), JSON.stringify(req));
  }
  assert.equal((await post(s.base, '/api/compare', { hex: HEX, archs: 'SKL' })).json.code, 1); // not split: one job
  // the instruction limit counts the whole block, whichever part
  assert.equal((await post(s.base, '/api/compare', { source: '.rept 10001\nnop\n.endr' })).status, 400);
  // the text form
  const t = await post(s.base, '/api/compare', { hex: HEX, archs: ['SKL', 'ZEN3'] }, { Accept: 'text/plain' });
  assert.match(t.text, /^SKL\s+Skylake/m);
  assert.match(t.text, /^ZEN3\s+AMD Zen 3/m);
});

test('a busy worker: the compare is one job', async () => {
  const n = jobs();
  const slow = post(s.base, '/api/analyze/SKL', { ...BIG, options: { minIterations: 1000, minCycles: 20000 } });
  while (s.app.pool.busy === 0) await new Promise((r) => setTimeout(r, 2)); // the analysis has a worker
  const r = await post(s.base, '/api/compare', { hex: HEX });
  const busyAfter = s.app.pool.busy;
  assert.deepEqual(r.json, plain(await w.compare({ hex: HEX })));
  assert.equal((await slow).json.code, 0);
  assert.equal(busyAfter, 1, 'the analysis took longer than the compare');
  assert.equal(jobs() - n, 2); // the analysis and the compare in one job
});

test('the parts share one time budget; splitCompare: false makes a compare one job', async () => {
  // a block whose compare takes far longer than the budget in total, and several times one part's share of it
  const heavy = { hex: '4801d84801c3c5fc100c87c4e27da80c86f3480fb80cc7'.repeat(200) + '49ffcf75f5', options: { minIterations: 400 } }; // a part: ~200 ms, all: ~1.6 s
  const t = await start({ workers: 2, timeoutMs: 400 });
  try {
    const t0 = performance.now();
    const r = await post(t.base, '/api/compare', heavy);
    const ms = performance.now() - t0;
    assert.equal(r.json.code, 3);
    assert.match(r.json.error, /took longer than 0\.4 s, the limit of this server/);
    assert.ok(ms < 400 * 2.5, `${ms} ms`); // one budget (and the start of the replaced worker), not one per part
  } finally { await t.close(); }
  const u = await start({ workers: 2, splitCompare: false });
  try {
    const n = u.app.pool.stats.jobs;
    const r = await post(u.base, '/api/compare', { hex: HEX });
    assert.deepEqual(r.json, plain(await w.compare({ hex: HEX })));
    assert.equal(u.app.pool.stats.jobs - n, 1);
  } finally { await u.close(); }
});
