// Reading the package's files (shared by the library and its worker threads).

import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliDecompress);
// a Uint8Array view of a Buffer (new Uint8Array(buffer) would copy it)
const view = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

// Reads a file; `.br` files are decompressed. For a path without `.br`, `<path>.br` is tried first.
export async function readMaybeCompressed(file) {
  if (file.endsWith('.br')) return view(await brotli(await fs.readFile(file)));
  try {
    return view(await brotli(await fs.readFile(file + '.br')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return view(await fs.readFile(file));
}

// The file of an instruction table in a data directory: the binary form (<name>.bin, the package's), else the JSON
// (<name>.json, as tools/export_data.py writes it: the analyzer that ships reads no JSON tables and says so), each plain
// or .br.
export function tableFile(dataDir, name) {
  const bin = path.join(dataDir, 'arch', `${name}.bin`);
  return existsSync(bin) || existsSync(bin + '.br') ? bin : path.join(dataDir, 'arch', `${name}.json`);
}

// The same, synchronously (an analyzer reloads its tables this way after a trap, instead of keeping their bytes).
export function readMaybeCompressedSync(file) {
  if (file.endsWith('.br')) return view(zlib.brotliDecompressSync(readFileSync(file)));
  try {
    return view(zlib.brotliDecompressSync(readFileSync(file + '.br')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return view(readFileSync(file));
}
