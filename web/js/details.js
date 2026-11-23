// The details of a result (docs/WASM-API.md, "details": per instruction its allowed ports, latencies and front-end facts;
// the port set behind the Ports limit; the issue slots per cause), fetched only when a view asks for them: one more
// analysis of the same request with `details: true`, once per result. Shared by the instruction card (icard.js) and the
// port-set drill-down of the bound view (portset.js). A response without details (the mock engine, an old module) gives
// null: the views then show what the response has.
//
// The first half has no DOM (tests-js/web_details.mjs runs it under Node).

// The details belong to the response if they have one entry per row and the same throughput was predicted.
export function detailsFit(response, res) {
  const d = res?.details;
  return !!d && Array.isArray(d.rows) && Array.isArray(response?.rows) && d.rows.length === response.rows.length && res.tp === response.tp;
}

// "1*p0156+1*p23" (uops.info's notation) from portData; non-Intel names (ALU0, FP2, ...) are listed: 1*[ALU0 ALU1]
export function portString(portData) {
  if (!Array.isArray(portData) || !portData.length) return '';
  return portData.map((p) => {
    const names = p.ports ?? [];
    const intel = names.every((n) => /^Port \w$/.test(n));
    return `${p.uops}*${intel ? 'p' + names.map((n) => n.slice(5)).join('') : `[${names.join(' ')}]`}`;
  }).join('+');
}

// The instruction's reciprocal throughput from its ports alone (the most uops per port over the unions of two of its port
// sets, as Facile's port model computes it for the block), and from the table's limit; cycles per instruction.
export function portThroughput(det) {
  const sets = (det?.portData ?? []).map((p) => ({ set: new Set(p.ports), uops: Number(p.uops) || 0 })).filter((p) => p.set.size);
  let best = 0;
  for (const a of sets) {
    for (const b of sets) {
      const u = new Set([...a.set, ...b.set]);
      const uops = sets.filter((s) => [...s.set].every((x) => u.has(x))).reduce((n, s) => n + s.uops, 0);
      best = Math.max(best, uops / u.size);
    }
  }
  return Math.max(best, Number(det?.tpTable) || 0);
}

// Latencies to show: per (input, output) pair, without the flag outputs of an instruction that writes a register too.
export function latencyPairs(det) {
  const all = Array.isArray(det?.latencies) ? det.latencies : [];
  const isFlags = (x) => String(x).startsWith('flags');
  const regOut = all.some((l) => !isFlags(l.to));
  const out = [];
  for (const l of all) {
    if (regOut && isFlags(l.to)) continue;
    if (!out.some((x) => x.from === l.from && x.to === l.to)) out.push(l);
  }
  return out;
}

// ---- the fetcher -----------------------------------------------------------------------------------------------------

const isCancel = (e) => e?.name === 'CancelledError';

// env: { engine() }. get(view) resolves to the details of view.response, or null; one analysis per view (a cancelled one
// is tried again on the next get).
export function createDetails(env) {
  const done = new WeakMap();    // view -> details | null
  const pending = new WeakMap(); // view -> promise
  const listeners = [];          // (view, details): details arrived (for any of the views that asked)
  return {
    onLoad(f) { listeners.push(f); },
    peek(view) { return done.get(view); }, // undefined: not fetched
    get(view) {
      if (!view) return Promise.resolve(null);
      if (done.has(view)) return Promise.resolve(done.get(view));
      let p = pending.get(view);
      if (p) return p;
      const r = view.response;
      if (!r || r.error || r.mock || !view.request || !env.engine?.()) { done.set(view, null); return Promise.resolve(null); }
      p = (async () => {
        try {
          const res = await env.engine().analyze({ ...view.request, details: true });
          const d = detailsFit(r, res) ? res.details : null;
          done.set(view, d);
          if (d) for (const f of listeners) { try { f(view, d); } catch { /* a view's problem */ } }
          return d;
        } catch (e) {
          if (!isCancel(e)) done.set(view, null);
          return null;
        } finally {
          pending.delete(view);
        }
      })();
      pending.set(view, p);
      return p;
    },
  };
}
