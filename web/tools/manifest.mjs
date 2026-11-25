// The last step of web/build.sh: the engine files under hashed names, the build's version, manifest.json, the legacy
// files. Prints the version.
//   node web/tools/manifest.mjs OUT SW_SOURCE ASSEMBLER(true|false) MCA(true|false) [LEGACY_DIR]
//
// Engine files (the analyzer, uarch.json, the instruction tables) are renamed to name.<16 hex digits of their
// sha256>.ext in their directory: wuica_wasm.<hash>.wasm, data/uarch.<hash>.json, data/arch/<NAME>.<hash>.bin.gz (the
// extensions stay: the host's content types, the _headers rules for /data/* and the service worker's LAZY pattern key on
// them). manifest.json:
//   version     the build id: a hash of the files the page can request (names and contents) and of the worker's source
//   assembler, mca, tables (the tables' names)
//   engine      plain name ('wuica_wasm.wasm', 'data/uarch.json', 'data/arch/<NAME>.bin.gz') -> {path, size, sha256}
//   files       every file the page can request -> its size (the service worker precaches those that are not lazy)
//   legacy      (with LEGACY_DIR) path -> {size, sha256}: the engine files of the build that was live before this one,
//   legacyOf    and that build's version; not in `files` (not precached, not in the transfer budgets), not in `version`
// LEGACY_DIR is written by scripts/fetch-legacy.mjs: the files at their paths and legacy.json ({version, files: {path:
// {size, sha256}}}). Each is checked against legacy.json and copied into OUT at its path; one that the build has too (an
// unchanged table keeps its name) must have the same bytes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [out, swSource, assembler, mca, legacyDir] = process.argv.slice(2);
const die = (m) => { console.error(`web/build.sh: ${m}`); process.exit(1); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const engine = {};
const tables = fs.readdirSync(path.join(out, 'data/arch')).filter((f) => f.endsWith('.bin.gz')).sort();
if (!tables.length) die('no tables in data/arch');
for (const name of ['wuica_wasm.wasm', 'data/uarch.json', ...tables.map((f) => `data/arch/${f}`)]) {
  const bytes = fs.readFileSync(path.join(out, name)), hash = sha(bytes);
  const [, base, ext] = /^(.*?)((?:\.bin)?\.gz|\.json|\.wasm)$/.exec(name);
  const hashed = `${base}.${hash.slice(0, 16)}${ext}`;
  fs.renameSync(path.join(out, name), path.join(out, hashed));
  engine[name] = { path: hashed, size: bytes.length, sha256: hash };
}

// what the page can request (not _headers and 404.html, which are for the host, nor robots.txt and sitemap.xml, which are
// for crawlers), in a stable order (bytewise, as LC_ALL=C sort)
const walk = (d) => fs.readdirSync(path.join(out, d), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : [path.posix.join(d, e.name)]));
const files = walk('').filter((f) => !['_headers', '404.html', 'robots.txt', 'sitemap.xml', 'manifest.json', 'sw.js'].includes(f))
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const version = sha(files.map((f) => `${sha(fs.readFileSync(path.join(out, f)))}  ${f}\n`).join('') + `${sha(fs.readFileSync(swSource))}  sw.js\n`).slice(0, 12);
const manifest = {
  version, assembler: assembler === 'true', mca: mca === 'true', tables: tables.map((f) => f.slice(0, -'.bin.gz'.length)), engine,
  files: Object.fromEntries(files.map((f) => [f, fs.statSync(path.join(out, f)).size])),
};

if (legacyDir) {
  let index;
  try { index = JSON.parse(fs.readFileSync(path.join(legacyDir, 'legacy.json'), 'utf8')); } catch (e) { die(`WUICA_LEGACY_DIR: ${path.join(legacyDir, 'legacy.json')}: ${e.message}`); }
  const legacy = {};
  for (const [p, want] of Object.entries(index.files ?? {})) {
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(p) || p.split('/').some((s) => s === '.' || s === '..')) die(`legacy: not a relative path: ${p}`);
    let bytes;
    try { bytes = fs.readFileSync(path.join(legacyDir, p)); } catch { die(`legacy: ${p} is missing in ${legacyDir}`); }
    if (bytes.length !== want.size || sha(bytes) !== want.sha256) die(`legacy: ${p} is not the file legacy.json describes (size or sha256)`);
    if (['index.html', 'sw.js', 'manifest.json', '_headers', '404.html'].includes(p)) die(`legacy: ${p} is not an engine file`);
    const dest = path.join(out, p);
    if (fs.existsSync(dest)) { if (!fs.readFileSync(dest).equals(bytes)) die(`legacy: ${p} is also a file of this build, with other bytes`); }
    else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); }
    legacy[p] = { size: want.size, sha256: want.sha256 };
  }
  if (!Object.keys(legacy).length) die(`legacy: ${path.join(legacyDir, 'legacy.json')} lists no files`);
  manifest.legacy = legacy;
  manifest.legacyOf = String(index.version ?? '');
}

fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
process.stdout.write(version);
