// Random analysis requests for the differential tests (tests-js/interfaces.mjs, tests-js/web_interfaces_browser.mjs):
// blocks from the decoder fixtures (fixtures/decode_fixtures*.jsonl.gz, in git), whole, two joined, or cut at a random
// byte (which gives decode errors), with random options in the range that every interface accepts. Seeded: the same
// seed gives the same cases everywhere.
//
//   import { fuzzCases } from './fuzz-cases.mjs';
//   for (const c of fuzzCases({ seed: 1, count: 200 })) ...   // c = { id, hex, arch, options }
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** mulberry32: a small seeded PRNG; returns floats in [0, 1) */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let blocks = null;
/** the distinct blocks (hex) of the decoder fixtures, in a stable order */
export function fixtureBlocks() {
  if (blocks) return blocks;
  const seen = new Set();
  for (const f of ['decode_fixtures.jsonl.gz', 'decode_fixtures_extra.jsonl.gz']) {
    const lines = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'fixtures', f))).toString().trim().split('\n');
    for (const l of lines) {
      const hex = /"hex":\s*"([0-9a-fA-F]*)"/.exec(l)?.[1]?.toLowerCase();
      if (hex && hex.length <= 4000) seen.add(hex); // at most 2000 bytes: the slow cases are not the point here
    }
  }
  blocks = [...seen].sort();
  return blocks;
}

// The listed microarchitectures (the page's menu, the API's list).
export const ARCHS = ['SNB', 'IVB', 'HSW', 'BDW', 'SKL', 'KBL', 'SKX', 'CFL', 'CLX', 'ICL', 'TGL', 'ZEN3', 'RKL', 'ICX', 'ADL-P'];

/** count requests; options within every interface's limits (page: alignment 0..63; server: minIterations <= 1000, minCycles <= 20000) */
export function fuzzCases({ seed = 1, count = 100 } = {}) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const all = fixtureBlocks();
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = r();
    let hex = pick(all);
    if (k < 0.15) hex = (hex + pick(all)).slice(0, 4000);
    else if (k < 0.3 && hex.length > 4) { const cut = 2 * (1 + Math.floor(r() * (hex.length / 2 - 1))); hex = r() < 0.5 ? hex.slice(0, cut) : hex.slice(cut); }
    const options = {};
    if (r() < 0.3) options.alignmentOffset = Math.floor(r() * 64);
    if (r() < 0.2) options.initPolicy = pick(['diff', 'same', 'stack']);
    if (r() < 0.15) options.simpleFrontEnd = true;
    if (r() < 0.15) options.noMicroFusion = true;
    if (r() < 0.15) options.noMacroFusion = true;
    if (r() < 0.15) options.minIterations = pick([1, 2, 3, 7, 20, 100]);
    if (r() < 0.15) options.minCycles = pick([1, 10, 100, 1000, 2000]);
    out.push({ id: `${seed}:${i}`, hex, arch: pick(ARCHS), options });
  }
  return out;
}

/** the part of an analysis response that every interface must agree on; a failure: its class (code, trapped) */
export function essence(r) {
  if (!r || typeof r !== 'object') return { bad: String(r) };
  if (r.error !== undefined || (r.code !== undefined && r.code !== 0)) return { failed: true, trapped: !!r.trapped };
  const { arch, tp, mode, decodeErrors, bottlenecks, limits, columns, rows, text, criticalPath } = r;
  return { arch, tp, mode, decodeErrors, bottlenecks, limits, columns, rows, text, criticalPath: criticalPath ?? null };
}

/** the first difference between two values (a path and the two values), or null */
export function firstDiff(a, b, p = '') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return { path: p || '.', a, b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path: p, a: 'array?', b: 'array?' };
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${p}.${k}`);
    if (d) return d;
  }
  return null;
}
