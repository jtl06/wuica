#!/usr/bin/env node
// The legacy files of a release: the engine files (the analyzer, uarch.json, the instruction tables) of the build that is
// live, downloaded from the site at their paths, for web/build.sh (WUICA_LEGACY_DIR) to ship beside the new build's own.
// An open page of the live build (and its service worker, which fetches what it has not cached from the site) then still
// finds its own engine files after the deploy, at the paths it asks for: never the new build's under the same name,
// never a 404 where it would need one of its files. It only reads (GET); scripts/fetch-legacy.sh runs it.
//
//   node scripts/fetch-legacy.mjs [--site URL] [--keep-previous] DIR
//
// DIR must be empty or new. The live manifest.json says what the engine files are:
//   - from 0.1.11 on: its `engine` (plain name -> {path, size, sha256}): each file is checked against its size and sha256;
//   - 0.1.10 and before (no `engine`): wuica_wasm.wasm, data/uarch.json and data/arch/<NAME>.bin.gz for its `tables`, at
//     those plain names; each is checked against the size in its `files` and for its kind (a WebAssembly module, JSON,
//     a gzip file that decompresses).
// --keep-previous: also the files the live build itself ships as legacy (its `legacy`), so that pages of the build before
// it keep working for one more release (default: one release, the live build's own files only).
// Writes the files at their paths under DIR and DIR/legacy.json: { site, version (the live build), fetched, files: {path:
// {size, sha256}} }; web/build.sh checks each file against it and records the list in the new manifest as `legacy`, which
// scripts/smoke-live.mjs checks on the site after the deploy (served, byte-identical).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const SITE = (opt('--site') ?? 'https://wuica.jacen.li').replace(/\/$/, '');
const keepPrevious = args.includes('--keep-previous');
const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--site');
if (!dir) { console.error('usage: node scripts/fetch-legacy.mjs [--site URL] [--keep-previous] DIR'); process.exit(2); }
const die = (m) => { console.error(`fetch-legacy: ${m}`); process.exit(1); };
if (fs.existsSync(dir) && fs.readdirSync(dir).length) die(`${dir} is not empty`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const get = async (p) => {
  const res = await fetch(`${SITE}/${p}`, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
  if (!res.ok) die(`GET ${SITE}/${p}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer()); // (a Content-Encoding of the host is undone by fetch)
};

const manifest = JSON.parse((await get('manifest.json')).toString('utf8'));
if (typeof manifest.version !== 'string' || typeof manifest.files !== 'object') die('manifest.json: not a manifest of the site');
/** path -> {size, sha256 | null} */
const want = new Map();
if (manifest.engine) {
  for (const e of Object.values(manifest.engine)) want.set(e.path, { size: e.size, sha256: e.sha256 });
} else {
  for (const p of ['wuica_wasm.wasm', 'data/uarch.json', ...(manifest.tables ?? []).map((t) => `data/arch/${t}.bin.gz`)]) {
    if (typeof manifest.files[p] !== 'number') die(`manifest.json lists no ${p}`);
    want.set(p, { size: manifest.files[p], sha256: null });
  }
}
if (keepPrevious) for (const [p, e] of Object.entries(manifest.legacy ?? {})) if (!want.has(p)) want.set(p, { size: e.size, sha256: e.sha256 });
if (want.size < 3) die(`manifest.json names only ${want.size} engine files`);

const files = {};
let total = 0;
for (const [p, w] of want) {
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(p) || p.split('/').some((s) => s === '.' || s === '..')) die(`not a relative path: ${p}`);
  const bytes = await get(p);
  if (bytes.length !== w.size) die(`${p}: ${bytes.length} bytes, the manifest says ${w.size}`);
  const hash = sha(bytes);
  if (w.sha256 && hash !== w.sha256) die(`${p}: sha256 ${hash}, the manifest says ${w.sha256}`);
  // (a manifest without hashes: at least the right kind of file)
  if (/\.wasm$/.test(p) && bytes.readUInt32BE(0) !== 0x0061736d) die(`${p}: not a WebAssembly module`);
  if (/\.json$/.test(p)) { try { JSON.parse(bytes.toString('utf8')); } catch { die(`${p}: not JSON`); } }
  if (/\.gz$/.test(p)) { try { zlib.gunzipSync(bytes); } catch { die(`${p}: not a gzip file`); } }
  fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
  fs.writeFileSync(path.join(dir, p), bytes);
  files[p] = { size: bytes.length, sha256: hash };
  total += bytes.length;
}
fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify({ site: SITE, version: manifest.version, fetched: new Date().toISOString(), files }, null, 1) + '\n');
console.log(`legacy files of build ${manifest.version} from ${SITE}: ${Object.keys(files).length} files, ${total} bytes, in ${dir}`);
