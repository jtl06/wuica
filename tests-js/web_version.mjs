// One version for the site, the npm package and the API server: the page's VERSION (web/js/app.js, the footer) is the
// version of packages/wuica and of server/ (their package.json and lock files), which /api/version and the MCP servers
// report. Bump them together.
// Usage: node tests-js/web_version.mjs
import fs from 'node:fs';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const json = (p) => JSON.parse(read(p));

const site = /^const VERSION = '([^']+)';/m.exec(read('web/js/app.js'))?.[1];
check(/^\d+\.\d+\.\d+$/.test(site ?? ''), 'the page has a VERSION', String(site));
const versions = {
  'packages/wuica/package.json': json('packages/wuica/package.json').version,
  'packages/wuica/package-lock.json': json('packages/wuica/package-lock.json').version,
  'packages/wuica/package-lock.json (root package)': json('packages/wuica/package-lock.json').packages[''].version,
  'server/package.json': json('server/package.json').version,
  'server/package-lock.json': json('server/package-lock.json').version,
  'server/package-lock.json (root package)': json('server/package-lock.json').packages[''].version,
  'server/package-lock.json (../packages/wuica)': json('server/package-lock.json').packages['../packages/wuica'].version,
};
for (const [where, v] of Object.entries(versions)) check(v === site, `${where}: the page's version ${site}`, String(v));

console.log(`${count} version checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
