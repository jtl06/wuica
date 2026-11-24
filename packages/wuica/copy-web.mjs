// Copies the page's modules that the package uses (web-modules.json) from web/js to lib/web, and removes any other file
// there: the copies are committed (the package works from a git checkout, and the server depends on it by file:), and
// nobody updates them by hand.
//   node packages/wuica/copy-web.mjs        (build.sh runs it; tests-js/web_pkg_copies.mjs checks the result)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(pkg, '../../web/js'), to = path.join(pkg, 'lib/web');
const { modules } = JSON.parse(fs.readFileSync(path.join(pkg, 'web-modules.json'), 'utf8'));
fs.mkdirSync(to, { recursive: true });
let changed = 0;
for (const f of modules) {
  const src = fs.readFileSync(path.join(from, f));
  const dst = path.join(to, f);
  if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(src)) { fs.writeFileSync(dst, src); changed++; }
}
for (const f of fs.readdirSync(to)) if (!modules.includes(f)) { fs.rmSync(path.join(to, f)); changed++; }
console.log(`lib/web: ${modules.length} modules from web/js${changed ? `, ${changed} updated` : ', up to date'}`);
