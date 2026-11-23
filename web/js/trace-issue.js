// The issue strip of the trace (trace.js): per cycle of the steady state, how many uops the renamer issued and, when fewer
// than the issue width, why (the simulation's own cause: the front end delivered too few, the reorder buffer or the
// scheduler was full, other). From details.issue of the analysis that made the trace (docs/WASM-API.md, "details");
// VTune's top-down slots, cycle by cycle. Drawn under the port strips; no strip without the details.
//
// The first half has no DOM (tests-js/web_details.mjs runs it under Node).

export const ISSUE_H = 9;
// cause -> [colour variable, name]
export const CAUSES = Object.freeze({
  '.': ['accent', 'full width issued'],
  F: ['external', 'front end: the IDQ ran empty'],
  R: ['caveat', 'reorder buffer full'],
  S: ['date', 'scheduler full'],
  O: ['subtle', 'other: a uop that did not fit, serialization, merge uops'],
});

// the issue log if it is usable: {width, first, issued: [], cause: ''} with one entry per cycle
export function issueLog(details) {
  const i = details?.issue;
  if (!i || !(i.width > 0) || !Number.isInteger(i.first) || !Array.isArray(i.issued) || typeof i.cause !== 'string' || i.issued.length !== i.cause.length || !i.issued.length) return null;
  return { width: i.width, first: i.first, issued: i.issued, cause: i.cause };
}

// cycle c: {n, cause} or null (outside the window)
export function issueAt(log, c) {
  const k = c - log.first;
  if (k < 0 || k >= log.issued.length) return null;
  return { n: log.issued[k], cause: log.cause[k] };
}

// the share of the issue slots used in cycles a..b (within the window), or null if none of them is in it
export function issueShare(log, a, b) {
  const lo = Math.max(a, log.first), hi = Math.min(b, log.first + log.issued.length - 1);
  if (hi < lo) return null;
  let n = 0;
  for (let c = lo; c <= hi; c++) n += log.issued[c - log.first];
  return n / ((hi - lo + 1) * log.width);
}

// draws the strip at y for the cycles cA..cB (v: the trace viewer: x(c), scale, colors)
export function drawIssueStrip(v, ctx, log, y, cA, cB) {
  const C = v.colors, s = v.scale, h = ISSUE_H - 2;
  const lo = Math.max(cA, log.first), hi = Math.min(cB, log.first + log.issued.length - 1);
  for (let c = lo; c <= hi; c++) {
    const k = c - log.first, n = log.issued[k], cause = log.cause[k];
    const x = v.x(c), w = Math.max(1, s - (s >= 4 ? 1 : 0));
    if (cause !== '.') {
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = C[CAUSES[cause]?.[0] ?? 'subtle'] ?? C.subtle;
      ctx.fillRect(x, y, w, h);
    }
    if (n > 0) {
      const bh = Math.max(1, Math.round((h * Math.min(n, log.width)) / log.width));
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.accent;
      ctx.fillRect(x, y + h - bh, w, bh);
    }
  }
  ctx.globalAlpha = 1;
}

// the text for the cycle under the pointer
export function issueText(log, c) {
  const a = issueAt(log, c);
  if (!a) return null;
  return a.cause === '.' ? `issued ${a.n}/${log.width}` : `issued ${a.n}/${log.width} · ${CAUSES[a.cause]?.[1] ?? a.cause}`;
}
