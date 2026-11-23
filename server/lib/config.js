// The server's settings: defaults, overridden by environment variables (WUICA_*), overridden by createApp(options).

import os from 'node:os';

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',          // behind cloudflared: no inbound port is exposed
  port: 8787,
  workers: 0,                 // 0 = os.availableParallelism()
  maxQueue: 64,               // jobs waiting for a worker; beyond that: 503 + Retry-After
  timeoutMs: 10_000,          // per-request budget of a worker job; exceeded: the worker is terminated and replaced
  maxBodyBytes: 256 * 1024,
  maxSourceBytes: 64 * 1024,  // `source` (UTF-8 bytes) and `hex` (characters)
  maxInstructions: 10_000,
  maxMinIterations: 1_000,
  maxMinCycles: 20_000,
  analyzerMemoryMb: 2048,     // maximum memory of the analyzer's WebAssembly instance (the module itself has none: 4 GB)
  recycleMemoryMb: 256,       // a worker whose analyzer grew by more than this (wasm memory never shrinks) is replaced
  warm: true,                 // load every instruction table and the assembler before a worker takes jobs
  splitCompare: true,         // spread a compare over idle workers (lib/facade.js); false: a compare is one job
  rateBurst: 60,              // token bucket per client IP (0 = no rate limit)
  ratePerMinute: 120,
  compareCost: 3,             // tokens a /api/compare (or compare_archs call) costs; everything else costs 1
  trustCfHeader: true,        // take the client IP from CF-Connecting-IP (the server sits behind a Cloudflare tunnel)
  shutdownGraceMs: 15_000,
  log: true,                  // one JSON line per request on stdout
});

const ENV = {
  host: 'WUICA_HOST', port: 'WUICA_PORT', workers: 'WUICA_WORKERS', maxQueue: 'WUICA_MAX_QUEUE', timeoutMs: 'WUICA_TIMEOUT_MS',
  maxBodyBytes: 'WUICA_MAX_BODY_BYTES', maxSourceBytes: 'WUICA_MAX_SOURCE_BYTES', maxInstructions: 'WUICA_MAX_INSTRUCTIONS',
  maxMinIterations: 'WUICA_MAX_MIN_ITERATIONS', maxMinCycles: 'WUICA_MAX_MIN_CYCLES', analyzerMemoryMb: 'WUICA_ANALYZER_MEMORY_MB',
  recycleMemoryMb: 'WUICA_RECYCLE_MEMORY_MB', warm: 'WUICA_WARM', splitCompare: 'WUICA_SPLIT_COMPARE', rateBurst: 'WUICA_RATE_BURST', ratePerMinute: 'WUICA_RATE_PER_MINUTE',
  compareCost: 'WUICA_COMPARE_COST', trustCfHeader: 'WUICA_TRUST_CF_HEADER', shutdownGraceMs: 'WUICA_SHUTDOWN_GRACE_MS', log: 'WUICA_LOG',
};

function parse(key, raw) {
  const d = DEFAULTS[key];
  if (typeof d === 'boolean') return !/^(0|false|no|off)$/i.test(raw);
  if (typeof d === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${ENV[key]}: expected a non-negative number, got "${raw}"`);
    return n;
  }
  return raw;
}

export function fromEnv(env = process.env) {
  const out = {};
  for (const [key, name] of Object.entries(ENV)) if (env[name] !== undefined && env[name] !== '') out[key] = parse(key, env[name]);
  return out;
}

export function resolveConfig(options = {}) {
  const unknown = Object.keys(options).filter((k) => !Object.hasOwn(DEFAULTS, k) && k !== 'dataDir');
  if (unknown.length) throw new Error(`unknown server option(s): ${unknown.join(', ')}`);
  const c = { ...DEFAULTS, ...options };
  if (!c.workers) c.workers = os.availableParallelism();
  return c;
}
