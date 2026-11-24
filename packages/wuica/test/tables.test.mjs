// The package ships the instruction tables in their binary form (dist/data/arch/<NAME>.bin.br, made by build.sh with
// tools/encode-tables.sh): every CPU gives the same analysis with them as with the JSON tables (a dataDir of
// data/arch/*.json); a binary table of another format version is an error that says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createWuica, examples } from '../lib/index.js';
import { isBinaryTable } from '../lib/wasm.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DIR, '../..');

test('the shipped tables are binary, and every CPU analyzes as with the JSON tables', async () => {
  const names = fs.readdirSync(path.join(DIR, 'dist/data/arch')).sort();
  assert.ok(names.length >= 15 && names.every((n) => n.endsWith('.bin.br')), names.join());
  assert.ok(isBinaryTable(zlib.brotliDecompressSync(fs.readFileSync(path.join(DIR, 'dist/data/arch', names[0])))));
  const bin = await createWuica({ threads: 1 });
  const json = await createWuica({ threads: 1, dataDir: path.join(ROOT, 'data') });
  const blocks = examples().filter((e) => e.group !== 'showcase').map((e) => e.hex);
  for (const { id } of bin.archs('id')) {
    for (const hex of blocks) {
      const [a, b] = [await bin.analyze(id, { hex }), await json.analyze(id, { hex })];
      assert.deepEqual(a, b, `${id} ${hex}`);
    }
  }
});

test('a binary table of another format version: a clear error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuica-tables-'));
  fs.mkdirSync(path.join(dir, 'arch'));
  fs.copyFileSync(path.join(ROOT, 'data/uarch.json'), path.join(dir, 'uarch.json'));
  const b = new Uint8Array(zlib.brotliDecompressSync(fs.readFileSync(path.join(DIR, 'dist/data/arch/SKL.bin.br'))));
  b[8] = 99; // the version
  fs.writeFileSync(path.join(dir, 'arch/SKL.bin'), b);
  const w = await createWuica({ dataDir: dir, threads: 1 });
  const r = await w.analyze('SKL', { hex: '4801d8' });
  assert.equal(r.code, 3);
  assert.match(r.error, /format version 99; this analyzer reads version 1 \(rebuild the tables\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});
