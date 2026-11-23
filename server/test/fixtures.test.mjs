// The server's results equal the npm library's for the assembly fixtures of the repository (fixtures/extra-src), on a
// sample of microarchitectures, as JSON and as text, and in compare.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createWuica } from 'wuica';
import http from 'node:http';
import { start, post, postHttp, plain, fixtureSources } from './helpers.mjs';

let s, w;
before(async () => { [s, w] = await Promise.all([start({ workers: 4, maxQueue: 1000 }), createWuica()]); });
after(() => s.close());

const fx = fixtureSources();
const ARCHS = ['SKL', 'ICL', 'ZEN3', 'ADL-P', 'HSW'];

test(`${fx.length} fixtures, each on 2 of ${ARCHS.join("/")}: analyze JSON equal to the library`, async () => {
  assert.ok(fx.length >= 50);
  const jobs = fx.flatMap((f, i) => [ARCHS[i % ARCHS.length], ARCHS[(i + 2) % ARCHS.length]].map((arch) => ({ f, arch })));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const got = await Promise.all(jobs.map(({ f, arch }) => postHttp(agent, s.base, `/api/analyze/${arch}`, { source: f.source })));
  agent.destroy();
  for (let i = 0; i < jobs.length; i++) {
    const { f, arch } = jobs[i];
    const lib = plain(await w.analyze(arch, { source: f.source }));
    assert.equal(got[i].status, lib.code === 1 ? 400 : 200, `${f.name} ${arch}`);
    assert.deepEqual(got[i].json, lib, `${f.name} ${arch}`);
  }
});

test('fixtures: text report and compare equal to the library', async () => {
  for (const f of fx.slice(0, 12)) {
    const t = await post(s.base, '/api/analyze/SKL', { source: f.source }, { Accept: 'text/plain' });
    const lib = await w.analyze('SKL', { source: f.source });
    if (lib.code === 0) assert.equal(t.text, lib.text, f.name);
    const c = await post(s.base, '/api/compare', { source: f.source });
    assert.deepEqual(c.json, plain(await w.compare({ source: f.source })), f.name);
  }
});
