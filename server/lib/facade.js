// The library's interface (archs, analyze, compare, assemble, summarize), backed by the worker pool and this server's
// limits. The REST handlers and the MCP tools (the package's own createServer(w)) both go through it, so the contract
// is the package's and the limits are the same everywhere.
//
// Methods never throw: like the library they resolve to {code, error, stderr} on failure. A failure caused by this
// server (a limit, a full queue) carries the HTTP status in the symbol STATUS (not serialized).

import { BusyError } from './pool.js';

export const STATUS = Symbol('httpStatus');
export const RETRY_AFTER = Symbol('retryAfter');

function refuse(status, error, extra = {}) {
  const r = { code: 1, error, stderr: [{ text: error }] };
  r[STATUS] = status;
  Object.assign(r, extra);
  return r;
}

const kb = (n) => (n % 1024 ? `${n} bytes` : `${n / 1024} KB`);

export class Facade {
  #local; #pool; #cfg;

  // local: a wuica instance on the main thread, used only for the list of microarchitectures, arch ids and summarize().
  constructor(local, pool, cfg) {
    this.#local = local; this.#pool = pool; this.#cfg = cfg;
  }

  archs(fields) { return this.#local.archs(fields); }
  resolveArch(arch) { return this.#local.resolveArch(arch); }
  summarize(r) { return this.#local.summarize(r); }

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

  async #run(op, args, ctx) {
    let out;
    try {
      out = await this.#pool.run(op, args);
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
    ctx.arch = Array.isArray(request?.archs) && request.archs.length ? request.archs.map(String).join(',').slice(0, 200) : 'all';
    return this.#check(request) ?? this.#run('compare', { req: request }, ctx);
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
      analyze: (arch, request) => { ctx.tool = 'analyze'; return this.analyze(arch, request, ctx).then((r) => { ctx.code = r.code; return r; }); },
      compare: (request) => { ctx.tool = 'compare_archs'; return this.compare(request, ctx).then((r) => { ctx.code = r.code; return r; }); },
      assemble: (source, syntax) => { ctx.tool = 'assemble'; return this.assemble(source, syntax, ctx).then((r) => { ctx.code = r.code; return r; }); },
    };
  }
}
