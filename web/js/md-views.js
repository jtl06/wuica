// Markdown of the views: bound, bytes, deps, sweep, the trace's shown range and llvm-mca's text, as the copy control of
// each tab copies them (copy-view.js). No DOM: the text comes from the views' models, not from what is drawn, so it is
// the same whatever is scrolled into view (tests-js/web_md_views.mjs). Tables are aligned for a monospace preview,
// pipes escaped, no trailing whitespace; numbers as the views show them.

import { boundModel, blame, topRows } from './bound-core.js';
import { fmtSlack } from './deps-slack.js';

const f2 = (x) => Number(x).toFixed(2);
const pct = (u) => `${Math.round(u * 100)}%`;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const code = (s) => (s ? '`' + String(s).replace(/`/g, "'").replace(/\|/g, '\\|') + '`' : '');

// A Markdown table, its columns padded to one width. head: [text]; rows: [[text]]; align: 'l' | 'r' | 'c' per column.
export function mdTable(head, rows, align = []) {
  const all = [head.map(cell), ...rows.map((r) => head.map((_, i) => cell(r[i])))];
  const w = head.map((_, i) => Math.max(3, ...all.map((r) => [...r[i]].length)));
  const pad = (s, i) => (align[i] === 'r' ? s.padStart(w[i]) : align[i] === 'c' ? s.padStart(Math.floor((w[i] + s.length) / 2)).padEnd(w[i]) : s.padEnd(w[i]));
  const line = (r) => `| ${r.map(pad).join(' | ')} |`;
  const rule = `|${w.map((n, i) => (align[i] === 'r' ? `${'-'.repeat(n + 1)}:` : align[i] === 'c' ? `:${'-'.repeat(n)}:` : `:${'-'.repeat(n + 1)}`)).join('|')}|`;
  return [line(all[0]), rule, ...all.slice(1).map(line)].join('\n');
}
const doc = (...parts) => parts.filter((p) => p !== null && p !== undefined && p !== '').join('\n\n').replace(/[ \t]+$/gm, '') + '\n';

// The bound view: how busy each resource is, the binding one, the next limit; the instructions with the largest share of
// the selected resource (selected: an item's id, as the view's; default: the binding one).
export function boundMd(r, selected = null) {
  const m = boundModel(r);
  if (!m) return '';
  const sel = selected ?? m.binding[0] ?? null;
  const it = m.items.find((x) => x.id === sel);
  const head = `**bound** · ${f2(m.tp)} cycles/iteration · binding ${m.binding.length ? m.binding.map((b) => m.items.find((x) => x.id === b)?.name ?? b).join(', ') : 'none'}`
    + (m.next ? ` · next ${m.next.name} ${f2(m.next.tp)} (at most ${m.next.speedup.toFixed(2)}× faster)` : '');
  const table = mdTable(['resource', 'group', 'cycles/iteration', 'busy', 'binding'],
    m.items.map((x) => [x.name, x.group, f2(x.cycles), pct(x.util), m.binding.includes(x.id) ? 'yes' : '']), ['l', 'l', 'r', 'r', 'c']);
  const b = sel ? blame(r, sel) : null;
  const top = topRows(b, 5);
  const shares = top.length ? `top of ${it?.name ?? sel} (by ${b.unit}):\n\n${mdTable(['instruction', 'share'], top.map(({ row, share }) => [code(r.rows[row].label), pct(share)]), ['l', 'r'])}` : '';
  return doc(head, table, shares);
}

// The bytes view: each instruction's place on the cache lines at the alignment offset (codemap.js codeMapModel).
export function bytesMd(m) {
  if (!m) return '';
  const head = `**bytes** · ${m.bytes} bytes from offset ${m.offset} · crossing 16 B: ${m.counts.cross16}, 32 B: ${m.counts.cross32}, 64 B: ${m.counts.cross64}`;
  const table = mdTable(['instruction', 'start', 'bytes', 'crosses', 'notes'],
    m.instrs.map((x) => [code(x.label), `0x${x.start.toString(16)}`, String(x.end - x.start),
      [x.cross16 ? '16' : '', x.cross32 ? '32' : '', x.cross64 ? '64' : ''].filter(Boolean).join(' '), [x.fused ? 'fused' : '', x.jcc ? 'JCC' : ''].filter(Boolean).join(' ')]),
    ['l', 'r', 'r', 'l', 'l']);
  return doc(head, table);
}

// The deps view: its arcs (producer → consumer, the iterations between them, the latency, the critical chain) and the
// slack of each instruction (deps.js depGraph, deps-slack.js).
export function depsMd(g) {
  if (!g) return '';
  const slack = g.slack?.slack ?? null;
  const carried = g.edges.filter((e) => e.dist).length;
  const head = `**deps** · ${g.edges.length} arcs, ${carried} carried into a later iteration${g.slack ? ` · chain ${+Number(g.slack.period).toFixed(2)} cycles/iteration` : ''}`;
  const lat = (e) => (e.lat === null || e.lat === undefined ? '' : String(+Number(e.lat).toFixed(2)));
  const arcs = mdTable(['from', 'to', 'iterations', 'latency', 'chain'],
    g.edges.map((e) => [code(g.nodes[e.a].label), code(g.nodes[e.b].label), String(e.dist), lat(e) + (e.mem ? ' (memory)' : ''), e.critical ? 'yes' : '']), ['l', 'l', 'r', 'r', 'c']);
  const sl = slack ? mdTable(['instruction', 'slack'], g.nodes.map((n, i) => [code(n.label), fmtSlack(slack[i])]), ['l', 'r']) : '';
  return doc(head, arcs, sl);
}

// The sweep: cycles/iteration at each alignment offset (compare.js sweepData: values per offset, null for none).
export function sweepMd(d, arch = '') {
  if (!d) return '';
  const head = `**sweep** · alignment 0–${d.n - 1}${arch ? ` · ${arch}` : ''}${d.min !== null ? ` · min ${f2(d.min)} at ${d.minAt.join(', ')} · max ${f2(d.max)} at ${d.maxAt.join(', ')}` : ''}${d.complete ? '' : ` · ${d.pending} pending`}`;
  const table = mdTable(['offset', 'cycles/iteration'], d.values.map((v, i) => [String(i), v === null ? (d.failed.includes(i) ? 'failed' : '') : f2(v)]), ['r', 'r']);
  return doc(head, table);
}

// The trace's shown rows as a table (trace.js TABLE_HEAD, tableRows); caption: what is shown.
export function traceMd(head, rows, caption = '') {
  if (!rows?.length) return '';
  return doc(caption ? `**trace** · ${caption}` : '**trace**', mdTable(head, rows, head.map((_, i) => (i === 1 || i === 2 || i === head.length - 1 ? 'l' : 'r'))));
}

// llvm-mca's text, as it printed it
export function mcaMd(text, caption = '') {
  if (!text) return '';
  return doc(caption ? `**llvm-mca** · ${caption}` : '**llvm-mca**', '```\n' + String(text).replace(/\s+$/, '') + '\n```');
}
