// Tests of the export formats (web/js/export.js): Markdown, CSV and JSON of a response; with the real analyzer (if built),
// every example's CSV read back (with a CSV parser written here) equals the response's table.
// Usage: node tests-js/web_export.mjs
import fs from 'node:fs';
import { toMarkdown, toCSV, toJSON } from '../web/js/export.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { tableBytes } from './tables.mjs'; // the binary tables (the module reads no JSON tables)

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);

const R = {
  arch: 'SKL', tp: 2, mode: 'loop', bottlenecks: ['Dependencies'], limits: [{ name: 'Issue', tp: 0.75 }, { name: 'Dependencies', tp: 2 }],
  columns: ['MITE', 'DSB', 'Issued', 'Port 0', 'Port 1'],
  rows: [
    { kind: 'regMerge', label: '<Register Merge Uop>', notes: '', values: [0, 0, 1, 0.5, 0.5] },
    { kind: 'instr', label: 'add rax, 0x1', opcode: '4883C001', notes: '', values: [0, 1, 1, 0.333333, 0.666667] },
    { kind: 'instr', label: 'jnz 0x0', opcode: '75F3', notes: 'M', values: [0, 0, 0, 0, 0] },
  ],
  text: 'report', trace: null,
};

{
  const md = toMarkdown(R, { archTitle: 'SKL · Skylake (2015)', link: 'https://example.invalid/#v=1' });
  const lines = md.trimEnd().split('\n');
  check(lines[0] === '**2.00 cycles/iteration** · SKL · Skylake (2015) · loop · bottleneck: Dependencies', 'markdown: the head line', lines[0]);
  check(lines[1] === 'limits: Issue 0.75 · Dependencies 2.00' && lines[2] === '', 'markdown: the limits', lines[1]);
  check(lines[3] === '| Instruction | Notes | DSB | Issued | Port 0 | Port 1 |' && lines[4] === '|---|:-:|--:|--:|--:|--:|', 'markdown: only used columns, numbers right-aligned', lines.slice(3, 5).join('\n'));
  check(lines[5] === '| <Register Merge Uop> |  |  | 1 | 0.5 | 0.5 |' && lines[6] === '| `add rax, 0x1` |  | 1 | 1 | 0.33 | 0.67 |' && lines[7] === '| `jnz 0x0` | M |  |  |  |  |', 'markdown: the rows, two decimals, zeros blank', lines.slice(5, 8).join('\n'));
  check(lines[8] === '| **Total** | | 1 | 2 | 0.83 | 1.17 |' && lines.at(-1) === '[wuica](https://example.invalid/#v=1)', 'markdown: totals and the link', lines.slice(8).join('\n'));
  check(!/\n\n\n/.test(toMarkdown({ ...R, limits: [] })) && toMarkdown({ ...R, bottlenecks: [] }).includes('bottleneck: unknown'), 'markdown: no limits, no bottleneck');
  check(toMarkdown({ ...R, rows: [{ ...R.rows[1], label: 'a|b`c' }] }).includes('| `a|b\'c` |'), 'markdown: a backtick in a label does not end the code span');

  const csv = toCSV({ ...R, rows: [...R.rows, { kind: 'instr', label: 'mov eax, "x", y', opcode: 'B8', notes: '', values: [1, 0, 1, 0, 0] }] });
  const c = csv.split('\r\n');
  check(c[0] === 'instruction,opcode,notes,MITE,DSB,Issued,Port 0,Port 1' && c[2] === 'add rax, 0x1,4883C001,,0,1,1,0.333333,0.666667'.replace('add rax, 0x1', '"add rax, 0x1"'), 'csv: header, quoted labels, raw numbers', c.slice(0, 3).join(' / '));
  check(c[4] === '"mov eax, ""x"", y",B8,,1,0,1,0,0' && c.at(-1) === '', 'csv: quotes doubled; CRLF line ends', c[4]);

  const j = JSON.parse(toJSON(R, { hex: '4883c00175f3', arch: 'SKL' }));
  check(j.request.arch === 'SKL' && j.response.tp === 2 && !('trace' in j.response) && !('text' in j.response) && j.response.rows.length === 3, 'json: request and response without trace and text');
}

// --- the examples: CSV read back --------------------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  return rows;
}
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (fs.existsSync(wasm) && fs.existsSync(new URL('data/uarch.json', root))) {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  for (const t of ['SKL', 'ZEN3']) await e.loadArch(t, tableBytes(t));
  for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
    for (const arch of ['SKL', 'ZEN3']) {
      const r = await e.analyze(makeRequest(ex.hex, arch));
      const back = parseCSV(toCSV(r));
      const ok = back.length === r.rows.length + 1 && back[0].slice(3).join('|') === r.columns.join('|')
        && r.rows.every((x, k) => back[k + 1][0] === x.label && back[k + 1].slice(3).every((v, i) => Number(v) === (Number(x.values[i]) || 0)));
      check(ok, `${ex.id} on ${arch}: the CSV reads back as the table`);
      const md = toMarkdown(r).split('\n').filter((l) => l.startsWith('| '));
      check(md.length === r.rows.length + 2, `${ex.id} on ${arch}: one Markdown row per table row, a header and the total`);
    }
  }
}

console.log(`${count} export checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
