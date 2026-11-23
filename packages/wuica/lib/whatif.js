// The what-if experiments of the web page (web/js/whatif.js), for the MCP tool `what_if`: the block re-analyzed with one
// change each: unrolled ×2/×4/×8 (n copies of the body and the loop's branch once, per original iteration), the front end
// limited only by the issue width, macro- or micro-fusion switched; and the estimate without the loop-carried chain (the
// largest other limit, no analysis). tests-js/web_whatif.mjs checks that the variants agree with the page's.

export const VARIANTS = Object.freeze(['unroll2', 'unroll4', 'unroll8', 'simpleFrontEnd', 'noMacroFusion', 'noMicroFusion', 'nochain']);
const UNROLL = [2, 4, 8];
const FLAGS = [
  ['simpleFrontEnd', 'simple front end', 'detailed front end'],
  ['noMacroFusion', 'no macro-fusion', 'macro-fusion'],
  ['noMicroFusion', 'no micro-fusion', 'micro-fusion'],
];

// The instructions as byte ranges of the code, or null if the rows do not make up the code (undecodable bytes).
function instrRanges(response, hex) {
  const out = [];
  let at = 0;
  for (const x of response?.rows ?? []) {
    if (x.kind !== 'instr') continue;
    const op = String(x.opcode ?? '').toLowerCase();
    out.push({ start: at, op, fused: x.notes === 'M' });
    at += op.length / 2;
  }
  return out.length && out.map((i) => i.op).join('') === String(hex ?? '').toLowerCase() ? out : null;
}

// The loop unrolled n times (as the page): {ok, hex, tail} or {ok: false, reason}
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

// The experiments for a response: [{id, label, per, hex, options} | {id: 'nochain', label, estimate, per}] (as the page's
// experiments()); options: the simulation options of the base analysis.
export function experiments(response, hex, options = {}) {
  const out = [];
  for (const n of UNROLL) {
    const u = unrollHex(response, hex, n);
    if (u.ok) out.push({ id: `unroll${n}`, label: `unroll ×${n}`, per: n, hex: u.hex, options });
  }
  for (const [k, on, off] of FLAGS) {
    const v = !options?.[k];
    out.push({ id: k, label: v ? on : off, per: 1, hex: String(hex).toLowerCase(), options: { ...options, [k]: v } });
  }
  const lims = Array.isArray(response?.limits) ? response.limits : [];
  const others = lims.filter((l) => l.name !== 'Dependencies').map((l) => Number(l.tp));
  if (lims.some((l) => l.name === 'Dependencies') && others.length) out.push({ id: 'nochain', label: 'no chain', estimate: Math.max(...others), per: 1 });
  return out;
}

// The label of a variant as experiments() gives it (for the variants it does not make).
function labelOf(id, options) {
  if (id.startsWith('unroll')) return `unroll ×${id.slice(6)}`;
  const f = FLAGS.find(([k]) => k === id);
  return f ? (options?.[id] ? f[2] : f[1]) : 'no chain';
}

const round = (x) => Math.round(x * 100) / 100;

// What the tool returns for one experiment, from the base result and the variant's (or its estimate).
export function outcome(base, exp, r) {
  const row = { id: exp.id, label: exp.label };
  let tp;
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
// syntax, options}); variants: ids of VARIANTS (default: all). Resolves to {code: 0, arch, tp, mode, bottlenecks,
// variants: [{id, label, tp, delta, speedup, estimate?, bottlenecks?, error?}]} or the base's failure.
export async function whatIf(analyze, arch, request, variants = VARIANTS) {
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
  for (const exp of experiments(base, rowsHex, options)) {
    if (!want.has(exp.id)) continue;
    const r = exp.estimate !== undefined ? null : await analyze(base.arch, exp.per > 1 ? { hex: exp.hex, options: exp.options } : { ...code, options: exp.options });
    out.push(outcome(base, exp, r));
  }
  for (const id of want) {
    if (!out.some((x) => x.id === id)) out.push({ id, label: labelOf(id, options), error: base.mode !== 'loop' && id.startsWith('unroll') ? 'not a loop' : id === 'nochain' ? 'no loop-carried chain' : 'not applicable' });
  }
  out.sort((a, b) => VARIANTS.indexOf(a.id) - VARIANTS.indexOf(b.id));
  return { code: 0, arch: base.arch, tp: base.tp, mode: base.mode, bottlenecks: base.bottlenecks, unit: 'cycles per original iteration', variants: out };
}
