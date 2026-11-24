// The library's interface (archs, analyze, compare, assemble, summarize), backed by the worker pool and this server's
// limits. The REST handlers and the MCP tools (the package's own createServer(w)) both go through it, so the contract
// is the package's and the limits are the same everywhere.
//
// Methods never throw: like the library they resolve to {code, error, stderr} on failure. A failure caused by this
// server (a limit, a full queue) carries the HTTP status in the symbol STATUS (not serialized).
//
// A compare is one job, except when the pool has nothing waiting and at least two idle workers: then its
// microarchitectures are split into parts of PART_ARCHS consecutive ones, one job each, run in `lanes` (as many as
// the idle workers, at most half the pool but at least two): a lane sends its next part when the previous one is done,
// so a request that comes in meanwhile is queued ahead of it and waits for one part at most. The parts' rows are put
// together in order. Each part is checked and limited like a whole compare (the instruction count of the limit is that
// of the whole request's first microarchitecture), and the parts share the time budget of one job (a part gets what is
// left of it, and none is sent once it is spent), so the response is the one the single job would give. On a pool of two
// workers this takes both: a request that comes in while a compare runs waits for one part (on aethia, for the SHA-256
// showcase, up to ~90 ms). splitCompare: false (WUICA_SPLIT_COMPARE=0) turns it off.

import { whatIfRequest, diffAnalyses } from 'wuica';
import { BusyError, timeoutFailure } from './pool.js';

export const STATUS = Symbol('httpStatus');
export const RETRY_AFTER = Symbol('retryAfter');

function refuse(status, error, extra = {}) {
  const r = { code: 1, error, stderr: [{ text: error }] };
  r[STATUS] = status;
  Object.assign(r, extra);
  return r;
}

const kb = (n) => (n % 1024 ? `${n} bytes` : `${n / 1024} KB`);
export const PART_ARCHS = 2;

export class Facade {
  #local; #pool; #cfg;

  // local: a wuica instance on the main thread, used only for the list of microarchitectures, arch ids, insights() and
  // summarize().
  constructor(local, pool, cfg) {
    this.#local = local; this.#pool = pool; this.#cfg = cfg;
  }

  archs(fields) { return this.#local.archs(fields); }
  resolveArch(arch) { return this.#local.resolveArch(arch); }
  summarize(r) { return this.#local.summarize(r); }
  insights(r) { return this.#local.insights(r); }

  // The checks that need no analysis: sizes and simulation options. Returns a failure or null.
  #check(req) {
    if (req === null || typeof req !== 'object' || Array.isArray(req)) return null; // the library reports it
    const c = this.#cfg;
    const source = req.source ?? req.asm;
    if (typeof source === 'string' && Buffer.byteLength(source) > c.maxSourceBytes) {
      return refuse(413, `\`source\` is larger than ${kb(c.maxSourceBytes)}, the limit of this server`);
    }
    if (typeof req.hex === 'string' && req.hex.length > c.maxSourceBytes) {
      return refuse(413, `\`hex\` is longer than ${c.maxSourceBytes} characters, the limit of this server`);
    }
    const options = req.options !== null && typeof req.options === 'object' ? req.options : {};
    for (const [k, max] of [['minIterations', c.maxMinIterations], ['minCycles', c.maxMinCycles]]) {
      const v = options[k] ?? req[k];
      if (typeof v === 'number' && v > max) return refuse(400, `\`options.${k}\` is ${v}; the limit of this server is ${max}`);
    }
    return null;
  }

  async #run(op, args, ctx, options) {
    let out;
    try {
      out = await this.#pool.run(op, args, options);
    } catch (e) {
      if (!(e instanceof BusyError)) throw e;
      ctx.busy = true;
      return refuse(503, 'the server is busy; try again later', { [RETRY_AFTER]: e.retryAfter });
    }
    ctx.queueMs = out.queueMs;
    ctx.runMs = out.runMs;
    if (out.meta?.instructions != null) ctx.instructions = out.meta.instructions;
    if (out.meta?.bytes != null) ctx.bytes = out.meta.bytes;
    if (out.timedOut) ctx.timedOut = true;
    if (out.shuttingDown) out.result[STATUS] = 503;
    if (out.meta?.limit) out.result[STATUS] = 400;
    return out.result;
  }

  async analyze(arch, request, ctx = {}) {
    let req = request;
    if (typeof arch === 'object' && arch !== null && request === undefined) { req = arch; arch = req.arch; }
    ctx.arch = this.resolveArch(arch) ?? String(arch).slice(0, 40);
    return this.#check(req) ?? this.#run('analyze', { arch, req }, ctx);
  }

  async compare(request = {}, ctx = {}) {
    const n = this.#local.archs().length;
    if (Array.isArray(request?.archs) && request.archs.length > n) {
      return refuse(400, `\`archs\` lists ${request.archs.length} microarchitectures; at most ${n} are allowed`);
    }
    // repeated names count once (as in the library), before the parts are made (the limit above counts the list as given)
    if (Array.isArray(request?.archs) && request.archs.length > 1) {
      const seen = new Set();
      const archs = request.archs.filter((a) => { const k = this.resolveArch(a) ?? `?${String(a).trim()}`; return !seen.has(k) && seen.add(k); });
      if (archs.length < request.archs.length) request = { ...request, archs };
    }
    ctx.arch = Array.isArray(request?.archs) && request.archs.length ? request.archs.map(String).join(',').slice(0, 200) : 'all';
    const bad = this.#check(request);
    if (bad) return bad;
    const split = this.#split(request);
    if (!split) return this.#run('compare', { req: request }, ctx);
    const { parts, lanes } = split;
    const sizeArch = Array.isArray(request.archs) && request.archs.length ? request.archs[0] : undefined;
    const ctxs = parts.map(() => /** @type {Record<string, any>} */ ({}));
    const out = new Array(parts.length).fill(null);
    const deadline = performance.now() + this.#cfg.timeoutMs; // one job's budget for all parts
    let next = 0;
    await Promise.all(Array.from({ length: lanes }, async () => {
      while (next < parts.length && !out.some((r) => r && r.code !== 0)) {
        const i = next++;
        const left = deadline - performance.now();
        if (left <= 0) { out[i] = timeoutFailure(this.#cfg.timeoutMs); ctxs[i].timedOut = true; break; }
        out[i] = await this.#run('compare', { req: { ...request, archs: parts[i] }, sizeArch }, ctxs[i], { timeoutMs: left });
      }
    }));
    const run = ctxs.filter((c, i) => out[i]);
    ctx.queueMs = Math.max(...run.map((c) => c.queueMs ?? 0));
    ctx.runMs = run.reduce((n, c) => n + (c.runMs ?? 0), 0);
    for (const k of ['instructions', 'bytes']) if (ctxs[0][k] !== undefined) ctx[k] = ctxs[0][k];
    for (const k of ['busy', 'timedOut']) if (run.some((c) => c[k])) ctx[k] = true;
    ctx.parts = run.length;
    const failed = out.find((r) => r && r.code !== 0); // the first part that failed (every part before it ran)
    return failed ?? { ...out[0], results: out.flatMap((r) => r.results) };
  }

  // The parts of a compare and the number of lanes for them (see the top), or null for one job.
  #split(request) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) return null;
    if (request.archs !== undefined && !Array.isArray(request.archs)) return null; // the library reports it
    const ids = request.archs?.length ? request.archs : this.#local.archs().map((a) => a.id);
    const pool = this.#pool;
    if (!this.#cfg.splitCompare || pool.queued > 0 || ids.length <= PART_ARCHS) return null;
    const lanes = Math.min(pool.idle, Math.max(2, Math.ceil(pool.size / 2)));
    if (lanes < 2) return null;
    const parts = [];
    for (let i = 0; i < ids.length; i += PART_ARCHS) parts.push(ids.slice(i, i + PART_ARCHS));
    return { parts, lanes: Math.min(lanes, parts.length) };
  }

  // A request that runs several analysis jobs (what-if, diff): the library's interface for them with one deadline for
  // all (the budget of one job, as a compare's parts share it); nothing more is started once it has passed, a job
  // refused (busy) or the client has gone (ctx.gone). ctx gets the totals: queueMs, runMs, jobs, and the instructions
  // and bytes of the first job. end(result): the result, or the reason the request stopped.
  #session(ctx) {
    const deadline = performance.now() + this.#cfg.timeoutMs;
    /** @type {any} */
    let stop = null;
    ctx.queueMs = 0; ctx.runMs = 0; ctx.jobs = 0;
    const job = async (check, op, args) => {
      if (stop) return stop;
      if (ctx.gone) return (stop = refuse(499, 'the client closed the connection'));
      const bad = check();
      if (bad) return bad;
      const left = deadline - performance.now();
      if (left <= 0) { ctx.timedOut = true; return (stop = timeoutFailure(this.#cfg.timeoutMs)); }
      /** @type {Record<string, any>} */
      const c = {};
      const r = await this.#run(op, args, c, { timeoutMs: left });
      ctx.jobs++;
      ctx.queueMs += c.queueMs ?? 0;
      ctx.runMs += c.runMs ?? 0;
      for (const k of ['instructions', 'bytes']) if (ctx[k] === undefined && c[k] !== undefined) ctx[k] = c[k];
      if (c.timedOut) { ctx.timedOut = true; stop = timeoutFailure(this.#cfg.timeoutMs); }
      if (c.busy) { ctx.busy = true; stop = r; }
      return r;
    };
    const w = {
      resolveArch: (a) => this.resolveArch(a),
      analyze: (arch, req) => { ctx.arch ??= this.resolveArch(arch) ?? String(arch).slice(0, 40); return job(() => this.#check(req), 'analyze', { arch, req }); },
      assemble: (source, syntax = 'intel') => job(() => this.#check({ source }), 'assemble', { source, syntax }),
    };
    return { w, end: (r) => stop ?? r };
  }

  // The what-if experiments (the package's whatIfRequest, as the MCP tool what_if): each variant one analysis job, all
  // within one deadline (#session).
  async whatIf(arch, request, ctx = {}) {
    const { w, end } = this.#session(ctx);
    return end(await whatIfRequest(w, arch, request));
  }

  // Two blocks (the package's diffAnalyses, as the MCP tool diff_blocks): {result, a, b} or {failure}. The sizes and
  // options of both blocks are checked before either is analyzed; both analyses within one deadline.
  async diff(arch, request, ctx = {}) {
    if (request !== null && typeof request === 'object') {
      for (const k of ['a', 'b']) {
        const x = request[k];
        if (x === null || typeof x !== 'object') continue;
        const bad = this.#check(request.options !== undefined && x.options === undefined ? { ...x, options: request.options } : x);
        if (bad) { bad.error = `${k.toUpperCase()}: ${bad.error}`; bad.stderr = [{ text: bad.error }]; return { failure: bad }; }
      }
    }
    const { w, end } = this.#session(ctx);
    const x = await diffAnalyses(w, arch, request);
    const stopped = end(null);
    return stopped ? { failure: stopped } : x;
  }

  async assemble(source, syntax = 'intel', ctx = {}) {
    return this.#check({ source }) ?? this.#run('assemble', { source, syntax }, ctx);
  }

  // The same methods bound to a log context (for the MCP tools, which call w.analyze(arch, request) etc.).
  forRequest(ctx) {
    return {
      archs: (fields) => { ctx.tool ??= 'list_archs'; return this.archs(fields); },
      summarize: (r) => this.summarize(r),
      resolveArch: (a) => this.resolveArch(a),
      analyze: (arch, request) => { ctx.tool ??= 'analyze'; return this.analyze(arch, request, ctx).then((r) => { ctx.code = r.code; return r; }); },
      compare: (request) => { ctx.tool ??= 'compare_archs'; return this.compare(request, ctx).then((r) => { ctx.code = r.code; return r; }); },
      whatIf: (arch, request) => { ctx.tool ??= 'what_if'; return this.whatIf(arch, request, ctx).then((r) => { ctx.code = r.code; return r; }); },
      diff: (arch, request) => { ctx.tool ??= 'diff_blocks'; return this.diff(arch, request, ctx).then((/** @type {any} */ x) => { const r = x.failure ?? x.result; ctx.code = r.code; return r; }); },
      assemble: (source, syntax) => { ctx.tool ??= 'assemble'; return this.assemble(source, syntax, ctx).then((r) => { ctx.code = r.code; return r; }); },
    };
  }
}
