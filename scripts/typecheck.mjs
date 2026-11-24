#!/usr/bin/env node
// Type-checks the JavaScript without a build step: tsc --noEmit --checkJs in two projects.
// 1. tsconfig.json: the npm package's lib and bin, the server's lib, packages/wuica/typecheck/api.ts against index.d.ts,
//    plus the page's DOM-free modules the package shares (packages/wuica/web-modules.json, read here so that the list is
//    kept in one place).
// 2. The page's own modules (web/js/*.js, the UI with them): the same options, but the browser's types only (no Node
//    types: setTimeout returns a number there) and without strictNullChecks: the page looks up the elements of
//    index.html by id, which the checker types as possibly null at every use (about 600 of them); the rest is as strict
//    as project 1. The shared modules come in through the imports: their errors are project 1's (stricter there; without
//    strictNullChecks the checker loses some narrowing of {ok: true, ...} | {ok: false, reason}), so project 2 leaves
//    them out. Not here: web/sw.js (a service worker's global scope).
// TypeScript and @types/node are development dependencies of packages/wuica (npm ci there installs them).
// scripts/check.sh runs this as the suite "typecheck". Usage: node scripts/typecheck.mjs   (exit status: 0 if both pass)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSC = path.join(ROOT, 'packages/wuica/node_modules/typescript/bin/tsc');
if (!fs.existsSync(TSC)) {
  console.error('typecheck: TypeScript is not installed: run npm ci in packages/wuica');
  process.exit(1);
}
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const shared = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/wuica/web-modules.json'), 'utf8')).modules.map((m) => `web/js/${m}`);
const dir = path.join(ROOT, 'target/typecheck');
fs.mkdirSync(dir, { recursive: true });
const rel = (p) => path.relative(dir, path.join(ROOT, p)).split(path.sep).join('/');
const projects = {
  package: { extends: rel('tsconfig.json'), include: [...base.include, ...shared].map(rel) },
  page: { extends: rel('tsconfig.json'), compilerOptions: { strictNullChecks: false, types: [] }, include: [rel('web/js/*.js')] },
};
const t0 = performance.now();
const files = new Set();
let errors = 0, failed = false;
for (const [name, config] of Object.entries(projects)) {
  const file = path.join(dir, name === 'package' ? 'tsconfig.json' : `tsconfig.${name}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 1) + '\n');
  const r = spawnSync(process.execPath, [TSC, '-p', file, '--listFilesOnly'], { encoding: 'utf8', cwd: ROOT });
  for (const f of r.stdout.split('\n')) if (f && !f.includes('/node_modules/')) files.add(f);
  const c = spawnSync(process.execPath, [TSC, '-p', file], { encoding: 'utf8', cwd: ROOT }); // (paths relative to ROOT)
  // tsc's messages: one block per error (a line naming the file, then indented lines)
  const blocks = c.stdout.split(/\n(?=\S)/).filter((b) => b.trim());
  const own = name === 'page' ? blocks.filter((b) => !shared.some((m) => b.startsWith(`${m}(`))) : blocks;
  if (own.length) process.stdout.write(own.join('\n') + '\n');
  process.stdout.write(c.stderr);
  const n = own.filter((b) => /error TS\d+/.test(b)).length;
  errors += n;
  if (n || (c.status !== 0 && !blocks.length)) failed = true;
}
console.log(`${files.size} files type-checked, ${errors} errors (${Math.round(performance.now() - t0)} ms)`);
process.exit(failed ? 1 : 0);
