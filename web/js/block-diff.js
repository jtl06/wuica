// Two blocks, A (before) and B (after), on one microarchitecture: one result object for `wuica diff`, the MCP tool
// diff_blocks and POST /api/diff/<arch>. Throughput before and after, speed-up, per element when both sides give their
// elements per iteration, bottlenecks and limits before and after, the change of each port's uops, the instructions that
// were added, removed or changed (ab-diff.js: the alignment of the page's A–B view), and each side's decode errors and
// warnings. No DOM; the package's copy is in packages/wuica/lib/web (web-modules.json).
//
// Numbers as compare and what-if give them: tp and the limits as the analyzer gives them (two decimals), delta and
// speedup rounded to two decimals, perElement tp / per unrounded (as compare's and what-if's perElement), the uop changes
// rounded to two decimals as the uop table shows them.

import { compareResponses, MINOR } from './ab-diff.js';
import { compare as compareMarkdown, shownLabels, text as mdText } from './markdown.js';

const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const side = (r, per) => ({
  tp: r.tp, mode: r.mode, bottlenecks: r.bottlenecks, decodeErrors: r.decodeErrors ?? 0,
  ...(r.unsupported ? { unsupported: r.unsupported } : {}), // (the CPU cannot run this side's code: caveats.js cannotRun)
  ...(per ? { perElement: r.tp / per } : {}), ...(r.loop ? { loop: r.loop } : {}),
  ...(r.stderr?.length ? { stderr: r.stderr } : {}),
});

// A's and B's modes differ (a loop against a block run unrolled): not comparable, as what-if says of such a variant.
const modeName = (m) => (m === 'loop' ? 'as a loop' : 'unrolled (it does not end with a branch)');
function notComparable(ra, rb) {
  const error = `not comparable: A is analyzed ${modeName(ra.mode)}, B ${modeName(rb.mode)}`;
  return { code: 1, error, stderr: [{ text: error }] };
}

// The result from the two analyze() responses (or the failure for a mode mismatch). opts: {per: [elements per iteration
// of A, of B] (both or none), sourceA, sourceB (the assembly text: branch targets as its labels)}.
/** @param {any} ra @param {any} rb @param {{per?: number[] | null, sourceA?: string | null, sourceB?: string | null}} [opts] @returns {any} */
export function diffResult(ra, rb, { per = null, sourceA = null, sourceB = null } = {}) {
  if (ra.mode !== rb.mode) return notComparable(ra, rb);
  const [pa, pb] = per ?? [null, null];
  const cmp = compareResponses(ra, rb);
  const t = cmp.tp;
  // a side the CPU cannot run (unsupported, caveats.js cannotRun): its number is no result, so neither are the change
  // and the speedup: verdict "not comparable", no delta, no speedup, in every form
  const no = !!(ra.unsupported || rb.unsupported);
  /** @type {any} */
  const out = { code: 0, arch: ra.arch, a: side(ra, pa), b: side(rb, pb), ...(no ? { verdict: 'not comparable' } : { delta: r2(t.delta), speedup: r2(t.speedup), verdict: t.verdict }) };
  if (pa && pb) {
    const pe = compareResponses(ra, rb, { workA: pa, workB: pb }).tp;
    out.perElement = { a: ra.tp / pa, b: rb.tp / pb, ...(no ? { verdict: 'not comparable' } : { delta: pe.delta, speedup: r2(pe.speedup), verdict: pe.verdict }) };
  }
  out.bottlenecks = { a: cmp.bottlenecks.a, b: cmp.bottlenecks.b, gone: cmp.bottlenecks.gone, new: cmp.bottlenecks.new };
  out.limits = cmp.limits.map((l) => ({ name: l.name, a: l.a, b: l.b, delta: r2(l.delta) }));
  // uops per iteration of each port (the ports both sides have), and the change
  const d = cmp.diff;
  const total = (r, i) => Number(r2(r.rows.reduce((s, x) => s + (Number(x.values?.[i]) || 0), 0)));
  out.ports = d.portsComparable ? d.columns.filter((c) => c.kind === 'port').map((c) => ({ port: c.name, a: total(ra, c.ia), b: total(rb, c.ib), delta: r2(total(rb, c.ib) - total(ra, c.ia)) })) : [];
  // the instructions that differ (branch targets as labels where the text gives them)
  const labels = new Map();
  for (const [r, source] of [[ra, sourceA], [rb, sourceB]]) shownLabels(r, typeof source === 'string' ? { source } : {}).forEach((l, i) => labels.set(r.rows[i], l));
  const label = (u) => (u ? labels.get(u.row) ?? u.label : null);
  out.instructions = {
    counts: d.counts,
    changes: d.rows.filter((x) => x.status !== 'same').map((x) => ({
      status: x.status, a: label(x.a), b: label(x.b),
      uops: Object.fromEntries(d.columns.map((c, k) => [c.name === 'Issued' ? 'issued' : c.name, r2(x.deltas[k])]).filter(([, v]) => v !== 0)),
      ...(x.minor ? { minor: true } : {}), // (ab-diff.js MINOR: left out of the Markdown and the text)
    })),
  };
  // the warnings of each side (decode errors, assembler warnings, the exits taken as not taken), named
  const warnings = [...(ra.stderr ?? []).map((l) => ({ ...l, text: `A: ${l.text}` })), ...(rb.stderr ?? []).map((l) => ({ ...l, text: `B: ${l.text}` }))];
  if (warnings.length) out.stderr = warnings;
  return out;
}

// The two analyses and the result: {result, a, b} (a, b: the analyze() responses), or {failure}. request: {a: {source
// | hex, syntax, loop, func, options?}, b: {...}, options?, per?: N | [A, B]}; `options` apply to both sides unless a
// side has its own. w: anything with analyze(arch, request) (and resolveArch). A failure names the side ("A: ", "B: ")
// only when it belongs to that side.
/** @param {any} w @param {string} arch @param {any} request @returns {Promise<any>} */
export async function diffAnalyses(w, arch, request) {
  const bad = (error, code = 1) => ({ failure: { code, error, stderr: [{ text: error }] } });
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return bad('the request must be an object');
  const unknown = Object.keys(request).filter((k) => !['a', 'b', 'options', 'per'].includes(k));
  if (unknown.length) return bad(`unknown request field(s): ${unknown.join(', ')} (known: a, b, options, per)`);
  for (const k of ['a', 'b']) {
    const x = request[k];
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return bad(`\`${k}\` must be a block: {source | hex, syntax?, loop?, func?, options?}`);
  }
  if (request.options !== undefined && (request.options === null || typeof request.options !== 'object' || Array.isArray(request.options))) return bad('`options` must be an object');
  let per = request.per ?? null;
  if (per !== null) {
    if (typeof per === 'number') per = [per, per];
    const ok = Array.isArray(per) && per.length === 2 && per.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
    if (!ok) return bad('`per` must be a positive number (elements per iteration of both) or [A, B]');
  }
  if (typeof w.resolveArch === 'function' && !w.resolveArch(arch)) {
    const r = await w.analyze(arch, request.a); // the library's message for an unknown microarchitecture
    if (r.code) return { failure: r };
  }
  const one = (x) => (request.options !== undefined && x.options === undefined ? { ...x, options: request.options } : x);
  // an error of the options both sides share is the request's, not a side's
  const named = (k, r) => {
    const shared = request.options !== undefined && request[k].options === undefined && /option/.test(r.error ?? '');
    return { failure: shared ? r : { ...r, error: `${k.toUpperCase()}: ${r.error}` } };
  };
  const ra = await w.analyze(arch, one(request.a));
  if (ra.code) return named('a', ra);
  const rb = await w.analyze(arch, one(request.b));
  if (rb.code) return named('b', rb);
  const text = (x) => (typeof x.source === 'string' ? x.source : null);
  const result = diffResult(ra, rb, { per, sourceA: text(request.a), sourceB: text(request.b) });
  if (result.code) return { failure: result };
  return { result, a: ra, b: rb, per, sourceA: text(request.a), sourceB: text(request.b) };
}

// diffAnalyses' result alone, or its failure.
/** @param {any} w @param {string} arch @param {any} request @returns {Promise<any>} */
export async function diffRequest(w, arch, request) {
  const x = await diffAnalyses(w, arch, request);
  return x.failure ?? x.result;
}

// Markdown of diffAnalyses' result (markdown.js compare: the page's A–B tables) with the microarchitecture named
// (opts.archTitle, e.g. "SKL · Skylake (2015)") and each side's warnings, or of its failure.
/** @param {any} x @param {{archTitle?: string}} [opts] */
export function diffMarkdown(x, { archTitle } = {}) {
  if (x.failure) return `**diff failed:** ${mdText(x.failure.error)}\n`;
  const [pa, pb] = x.per ?? [1, 1];
  const shownA = shownLabels(x.a, typeof x.sourceA === 'string' ? { source: x.sourceA } : {});
  const shownB = shownLabels(x.b, typeof x.sourceB === 'string' ? { source: x.sourceB } : {});
  const head = `**A–B on ${mdText(archTitle ?? x.result.arch)}**\n\n`;
  const warnings = (x.result.stderr ?? []).map((l) => `- ${mdText(l.text)}`).join('\n');
  return head + compareMarkdown(x.a, x.b, { workA: pa, workB: pb, shownA, shownB }) + (warnings ? `\n${warnings}\n` : '');
}

// The result as text (the CLI without -md, the REST API's text/plain): cycles with two decimals, per element as the CLI
// prints it (three significant digits below 0.1).
const f2 = (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const fe = (v) => (v === null || v === undefined ? '-' : v !== 0 && Math.abs(v) < 0.1 ? Number(v).toPrecision(3) : f2(v));
const sg = (v, f = f2) => (v === null || v === undefined ? '' : `${v > 0 ? '+' : ''}${f(v)}`);
export function diffText(r) {
  if (r.code) return `diff failed: ${r.error}\n`;
  const pct = r.a.tp > 0 ? ` ${sg((100 * (r.b.tp - r.a.tp)) / r.a.tp, (v) => Number(v).toFixed(1))}%` : '';
  // a side whose code the CPU cannot run (unsupported): its number is no result, so no verdict
  const bad = [['A', r.a.unsupported], ['B', r.b.unsupported]].filter(([, x]) => x).map(([k, x]) => `${k} ${x}`);
  const verdict = (v, same) => (bad.length ? `not comparable: ${bad.join(', ')}` : same ? 'the same' : v);
  const lines = [`${r.arch}: A ${f2(r.a.tp)}  B ${f2(r.b.tp)} cycles per iteration  (${verdict(`${sg(r.delta)},${pct}; speedup ${f2(r.speedup)}x`, r.verdict === 'same')})`];
  if (r.perElement) lines.push(`per element: A ${fe(r.perElement.a)}  B ${fe(r.perElement.b)}  (${verdict(`${sg(r.perElement.delta, fe)}; speedup ${f2(r.perElement.speedup)}x`, r.perElement.verdict === 'same')})`);
  const names = (xs) => (xs.length ? xs.join(', ') : 'unknown');
  lines.push(`bottleneck: A ${names(r.bottlenecks.a)} -> B ${names(r.bottlenecks.b)}`);
  for (const l of r.stderr ?? []) lines.push(`warning: ${l.text.replace(/^([AB]: )Warning: /, '$1')}`);
  const w = Math.max(5, ...r.limits.map((l) => l.name.length));
  lines.push('', `  ${'limit'.padEnd(w)}  ${'A'.padStart(7)}  ${'B'.padStart(7)}  ${'delta'.padStart(7)}`);
  for (const l of r.limits) lines.push(`  ${l.name.padEnd(w)}  ${f2(l.a).padStart(7)}  ${f2(l.b).padStart(7)}  ${(l.delta ? sg(l.delta) : '').padStart(7)}`.trimEnd());
  const moved = r.ports.filter((p) => Math.abs(p.delta) >= MINOR); // (a change under MINOR, as the instructions': not listed)
  lines.push('', `ports (uops per iteration): ${moved.length ? moved.map((p) => `${p.port} ${f2(p.a)} -> ${f2(p.b)}`).join(', ') : 'no change'}`);
  // (minor changes of uops, ab-diff.js MINOR, are counted as the same and not listed)
  const minor = r.instructions.changes.filter((x) => x.minor).length;
  const c = { ...r.instructions.counts, changed: r.instructions.counts.changed - minor };
  const said = [['modified', 'with other operands'], ['changed', 'with other uops'], ['added', 'only in B'], ['removed', 'only in A']].filter(([k]) => c[k]).map(([k, t]) => `${c[k]} ${t}`);
  lines.push(`instructions: ${said.length ? said.join('; ') : 'the same'}${minor ? ` (changes under ${MINOR} uops not listed: ${minor})` : ''}`);
  const MARK = { changed: '*', modified: '~', added: '+', removed: '-' };
  for (const x of r.instructions.changes.filter((y) => !y.minor)) {
    const what = x.status === 'added' ? x.b : x.status === 'removed' ? x.a : x.status === 'modified' ? `${x.a} -> ${x.b}` : x.a;
    const uops = Object.entries(x.uops).map(([k, v]) => `${k} ${sg(v)}`).join(', ');
    lines.push(`  ${MARK[x.status]} ${what}${uops ? `  (${uops})` : ''}`);
  }
  if (said.length) lines.push(`  (~ other operands, * same instruction with other uops, + only in B, - only in A; uops per iteration, B - A)`);
  return lines.join('\n') + '\n';
}
