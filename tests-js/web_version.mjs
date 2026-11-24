// One version for the site, the npm package, the API server and the Rust workspace: the page's VERSION (web/js/app.js, the
// footer) is the version of packages/wuica and of server/ (their package.json and lock files), which /api/version and the
// MCP servers report, and of Cargo.toml's workspace (and Cargo.lock's workspace crates). The list of places is
// scripts/check-version.mjs (also run before a release with the version being released). Bump them together.
// Usage: node tests-js/web_version.mjs
import { checkVersions } from '../scripts/check-version.mjs';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }

const r = checkVersions();
check(/^\d+\.\d+\.\d+$/.test(r.version ?? ''), 'the page has a VERSION', String(r.version));
for (const [where, v] of r.list.slice(1)) check(v === r.version, `${where}: the page's version ${r.version}`, String(v));
check(r.list.some(([w]) => w.startsWith('Cargo.toml')) && r.list.filter(([w]) => w.startsWith('Cargo.lock')).length === 6, 'the Rust workspace is in the list');

console.log(`${count} version checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
