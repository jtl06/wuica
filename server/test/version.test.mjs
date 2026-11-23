// The component versions reported by /api/version are constants (the deployed server has no repository docs); check
// them against the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { COMPONENTS, versionInfo } from '../lib/version.js';
import { capMemory } from '../lib/wasm-limits.js';
import { ROOT } from './helpers.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('version constants match the repository', () => {
  assert.match(read('docs/DESIGN.md'), new RegExp(`commit\\s+\`${COMPONENTS.uiCA.commit}\``));
  assert.ok(read('third_party/xed/README.md').includes(`\`${COMPONENTS.xed}\``));
  assert.ok(read('packages/wuica/README.md').includes(`LLVM ${COMPONENTS.llvm}`));
  assert.ok(fs.existsSync(path.join(ROOT, `assembler/llvm-${COMPONENTS.llvm}-wasi.patch`)));
  const v = versionInfo();
  assert.equal(v.wuica, JSON.parse(read('packages/wuica/package.json')).version);
});

test('capMemory sets a maximum on a module without one and lowers a larger one', async () => {
  // (module (memory 2)) and (module (memory 2 100)), with an exported memory
  const noMax = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 2, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0]);
  const withMax = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 1, 2, 100, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0]);
  for (const [bytes, cap, expected] of [[noMax, 16, 16], [withMax, 16, 16], [withMax, 1000, 100], [noMax, 1, 2]]) {
    const inst = new WebAssembly.Instance(await WebAssembly.compile(capMemory(bytes, cap)), {});
    const mem = inst.exports.memory;
    assert.equal(mem.buffer.byteLength, 2 * 65536);
    let pages = 2;
    while (true) { try { mem.grow(1); pages++; } catch { break; } }
    assert.equal(pages, expected, `cap ${cap}`);
  }
});
