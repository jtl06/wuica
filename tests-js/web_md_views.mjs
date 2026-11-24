// The Markdown of the page's views that the copy control copies (web/js/markdown.js: bound, bytes, deps, sweep,
// traceRange, mcaText): the default example on SKL against golden files (tests-js/fixtures/md-views/*.md;
// WUICA_UPDATE_GOLDEN=1 writes them). No line ends in a space. (The result, the tables, what-if and A–B:
// tests-js/web_export.mjs.)
//
//   node tests-js/web_md_views.mjs
import fs from 'node:fs';
import { bound, bytes, deps, sweep, traceRange, mcaText } from '../web/js/markdown.js';
import { codeMapModel } from '../web/js/codemap.js';
import { depGraph } from '../web/js/deps.js';
import { annotateLatencies, slackOf, fmtSlack } from '../web/js/deps-slack.js';
import { sweepData, summarize } from '../web/js/compare.js';
import { buildModel, selectRows, tableRows, TABLE_HEAD } from '../web/js/trace.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES } from '../web/js/examples.js';
import { tableBytes } from './tables.mjs';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + String(detail).slice(0, 3000) : ''}`); } }
const root = new URL('../', import.meta.url);
const GOLD = new URL('tests-js/fixtures/md-views/', root);

const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(wasm)) {
  console.log('(the analyzer is missing: nothing checked)');
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
    bound: bound(r),
    bytes: bytes(codeMapModel(r, ex.hex, 0)),
    deps: deps(g, { slack: g.slack?.slack ? g.nodes.map((_, i) => fmtSlack(g.slack.slack[i])) : null }),
    sweep: sweep(sweepData(points), 'SKL'),
    trace: traceRange(TABLE_HEAD, tableRows(m, rows), `${rows.length} uops`),
    mca: mcaText('Iterations:        100\nInstructions:      400\n', '100 iterations'),
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
