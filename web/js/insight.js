// "Which instruction should I fix?": the data side of the insight views, without DOM (tests-js/web_insight.mjs runs
// it under Node).
//   chainInfo       the critical dependency chain of a response (its `criticalPath`) in terms of the uop table
//   costUnits       what the cost column removes: instructions, macro-fused pairs together, never the loop's branch
//   editHex, nopHex the block without a unit, or with NOPs of the same length in its place
//   costJobs        the modified blocks to analyze
//   costCells       the cycles/iteration each row adds (with it minus without it) from those results, and the largest
//   costKey         results are reused across redraws

export const VARIANTS = Object.freeze({
  remove: 'removed (the code after it moves up)',
  nop: 'replaced by a NOP of the same length (keeps the alignment, still takes a slot in the front end)',
});

const round2 = (x) => Math.round(x * 100) / 100;

// ---- the critical chain ---------------------------------------------------------------------------------------------

// The name of an operand as the page shows it: registers in lower case, like the disassembly.
export function operandName(op) {
  const s = String(op ?? '');
  return s === 'mem' || s === 'flags' ? s : s.toLowerCase();
}

const cycles = (n) => `${n} cycle${n === 1 ? '' : 's'}`;

// null, or {ratio, edges, steps, onChain: Map row -> [{operand, latency, carried, fromLabel}], lines}
//   steps: the instructions in the order of the chain, each with the arrow that leaves it ('→' same iteration,
//          '↻' into the next one); the last arrow leads back to the first instruction
//   lines: the edges as text, for a tooltip
export function chainInfo(response) {
  const cp = response?.criticalPath;
  const rows = response?.rows;
  if (!cp || !Array.isArray(cp.edges) || cp.edges.length === 0 || !Array.isArray(rows)) return null;
  const n = cp.edges.length;
  const label = (row) => rows[row]?.label ?? `row ${row}`;
  for (let k = 0; k < n; k++) {
    const e = cp.edges[k];
    if (rows[e.from]?.kind !== 'instr' || rows[e.to]?.kind !== 'instr' || e.to !== cp.edges[(k + 1) % n].from) return null; // not a cycle of this table
  }
  const onChain = new Map();
  const lines = [];
  for (const e of cp.edges) {
    const list = onChain.get(e.to) ?? [];
    list.push({ operand: operandName(e.operand), latency: e.latency, carried: !!e.carried, fromLabel: label(e.from) });
    onChain.set(e.to, list);
    lines.push(`${operandName(e.operand)} ← ${label(e.from)} (${cycles(e.latency)}${e.carried ? ', previous iteration' : ''})`);
  }
  const steps = cp.edges.map((e) => ({ row: e.from, label: label(e.from), arrow: e.carried ? '↻' : '→', operand: operandName(e.operand), latency: e.latency }));
  const iterations = cp.edges.filter((e) => e.carried).length;
  const ratio = Number(cp.ratio);
  return { ratio, iterations, edges: cp.edges, steps, onChain, lines };
}

// The tooltip of a row on the chain.
export function chainTitle(info, row) {
  const mine = info.onChain.get(row) ?? [];
  const head = mine.map((m) => `reads ${m.operand} from ${m.fromLabel} (${cycles(m.latency)}${m.carried ? ', previous iteration' : ''})`);
  return [`critical dependency chain: ${round2(info.ratio).toFixed(2)} cycles/iteration`, ...head, '', 'chain:', ...info.lines].join('\n');
}

// ---- the cost of each instruction ------------------------------------------------------------------------------------

// Multi-byte NOPs (Intel SDM, "Recommended Multi-Byte Sequence of NOP Instruction"); 10–15 bytes: more 66 prefixes.
// One instruction for every length from 1 to 15 bytes.
const NOPS = ['90', '6690', '0f1f00', '0f1f4000', '0f1f440000', '660f1f440000', '0f1f8000000000', '0f1f840000000000', '660f1f840000000000'];
export function nopHex(len) {
  let out = '';
  for (let left = len; left > 0;) {
    const n = Math.min(left, 15);
    out += n <= 9 ? NOPS[n - 1] : '66'.repeat(n - 9) + '2e0f1f840000000000';
    left -= n;
  }
  return out;
}

// The units the cost column removes, from a response and the machine code it was made from (hex).
// {ok: true, units: [{rows, start, end, fixed}], unitOfRow: Map row -> unit index} or {ok: false, reason}.
//   rows: the table rows of the unit's instructions; start, end: byte offsets in the code
//   fixed: the loop's branch (the last instruction of a loop): never removed
// A macro-fused pair (an "M" row and the instruction before it) is one unit, except when its second instruction is
// the loop's branch: then the first one is a unit of its own.
export function costUnits(response, hex) {
  const rows = response?.rows;
  if (!Array.isArray(rows)) return { ok: false, reason: 'no result' };
  const code = String(hex ?? '').toLowerCase();
  const instrs = [];
  let at = 0;
  rows.forEach((x, row) => {
    if (x.kind !== 'instr') return;
    const len = String(x.opcode ?? '').length / 2;
    instrs.push({ row, start: at, end: at + len, opcode: String(x.opcode ?? '').toLowerCase(), fused: x.notes === 'M' });
    at += len;
  });
  if (instrs.length === 0) return { ok: false, reason: 'no instructions' };
  if (instrs.map((i) => i.opcode).join('') !== code) return { ok: false, reason: 'the code has bytes that are not instructions' };
  const loopBranch = response.mode === 'loop' ? instrs.length - 1 : -1;
  const units = [];
  instrs.forEach((ins, k) => {
    const fixed = k === loopBranch;
    const prev = units[units.length - 1];
    if (ins.fused && prev && !prev.fixed && !fixed) {
      prev.rows.push(ins.row);
      prev.end = ins.end;
    } else {
      units.push({ rows: [ins.row], start: ins.start, end: ins.end, fixed });
    }
  });
  const unitOfRow = new Map();
  units.forEach((u, i) => { for (const r of u.rows) unitOfRow.set(r, i); });
  return { ok: true, units, unitOfRow };
}

// The code with the bytes [start, end) removed ('remove') or replaced by NOPs ('nop').
export function editHex(hex, { start, end }, variant = 'remove') {
  const h = String(hex).toLowerCase();
  return h.slice(0, 2 * start) + (variant === 'nop' ? nopHex(end - start) : '') + h.slice(2 * end);
}

// The analyses for the cost column: [{unit, hex}] (not for the loop's branch, nor for a block that would be empty).
export function costJobs(units, hex, variant = 'remove') {
  const jobs = [];
  units.forEach((u, unit) => {
    if (u.fixed) return;
    const h = editHex(hex, u, variant);
    if (h !== '') jobs.push({ unit, hex: h });
  });
  return jobs;
}

// Δ in uiCA's precision (both throughputs at two decimals).
export const delta = (tp, baseTp) => (Math.round(tp * 100) - Math.round(baseTp * 100)) / 100;

export function formatDelta(d) {
  if (d === 0) return '0.00';
  return `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`;
}

// The cost column: one cell per row of the response: what the instruction adds, in cycles/iteration (the throughput with
// it minus the throughput without it: +0.94 costs 0.94 cycles; −0.94 means the block is slower without it, e.g. its
// removal breaks a chain).
//   results: Map unit index -> summary ({tp, mode} or {error}; absent: not analyzed yet)
// Each cell: {kind, text, title, delta, top}; kind: 'none' (inserted uops), 'fixed' (the loop's branch), 'with' (the
// second instruction of a fused pair: removed with the one above), 'pending', 'na' (no comparable result), 'value'.
// delta: the cost (with − without). top: the largest cost (the most to save); ties are all marked.
export function costCells(response, cu, results, variant = 'remove') {
  const baseTp = Number(response.tp);
  const what = variant === 'nop' ? 'replaced by NOPs' : 'removed';
  const cells = response.rows.map((x, row) => {
    if (x.kind !== 'instr' || !cu.unitOfRow.has(row)) return { kind: 'none', text: '', title: null, delta: null };
    const i = cu.unitOfRow.get(row);
    const u = cu.units[i];
    if (u.fixed) return { kind: 'fixed', text: '—', title: 'the loop\'s branch: kept', delta: null };
    if (u.rows[0] !== row) return { kind: 'with', text: '↑', title: `macro-fused: ${what} together with the instruction above`, delta: null };
    const r = results.get(i);
    if (!r) return { kind: 'pending', text: '…', title: 'not analyzed yet', delta: null };
    if (r.error) return { kind: 'na', text: '—', title: `the block without it: ${r.error}`, delta: null };
    if (r.mode && response.mode && r.mode !== response.mode) {
      return { kind: 'na', text: '—', title: `without it, the block is analyzed ${r.mode === 'loop' ? 'as a loop' : 'unrolled'}: not comparable`, delta: null };
    }
    const d = delta(baseTp, r.tp);
    const pair = u.rows.length > 1 ? ' (with the macro-fused instruction below)' : '';
    return {
      kind: 'value', text: formatDelta(d), delta: d, tp: r.tp,
      title: `adds ${formatDelta(d)} cycles/iteration: ${what}${pair}, ${Number(r.tp).toFixed(2)} instead of ${baseTp.toFixed(2)}`,
    };
  });
  const values = cells.filter((c) => c.kind === 'value').map((c) => c.delta);
  const best = values.length ? Math.max(...values) : 0;
  for (const c of cells) c.top = c.kind === 'value' && best > 0 && c.delta === best;
  return cells;
}

// Results depend on the code, the CPU, the options and the variant.
const optionKey = (o) => JSON.stringify(Object.keys(o ?? {}).filter((k) => k !== 'includeTrace').sort().map((k) => [k, o[k]]));
export const costKey = (hex, arch, options, variant) => `cost|${variant}|${arch}|${String(hex).toLowerCase()}|${optionKey(options)}`;
