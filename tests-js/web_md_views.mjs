// The Markdown of the views the copy control copies (web/js/md-views.js): the table helper by hand, and the bound,
// bytes, deps, sweep, trace and llvm-mca texts of the default example on SKL against golden files
// (tests-js/fixtures/md-views/*.md; WUICA_UPDATE_GOLDEN=1 writes them). Pipes are escaped, columns padded to one
// width, no line ends in a space.
//
//   node tests-js/web_md_views.mjs
import fs from 'node:fs';
import { mdTable, boundMd, bytesMd, depsMd, sweepMd, traceMd, mcaMd } from '../web/js/md-views.js';
import { codeMapModel } from '../web/js/codemap.js';
import { depGraph } from '../web/js/deps.js';
import { annotateLatencies, slackOf } from '../web/js/deps-slack.js';
import { sweepData, summarize } from '../web/js/compare.js';
import { buildModel, selectRows, tableRows, TABLE_HEAD } from '../web/js/trace.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES } from '../web/js/examples.js';
import { tableBytes } from './tables.mjs';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + String(detail).slice(0, 3000) : ''}`); } }
const root = new URL('../', import.meta.url);
const GOLD = new URL('tests-js/fixtures/md-views/', root);

// the table helper
{
  const t = mdTable(['a', 'b|c'], [['x', '1'], ['long text', '12.50']], ['l', 'r']);
  check(t === '| a         |  b\\|c |\n|:----------|------:|\n| x         |     1 |\n| long text | 12.50 |', 'mdTable: padded, pipes escaped, aligned', '\n' + t);
  check(!/ $/m.test(t) && t.split('\n').every((l) => l.length === t.split('\n')[0].length), 'mdTable: no trailing space, every line one width', t);
}

const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(wasm)) {
  console.log('(the analyzer is missing: only the helper)');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  await e.loadArch('SKL', tableBytes('SKL'));
  const ex = EXAMPLES[0]; // the default example
  const r = await e.analyze(makeRequest(ex.hex, 'SKL', { includeTrace: true, details: true }));
  const g = depGraph(r, r.trace);
  annotateLatencies(g, r, r.details);
  g.slack = slackOf(g, r.criticalPath?.ratio);
  const points = [];
  for (let k = 0; k < 64; k++) points.push(summarize(await e.analyze(makeRequest(ex.hex, 'SKL', { alignmentOffset: k }))));
  const m = buildModel(r.trace, {});
  const rows = selectRows(m, m.relevant.first, m.relevant.first + 2);
  const texts = {
    bound: boundMd(r),
    bytes: bytesMd(codeMapModel(r, ex.hex, 0)),
    deps: depsMd(g),
    sweep: sweepMd(sweepData(points), 'SKL'),
    trace: traceMd(TABLE_HEAD, tableRows(m, rows), `${rows.length} uops`),
    mca: mcaMd('Iterations:        100\nInstructions:      400\n', '100 iterations'),
  };
  if (process.env.WUICA_UPDATE_GOLDEN) {
    fs.mkdirSync(GOLD, { recursive: true });
    for (const [k, t] of Object.entries(texts)) fs.writeFileSync(new URL(`${k}.md`, GOLD), t);
    console.log('golden files written');
  }
  for (const [k, t] of Object.entries(texts)) {
    const file = new URL(`${k}.md`, GOLD);
    const want = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    check(want !== null && t === want, `${k}: the Markdown of the default example on SKL is the golden text (tests-js/fixtures/md-views/${k}.md)`, `\n${t}`);
    check(t.endsWith('\n') && !/[ \t]$/m.test(t), `${k}: no trailing whitespace, one newline at the end`);
  }
}
console.log(`${count} markdown view checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
