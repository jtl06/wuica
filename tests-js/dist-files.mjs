// Where a build of the site (web/dist, web/build.sh) has its engine files: the analyzer, uarch.json and the instruction
// tables are written under names that hold a hash of their content (wuica_wasm.<hash>.wasm, data/uarch.<hash>.json,
// data/arch/<NAME>.<hash>.bin.gz), listed in manifest.json's `engine` under their plain names. A build without that key
// (one made before the names had hashes) has them at the plain names. Not a suite.
//
//   import { enginePath, tablePath } from './dist-files.mjs';
//   fs.readFileSync(enginePath(dist, 'wuica_wasm.wasm')); fs.readFileSync(tablePath(dist, 'SKL'));
import fs from 'node:fs';
import path from 'node:path';

const manifests = new Map();
function manifestOf(dist) {
  const file = path.join(dist, 'manifest.json');
  if (!manifests.has(file)) manifests.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
  return manifests.get(file);
}

/** the path relative to the build's root of an engine file by its plain name ('wuica_wasm.wasm', 'data/uarch.json',
 * 'data/arch/SKL.bin.gz') */
export function engineRel(dist, name) {
  return manifestOf(dist).engine?.[name]?.path ?? name;
}
/** the file of an engine file in the build, by its plain name */
export const enginePath = (dist, name) => path.join(dist, engineRel(dist, name));
/** the file of a CPU's instruction table (gzip, the binary form) in the build */
export const tablePath = (dist, table) => enginePath(dist, `data/arch/${table}.bin.gz`);
