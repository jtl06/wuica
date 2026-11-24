// Two blocks, A (before) and B (after), on one microarchitecture: one result object for `wuica diff`, the MCP tool
// diff_blocks and POST /api/diff/<arch>. Throughput before and after, speed-up, per element when both sides give their
// elements per iteration, bottlenecks and limits before and after, the change of each port's uops, and the instructions
// that were added, removed or changed (ab-diff.js: the alignment of the page's A–B view). No DOM; the package's copy is
// in packages/wuica/lib/web (web-modules.json).

import { compareResponses } from './ab-diff.js';
import { compare as compareMarkdown, shownLabels } from './markdown.js';

const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(3)) : null);
const side = (r, per) => ({ tp: r.tp, mode: r.mode, bottlenecks: r.bottlenecks, ...(per ? { perElement: r3(r.tp / per) } : {}), ...(r.loop ? { loop: r.loop } : {}) });

// The result from the two analyze() responses. opts: {per: [elements per iteration of A, of B] (both or none),
// sourceA, sourceB (the assembly text: branch targets as its labels)}.
/** @param {any} ra @param {any} rb @param {{per?: number[] | null, sourceA?: string | null, sourceB?: string | null}} [opts] */
export function diffResult(ra, rb, { per = null, sourceA = null, sourceB = null } = {}) {
  const [pa, pb] = per ?? [null, null];
  const cmp = compareResponses(ra, rb);
  const t = cmp.tp;
  const out = {
    code: 0, arch: ra.arch, a: side(ra, pa), b: side(rb, pb),
    delta: r2(t.delta), speedup: r2(t.speedup), verdict: t.verdict,
  };
  if (pa && pb) {
    const pe = compareResponses(ra, rb, { workA: pa, workB: pb }).tp;
    out.perElement = { a: r3(pe.a), b: r3(pe.b), delta: r3(pe.delta), speedup: r2(pe.speedup), verdict: pe.verdict };
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
      uops: Object.fromEntries(d.columns.map((c, k) => [c.name === 'Issued' ? 'issued' : c.name, x.deltas[k]]).filter(([, v]) => v !== 0)),
    })),
  };
  return out;
}

// The two analyses and the result: {result, a, b} (a, b: the analyze() responses), or {failure} with the failing side
// named. request: {a: {source | hex, syntax, loop, func, options?}, b: {...}, options?, per?: N | [A, B]}; `options`
// apply to both sides unless a side has its own. w: anything with analyze(arch, request).
/** @param {any} w @param {string} arch @param {any} request @returns {Promise<any>} */
export async function diffAnalyses(w, arch, request) {
  const bad = (error) => ({ failure: { code: 1, error, stderr: [{ text: error }] } });
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return bad('the request must be an object');
  const unknown = Object.keys(request).filter((k) => !['a', 'b', 'options', 'per'].includes(k));
  if (unknown.length) return bad(`unknown request field(s): ${unknown.join(', ')} (known: a, b, options, per)`);
  for (const k of ['a', 'b']) {
    const x = request[k];
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return bad(`\`${k}\` must be a block: {source | hex, syntax?, loop?, func?, options?}`);
  }
  let per = request.per ?? null;
  if (per !== null) {
    if (typeof per === 'number') per = [per, per];
    const ok = Array.isArray(per) && per.length === 2 && per.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
    if (!ok) return bad('`per` must be a positive number (elements per iteration of both) or [A, B]');
  }
  const one = (x) => (request.options !== undefined && x.options === undefined ? { ...x, options: request.options } : x);
  const ra = await w.analyze(arch, one(request.a));
  if (ra.code) return { failure: { ...ra, error: `A: ${ra.error}` } };
  const rb = await w.analyze(arch, one(request.b));
  if (rb.code) return { failure: { ...rb, error: `B: ${rb.error}` } };
  const text = (x) => (typeof x.source === 'string' ? x.source : null);
  return { result: diffResult(ra, rb, { per, sourceA: text(request.a), sourceB: text(request.b) }), a: ra, b: rb, per, sourceA: text(request.a), sourceB: text(request.b) };
}

// diffAnalyses' result alone, or its failure.
/** @param {any} w @param {string} arch @param {any} request @returns {Promise<any>} */
export async function diffRequest(w, arch, request) {
  const x = await diffAnalyses(w, arch, request);
  return x.failure ?? x.result;
}

// Markdown of diffAnalyses' result (markdown.js compare: the page's A–B table), or of its failure.
export function diffMarkdown(x) {
  if (x.failure) return `**diff failed:** ${String(x.failure.error).replace(/\|/g, '\\|')}\n`;
  const [pa, pb] = x.per ?? [1, 1];
  const shownA = shownLabels(x.a, typeof x.sourceA === 'string' ? { source: x.sourceA } : {});
  const shownB = shownLabels(x.b, typeof x.sourceB === 'string' ? { source: x.sourceB } : {});
  return compareMarkdown(x.a, x.b, { workA: pa, workB: pb, shownA, shownB });
}

// The result as text (the CLI without -md, the REST API's text/plain).
const f2 = (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const fe = (v) => (v === null || v === undefined ? '-' : v !== 0 && Math.abs(v) < 0.1 ? Number(v).toPrecision(3) : f2(v));
const sg = (v, f = f2) => (v === null || v === undefined ? '' : `${v > 0 ? '+' : ''}${f(v)}`);
export function diffText(r) {
  if (r.code) return `diff failed: ${r.error}\n`;
  const pct = r.a.tp > 0 ? ` ${sg((100 * (r.b.tp - r.a.tp)) / r.a.tp, (v) => Number(v).toFixed(1))}%` : '';
  const lines = [`${r.arch}: A ${f2(r.a.tp)}  B ${f2(r.b.tp)} cycles per iteration  (${r.verdict === 'same' ? 'the same' : `${sg(r.delta)},${pct}; speedup ${f2(r.speedup)}x`})`];
  if (r.perElement) lines.push(`per element: A ${fe(r.perElement.a)}  B ${fe(r.perElement.b)}  (${r.perElement.verdict === 'same' ? 'the same' : `${sg(r.perElement.delta, fe)}; speedup ${f2(r.perElement.speedup)}x`})`);
  const names = (xs) => (xs.length ? xs.join(', ') : 'unknown');
  lines.push(`bottleneck: A ${names(r.bottlenecks.a)} -> B ${names(r.bottlenecks.b)}`);
  const w = Math.max(5, ...r.limits.map((l) => l.name.length));
  lines.push('', `  ${'limit'.padEnd(w)}  ${'A'.padStart(7)}  ${'B'.padStart(7)}  ${'delta'.padStart(7)}`);
  for (const l of r.limits) lines.push(`  ${l.name.padEnd(w)}  ${f2(l.a).padStart(7)}  ${f2(l.b).padStart(7)}  ${(l.delta ? sg(l.delta) : '').padStart(7)}`.trimEnd());
  const moved = r.ports.filter((p) => p.delta);
  lines.push('', `ports (uops per iteration): ${moved.length ? moved.map((p) => `${p.port} ${f2(p.a)} -> ${f2(p.b)}`).join(', ') : 'no change'}`);
  const c = r.instructions.counts;
  const said = [['changed', 'same instruction, other uops'], ['modified', 'changed operands'], ['added', 'only in B'], ['removed', 'only in A']].filter(([k]) => c[k]).map(([k, t]) => `${c[k]} ${t}`);
  lines.push(`instructions: ${said.length ? said.join(', ') : 'the same'}`);
  const MARK = { changed: '*', modified: '~', added: '+', removed: '-' };
  for (const x of r.instructions.changes) {
    const what = x.status === 'added' ? x.b : x.status === 'removed' ? x.a : x.status === 'modified' ? `${x.a} -> ${x.b}` : x.a;
    const uops = Object.entries(x.uops).map(([k, v]) => `${k} ${sg(v)}`).join(', ');
    lines.push(`  ${MARK[x.status]} ${what}${uops ? `  (${uops})` : ''}`);
  }
  return lines.join('\n') + '\n';
}
