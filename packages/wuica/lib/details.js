// The details of an analysis ("details": true; docs/WASM-API.md) in the compact form (summarize(), the MCP `analyze`
// JSON): per instruction its allowed ports in uops.info's notation, its latencies and front-end facts; the port set behind
// the Ports limit with the instructions that load it; the issue slots per cause. The notation and the latencies shown are
// the page's (web/details.js, shared).

import { portString, latencyPairs } from './web/details.js';

export { portString, latencyPairs };

const round = (x) => Math.round(x * 100) / 100;

// the fields one instruction of the compact form gets
export function instrDetails(det) {
  if (!det) return null;
  const out = { allowedPorts: portString(det.portData), uops: det.uops, fusedUops: det.retireSlots };
  if (det.uopsMS) out.msUops = det.uopsMS;
  const lat = latencyPairs(det);
  if (lat.length) out.latencies = lat.map((l) => `${l.from}->${l.to}:${l.cycles}`);
  const fe = { length: det.length, offset: det.offset };
  if (det.crosses?.length) fe.crosses = det.crosses;
  for (const k of ['lcp', 'microcoded', 'complexDecoder', 'macroFusedWithNext', 'macroFusedWithPrev']) if (det[k]) fe[k] = true;
  out.frontEnd = fe;
  return out;
}

// {portSet, issueSlots} for insights (either may be absent)
export function detailInsights(r) {
  const d = r?.details;
  if (!d) return {};
  const out = {};
  if (d.ports && Array.isArray(d.ports.rows)) {
    const instructions = d.ports.rows.map((uops, index) => ({ index, instr: r.rows[index]?.label, uops: round(uops) })).filter((x) => x.uops > 0)
      .sort((a, b) => b.uops - a.uops || a.index - b.index);
    out.portSet = { ports: d.ports.ports, uops: round(d.ports.uops), cycles: round(d.ports.tp), instructions };
  }
  if (d.issue?.slots) {
    const s = d.issue.slots;
    out.issueSlots = { width: d.issue.width, perIteration: { issued: s.issued, frontEnd: s.frontEnd, rob: s.rob, rs: s.rs, other: s.other } };
  }
  return out;
}
