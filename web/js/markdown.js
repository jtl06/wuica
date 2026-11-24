// Results as text, without the DOM: Markdown (GitHub-flavoured) for an issue, a review or a chat; the uop table as CSV;
// the response as JSON. From the response and the shared models (bound-core.js, ab-diff.js), never from the page. One
// module for the page (its copy controls) and the npm package (`wuica -md`, the library's `markdown`): its copy in
// packages/wuica/lib/web (web-modules.json).
//
// The text: valid GFM; pipes and backticks in instruction text escaped; numbers as the page and the CLI print them
// (cycles with two decimals, three significant digits below 0.1 per element; the uop table's values as uiCA prints them,
// zeros blank); table columns padded so that the source reads in a monospace font; no trailing whitespace; the same
// input gives the same text.
//
// Generators: report (the whole result), uopTable, cpuTable (several CPUs, or files x CPUs), whatIf, loops, compare (A-B);
// the page's other views, each from that view's model: bound, bytes, deps, sweep, traceRange, mcaText. A new view: a
// generator here that takes its model and builds its text with the exported building blocks: table(head, rows, align),
// code(text), text(s), fence(text, lang), cycles(v), signedCycles(v), uopValue(v).

import { insights, boundModel, blame, topRows } from './bound-core.js';
import { compareResponses, cycles, signed, signedCycles } from './ab-diff.js';
import { branchLabels, analyzedLines } from './branch-label.js';

export { cycles, signedCycles };

// ---- building blocks ------------------------------------------------------------------------------------------------

// a value of the uop table as uiCA prints it: up to two decimals, zeros blank
export const uopValue = (v) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? String(Math.round(v * 100) / 100) : '');
const f2 = (v) => Number(v).toFixed(2);

// text in a table cell or a line: pipes and backticks escaped
export const text = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`').replace(/\s+/g, ' ').trim();

// a code span (instruction text): a pipe escaped (GFM tables split cells at an unescaped pipe, also in code spans); a
// backtick inside: the span is fenced with more backticks than any run in the text
export function code(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  if (!t.includes('`')) return `\`${t}\``;
  const run = Math.max(...(t.match(/`+/g) ?? ['']).map((x) => x.length));
  const f = '`'.repeat(run + 1);
  return `${f} ${t} ${f}`;
}

// a fenced code block: the fence longer than any run of backticks in the text
export function fence(body, lang = '') {
  const run = Math.max(2, ...(String(body).match(/`+/g) ?? ['']).map((x) => x.length));
  const f = '`'.repeat(run + 1);
  return `${f}${lang}\n${String(body).replace(/\s+$/, '')}\n${f}`;
}

// A GFM table, its columns padded to their widest cell. head: [names]; rows: [[cells]] (strings); align: per column
// 'l' (default), 'r', 'c'.
export function table(head, rows, align = []) {
  const n = head.length;
  const width = head.map((h, i) => Math.max(3, [...String(h)].length, ...rows.map((r) => [...String(r[i] ?? '')].length)));
  const pad = (s, i) => {
    const t = String(s ?? ''), w = width[i] - [...t].length;
    if (align[i] === 'r') return ' '.repeat(w) + t;
    if (align[i] === 'c') return ' '.repeat(Math.floor(w / 2)) + t + ' '.repeat(Math.ceil(w / 2));
    return t + ' '.repeat(w);
  };
  const line = (cells) => `| ${cells.map(pad).join(' | ')} |`.replace(/\s+$/, '');
  const rule = `|${width.map((w, i) => (align[i] === 'r' ? `${'-'.repeat(w + 1)}:` : align[i] === 'c' ? `:${'-'.repeat(w)}:` : '-'.repeat(w + 2))).join('|')}|`;
  return [line(head), rule, ...rows.map((r) => line(Array.from({ length: n }, (_, i) => r[i] ?? '')))].join('\n');
}

// a hard line break without trailing spaces (GFM: a backslash at the end of the line)
const BR = '\\\n';
const join = (blocks) => blocks.filter((b) => b !== null && b !== undefined && b !== '').join('\n\n') + '\n';

// Branch targets as the page shows them (branch-label.js): the label written in the text, a numeric label as written,
// the nearest label plus an offset, else the offset in the block ("jnz 0x0"), never the analyzer's 64-bit relative
// value. meta.shown: the labels per row (the page's view.shown); else meta.src ({text, from, to}: the analyzed lines of
// the assembly, branch-label.js analyzedLines); else meta.source (the assembly text of the request: its analyzed lines
// from the result's loop); else the block's offsets.
export function shownLabels(r, meta = {}) {
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  const shown = Array.isArray(meta.shown) && meta.shown.length === rows.length ? meta.shown : branchLabels(rows, meta.src ?? (typeof meta.source === 'string' ? analyzedLines(meta.source, r) : null));
  return rows.map((x, i) => String(shown[i] ?? x.label ?? ''));
}
const cell = (row, label) => (row.kind === 'instr' ? code(label) : text(label));

// ---- one result -----------------------------------------------------------------------------------------------------

// "Issue 3.50" (per element with `per`): the largest limit(s), the nearest bound when uiCA names no bottleneck
function nearest(r, per = 1) {
  const lims = (r?.limits ?? []).map((l) => ({ name: l.name, tp: Number(l.tp) })).filter((l) => Number.isFinite(l.tp));
  if (!lims.length) return '';
  const max = Math.max(...lims.map((l) => l.tp));
  return `${lims.filter((l) => l.tp >= max - 0.005).map((l) => l.name).join(', ')} ${per > 1 ? cycles(max / per) : f2(max)}`;
}

// The headline: cycles per iteration (or per element), the CPU, loop or unrolled, the bottleneck.
//   meta: {arch, archTitle (the CPU's title: "SKL · Skylake (2015)"), per (elements per iteration)}
export function headline(r, meta = {}) {
  const per = meta.per > 1 ? meta.per : 1;
  const tp = Number(r.tp);
  const head = per > 1 ? `**${cycles(tp / per)} cycles/element** (${f2(tp)} cycles/iteration, ${per} elements per iteration)` : `**${f2(tp)} cycles/iteration**`;
  const bn = r.bottlenecks?.length ? r.bottlenecks.join(', ') : `unknown${nearest(r, per) ? ` · nearest ${nearest(r, per)}` : ''}`;
  return `${head} · ${text(meta.archTitle ?? meta.arch ?? r.arch)} · ${r.mode === 'loop' ? 'loop' : 'unrolled'} · bottleneck: ${bn}`;
}

// The uop table: every row (branch targets as shownLabels), the columns that are used, the totals.
//   meta: {shown | src | source} (shownLabels)
export function uopTable(r, meta = {}) {
  const labels = shownLabels(r, meta);
  const cols = r.columns.map((_, i) => i).filter((i) => r.rows.some((x) => Number(x.values?.[i]) || 0));
  const tot = cols.map((i) => r.rows.reduce((s, x) => s + (Number(x.values?.[i]) || 0), 0));
  const rows = r.rows.map((x, k) => [cell(x, labels[k]), text(x.notes ?? ''), ...cols.map((i) => uopValue(Number(x.values?.[i])))]);
  rows.push(['**Total**', '', ...tot.map(uopValue)]);
  return table(['Instruction', 'Notes', ...cols.map((i) => text(r.columns[i]))], rows, ['l', 'c', ...cols.map(() => 'r')]);
}

// The whole result: the headline, the limits, the next limit, what the model does not simulate (caveats), the
// critical chain, the uop table, the code (if given), a link (if given). A failure: its error and stderr lines.
//   meta: {arch, archTitle, per, insights (bound-core.js insights(r, config), e.g. the library's w.insights(r)) or config
//          (the CPU's configuration in uarch.json, for the caveats), shown | src | source (shownLabels), code, lang, link,
//          title (a heading)}
export function report(r, meta = {}) {
  const blocks = [];
  if (meta.title) blocks.push(`## ${text(meta.title)}`);
  if (!r || r.error || r.code || !Array.isArray(r.rows)) {
    blocks.push(`**analysis failed:** ${text(r?.error ?? 'no result')}`);
    const lines = (r?.stderr ?? []).map((l) => String(l.text ?? l)).filter((l) => l !== String(r?.error));
    if (lines.length) blocks.push(fence(lines.join('\n')));
    if (meta.code) blocks.push(fence(meta.code, meta.lang ?? 'asm'));
    if (meta.link) blocks.push(`[open in wuica](${meta.link})`);
    return join(blocks);
  }
  const per = meta.per > 1 ? meta.per : 1;
  const ins = meta.insights ?? insights(r, meta.config ?? null);
  const labels = shownLabels(r, meta);
  const lines = [headline(r, meta)];
  if (r.limits?.length) lines.push(`limits: ${r.limits.map((l) => `${l.name} ${per > 1 ? cycles(Number(l.tp) / per) : f2(l.tp)}`).join(' · ')}`);
  if (ins?.next && ins.binding.length) lines.push(`next limit: ${ins.next.limit} ${per > 1 ? cycles(ins.next.tp / per) : f2(ins.next.tp)} (at most ${f2(ins.next.maxSpeedup)}x faster without ${ins.binding.join(', ')})`);
  if (r.decodeErrors > 0) lines.push(`${r.decodeErrors} position(s) could not be decoded: the throughput leaves them out`);
  blocks.push(lines.join(BR));
  if (ins?.caveats?.length) blocks.push(ins.caveats.map((c) => `- **not modelled:** ${text(c.text)}: ${text(c.title)}`).join('\n'));
  if (ins?.chain?.length) {
    const lat = ins.chain.reduce((s, e) => s + (Number(e.latency) || 0), 0);
    blocks.push(`critical chain (${lat} cycle${lat === 1 ? '' : 's'} of latency): ${ins.chain.map((e) => `${code(labels[e.index] ?? e.instr)} (${text(e.operand)}, ${e.latency})`).join(' → ')}`);
  }
  blocks.push(uopTable(r, { shown: labels }));
  if (meta.code) blocks.push(fence(meta.code, meta.lang ?? 'asm'));
  if (meta.link) blocks.push(`[open in wuica](${meta.link})`);
  return join(blocks);
}

// ---- several CPUs, several files ----------------------------------------------------------------------------------

// The rows of a CPU table: from a compare() result ({results}), an analyze result (one CPU), or a failure.
function cpuRows(x) {
  if (Array.isArray(x?.results)) return x.results;
  if (x && !x.code && x.tp !== undefined) return [x];
  return [{ arch: '', name: '', code: x?.code ?? 1, error: x?.error ?? 'no result' }];
}

// Several CPUs, one row each: CPU, model, TP (and per element), bottlenecks (or "- (nearest X)"), notes (undecodable
// instructions, caveats, prototype). The batch form: files x CPUs (items {file, loop?, result}).
//   input: a compare() result, an array of its rows, or [{file, result}] (each result a compare() or analyze result)
//   opts: {per (elements per iteration)}
// A row's caveats: its `caveats` ([{text}] or ids) as the CLI's -json gives them.
export function cpuTable(input, opts = {}) {
  const per = opts.per > 1 ? opts.per : null;
  const batch = Array.isArray(input) && input.some((x) => x && 'file' in x);
  const items = batch ? input : [{ result: Array.isArray(input) ? { results: input } : input }];
  const loopOf = (r) => (r?.loop ? `${r.loop.name.replace(/^loop /, '')}${r.loop.function ? ` (${r.loop.function})` : ''}` : r && !r.code ? 'as is' : '-');
  const rows = [];
  let prototype = false;
  for (const it of items) {
    cpuRows(it.result).forEach((r, k) => {
      const lead = batch ? [k ? '' : text(it.file), k ? '' : text(loopOf(it.result))] : [];
      if (r.code) { rows.push([...lead, text(r.arch ?? ''), text(r.name ?? ''), String(r.year ?? ''), '-', ...(per ? ['-'] : []), `error: ${text(String(r.error).split('\n')[0])}`, '']); return; }
      const bn = r.bottlenecks?.length ? r.bottlenecks.join(', ') : nearest(r) ? `- (nearest ${nearest(r).replace(/ [\d.]+$/, '')})` : '-';
      const cav = (r.caveats ?? r.insights?.caveats ?? []).map((c) => (typeof c === 'string' ? c : c.text));
      prototype ||= !!r.prototype;
      const notes = [r.decodeErrors ? `${r.decodeErrors} undecodable (left out)` : null, ...cav, r.prototype ? '[prototype]' : null].filter(Boolean).map(text).join('; ');
      rows.push([...lead, text(r.arch), text(r.name ?? ''), String(r.year ?? ''), `${f2(r.tp)}${r.decodeErrors ? '*' : ''}`, ...(per ? [cycles(Number(r.tp) / per)] : []), text(bn), notes]);
    });
  }
  const head = [...(batch ? ['File', 'Loop'] : []), 'CPU', 'Model', 'Year', 'TP', ...(per ? ['per el'] : []), 'Bottlenecks', 'Notes'];
  const align = [...(batch ? ['l', 'l'] : []), 'l', 'l', 'l', 'r', ...(per ? ['r'] : []), 'l', 'l'];
  const notes = [`TP: cycles per iteration${per ? `; per el: cycles per element (${per} per iteration)` : ''}. "-": unknown or failed.`];
  if (rows.some((r) => /\*$/.test(r[batch ? 5 : 3]))) notes.push('*: some instructions could not be decoded for that CPU and are left out.');
  if (prototype) notes.push('[prototype]: experimental model of the fork jtl06/uiCA.');
  return join([table(head, rows, align), notes.join(BR)]);
}

// ---- what if, loops -------------------------------------------------------------------------------------------------

// The what-if table of one CPU (the library's whatIf result; with elementsPerIteration, per element): variant, cycles,
// delta, speedup; the best number of accumulators.
export function whatIf(x) {
  if (x?.code) return `**What if (${text(x.arch ?? '')}):** ${text(x.error)}\n`;
  const per = x.elementsPerIteration > 1 ? x.elementsPerIteration : null;
  const v = (n) => (per ? cycles(n / per) : f2(n));
  const rows = x.variants.map((y) => (y.error ? [text(y.label), '-', '', '', text(y.error)]
    : [text(y.label), `${y.estimate ? '>=' : ''}${v(y.tp)}`, `${y.delta > 0 ? '+' : ''}${v(y.delta)}`, `${f2(y.speedup ?? 0)}x`, y.estimate ? 'estimate' : '']));
  const head = `**What if (${text(x.arch)})**, ${per ? `cycles per element (${per} per original iteration; base ${cycles(x.tp / per)})` : `cycles per original iteration (base ${f2(x.tp)})`}`;
  const best = x.accumulators ? `best number of accumulators: ${x.accumulators.best}${x.accumulators.best === 1 ? ' (as it is)' : ''}` : null;
  return join([head, table(['Variant', 'Cycles', 'Δ', 'Speedup', 'Note'], rows, ['l', 'r', 'r', 'r', 'l']), best]);
}

// The loops of assembly text (listLoops / the CLI's -loops): index, label, function, lines, instructions, depth, the
// loop "auto" picks.
export function loops(list) {
  if (!list?.length) return 'no loops\n';
  const rows = list.map((l) => [String(l.index), code(l.label), text(l.function ?? '-'), `${l.line}-${l.endLine}`, String(l.instructions), String(l.depth), l.auto ? 'auto' : '']);
  return join([table(['#', 'Label', 'Function', 'Lines', 'Instructions', 'Depth', 'Pick'], rows, ['r', 'l', 'l', 'l', 'r', 'r', 'l'])]);
}

// ---- A-B ----------------------------------------------------------------------------------------------------------

const percent = (p) => (p === null || !Number.isFinite(p) ? '' : `${p < 0 ? '−' : '+'}${Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : String(Math.round(Math.abs(p)))}%`);
// the page's marks (ab.js): • same instruction, other uops; ~ changed operands; + only in B; − only in A
const MARK = { same: '', changed: '•', modified: '~', added: '+', removed: '−' };
const MARK_TEXT = { changed: 'same instruction, other uops', modified: 'changed operands', added: 'only in B', removed: 'only in A' };

// Two results, A and B (ab-diff.js, as the page compares them): the summary line, the bottlenecks, the limits, and the
// instructions aligned with the change (B − A) of every shared column; with meta.cpus ([{arch, a, b}]: the throughputs of
// both sides per CPU) the A/B/Δ table per CPU.
//   meta: {workA, workB (elements per iteration of each side), archA, archB, cpus, shownA | srcA, shownB | srcB
//          (each side's branch labels, shownLabels)}
export function compare(a, b, meta = {}) {
  const cmp = compareResponses(a, b, { workA: meta.workA ?? 1, workB: meta.workB ?? null });
  const unit = cmp.perElement ? 'cycles per element' : 'cycles per iteration';
  const blocks = [];
  if (!cmp.tp) {
    blocks.push(`**A–B:** one side has no result${a?.error ? ` (A: ${text(a.error)})` : ''}${b?.error ? ` (B: ${text(b.error)})` : ''}`);
    return join(blocks);
  }
  const t = cmp.tp;
  const sides = meta.archA || meta.archB ? ` (A: ${text(meta.archA ?? a.arch)}, B: ${text(meta.archB ?? b.arch)})` : '';
  const lines = [`**A ${cycles(t.a)} · B ${cycles(t.b)} ${unit}**${t.verdict === 'same' ? ' (the same)' : ` (Δ ${t.delta === 0 ? '0' : signedCycles(t.delta)}, ${percent(t.pct)})`}${sides}`];
  const bn = cmp.bottlenecks;
  const names = (xs) => (xs.length ? xs.join(', ') : 'unknown');
  lines.push(bn.same && bn.a.length ? `bottleneck: ${bn.a.join(', ')} (both)` : `bottleneck: A ${names(bn.a)} → B ${names(bn.b)}`);
  blocks.push(lines.join(BR));
  if (cmp.limits.length) {
    blocks.push(table(['Limit', 'A', 'B', 'Δ'], cmp.limits.map((l) => [`${text(l.name)}${l.bottleneckA || l.bottleneckB ? ' *' : ''}`, l.a === null ? '-' : cycles(l.a), l.b === null ? '-' : cycles(l.b), l.delta === null ? '' : l.delta === 0 ? '' : signedCycles(l.delta)]), ['l', 'r', 'r', 'r']));
  }
  const d = cmp.diff;
  if (d?.rows?.length) {
    const shown = new Map();
    for (const [r, sh, src] of [[a, meta.shownA, meta.srcA], [b, meta.shownB, meta.srcB]]) shownLabels(r, { shown: sh, src }).forEach((l, i) => shown.set(r.rows[i], l));
    const label = (u) => (u ? cell(u.row, shown.get(u.row) ?? u.label) : '');
    const rows = d.rows.map((x) => [MARK[x.status], label(x.a), label(x.b), ...x.deltas.map((v) => signed(v))]);
    rows.push(['', '**Total**', '', ...d.totals.map((v) => signed(v))]);
    blocks.push(table(['', 'A', 'B', ...d.columns.map((c) => (c.name === 'Issued' ? 'Δ uops' : `Δ ${text(c.name)}`))], rows, ['c', 'l', 'l', ...d.columns.map(() => 'r')]));
    const used = Object.keys(MARK_TEXT).filter((k) => d.counts[k] > 0);
    const legend = [used.length ? used.map((k) => `${MARK[k]} ${MARK_TEXT[k]}`).join(' · ') : 'no change', 'Δ: B − A, uops per iteration'];
    if (!d.portsComparable) legend.push('the two sides have different execution ports: uop counts only');
    blocks.push(legend.join('; '));
  }
  if (meta.cpus?.length) {
    blocks.push(table(['CPU', 'A', 'B', 'Δ', '%'], meta.cpus.map((c) => {
      const okA = Number.isFinite(c.a), okB = Number.isFinite(c.b);
      const dd = okA && okB ? c.b - c.a : null;
      return [text(c.arch), okA ? cycles(c.a) : '-', okB ? cycles(c.b) : '-', dd === null ? '' : Math.abs(dd) < 0.005 ? '0' : signedCycles(dd), dd === null || !(c.a > 0) ? '' : percent((100 * dd) / c.a)];
    }), ['l', 'r', 'r', 'r', 'r']));
  }
  return join(blocks);
}

// ---- the page's other views: bound, bytes, deps, the sweep, a trace range, llvm-mca --------------------------------

const pct = (u) => `${Math.round(u * 100)}%`;

// The bound view (bound-core.js): how busy each resource is, the binding one, the next limit; the instructions with the
// largest share of the selected resource (an item's id, as the view's; default: the binding one).
export function bound(r, selected = null) {
  const m = boundModel(r);
  if (!m) return '';
  const sel = selected ?? m.binding[0] ?? null;
  const it = m.items.find((x) => x.id === sel);
  const name = (id) => m.items.find((x) => x.id === id)?.name ?? id;
  const head = `**bound** · ${f2(m.tp)} cycles/iteration · binding ${m.binding.length ? m.binding.map(name).join(', ') : 'none'}`
    + (m.next ? ` · next ${m.next.name} ${f2(m.next.tp)} (at most ${f2(m.next.speedup)}x faster)` : '');
  const rows = m.items.map((x) => [text(x.name), x.group, f2(x.cycles), pct(x.util), m.binding.includes(x.id) ? 'yes' : '']);
  const b = sel ? blame(r, sel) : null;
  const top = topRows(b, 5);
  const shares = top.length ? `top of ${text(it?.name ?? sel)} (by ${b.unit}):\n\n${table(['Instruction', 'Share'], top.map(({ row, share }) => [code(r.rows[row].label), pct(share)]), ['l', 'r'])}` : null;
  return join([head, table(['Resource', 'Group', 'Cycles/iteration', 'Busy', 'Binding'], rows, ['l', 'l', 'r', 'r', 'c']), shares]);
}

// The bytes view: each instruction's place on the cache lines at the alignment offset (the page's codemap.js
// codeMapModel: {bytes, offset, instrs: [{label, start, end, fused, jcc, cross16, cross32, cross64}], counts}).
export function bytes(m) {
  if (!m) return '';
  const head = `**bytes** · ${m.bytes} bytes from offset ${m.offset} · crossing 16 B: ${m.counts.cross16}, 32 B: ${m.counts.cross32}, 64 B: ${m.counts.cross64}`;
  const rows = m.instrs.map((x) => [code(x.label), `0x${x.start.toString(16)}`, String(x.end - x.start),
    [x.cross16 ? '16' : '', x.cross32 ? '32' : '', x.cross64 ? '64' : ''].filter(Boolean).join(' '), [x.fused ? 'fused' : '', x.jcc ? 'JCC' : ''].filter(Boolean).join(' ')]);
  return join([head, table(['Instruction', 'Start', 'Bytes', 'Crosses', 'Notes'], rows, ['l', 'r', 'r', 'l', 'l'])]);
}

// The deps view: its arcs (producer → consumer, the iterations between them, the latency, the critical chain) and the
// slack of each instruction (the page's deps.js depGraph: {nodes: [{label}], edges: [{a, b, dist, lat, mem, critical}],
// slack: {period}}). slack: the slack of each node as the view writes it (deps-slack.js fmtSlack), or null.
export function deps(g, { slack = null } = {}) {
  if (!g) return '';
  const carried = g.edges.filter((e) => e.dist).length;
  const head = `**deps** · ${g.edges.length} arcs, ${carried} carried into a later iteration${g.slack ? ` · chain ${+Number(g.slack.period).toFixed(2)} cycles/iteration` : ''}`;
  const lat = (e) => (e.lat === null || e.lat === undefined ? '' : String(+Number(e.lat).toFixed(2)));
  const arcs = table(['From', 'To', 'Iterations', 'Latency', 'Chain'],
    g.edges.map((e) => [code(g.nodes[e.a].label), code(g.nodes[e.b].label), String(e.dist), lat(e) + (e.mem ? ' (memory)' : ''), e.critical ? 'yes' : '']), ['l', 'l', 'r', 'r', 'c']);
  const sl = slack ? table(['Instruction', 'Slack'], g.nodes.map((n, i) => [code(n.label), text(slack[i])]), ['l', 'r']) : null;
  return join([head, arcs, sl]);
}

// The sweep: cycles/iteration at each alignment offset (the page's compare.js sweepData: {n, values (null: none),
// failed, pending, complete, min, max, minAt, maxAt}).
export function sweep(d, arch = '') {
  if (!d) return '';
  const head = `**sweep** · alignment 0–${d.n - 1}${arch ? ` · ${text(arch)}` : ''}${d.min !== null ? ` · min ${f2(d.min)} at ${d.minAt.join(', ')} · max ${f2(d.max)} at ${d.maxAt.join(', ')}` : ''}${d.complete ? '' : ` · ${d.pending} pending`}`;
  return join([head, table(['Offset', 'Cycles/iteration'], d.values.map((v, i) => [String(i), v === null ? (d.failed.includes(i) ? 'failed' : '') : f2(v)]), ['r', 'r'])]);
}

// A trace range: the shown rows of the trace view as a table (the page's trace.js TABLE_HEAD and tableRows); caption:
// what is shown.
export function traceRange(head, rows, caption = '') {
  if (!rows?.length) return '';
  return join([caption ? `**trace** · ${text(caption)}` : '**trace**', table(head.map(text), rows.map((r) => r.map(text)), head.map((_, i) => (i === 1 || i === 2 || i === head.length - 1 ? 'l' : 'r')))]);
}

// llvm-mca's text, as it printed it
export function mcaText(out, caption = '') {
  if (!out) return '';
  return join([caption ? `**llvm-mca** · ${text(caption)}` : '**llvm-mca**', fence(out)]);
}

// ---- CSV, JSON ------------------------------------------------------------------------------------------------------

// CSV (RFC 4180): instruction, opcode, notes and every column of the uop table; numbers as the analyzer gives them.
export function toCSV(r) {
  const q = (s) => (/[",\n\r]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const out = [['instruction', 'opcode', 'notes', ...r.columns].map(q).join(',')];
  for (const x of r.rows) out.push([x.label, x.opcode ?? '', x.notes ?? '', ...r.columns.map((_, i) => String(Number(x.values?.[i]) || 0))].map(q).join(','));
  return out.join('\r\n') + '\r\n';
}

// JSON: the request and the response (without the trace and the text report, which the page has elsewhere).
export function toJSON(r, request) {
  const { trace, text: report_, ...rest } = r;
  return JSON.stringify({ request: request ?? null, response: rest }, null, 1) + '\n';
}
