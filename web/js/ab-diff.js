// A–B comparison: compares two analysis responses (docs/WASM-API.md): throughput, bottlenecks, limits, and an
// instruction-by-instruction alignment of the two uop tables with the change of every shared column.
// Pure: no DOM, runs under Node (tests-js/web_ab_diff.mjs).

import { columnKind } from './render.js';

export const EPS = 0.005; // values are shown with two decimals: smaller differences are "the same"

// Prefixes that come before the mnemonic in a disassembly ("lock add", "rep movsb", "notrack jmp").
const PREFIXES = new Set(['lock', 'rep', 'repe', 'repz', 'repne', 'repnz', 'bnd', 'notrack', 'xacquire', 'xrelease',
  'data16', 'data32', 'addr32', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'rex', 'rex.w', '{vex}', '{vex3}', '{evex}']);
// Direct branches: their operand is an address that changes whenever the code before the target changes size.
const BRANCH = /^(?:j[a-z]{1,4}|loop[a-z]{0,2}|jrcxz|jecxz|call|xbegin)$/;
const TARGET = /^(?:0x[0-9a-f]+|[0-9a-f]+|[0-9]+|0x[0-9a-f]+ <.*>|[0-9a-f]+ <.*>)$/;

// The text of an instruction for matching, and its mnemonic. Direct branch targets are replaced by "→" so that
// "jnz 0xfffffffffffffff5" and "jnz 0xfffffffffffffff2" match.
export function normalizeInstr(label) {
  const t = String(label ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/ ?, ?/g, ', ');
  const words = t.split(' ');
  let i = 0;
  while (i < words.length - 1 && PREFIXES.has(words[i])) i++;
  const mnemonic = words[i] ?? '';
  const operands = words.slice(i + 1).join(' ');
  let key = t;
  if (BRANCH.test(mnemonic) && TARGET.test(operands)) key = [...words.slice(0, i + 1), '→'].join(' ');
  return { key, mnemonic };
}

// The instructions of a response, each with the extra uops the renamer inserts before it (regMerge, stackSync)
// added to its values: they are caused by it.
export function instructionUnits(response) {
  const rows = Array.isArray(response?.rows) ? response.rows : [];
  const n = Array.isArray(response?.columns) ? response.columns.length : 0;
  const units = [];
  let pending = [];
  const unit = (row, extras) => {
    const values = new Array(n).fill(0);
    for (const r of [...extras, row]) for (let i = 0; i < n; i++) values[i] += Number(r.values?.[i]) || 0;
    const { key, mnemonic } = row.kind === 'instr' ? normalizeInstr(row.label) : { key: `<${row.kind}>`, mnemonic: `<${row.kind}>` };
    return { label: String(row.label ?? ''), key, mnemonic, notes: row.notes ?? '', values, extras: extras.map((x) => x.kind), row };
  };
  for (const row of rows) {
    if (row.kind !== 'instr') { pending.push(row); continue; }
    units.push(unit(row, pending));
    pending = [];
  }
  for (const row of pending) units.push(unit(row, [])); // extra uops after the last instruction (not expected)
  return units;
}

// Longest common subsequence of two arrays of keys: [[i, j], ...] of the matched pairs, in order. The common
// prefix and suffix are matched first; the rest uses the quadratic table (up to `limit` cells), beyond that
// nothing more is matched.
export function lcsPairs(a, b, limit = 4e6) {
  const pairs = [];
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) { pairs.push([lo, lo]); lo++; }
  let ha = a.length, hb = b.length;
  const tail = [];
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) { ha--; hb--; tail.push([ha, hb]); }
  const n = ha - lo, m = hb - lo;
  if (n > 0 && m > 0 && n * m <= limit) {
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w); // t[i][j]: LCS length of a[lo+i..ha) and b[lo+j..hb)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = a[lo + i] === b[lo + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[lo + i] === b[lo + j]) { pairs.push([lo + i, lo + j]); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
      else j++;
    }
  }
  for (let k = tail.length - 1; k >= 0; k--) pairs.push(tail[k]);
  return pairs;
}

// Aligns two lists of instruction units: [{op, a, b}] with op
//   'same'      the same instruction text (a and b are indices)
//   'modified'  in a stretch between matches, the same mnemonic with other operands
//   'removed'   only in A (b is null),  'added'  only in B (a is null)
export function alignUnits(ua, ub) {
  const out = [];
  const gap = (a0, a1, b0, b1) => { // the unmatched stretches a0..a1 and b0..b1: pair them by mnemonic
    const pa = lcsPairs(ua.slice(a0, a1).map((u) => u.mnemonic), ub.slice(b0, b1).map((u) => u.mnemonic));
    let i = a0, j = b0;
    for (const [x, y] of pa) {
      while (i < a0 + x) out.push({ op: 'removed', a: i++, b: null });
      while (j < b0 + y) out.push({ op: 'added', a: null, b: j++ });
      out.push({ op: 'modified', a: i++, b: j++ });
    }
    while (i < a1) out.push({ op: 'removed', a: i++, b: null });
    while (j < b1) out.push({ op: 'added', a: null, b: j++ });
  };
  let i = 0, j = 0;
  for (const [x, y] of lcsPairs(ua.map((u) => u.key), ub.map((u) => u.key))) {
    gap(i, x, j, y);
    out.push({ op: 'same', a: x, b: y });
    i = x + 1; j = y + 1;
  }
  gap(i, ua.length, j, ub.length);
  return out;
}

const okResponse = (r) => !!r && typeof r === 'object' && !('error' in r) && Array.isArray(r.rows) && Array.isArray(r.columns);
const round = (v) => (Math.abs(v) < EPS ? 0 : v);

// The columns both responses have (by name), in A's order: [{name, kind, ia, ib}].
export function sharedColumns(ra, rb) {
  return ra.columns.map((name, ia) => ({ name, kind: columnKind(name), ia, ib: rb.columns.indexOf(name) })).filter((c) => c.ib >= 0);
}

// Two cycle counts (per iteration or per element) are the same when they differ by less than REL of the larger one:
// uiCA's throughputs are exact to its two decimals at about 2 cycles, and per element they can be 100× smaller, so the
// test is relative, on the unrounded values.
export const REL = 0.0025;
export const sameValue = (a, b) => Math.abs(b - a) <= REL * Math.max(Math.abs(a), Math.abs(b));
// verdict for a change of a cycle count from a to b (lower is better); verdict(delta) alone: against EPS (older form)
export function verdict(a, b) {
  if (b === undefined) return Math.abs(a) < EPS ? 'same' : a < 0 ? 'better' : 'worse';
  return sameValue(a, b) ? 'same' : b < a ? 'better' : 'worse';
}
// A cycle count as shown: two decimals, or three significant digits below 0.1 (per element: 0.0156)
export function cycles(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  return a !== 0 && a < 0.1 ? v.toPrecision(3) : v.toFixed(2);
}
// a change of a cycle count, with its sign (a real minus sign): "+1.50", "−0.00313"
export const signedCycles = (v) => `${v < 0 ? '−' : '+'}${cycles(Math.abs(v))}`;

// The comparison of two responses. workA, workB: the elements (or bytes) one iteration of A and of B processes; the
// cycle counts are divided by them before they are compared (cycles per element). scale (older form): B does the work
// of `scale` iterations of A, i.e. workA = 1, workB = scale.
// Either response may be an error ({error}) or missing: then only what can be compared is filled in.
export function compareResponses(ra, rb, { workA = 1, workB = null, scale = 1 } = {}) {
  const wa = workA > 0 ? workA : 1, wb = workB > 0 ? workB : scale > 0 ? scale : 1;
  const okA = okResponse(ra), okB = okResponse(rb);
  const out = { okA, okB, workA: wa, workB: wb, scale: wb / wa, perElement: wa !== 1 || wb !== 1, tp: null, bottlenecks: null, limits: [], diff: null };
  if (!okA || !okB) return out;
  const a = Number(ra.tp) / wa, b = Number(rb.tp) / wb;
  const v = verdict(a, b);
  const delta = v === 'same' ? 0 : b - a; // (unrounded; 0 when the same)
  out.tp = { a, b, aRaw: Number(ra.tp), bRaw: Number(rb.tp), delta, pct: a > 0 ? (100 * delta) / a : null, speedup: b > 0 ? a / b : null, verdict: v };

  const ba = ra.bottlenecks ?? [], bb = rb.bottlenecks ?? [];
  out.bottlenecks = { a: ba, b: bb, same: ba.length === bb.length && ba.every((x) => bb.includes(x)),
    gone: ba.filter((x) => !bb.includes(x)), new: bb.filter((x) => !ba.includes(x)), kept: ba.filter((x) => bb.includes(x)) };

  const names = [...new Set([...(ra.limits ?? []).map((l) => l.name), ...(rb.limits ?? []).map((l) => l.name)])];
  out.limits = names.map((name) => {
    const la = ra.limits.find((l) => l.name === name), lb = rb.limits.find((l) => l.name === name);
    const va = la ? Number(la.tp) / wa : null, vb = lb ? Number(lb.tp) / wb : null;
    return { name, a: va, b: vb, delta: va !== null && vb !== null ? (sameValue(va, vb) ? 0 : vb - va) : null,
      bottleneckA: ba.includes(name), bottleneckB: bb.includes(name) };
  });
  out.diff = diffTables(ra, rb);
  return out;
}

// The instruction-by-instruction difference of two uop tables.
//   rows:     [{status, a: unit|null, b: unit|null, deltas: [per shown column, B − A]}]
//             status: 'same' | 'changed' (same instruction, other uops) | 'modified' | 'added' | 'removed'
//   columns:  the shared columns that are shown: the issued uops and every execution port either side uses
//   totals:   the sum of the deltas per shown column
//   portsComparable: false if the two sides have different execution ports (e.g. Skylake and Zen 3)
//   counts:   rows per status
export function diffTables(ra, rb) {
  const ua = instructionUnits(ra), ub = instructionUnits(rb);
  const shared = sharedColumns(ra, rb);
  const portsA = ra.columns.filter((c) => columnKind(c) === 'port'), portsB = rb.columns.filter((c) => columnKind(c) === 'port');
  const portsComparable = portsA.length === portsB.length && portsA.every((c) => portsB.includes(c));
  const used = (c) => [ra, rb].some((r, k) => r.rows.some((x) => Number(x.values?.[k ? c.ib : c.ia]) > 0));
  const columns = shared.filter((c) => (c.name === 'Issued' || (c.kind === 'port' && portsComparable)) && used(c));
  const counts = { same: 0, changed: 0, modified: 0, added: 0, removed: 0 };
  const totals = new Array(columns.length).fill(0);
  const rows = alignUnits(ua, ub).map(({ op, a, b }) => {
    const x = a === null ? null : ua[a], y = b === null ? null : ub[b];
    const deltas = columns.map((c, k) => {
      const d = (y ? y.values[c.ib] : 0) - (x ? x.values[c.ia] : 0);
      totals[k] += d;
      return round(d);
    });
    let status = op;
    if (op === 'same') {
      const allShared = shared.every((c) => Math.abs(y.values[c.ib] - x.values[c.ia]) < EPS);
      status = allShared && x.notes === y.notes && (portsComparable || deltas.every((d) => d === 0)) ? 'same' : 'changed';
    }
    counts[status]++;
    return { status, a: x, b: y, deltas };
  });
  return { rows, columns, totals: totals.map(round), portsComparable, counts };
}

// "+0.25", "−0.5" (a real minus sign), "" for zero
export function signed(v, digits = 2) {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) < EPS) return '';
  const s = String(Math.round(Math.abs(v) * 10 ** digits) / 10 ** digits);
  return (v < 0 ? '−' : '+') + s;
}
