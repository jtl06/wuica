// What-if experiments without the DOM: the whole block re-analyzed with one change each: unrolled ×2/×4/×8 (n copies of
// the body and the loop's branch once, per original iteration), N accumulators (unrolled ×N with the chain's register
// renamed in each copy: accum.js, assembled), the front end limited only by the issue width, macro- or micro-fusion
// switched; and the estimate without the loop-carried chain (the largest other limit, no analysis). One module for the
// page (whatif.js runs the experiments on its engines and renders them) and the npm package (whatIf(), the MCP tool
// what_if; its copy in packages/wuica/lib/web, web-modules.json).

import { ACCUMULATORS, accumulatorText, bestAccumulators } from './accum.js';

export const VARIANTS = Object.freeze(['unroll2', 'unroll4', 'unroll8', 'acc2', 'acc3', 'acc4', 'acc8', 'simpleFrontEnd', 'noMacroFusion', 'noMicroFusion', 'nochain']);

const UNROLL = [2, 4, 8];

// The instructions of a response as byte ranges of the code: [{row, start, end, fused}], or null if the rows do not
// make up the code (undecodable bytes).
export function instrRanges(response, hex) {
  const rows = response?.rows;
  if (!Array.isArray(rows)) return null;
  const out = [];
  let at = 0;
  rows.forEach((x, row) => {
    if (x.kind !== 'instr') return;
    const op = String(x.opcode ?? '').toLowerCase();
    out.push({ row, start: at, end: at + op.length / 2, op, fused: x.notes === 'M' });
    at += op.length / 2;
  });
  if (!out.length || out.map((i) => i.op).join('') !== String(hex ?? '').toLowerCase()) return null;
  return out;
}

// The loop unrolled n times: n copies of the body, then the loop's branch once (with the instruction it is macro-fused
// with). Registers are not renamed: the dependencies stay; what goes is the loop overhead (n − 1 branches and their
// compares) and the front end sees a longer body. {ok, hex, tail} or {ok: false, reason}.
export function unrollHex(response, hex, n) {
  if (response?.mode !== 'loop') return { ok: false, reason: 'not a loop' };
  const ins = instrRanges(response, hex);
  if (!ins) return { ok: false, reason: 'the code has bytes that are not instructions' };
  const last = ins.length - 1;
  const tailFrom = ins[last].fused && last > 0 ? ins[last - 1].start : ins[last].start;
  if (tailFrom === 0) return { ok: false, reason: 'nothing but the branch' };
  const code = String(hex).toLowerCase();
  return { ok: true, hex: code.slice(0, 2 * tailFrom).repeat(n) + code.slice(2 * tailFrom), tail: tailFrom === ins[last].start ? 1 : 2 };
}

const FLAGS = [
  ['simpleFrontEnd', 'simple front end', 'detailed front end', 'a front end limited only by the issue width (uiCA -simpleFrontEnd); not always faster'],
  ['noMacroFusion', 'no macro-fusion', 'macro-fusion', 'compare and branch not fused (uiCA -noMacroFusion)'],
  ['noMicroFusion', 'no micro-fusion', 'micro-fusion', 'load and operation not fused (uiCA -noMicroFusion)'],
];

// The experiments for a response: [{id, label, title, hex, options, per}] (analyses) and, if the chain is a limit,
// {id: 'nochain', label, estimate, title} (no analysis: the largest other limit, as uiCA computes them).
// The accumulator variants have `text` (assembly, accum.js) instead of hex until it is assembled, and `renamed` (the
// chain's registers and those of the copies); one that cannot be made has `error` (one row, 'acc').
//   options: the request's options (alignmentOffset, ..., without hex, arch, includeTrace)
export function experiments(response, hex, options) {
  const out = [];
  for (const n of UNROLL) {
    const u = unrollHex(response, hex, n);
    if (u.ok) out.push({ id: `unroll${n}`, label: `unroll ×${n}`, per: n, hex: u.hex, options,
      title: `${n} copies of the loop body and one branch${u.tail === 2 ? ' (with its macro-fused compare)' : ''}; registers not renamed, so the dependencies stay; per original iteration` });
  }
  if (response?.mode === 'loop' && response.criticalPath?.edges?.length) {
    for (const n of ACCUMULATORS) {
      const a = accumulatorText(response, hex, n);
      // none possible: one row with the reason; a larger N alone (no free registers left): its row with the reason
      if (!a.ok && n === ACCUMULATORS[0]) { out.push({ id: 'acc', label: 'accumulators', per: 1, error: a.reason, options, title: `N accumulators: ${a.reason}` }); break; }
      if (!a.ok) { out.push({ id: `acc${n}`, label: `${n} accumulators`, per: n, error: a.reason, options, title: `${n} accumulators: ${a.reason}` }); continue; }
      const names = a.renamed.map((x) => `${x.from} → ${x.to.join(', ')}`).join('; ');
      out.push({ id: `acc${n}`, label: `${n} accumulators`, per: n, text: a.text, options, renamed: a.renamed,
        title: `unrolled ×${n} with the chain's register renamed in each copy (${names}): ${n} independent chains; per original iteration` });
    }
  }
  for (const [k, on, off, what] of FLAGS) {
    const v = !options?.[k];
    out.push({ id: k, label: v ? on : off, per: 1, hex: String(hex).toLowerCase(), options: { ...options, [k]: v }, title: v ? what : `${off} (as without uiCA -${k})` });
  }
  const lims = Array.isArray(response?.limits) ? response.limits : [];
  const dep = lims.find((l) => l.name === 'Dependencies');
  const others = lims.filter((l) => l.name !== 'Dependencies').map((l) => Number(l.tp));
  if (dep && others.length) {
    const est = Math.max(...others);
    out.push({ id: 'nochain', label: 'no chain', estimate: est, per: 1,
      title: `at best the largest other limit (${lims.filter((l) => l.name !== 'Dependencies' && Number(l.tp) === est).map((l) => l.name).join(', ')}): an estimate without the loop-carried dependencies, not a simulation` });
  }
  return out;
}

// One result line of the page: {tp (per original iteration), delta, speedup, comparable} from a summary ({tp, mode} or
// {error}).
export function outcome(base, exp, r) {
  if (exp.error) return { error: exp.error };
  if (exp.estimate !== undefined) {
    const tp = exp.estimate;
    return { tp, delta: tp - base.tp, speedup: tp > 0 ? base.tp / tp : Infinity, estimate: true };
  }
  if (!r) return null;
  if (r.error) return { error: r.error };
  if (r.mode && base.mode && r.mode !== base.mode) return { error: `analyzed ${r.mode === 'loop' ? 'as a loop' : 'unrolled'}: not comparable` };
  const tp = r.tp / exp.per;
  return { tp, delta: tp - base.tp, speedup: tp > 0 ? base.tp / tp : Infinity };
}

// The size of an experiment relative to the block (the time of its analysis grows about linearly).
export const weight = (exp, baseBytes) => (exp.estimate !== undefined || exp.error ? 0 : exp.hex ? (exp.hex.length / 2) / Math.max(1, baseBytes) : exp.per);

// The best number of accumulators from the base throughput and the results of the accumulator variants ({n, tp} or
// null if none has a result).
export function bestOf(baseTp, exps, results) {
  const tps = new Map([[1, Number(baseTp)]]);
  for (const x of exps) {
    if (!/^acc\d+$/.test(x.id)) continue;
    const r = results.get(x.id);
    if (r && !r.error && Number.isFinite(r.tp)) tps.set(x.per, r.tp / x.per);
  }
  return tps.size > 1 ? bestAccumulators(tps) : null;
}

// ---- the package's whatIf (the MCP tool what_if, the CLI's -whatif) -------------------------------------------------

// The label of a variant as experiments() gives it (for the variants it does not make).
function labelOf(id, options) {
  if (id.startsWith('unroll')) return `unroll ×${id.slice(6)}`;
  if (id.startsWith('acc')) return `${id.slice(3)} accumulators`;
  const f = FLAGS.find(([k]) => k === id);
  return f ? (options?.[id] ? f[2] : f[1]) : 'no chain';
}

const round = (x) => Math.round(x * 100) / 100;

// What the package returns for one experiment, from the base result and the variant's (or its estimate).
export function toolOutcome(base, exp, r) {
  const row = { id: exp.id, label: exp.label };
  if (exp.renamed) row.renamed = exp.renamed;
  let tp;
  if (exp.error) return { ...row, error: exp.error };
  if (exp.estimate !== undefined) { tp = exp.estimate; row.estimate = true; }
  else if (!r || r.code !== 0) {
    const error = r?.error ?? 'not analyzed';
    // a limit or failure of the unrolled code, not of the caller's block: say so
    return { ...row, error: exp.per > 1 && exp.hex ? `the block unrolled ×${exp.per} (${exp.hex.length} hex characters) could not be analyzed: ${error}` : error };
  }
  else if (r.mode !== base.mode) return { ...row, error: `analyzed ${r.mode === 'loop' ? 'as a loop' : 'unrolled'}: not comparable` };
  else { tp = r.tp / exp.per; row.bottlenecks = r.bottlenecks; }
  return { ...row, tp: round(tp), delta: round(tp - base.tp), speedup: tp > 0 ? round(base.tp / tp) : null };
}

// Runs the experiments with analyze(arch, {hex, options}) (one after another). request: as analyze's ({source | hex,
// syntax, loop, options}); variants: ids of VARIANTS (default: all); assemble(text) -> {code, hex} (the accumulator
// variants; Intel syntax). Resolves to {code: 0, arch, tp, mode, bottlenecks, loop?, variants: [{id, label, tp, delta,
// speedup, estimate?, bottlenecks?, renamed?, error?}], accumulators?: {best, tp}} or the base's failure.
//   accumulators: the best number of accumulators (the smallest within 1% of the fastest, 1 = as it is) among those run.
export async function whatIf(analyze, arch, request, variants = VARIANTS, { assemble = null } = {}) {
  const unknown = (variants ?? []).filter((v) => !VARIANTS.includes(v));
  if (unknown.length) return { code: 1, error: `unknown variant(s): ${unknown.join(', ')} (known: ${VARIANTS.join(', ')})`, stderr: [] };
  const base = await analyze(arch, request);
  if (base.code !== 0) return base;
  // the code as the rows have it (the analyzed bytes, if every byte was decoded), for the unrolled copies; the other
  // variants analyze the caller's code as given (hex in any form the library accepts, or the assembled bytes)
  const rowsHex = base.decodeErrors ? '' : base.rows.filter((x) => x.kind === 'instr').map((x) => String(x.opcode ?? '').toLowerCase()).join('');
  const code = base.hex !== undefined ? { hex: base.hex } : { hex: request.hex };
  const options = { ...(request.options ?? {}) };
  const want = new Set(variants ?? VARIANTS);
  const out = [];
  // the alignment offset the base got from the code's addresses (objdump input) holds for the variants too
  if (options.alignmentOffset === undefined && request.alignmentOffset === undefined && base.loop?.alignmentOffset !== undefined) options.alignmentOffset = base.loop.alignmentOffset;
  const exps = experiments(base, rowsHex, options);
  const accError = exps.find((x) => x.id === 'acc')?.error;
  for (const exp of exps) {
    if (!want.has(exp.id)) continue;
    if (exp.text && !exp.hex) {
      const a = assemble ? await assemble(exp.text) : null;
      if (a?.code === 0 && a.hex) exp.hex = a.hex;
      else { out.push(toolOutcome(base, { ...exp, error: a ? `the variant does not assemble: ${a.error}` : 'no assembler' }, null)); continue; }
    }
    const r = exp.estimate !== undefined ? null : await analyze(base.arch, exp.per > 1 ? { hex: exp.hex, options: exp.options } : { ...code, options: exp.options });
    out.push(toolOutcome(base, exp, r));
  }
  for (const id of want) {
    if (!out.some((x) => x.id === id)) {
      out.push({ id, label: labelOf(id, options), error: base.mode !== 'loop' && (id.startsWith('unroll') || id.startsWith('acc')) ? 'not a loop' : id === 'nochain' || id.startsWith('acc') ? (id.startsWith('acc') && accError) || 'no loop-carried chain' : 'not applicable' });
    }
  }
  out.sort((a, b) => VARIANTS.indexOf(a.id) - VARIANTS.indexOf(b.id));
  const accs = out.filter((x) => x.id.startsWith('acc') && x.tp !== undefined);
  const best = accs.length ? bestAccumulators(new Map([[1, base.tp], ...accs.map((x) => [Number(x.id.slice(3)), x.tp])])) : null;
  return { code: 0, arch: base.arch, tp: base.tp, mode: base.mode, bottlenecks: base.bottlenecks, ...(base.loop ? { loop: base.loop } : {}), unit: 'cycles per original iteration', variants: out,
    ...(best ? { accumulators: { best: best.n, tp: round(best.tp) } } : {}) };
}
