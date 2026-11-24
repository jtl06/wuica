// What-if experiments without the DOM: the whole block re-analyzed with one change each: unrolled ×2/×4/×8 (n copies of
// the body and the loop's branch once, per original iteration), N accumulators (unrolled ×N with the chain's register
// renamed in each copy: accum.js, assembled), the front end limited only by the issue width, macro- or micro-fusion
// switched; and the estimate without the loop-carried chain (the largest other limit, no analysis). One module for the
// page (whatif.js runs the experiments on its engines and renders them) and the npm package (whatIf(), the MCP tool
// what_if; its copy in packages/wuica/lib/web, web-modules.json).

import { ACCUMULATORS, accumulatorText, bestAccumulators } from './accum.js';

export const VARIANTS = Object.freeze(['unroll2', 'unroll4', 'unroll8', 'acc2', 'acc3', 'acc4', 'acc8', 'simpleFrontEnd', 'noMacroFusion', 'noMicroFusion', 'nochain']);
// Variants that run only when asked for (not in the default set): align, the block at each of the 64 alignment offsets
// (64 analyses: min, median, max, the best and the worst offset, the spread).
export const OPT_IN_VARIANTS = Object.freeze(['align']);
const ALL_VARIANTS = [...VARIANTS, ...OPT_IN_VARIANTS];

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
  if (id === 'align') return 'alignment 0-63';
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
/**
 * @param {(arch: string, request: any) => Promise<any>} analyze
 * @param {string} arch
 * @param {any} request
 * @param {readonly string[] | null} [variants]
 * @param {{assemble?: ((text: string) => Promise<any>) | null}} [tools]
 */
export async function whatIf(analyze, arch, request, variants = VARIANTS, { assemble = null } = {}) {
  const unknown = (variants ?? []).filter((v) => !ALL_VARIANTS.includes(v));
  if (unknown.length) return { code: 1, error: `unknown variant(s): ${unknown.join(', ')} (known: ${ALL_VARIANTS.join(', ')})`, stderr: [] };
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
  // an analysis that says the request stops (notRun: a server's deadline for the whole request, a busy server): the
  // variants without a result are "not run: <why>"; what finished stays
  let halt = null;
  const notRun = (exp) => ({ id: exp.id, label: labelOf(exp.id, options), error: `not run: ${halt}` });
  for (const exp of exps) {
    if (!want.has(exp.id)) continue;
    if (exp.estimate !== undefined) { out.push(toolOutcome(base, exp, null)); continue; } // (no analysis: nochain)
    if (halt) { out.push(notRun(exp)); continue; }
    if (exp.text && !exp.hex) {
      const a = assemble ? await assemble(exp.text) : null;
      if (a?.notRun) { halt = a.notRun; out.push(notRun(exp)); continue; }
      if (a?.code === 0 && a.hex) exp.hex = a.hex;
      else { out.push(toolOutcome(base, { ...exp, error: a ? `the variant does not assemble: ${a.error}` : 'no assembler' }, null)); continue; }
    }
    const r = await analyze(base.arch, exp.per > 1 ? { hex: exp.hex, options: exp.options } : { ...code, options: exp.options });
    if (r?.notRun) { halt = r.notRun; out.push(notRun(exp)); continue; }
    out.push(toolOutcome(base, exp, r));
  }
  if (want.has('align')) {
    if (halt) out.push(notRun({ id: 'align' }));
    else {
      const { notRun: why, ...a } = await alignment(analyze, base, code, options);
      if (why) halt = why;
      out.push(a);
    }
  }
  for (const id of want) {
    if (!out.some((x) => x.id === id)) {
      out.push({ id, label: labelOf(id, options), error: base.mode !== 'loop' && (id.startsWith('unroll') || id.startsWith('acc')) ? 'not a loop' : id === 'nochain' || id.startsWith('acc') ? (id.startsWith('acc') && accError) || 'no loop-carried chain' : 'not applicable' });
    }
  }
  out.sort((a, b) => ALL_VARIANTS.indexOf(a.id) - ALL_VARIANTS.indexOf(b.id));
  // (the best number of accumulators only when every accumulator variant asked for has run)
  const accs = out.filter((x) => x.id.startsWith('acc') && x.tp !== undefined);
  const accsCut = out.some((x) => x.id.startsWith('acc') && /^not run: /.test(x.error ?? ''));
  const best = accs.length && !accsCut ? bestAccumulators(new Map([[1, base.tp], ...accs.map((x) => /** @type {[number, number]} */ ([Number(x.id.slice(3)), x.tp]))])) : null;
  // (the base's decode errors and warnings: they hold for the variants too; and how many variants were not run)
  const skipped = halt ? out.filter((x) => /^not run: /.test(x.error ?? '')).length : 0;
  const stderr = [...(base.stderr ?? []), ...(halt ? [{ text: `Warning: ${skipped} of ${out.length} variant(s) not run: ${halt}` }] : [])];
  return { code: 0, arch: base.arch, tp: base.tp, mode: base.mode, bottlenecks: base.bottlenecks, ...(base.loop ? { loop: base.loop } : {}),
    ...(base.decodeErrors ? { decodeErrors: base.decodeErrors } : {}), ...(stderr.length ? { stderr } : {}), ...(halt ? { notRun: halt } : {}),
    unit: 'cycles per original iteration', variants: out, ...(best ? { accumulators: { best: best.n, tp: round(best.tp) } } : {}) };
}

// The variant align: the code at each alignment offset 0-63 (64 analyses with the other options as given). tp is the
// median; alignment: {min, median, max, best, worst (the first offset with the minimum, the maximum), spread (max - min),
// offset (the base's, 0-63: the analyzer reads an offset modulo 64)}. A failed analysis at any offset: the variant's error.
/** @returns {Promise<any>} */
async function alignment(analyze, base, code, options) {
  const row = { id: 'align', label: labelOf('align') };
  const tps = [];
  for (let k = 0; k < 64; k++) {
    const r = await analyze(base.arch, { ...code, options: { ...options, alignmentOffset: k } });
    if (r.notRun) return { ...row, notRun: r.notRun, error: `not run: ${r.notRun} (${k} of the 64 offsets analyzed)` };
    if (r.code !== 0) return { ...row, error: `alignment offset ${k}: ${r.error}` };
    if (r.mode !== base.mode) return { ...row, error: `alignment offset ${k}: analyzed ${r.mode === 'loop' ? 'as a loop' : 'unrolled'}` };
    tps.push(r.tp);
  }
  const sorted = [...tps].sort((a, b) => a - b);
  const min = sorted[0], max = sorted[63], median = round((sorted[31] + sorted[32]) / 2);
  return { ...row, tp: median, delta: round(median - base.tp), speedup: median > 0 ? round(base.tp / median) : null,
    alignment: { min, median, max, best: tps.indexOf(min), worst: tps.indexOf(max), spread: round(max - min), offset: ((Number(options.alignmentOffset ?? 0) % 64) + 64) % 64 } };
}

// ---- per element and as text (the CLI's -whatif, the REST API's text/plain) ------------------------------------------------

// A what-if result with cycles per element (`per` elements per original iteration): elementsPerIteration and perElement on
// it, perElement on each variant with a tp. Unchanged without `per` or for a failure.
export function whatIfPerElement(x, per) {
  if (!per || x.code) return x;
  return { ...x, elementsPerIteration: per, perElement: x.tp / per, variants: x.variants.map((v) => (v.tp !== undefined ? { ...v, perElement: v.tp / per } : v)) };
}

const fmt2 = (x) => Number(x).toFixed(2);
// cycles per element: 3 significant digits under 0.1 (0.0625, 0.0313), else two decimals
const fmtEl = (x) => (x !== 0 && Math.abs(x) < 0.1 ? Number(x).toPrecision(3) : fmt2(x));
const VARIANT_W = 18;

// The what-if table as text (per element with elementsPerIteration); a failure as one line.
export function whatIfText(x) {
  if (x.code) return `What if (${x.arch ?? ''}): ${x.error}\n`;
  const per = x.elementsPerIteration;
  const f = per ? (v) => fmtEl(v / per) : fmt2;
  const rows = x.variants.map((v) => (v.error ? `  ${v.label.padEnd(VARIANT_W)} ${'-'.padStart(8)}  ${v.error}`
    : `  ${v.label.padEnd(VARIANT_W)} ${`${v.estimate ? '>=' : ''}${f(v.tp)}`.padStart(8)} ${`${v.delta > 0 ? '+' : ''}${f(v.delta)}`.padStart(8)} ${`${fmt2(v.speedup ?? 0)}x`.padStart(7)}`));
  return [per ? `What if (${x.arch}), cycles per element (${per} per original iteration; base ${fmtEl(x.tp / per)}):` : `What if (${x.arch}), cycles per original iteration (base ${fmt2(x.tp)}):`,
    `  ${'variant'.padEnd(VARIANT_W)} ${'cycles'.padStart(8)} ${'delta'.padStart(8)} ${'speedup'.padStart(7)}`, ...rows,
    ...(x.accumulators ? [`  best number of accumulators: ${x.accumulators.best}${x.accumulators.best === 1 ? ' (as it is)' : ''}`] : []),
    ...x.variants.filter((v) => v.alignment).map((v) => { const a = v.alignment; return `  alignment over 64 offsets: min ${f(a.min)} (offset ${a.best}), median ${f(a.median)}, max ${f(a.max)} (offset ${a.worst}), spread ${f(a.spread)}; this block at offset ${a.offset}`; }),
    ...(x.stderr ?? []).map((l) => `  warning: ${String(l.text).replace(/^Warning: /, '')}`)].join('\n') + '\n';
}

// The what-if of a request as the interfaces take it (the library's whatIf method, the MCP tool what_if, the REST API's
// POST /api/what-if/<arch>): w has analyze(arch, request) and assemble(text, syntax); request is analyze's ({source | hex,
// syntax, loop, func, options}) with `variants` (ids of VARIANTS, default all) and `per` (elements per original
// iteration: also cycles per element). Resolves to whatIf's result (whatIfPerElement with `per`) or a failure.
/** @param {any} w @param {string} arch @param {any} [request] @returns {Promise<any>} */
export async function whatIfRequest(w, arch, request = {}) {
  const bad = (error) => ({ code: 1, error, stderr: [{ text: error }] });
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return bad('the request must be an object');
  const { variants, per, ...rest } = request;
  if (variants !== undefined && !Array.isArray(variants)) return bad('`variants` must be an array of variant ids');
  if (per !== undefined && !(typeof per === 'number' && Number.isFinite(per) && per > 0)) return bad('`per` must be a positive number (elements per iteration)');
  const x = await whatIf((a, r) => w.analyze(a, r), arch, rest, variants ?? VARIANTS, { assemble: (text) => w.assemble(text, 'intel') });
  return whatIfPerElement(x, per);
}
