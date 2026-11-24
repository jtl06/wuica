// The npm package reads assembly, makes its what-if variants, insights and caveats with the web page's own modules: the
// ones listed in packages/wuica/web-modules.json, copied to packages/wuica/lib/web by packages/wuica/copy-web.mjs (which
// packages/wuica/build.sh runs). The copies must be the files of web/js, and import only each other; nothing else is
// in lib/web.
// Usage: node tests-js/web_pkg_copies.mjs
import fs from 'node:fs';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const dir = new URL('packages/wuica/lib/web/', root);
const { modules } = JSON.parse(fs.readFileSync(new URL('packages/wuica/web-modules.json', root), 'utf8'));
const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
check(JSON.stringify(files) === JSON.stringify([...modules].sort()), 'lib/web has the modules of web-modules.json, no others (node packages/wuica/copy-web.mjs)', files.join());
for (const f of modules) {
  const page = fs.readFileSync(new URL(`web/js/${f}`, root), 'utf8');
  let pkg = null;
  try { pkg = fs.readFileSync(new URL(f, dir), 'utf8'); } catch { /* missing: the check below fails */ }
  check(page === pkg, `packages/wuica/lib/web/${f} is web/js/${f} (node packages/wuica/copy-web.mjs)`);
  // the copies import only each other (static imports; examples.js loads the showcase's assembly on request, which the
  // package never asks for: it analyzes the showcase's machine code)
  for (const m of page.matchAll(/from '\.\/([\w.-]+)'/g)) check(modules.includes(m[1]), `${f} imports ${m[1]}, which is in web-modules.json`);
}
console.log(`${count} package copy checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
