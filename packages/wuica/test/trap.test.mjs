// An input on which the analyzer traps (docs/WASM-API.md, "Failures and traps"): the call must return an error and
// the next call must work (the module is re-instantiated and its tables reloaded). If the module later returns an
// error for this input instead of trapping, the test still passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWuica } from '../lib/index.js';

const TRAP = { hex: '48f7f1'.repeat(200), options: { minIterations: 10000, minCycles: 100000 } };
const HEX = '4801d84801c349ffcf75f5';

test('trap recovery', async () => {
  const w = await createWuica();
  const before = await w.analyze('ZEN3', { hex: HEX });
  assert.equal(before.error, undefined);

  const r = await w.analyze('SKL', TRAP);
  assert.equal(r.code, 3);
  assert.equal(typeof r.error, 'string');
  if (r.trapped) assert.equal(w.restarts, 0); // restarted lazily, on the next call
  if (r.trapped) assert.match(r.error, /trapped: unreachable: out of memory, \d\.\d GB in use/); // it runs out of memory

  for (const arch of ['SKL', 'ZEN3']) { // ZEN3 was loaded before the trap and must be loaded again
    const ok = await w.analyze(arch, { hex: HEX });
    assert.equal(ok.code, 0, arch);
    assert.equal(ok.tp, before.tp);
  }
  if (r.trapped) assert.equal(w.restarts, 1);
  assert.equal((await w.analyze('ADL-P', { hex: HEX })).error, undefined);
});

test('assembler trap recovery (out of memory)', async () => {
  const w = await createWuica();
  const r = await w.assemble('.fill 400000000, 1, 0\n');
  assert.notEqual(r.code, 0);
  assert.equal(typeof r.error, 'string');
  const ok = await w.assemble('nop');
  assert.equal(ok.code, 0);
  assert.equal(ok.hex, '90');
  assert.equal((await w.analyze('SKL', { source: 'add rax, rbx' })).code, 0);
});
