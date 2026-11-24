// The instruction tables for the suites that load the analyzer themselves: the binary form, as the site and the npm
// package ship it (the module reads no JSON tables): web/dist/data/arch/<NAME>.bin.gz (web/build.sh), else
// packages/wuica/dist/data/arch/<NAME>.bin.br (packages/wuica/build.sh).
//   import { tableBytes } from './tables.mjs';   engine.loadArch(name, tableBytes(name))
import fs from 'node:fs';
import zlib from 'node:zlib';

const root = new URL('../', import.meta.url);

export function tableBytes(name) {
  const site = new URL(`web/dist/data/arch/${name}.bin.gz`, root);
  if (fs.existsSync(site)) return new Uint8Array(zlib.gunzipSync(fs.readFileSync(site)));
  const pkg = new URL(`packages/wuica/dist/data/arch/${name}.bin.br`, root);
  if (fs.existsSync(pkg)) return new Uint8Array(zlib.brotliDecompressSync(fs.readFileSync(pkg)));
  throw new Error(`no binary table ${name}: run web/build.sh or packages/wuica/build.sh`);
}
