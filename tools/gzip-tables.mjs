// The site's instruction tables, gzip-compressed at build time: DIR/<NAME>.bin -> DIR/<NAME>.bin.gz (the .bin removed).
// The host (Cloudflare static assets) compresses only text-like content types, not application/octet-stream or
// application/gzip, so the site ships its tables compressed itself and the page decompresses them (loader.js, gunzip).
// zopfli if it is on the PATH (about 13% smaller), else zlib at level 9; the header is fixed (no name, mtime 0, OS 3),
// so the same input gives the same bytes and the build's version hash stays stable. WUICA_ZOPFLI=0: zlib.
//   node tools/gzip-tables.mjs DIR
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/gzip-tables.mjs DIR'); process.exit(2); }
const zopfli = process.env.WUICA_ZOPFLI !== '0' && spawnSync('zopfli', ['-h'], { stdio: 'ignore' }).status === 0;
let raw = 0, packed = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.bin')).sort()) {
  const file = path.join(dir, f);
  const bytes = fs.readFileSync(file);
  let gz;
  if (zopfli) {
    const r = spawnSync('zopfli', ['-c', '--i15', file], { maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`zopfli ${f}: exit ${r.status}`);
    gz = r.stdout;
  } else gz = zlib.gzipSync(bytes, { level: 9, memLevel: 9 });
  gz = Buffer.from(gz);
  gz.writeUInt32LE(0, 4); // mtime
  gz[8] = 2;              // XFL: maximum compression
  gz[9] = 3;              // OS: Unix (zlib writes the platform's)
  if (!zlib.gunzipSync(gz).equals(bytes)) throw new Error(`${f}: the gzip file does not decompress to the table`);
  fs.writeFileSync(file + '.gz', gz);
  fs.rmSync(file);
  raw += bytes.length; packed += gz.length;
}
console.log(`tables: ${(raw / 1e6).toFixed(2)} MB -> ${(packed / 1e3).toFixed(0)} kB gzip (${zopfli ? 'zopfli' : 'zlib -9'})`);
