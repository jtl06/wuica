#!/usr/bin/env node
// The release version everywhere it is written, in one list: the page (web/js/app.js VERSION, the footer), the npm package
// (packages/wuica/package.json and its lock file), the API server (server/package.json and its lock file, with the
// package it depends on), and the Rust workspace (Cargo.toml's [workspace.package] version and the workspace crates in
// Cargo.lock). All must be equal (tests-js/web_version.mjs runs this in scripts/check.sh), and equal to EXPECTED if given
// (before a release: the version being released; scripts/smoke-live.sh checks the deployed one).
// Usage: node scripts/check-version.mjs [EXPECTED]   (prints one line per place; exit status 1 on a mismatch)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

// The workspace's own crates (path dependencies): Cargo.lock writes their version.
export const CRATES = ['wuica', 'wuica-cli', 'wuica-core', 'wuica-testkit', 'wuica-wasm', 'wuica-xed'];

// [[where, version | undefined]] in a fixed order.
export function versions() {
  const out = [];
  out.push(['web/js/app.js (VERSION)', /^const VERSION = '([^']+)';/m.exec(read('web/js/app.js'))?.[1]]);
  const pkgLock = json('packages/wuica/package-lock.json');
  out.push(['packages/wuica/package.json', json('packages/wuica/package.json').version]);
  out.push(['packages/wuica/package-lock.json', pkgLock.version]);
  out.push(['packages/wuica/package-lock.json (root package)', pkgLock.packages?.['']?.version]);
  const srvLock = json('server/package-lock.json');
  out.push(['server/package.json', json('server/package.json').version]);
  out.push(['server/package-lock.json', srvLock.version]);
  out.push(['server/package-lock.json (root package)', srvLock.packages?.['']?.version]);
  out.push(['server/package-lock.json (../packages/wuica)', srvLock.packages?.['../packages/wuica']?.version]);
  const cargo = read('Cargo.toml');
  const ws = /^\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(cargo);
  out.push(['Cargo.toml ([workspace.package] version)', ws?.[1]]);
  const lock = read('Cargo.lock');
  for (const c of CRATES) {
    const m = new RegExp(`^\\[\\[package\\]\\]\\nname = "${c}"\\nversion = "([^"]+)"`, 'm').exec(lock);
    out.push([`Cargo.lock (${c})`, m?.[1]]);
  }
  return out;
}

// {ok, version, problems: [text]}: all equal (and equal to expected, if given).
export function checkVersions(expected = null) {
  const list = versions();
  const want = expected ?? list[0][1];
  const problems = list.filter(([, v]) => v !== want).map(([where, v]) => `${where}: ${v ?? '(not found)'}, expected ${want}`);
  if (!/^\d+\.\d+\.\d+$/.test(want ?? '')) problems.unshift(`not a version: ${want}`);
  return { ok: problems.length === 0, version: want, list, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkVersions(process.argv[2] ?? null);
  for (const [where, v] of r.list) console.log(`${v === r.version ? 'ok  ' : 'DIFF'}  ${String(v ?? '-').padEnd(8)}  ${where}`);
  console.log(r.ok ? `version ${r.version} everywhere (${r.list.length} places)` : `version mismatch:\n  ${r.problems.join('\n  ')}`);
  process.exit(r.ok ? 0 : 1);
}
