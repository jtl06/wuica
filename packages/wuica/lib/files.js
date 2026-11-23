// Reading the package's files (shared by the library and its worker threads).

import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliDecompress);

// Reads a file; `.br` files are decompressed. For a path without `.br`, `<path>.br` is tried first.
export async function readMaybeCompressed(file) {
  if (file.endsWith('.br')) return new Uint8Array(await brotli(await fs.readFile(file)));
  try {
    return new Uint8Array(await brotli(await fs.readFile(file + '.br')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return new Uint8Array(await fs.readFile(file));
}
