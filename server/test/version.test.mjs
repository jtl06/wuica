// The component versions reported by /api/version are constants (the deployed server has no repository docs); check
// them against the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { COMPONENTS, versionInfo } from '../lib/version.js';
import { capMemory } from '../lib/wasm-limits.js';
import { ROOT } from './helpers.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('version constants match the repository', () => {
  assert.ok(read('third_party/xed/README.md').includes(`\`${COMPONENTS.xed}\``));
  assert.ok(read('packages/wuica/README.md').includes(`LLVM ${COMPONENTS.llvm}`));
  assert.ok(fs.existsSync(path.join(ROOT, `assembler/llvm-${COMPONENTS.llvm}-wasi.patch`)));
  const v = versionInfo();
  assert.equal(v.wuica, JSON.parse(read('packages/wuica/package.json')).version);
});

test('the uiCA commit is the data asset\'s (ci/data-asset.txt, through the package\'s dist/manifest.json; the CLI\'s --version -json)', () => {
  const m = /^uica_commit=([0-9a-f]+)(?:\s+\(([^)]+)\))?/m.exec(read('ci/data-asset.txt'));
  const want = { repository: 'https://github.com/jtl06/uiCA', commit: m[1], branch: m[2] };
  assert.deepEqual(versionInfo().uiCA, want);
  const cli = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'packages/wuica/bin/wuica.js'), '--version', '-json'], { encoding: 'utf8' }));
  assert.deepEqual(cli.uiCA, want);
});

test('the data hash names the JSON tables the shipped binary ones were made from', () => {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const names = fs.readdirSync(path.join(ROOT, 'data/arch')).filter((f) => f.endsWith('.json')).sort();
  const want = sha(names.map((f) => `${f} ${sha(fs.readFileSync(path.join(ROOT, 'data/arch', f)))}\n`).join(''));
  const v = versionInfo();
  assert.equal(v.data.tablesSha256, want);
  assert.equal(v.data.tablesFormat, 'WUICATBL 1');
  assert.match(v.data.uarchSha256, /^[0-9a-f]{64}$/);
});

test('the server and the library have the site\'s version (web/js/app.js; tests-js/web_version.mjs)', () => {
  const site = /^const VERSION = '([^']+)';/m.exec(read('web/js/app.js'))[1];
  const v = versionInfo();
  assert.equal(v.wuica, site);
  assert.equal(v.server, site);
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
