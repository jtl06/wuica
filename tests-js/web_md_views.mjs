// The Markdown of the page's views that the copy control copies (web/js/markdown.js: bound, bytes, deps, sweep,
// traceRange, mcaText): the default example on SKL against golden files (tests-js/fixtures/md-views/*.md;
// WUICA_UPDATE_GOLDEN=1 writes them). No line ends in a space. (The result, the tables, what-if and A–B:
// tests-js/web_export.mjs.)
//
//   node tests-js/web_md_views.mjs
import fs from 'node:fs';
import { bound, bytes, deps, sweep, traceRange, mcaText, shownLabels, offsetRanges } from '../web/js/markdown.js';
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

// The sweep's head says what the page says: a flat sweep is one value "at every offset" (not the 64 offsets twice, as a
// user test copied it), and long lists of offsets are ranges
{
  const at = (f) => Array.from({ length: 64 }, (_, k) => ({ tp: f(k) }));
  const flat = sweep(sweepData(at(() => 16)), 'ZEN3').split('\n')[0];
  check(flat === '**sweep** · alignment 0–63 · ZEN3 · 16.00 at every offset', 'a flat sweep: one value at every offset', flat);
  const steps = sweep(sweepData(at((k) => (k % 32 < 8 ? 2 : k === 20 || k === 21 ? 3 : 2.5))), 'SKL').split('\n')[0];
  check(steps === '**sweep** · alignment 0–63 · SKL · min 2.00 at 0–7, 32–39 · max 3.00 at 20, 21', 'min and max offsets as ranges', steps);
  check(offsetRanges([]) === '' && offsetRanges([5]) === '5' && offsetRanges([1, 2, 3, 5, 7, 8]) === '1–3, 5, 7, 8', 'offsetRanges: runs of three or more', offsetRanges([1, 2, 3, 5, 7, 8]));
}

const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(wasm)) {
  console.log('(the analyzer is missing: nothing checked)');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  await e.loadArch('SKL', tableBytes('SKL'));
  const ex = EXAMPLES[0]; // the default example
  // (as the page: the result; the dependencies from a run with the trace and details, as the analyzer's worker makes
  // them, engine-rpc.js depGraph; the slack by the result's critical path, deps.js)
  const r = await e.analyze(makeRequest(ex.hex, 'SKL'));
  const traced = await e.analyze({ ...makeRequest(ex.hex, 'SKL'), includeTrace: true, details: true });
  const g = depGraph(traced, traced.trace);
  annotateLatencies(g, traced, traced.details);
  g.slack = slackOf(g, r.criticalPath?.ratio);
  const points = [];
  for (let k = 0; k < 64; k++) points.push(summarize(await e.analyze(makeRequest(ex.hex, 'SKL', { alignmentOffset: k }))));
  const m = buildModel(traced.trace, {});
  const rows = selectRows(m, m.relevant.first, m.relevant.first + 2);
  // (the branch targets as the page shows them: the labels of the example's text)
  const shown = shownLabels(r, { source: ex.text.intel });
  const texts = {
    bound: bound(r, null, { shown }),
    bytes: bytes(codeMapModel(r, ex.hex, 0), { shown }),
    deps: deps(g, { shown, slack: g.slack?.slack ? g.nodes.map((_, i) => fmtSlack(g.slack.slack[i])) : null }),
    sweep: sweep(sweepData(points), 'SKL'),
    trace: traceRange(TABLE_HEAD, tableRows(m, rows), `${rows.length} uops`),
    mca: mcaText('Iterations:        100\nInstructions:      400\n', '100 iterations'),
  };
  // branch targets as the page shows them (the labels of the text: shownLabels), in every view that lists instructions
  check(shown.includes('jnz loop'), 'the default example\'s branch, as the page shows it: jnz loop', JSON.stringify(shown));
  for (const [k, t] of Object.entries({ bytes: bytes(codeMapModel(r, ex.hex, 0), { shown }), deps: deps(g, { shown, slack: g.nodes.map((_, i) => fmtSlack(g.slack?.slack?.[i] ?? 0)) }), bound: bound(r, 'Dependencies', { shown }) })) {
    check(!/jnz 0x/.test(t) && (k === 'bound' || t.includes('`jnz loop`')), `${k}: the branch copied as the page shows it (jnz loop, not its offset)`, t);
  }
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
