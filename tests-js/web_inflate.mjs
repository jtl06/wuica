// The site's tables are gzip files (web/build.sh, tools/gzip-tables.mjs) that the page decompresses (loader.js gunzip):
// with DecompressionStream, and with inflate.js where it is missing (Safari 15 to 16.3). Both give every table of
// web/dist exactly; inflate.js also on zlib's output at levels 1 and 9 (stored, fixed and dynamic blocks).
// Usage: node tests-js/web_inflate.mjs   (after web/build.sh)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { gunzip as inflateGunzip } from '../web/js/inflate.js';
import { gunzip } from '../web/js/loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '../web/dist/data/arch');
let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
if (!fs.existsSync(dir)) { console.log('web/dist is missing: run web/build.sh'); process.exit(1); }
const files = fs.readdirSync(dir).sort();
check(files.length >= 15 && files.every((f) => f.endsWith('.bin.gz')), 'the site ships its tables as .bin.gz only', files.join());
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
for (const f of files) {
  const gz = fs.readFileSync(path.join(dir, f));
  const want = zlib.gunzipSync(gz);
  check(gz[3] === 0 && gz.readUInt32LE(4) === 0 && gz[9] === 3, `${f}: a fixed gzip header (no name, mtime 0): the build is reproducible`);
  check(want.subarray(0, 8).toString() === 'WUICATBL', `${f}: a binary table inside`);
  check(same(await gunzip(gz), want), `${f}: DecompressionStream (loader.js gunzip)`);
  check(same(inflateGunzip(gz), want), `${f}: inflate.js`);
  for (const level of [1, 9]) check(same(inflateGunzip(zlib.gzipSync(want, { level })), want), `${f}: inflate.js on zlib level ${level}`);
}
// without DecompressionStream, loader.js falls back to inflate.js
const saved = globalThis.DecompressionStream;
globalThis.DecompressionStream = undefined;
const gz = fs.readFileSync(path.join(dir, files[0]));
check(same(await gunzip(gz), zlib.gunzipSync(gz)), 'loader.js gunzip without DecompressionStream: inflate.js');
globalThis.DecompressionStream = saved;
let threw = false;
try { inflateGunzip(gz.subarray(0, gz.length - 20)); } catch { threw = true; }
check(threw, 'inflate.js: a truncated file is an error');
console.log(`${count} inflate checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
