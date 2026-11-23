// Tests of the cost per source line (web/js/srcmap.js, godbolt.js rangeLines): on a hand-written response, and on the
// recorded Compiler Explorer responses (tests-js/fixtures/godbolt; no network) imported as the page imports them and
// analyzed with the real analyzer (if it has been built).
// Usage: node tests-js/web_srcmap.mjs
import fs from 'node:fs';
import { srcModel } from '../web/js/srcmap.js';
import { blame, boundModel, defaultResource } from '../web/js/bound.js';
import { parseListing, defaultSelection, extractRange, rangeLines, parseCeLink } from '../web/js/godbolt.js';
import { parseHexInput } from '../web/js/hex-input.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const near = (a, b) => Math.abs(a - b) < 1e-9;
const fx = (name) => JSON.parse(fs.readFileSync(new URL(`tests-js/fixtures/godbolt/${name}`, root)));

// --- hand-written ----------------------------------------------------------------------------------------------------
const COLS = ['MITE', 'MS', 'DSB', 'LSD', 'Issued', 'Exec.', 'Port 0', 'Port 1'];
const instr = (label, values, notes = '') => ({ kind: 'instr', label, opcode: '00', notes, values });
const R = {
  tp: 2, mode: 'loop', bottlenecks: ['Ports'], limits: [{ name: 'Issue', tp: 1 }, { name: 'Ports', tp: 2 }],
  columns: COLS,
  rows: [
    instr('a', [0, 0, 1, 0, 1, 1, 1, 0]),
    { kind: 'regMerge', label: '<Register Merge Uop>', notes: '', values: [0, 0, 0, 0, 1, 1, 0, 1] },
    instr('b', [0, 0, 1, 0, 1, 1, 1, 1]),
    instr('c', [0, 0, 1, 0, 1, 1, 0, 1]),
    instr('d', [0, 0, 0, 0, 0, 0, 0, 0], 'M'),
  ],
};
{
  const src = { text: 'int f() {\n  x;\n  y;\n  z;\n}\n', lines: [2, 2, 4, null], hex: 'aa' };
  const m = srcModel(R, src, 'aa');
  const b = blame(R, defaultResource(boundModel(R)));
  check(m && m.resource === 'Ports' && m.unit === b.unit, 'the bottleneck is the resource', JSON.stringify(m));
  check(m.lines.map((x) => x.line).join() === '1,2,3,4,5' && m.lines[0].rows.length === 0 && m.lines[2].rows.length === 0, 'lines: the mapped ones with one line of context');
  // the busiest port is p1 (3 uops; p0 has 2): a 0, the merge uop 1 (to b), b 1, c 1: line 2 = 2/3, line 4 = 1/3
  const l2 = m.lines.find((x) => x.line === 2), l4 = m.lines.find((x) => x.line === 4);
  check(near(l2.share, 2 / 3) && near(l4.share, 1 / 3) && l2.rows.join() === '0,2' && l2.top === 2 && l4.top === 3 && l2.text === '  x;', 'shares: the extra uops count for their instruction', JSON.stringify([l2, l4]));
  check(m.unmapped === 0, 'unmapped: the fused branch has no weight');
  check(srcModel(R, src, 'bb') === null, 'another block: no model');
  check(srcModel(R, { ...src, lines: [2, 4] }, 'aa') === null, 'another number of instructions: no model');
  check(srcModel(R, { ...src, lines: [null, null, null, null] }, 'aa') === null, 'no lines: no model');
  // lines far apart: two windows with a gap between them
  const far = srcModel(R, { text: Array.from({ length: 900 }, (_, k) => `line ${k + 1}`).join('\n'), lines: [5, 5, 800, null], hex: 'aa' }, 'aa');
  check(far.lines.map((x) => x.gap ?? x.line).join() === '4,5,6,792,799,800,801' && far.lines.find((x) => x.line === 800).share > 0, 'lines far apart: windows around each, the gap in between', JSON.stringify(far.lines.map((x) => x.gap ?? x.line)));
  check(srcModel(R, null, 'aa') === null && srcModel({ error: 'x' }, src, 'aa') === null, 'no source or no result: no model');
}

// --- the recorded Compiler Explorer responses ---------------------------------------------------------------------------
{
  const listing = parseListing(fx('compile-g82-countSetBits.json'));
  const sel = defaultSelection(listing);
  const fn = listing.functions[sel.fn];
  const lines = rangeLines(fn, sel.start, sel.end);
  const ext = extractRange(fn, sel.start, sel.end, listing);
  check(lines.length === ext.instructions && lines.every((l) => l === null || l > 0), 'countSetBits: a line per instruction of the loop', JSON.stringify(lines));
  check(lines.join() === '6,4,4', 'countSetBits: the loop is lines 6 and 4', lines.join());
  const clang = parseListing(fx('compile-clang1810-text.json').response);
  const csel = defaultSelection(clang);
  const cl = rangeLines(clang.functions[csel.fn], csel.start, csel.end);
  check(cl.length > 0 && !cl.includes(0), 'clang: line 0 (no line) is null', JSON.stringify(cl));
  // a line in another file is not the main source's
  const other = parseListing({ asm: [{ text: 'f:', source: null }, { text: '  nop', opcodes: ['90'], address: 0, source: { file: 'x.h', line: 3 } }, { text: '  ret', opcodes: ['c3'], address: 1, source: { file: null, line: 5 } }] });
  check(rangeLines(other.functions[0], 0, 2).join() === ',5', 'another file: null', JSON.stringify(rangeLines(other.functions[0], 0, 2)));

  const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
  if (!fs.existsSync(wasm) || !fs.existsSync(new URL('data/uarch.json', root))) {
    console.log('(analyzer or data/ missing: only the hand-written cases)');
  } else {
    const e = await WasmEngine.create(fs.readFileSync(wasm));
    await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
    await e.loadArch('SKL', fs.readFileSync(new URL('data/arch/SKL.json', root)));
    const p = parseHexInput(ext.text);
    const hex = [...p.bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    const r = await e.analyze(makeRequest(hex, 'SKL'));
    const link = parseCeLink(JSON.parse(fs.readFileSync(new URL('tests-js/fixtures/godbolt/links.json', root))).countSetBits);
    const source = link.state.editors[0].source;
    const m = srcModel(r, { text: source, lines, hex }, hex);
    check(m && Math.abs(m.lines.reduce((s, x) => s + x.share, 0) + m.unmapped - 1) < 1e-9, 'countSetBits: the shares add up to 1', JSON.stringify(m));
    check(m.lines.find((x) => x.line === 4)?.text.trim() === 'while (a != 0)' && m.lines.find((x) => x.line === 6).rows.length === 1, 'countSetBits: the source text of the lines', JSON.stringify(m.lines));
    console.log(`countSetBits on SKL: ${r.tp} cycles/iteration, ${m.resource}: ${m.lines.filter((x) => x.rows.length).map((x) => `line ${x.line} ${Math.round(x.share * 100)}%`).join(', ')}`);
  }
}

console.log(`${count} source line checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
