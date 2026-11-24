// Export: the result as Markdown (for an issue or a review), the uop table as CSV, the response as JSON; copied to the
// clipboard by three small buttons next to the uop table (the row of tools above it). Text is made only on a click.
//
// The first half has no DOM (tests-js/web_export.mjs runs it under Node).

import { setCopy } from './copy-view.js';

const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? String(Math.round(v * 100) / 100) : '');
const used = (r) => r.columns.map((_, i) => i).filter((i) => r.rows.some((x) => Number(x.values?.[i]) || 0));
const totals = (r) => r.columns.map((_, i) => r.rows.reduce((s, x) => s + (Number(x.values?.[i]) || 0), 0));

// Markdown: a header line, the limits, the uop table (columns that are used), a link back to the page (optional).
//   meta: {archKey, archTitle, link}
export function toMarkdown(r, meta = {}) {
  const cols = used(r);
  const tot = totals(r);
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const head = `**${Number(r.tp).toFixed(2)} cycles/iteration** · ${meta.archTitle ?? meta.archKey ?? r.arch} · ${r.mode === 'loop' ? 'loop' : 'unrolled'}`
    + ` · bottleneck: ${r.bottlenecks?.length ? r.bottlenecks.join(', ') : 'unknown'}`;
  const limits = r.limits?.length ? `limits: ${r.limits.map((l) => `${l.name} ${Number(l.tp).toFixed(2)}`).join(' · ')}` : '';
  const lines = [
    `| Instruction | Notes | ${cols.map((i) => esc(r.columns[i])).join(' | ')} |`,
    `|---|:-:|${cols.map(() => '--:').join('|')}|`,
    ...r.rows.map((x) => `| ${x.kind === 'instr' ? '`' + String(x.label).replace(/`/g, "'") + '`' : esc(x.label)} | ${x.notes ?? ''} | ${cols.map((i) => r2(Number(x.values?.[i]))).join(' | ')} |`),
    `| **Total** | | ${cols.map((i) => r2(tot[i])).join(' | ')} |`,
  ];
  return [head, ...(limits ? [limits] : []), '', ...lines, ...(meta.link ? ['', `[wuica](${meta.link})`] : [])].join('\n') + '\n';
}

// CSV (RFC 4180): instruction, opcode, notes and every column of the uop table; numbers as the analyzer gives them.
export function toCSV(r) {
  const q = (s) => (/[",\n\r]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const out = [['instruction', 'opcode', 'notes', ...r.columns].map(q).join(',')];
  for (const x of r.rows) out.push([x.label, x.opcode ?? '', x.notes ?? '', ...r.columns.map((_, i) => String(Number(x.values?.[i]) || 0))].map(q).join(','));
  return out.join('\r\n') + '\r\n';
}

// JSON: the request and the response (without the trace and the text report, which the page has elsewhere).
export function toJSON(r, request) {
  const { trace, text, ...rest } = r;
  return JSON.stringify({ request: request ?? null, response: rest }, null, 1) + '\n';
}

// ---- the view: the result's table tab copies through the tab row's control (copy-view.js) ------------------------------

export function createExport() {
  return {
    decorate(root, view) {
      const r = view?.response;
      if (!r || r.error || !Array.isArray(r.rows)) { setCopy('table', null); return; }
      setCopy('table', {
        what: 'the uop table',
        md: () => toMarkdown(r, { archKey: view.archKey, archTitle: view.archTitle, link: typeof location !== 'undefined' ? location.href : null }),
        csv: () => toCSV(r),
        json: () => toJSON(r, view.request),
      });
    },
    setOpen() {},
  };
}
