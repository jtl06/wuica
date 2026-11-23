// The npm package reads assembly and makes its what-if variants and caveats with the web page's own modules: its copies
// in packages/wuica/lib/web must be the files of web/js (after a change there: cp web/js/<file> packages/wuica/lib/web/).
// Usage: node tests-js/web_pkg_copies.mjs
import fs from 'node:fs';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const dir = new URL('packages/wuica/lib/web/', root);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
check(['accum.js', 'asm-regions.js', 'assembler.js', 'caveats.js', 'loop-find.js'].every((f) => files.includes(f)), 'the copies are there', files.join());
for (const f of files) {
  const page = fs.readFileSync(new URL(`web/js/${f}`, root), 'utf8');
  const pkg = fs.readFileSync(new URL(f, dir), 'utf8');
  check(page === pkg, `packages/wuica/lib/web/${f} is web/js/${f} (cp web/js/${f} packages/wuica/lib/web/)`);
  // the copies import only each other
  for (const m of page.matchAll(/from '\.\/([\w.-]+)'/g)) check(files.includes(m[1]), `${f} imports ${m[1]}, which has a copy`);
}
console.log(`${count} package copy checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
