// The compare views' data handling, without DOM (tests-js/web_compare.mjs runs it under Node):
//   summarize      the part of a response the views show
//   compareRows    rows of the "all CPUs" table: order, bars, the fastest and the current CPU
//   sweepData      the alignment sweep: 64 throughputs, minimum, maximum, failed offsets
//   sweepLayout    point positions of the sweep chart for a width and height in pixels
//   compareKey / sweepKey, ResultCache   results are reused across views and redraws
//   latestWins     debounced, single-flight scheduling: never queues work, runs only the latest request

export const SWEEP_OFFSETS = 64;

// The part of a response the compare views need; error responses (and missing ones) give {error}.
export function summarize(response) {
  if (!response || typeof response !== 'object') return { error: 'no response' };
  if ('error' in response) return { error: String(response.error), trapped: !!response.trapped };
  const tp = Number(response.tp);
  if (!Number.isFinite(tp)) return { error: 'unexpected response' };
  return {
    tp,
    bottlenecks: Array.isArray(response.bottlenecks) ? response.bottlenecks.map(String) : [],
    mode: response.mode,
    decodeErrors: Number(response.decodeErrors) || 0, // positions this CPU's decoder skipped (e.g. AVX2 on SNB)
    mock: !!response.mock,
  };
}

// Throughputs are compared as uiCA prints them (two decimals): 2.004 and 2.00 are the same.
const round2 = (x) => Math.round(x * 100) / 100;

// items: the menu items in menu order ([{key, title, experimental, ...}]); results: Map key -> summary (absent:
// not analyzed yet). sort: 'menu' (chronological, the menu's order) | 'tp' (fastest first) | 'tp-desc'.
// Rows without a result sort last, in menu order. bar: tp relative to the slowest result (0..1). decodeErrors: the
// positions a CPU could not decode (its result leaves those instructions out); such a row is not the fastest unless
// every row skipped as much.
export function compareRows(items, results, { sort = 'menu', current = null } = {}) {
  const ok = items.map((it) => results.get(it.key)).filter((r) => r && !r.error);
  const max = Math.max(0, ...ok.map((r) => r.tp));
  const fewest = Math.min(...ok.map((r) => r.decodeErrors ?? 0));
  const complete = ok.filter((r) => (r.decodeErrors ?? 0) === fewest);
  const min = complete.length ? Math.min(...complete.map((r) => round2(r.tp))) : null;
  const rows = items.map((it, index) => {
    const r = results.get(it.key);
    const state = !r ? 'pending' : r.error ? 'error' : 'ok';
    return {
      key: it.key, title: it.title, experimental: !!it.experimental, index, state,
      tp: state === 'ok' ? r.tp : null,
      bottlenecks: state === 'ok' ? r.bottlenecks : [],
      error: state === 'error' ? r.error : null,
      decodeErrors: state === 'ok' ? r.decodeErrors ?? 0 : 0,
      bar: state === 'ok' && max > 0 ? r.tp / max : 0,
      fastest: state === 'ok' && (r.decodeErrors ?? 0) === fewest && round2(r.tp) === min,
      current: it.key === current,
    };
  });
  if (sort === 'tp' || sort === 'tp-desc') {
    const sign = sort === 'tp' ? 1 : -1;
    rows.sort((a, b) => {
      if ((a.tp === null) !== (b.tp === null)) return a.tp === null ? 1 : -1;
      if (a.tp === null) return a.index - b.index;
      return sign * (a.tp - b.tp) || a.index - b.index;
    });
  }
  return rows;
}

// points: array (length 64) of summaries or undefined (not analyzed yet). The minimum and maximum are taken over
// the offsets that succeeded, at uiCA's precision; flat: every result is the same.
export function sweepData(points, n = SWEEP_OFFSETS) {
  const values = [];
  const failed = [];
  let pending = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (!p) { values.push(null); pending++; } else if (p.error) { values.push(null); failed.push(i); } else values.push(p.tp);
  }
  const ok = values.filter((v) => v !== null).map(round2);
  const min = ok.length ? Math.min(...ok) : null;
  const max = ok.length ? Math.max(...ok) : null;
  const at = (x) => values.flatMap((v, i) => (v !== null && round2(v) === x ? [i] : []));
  return {
    n, values, failed, pending, complete: pending === 0,
    min, max, minAt: min === null ? [] : at(min), maxAt: max === null ? [] : at(max),
    flat: ok.length > 0 && min === max,
  };
}

// Pixel positions for the chart: x of each offset (the centre of its column), y of each value (null: no point).
// The y range is the data's range with some room; a flat sweep is drawn in the middle.
export function sweepLayout(data, { width, height, left = 0, right = 0, top = 6, bottom = 6 }) {
  const plotW = Math.max(1, width - left - right);
  const plotH = Math.max(1, height - top - bottom);
  const step = plotW / data.n;
  let lo = data.min ?? 0, hi = data.max ?? 1;
  if (data.flat || lo === hi) { lo -= 1; hi += 1; }
  const y = (v) => top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const points = data.values.map((v, i) => ({ offset: i, x: left + (i + 0.5) * step, y: v === null ? null : y(round2(v)), value: v }));
  return { step, points, x0: left, x1: left + plotW, y0: top, y1: top + plotH, yOf: y };
}

// Cache keys. The table of all CPUs does not depend on the selected CPU, the sweep not on the alignment offset:
// moving those only moves a marker.
const optionKey = (o, skip = null) => JSON.stringify(Object.keys(o).filter((k) => k !== skip && k !== 'includeTrace').sort().map((k) => [k, o[k]]));
export const compareKey = (hex, options) => `cpus|${hex}|${optionKey(options)}`;
export const sweepKey = (hex, arch, options) => `sweep|${arch}|${hex}|${optionKey(options, 'alignmentOffset')}`;
export const resultKey = (hex, arch, options) => `${arch}|${hex}|${optionKey(options)}`;

// A bounded map (least recently used goes first) of resultKey -> summary.
export class ResultCache {
  #map = new Map();
  constructor(limit = 4096) { this.limit = limit; }
  get(k) {
    const v = this.#map.get(k);
    if (v !== undefined) { this.#map.delete(k); this.#map.set(k, v); }
    return v;
  }
  set(k, v) {
    this.#map.delete(k);
    this.#map.set(k, v);
    while (this.#map.size > this.limit) this.#map.delete(this.#map.keys().next().value);
  }
  get size() { return this.#map.size; }
}

// Debounced, single-flight scheduling of an async task.
//   schedule(ms)  (re)starts the debounce; when it ends, the task starts, or, if a run is in progress, the task
//                 runs once more after it (never more than one waiting run, whatever the number of requests)
//   cancel()      drops a waiting request and marks the running one stale
//   idle()        resolves when nothing is waiting or running (tests)
// The task gets {isStale, signal}: isStale() is true, and the signal aborts, once a newer request (or cancel) has come
// in, so a long task can stop early (the next run starts only when the task's promise has settled).
export function latestWins(task, { timers = globalThis, onError = null } = {}) {
  let timer = null;
  let running = null;
  let again = false;   // a request came in while running and its debounce has ended
  let gen = 0;         // counts requests; a run is stale when a newer one exists
  let abort = null;    // aborts the running task's signal
  const idlers = [];

  function settle() {
    if (timer === null && running === null) for (const r of idlers.splice(0)) r();
  }
  function start() {
    again = false;
    const mine = gen;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    abort = () => ctrl?.abort();
    running = (async () => {
      try { await task({ isStale: () => mine !== gen, signal: ctrl?.signal ?? null }); } catch (e) { onError?.(e); }
    })();
    running.then(() => {
      running = null;
      abort = null;
      if (again) start(); else settle();
    });
  }
  function fire() {
    timer = null;
    if (running) again = true; else start();
  }
  return {
    schedule(ms = 0) {
      gen++;
      abort?.();
      again = false; // the new debounce decides when the next run starts
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(fire, Math.max(0, ms));
    },
    cancel() {
      gen++;
      abort?.();
      again = false;
      if (timer !== null) { timers.clearTimeout(timer); timer = null; }
      settle();
    },
    get waiting() { return timer !== null || again; },
    get running() { return running !== null; },
    idle() { return new Promise((r) => { idlers.push(r); settle(); }); },
  };
}
