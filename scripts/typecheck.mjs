#!/usr/bin/env node
// Type-checks the JavaScript without a build step: tsc --noEmit --checkJs with tsconfig.json (the npm package's lib and
// bin, the server's lib, packages/wuica/typecheck/api.ts against index.d.ts) plus the page's DOM-free modules the package
// shares (packages/wuica/web-modules.json, read here so that the list is kept in one place). TypeScript and @types/node
// are development dependencies of packages/wuica (npm ci there installs them). scripts/check.sh runs this as the suite
// "typecheck". Usage: node scripts/typecheck.mjs   (exit status: tsc's)
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
const config = { extends: rel('tsconfig.json'), include: [...base.include, ...shared].map(rel) };
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(config, null, 1) + '\n');
const t0 = performance.now();
const r = spawnSync(process.execPath, [TSC, '-p', path.join(dir, 'tsconfig.json'), '--listFilesOnly'], { encoding: 'utf8' });
const files = r.stdout.split('\n').filter((f) => f && !f.includes('/node_modules/'));
const c = spawnSync(process.execPath, [TSC, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
process.stdout.write(c.stdout + c.stderr);
const errors = (c.stdout.match(/error TS\d+/g) ?? []).length;
console.log(`${files.length} files type-checked, ${errors} errors (${Math.round(performance.now() - t0)} ms)`);
process.exit(c.status ?? 1);
