// The HTTP server: the public REST API (Compiler Explorer style, the contract in packages/wuica/README.md) and the
// remote MCP endpoint (Streamable HTTP, stateless), on Node's http module.
//
//   GET  /                       index
//   GET  /healthz                health
//   GET  /api/archs[?fields=]    microarchitectures
//   POST /api/analyze/<arch>     analysis
//   POST /api/compare            one block on several microarchitectures
//   POST /api/what-if/<arch>     what-if experiments (unrolled, N accumulators, front end, fusion; the MCP tool what_if)
//   POST /api/diff/<arch>        two blocks, before and after (the MCP tool diff_blocks)
//   POST /api/assemble           assembly -> hex
//   GET  /api/version            versions
//   POST /mcp                    MCP (tools list_archs, analyze, what_if, compare_archs, assemble)
//
// JSON by default; `Accept: text/plain` gives uiCA's text report (or the stderr lines of a failure); `Accept:
// text/markdown` on analyze and compare gives the package's Markdown (markdown.report, markdown.cpuTable).

import http from 'node:http';
import { createWuica, ARCH_FIELDS, detailInsights, markdown, whatIfText, diffMarkdown, diffText, WHAT_IF_VARIANTS } from 'wuica';
import { createMcpServer } from './mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { resolveConfig } from './config.js';
import { Pool } from './pool.js';
import { Facade, STATUS, RETRY_AFTER } from './facade.js';
import { RateLimiter } from './ratelimit.js';
import { versionInfo } from './version.js';

const SITE = 'https://wuica.jacen.li';
const MAX_MCP_BATCH = 16; // JSON-RPC messages in one POST /mcp

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

const failure = (error) => ({ code: 1, error, stderr: [{ text: error }] });
const stderrText = (r) => (r.stderr?.length ? r.stderr.map((l) => l.text).join('\n') : r.error ?? '') + '\n';

// ---- text renderings (Accept: text/plain), in the format of the package's CLI ----

function archsText(archs) {
  const width = Math.max(...archs.map((a) => a.id.length));
  return archs.map((a) => `${a.id.padEnd(width)}  ${a.name}${a.year ? ` (${a.year})` : ''}${a.prototype ? '  [prototype]' : ''}\n`).join('');
}

function compareText(c) {
  if (c.code) return stderrText(c);
  const fmt = (tp) => tp.toFixed(2);
  const kw = Math.max(4, ...c.results.map((r) => r.arch.length));
  const nw = Math.max(5, ...c.results.map((r) => r.name.length));
  // with per (elementsPerIteration): cycles per element too, as the CLI prints it (three significant digits below 0.1)
  const per = c.elementsPerIteration;
  const fmtEl = (x) => (x !== 0 && Math.abs(x) < 0.1 ? Number(x).toPrecision(3) : fmt(x));
  let out = `${'Arch'.padEnd(kw)}  ${'Model'.padEnd(nw)}  Year  ${'TP'.padStart(6)}${per ? `  ${'per el'.padStart(6)}` : ''}  Bottlenecks\n`;
  for (const r of c.results) {
    const year = String(r.year ?? '').padEnd(4);
    const rest = r.code ? `error: ${r.error.split('\n')[0]}` : `${r.bottlenecks.join(', ') || '-'}${r.prototype ? '  [prototype]' : ''}`;
    out += `${r.arch.padEnd(kw)}  ${r.name.padEnd(nw)}  ${year}  ${(r.code ? '-' : fmt(r.tp)).padStart(6)}${per ? `  ${(r.code ? '-' : fmtEl(r.perElement)).padStart(6)}` : ''}  ${rest}\n`;
  }
  return out + `\nTP: cycles per iteration${per ? `; per el: cycles per element (${per} per iteration)` : ''}. [prototype]: experimental model of the fork jtl06/uiCA.\n`;
}

function flatText(obj, prefix = '') {
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object') out += flatText(v, `${prefix}${k}.`);
    else out += `${prefix}${k}: ${v}\n`;
  }
  return out;
}

function index() {
  return {
    name: 'wuica API',
    description: 'x86-64 basic-block throughput prediction (uiCA, in WebAssembly). Not the official uiCA (https://uiCA.uops.info).',
    site: SITE,
    docs: 'https://github.com/jtl06/wuica/blob/main/packages/wuica/README.md#api-contract',
    endpoints: {
      'GET /api/archs[?fields=id,name]': 'microarchitectures',
      'POST /api/analyze/<arch>': 'analysis: {source | hex, syntax?, options?}',
      'POST /api/compare': 'one block on several microarchitectures: {source | hex, syntax?, archs?, options?}',
      'POST /api/what-if/<arch>': 'what-if experiments: {source | hex, syntax?, options?, variants?, per?}',
      'POST /api/diff/<arch>': 'two blocks, before and after: {a: {source | hex, ...}, b: {...}, options?, per?}',
      'POST /api/assemble': 'assembly to machine code: {source, syntax?}',
      'GET /api/version': 'versions',
      'POST /mcp': 'remote MCP server (Streamable HTTP): tools list_archs, analyze, what_if, compare_archs, assemble',
      'GET /healthz': 'health',
    },
    formats: 'JSON; send "Accept: text/plain" for uiCA\'s text report, "Accept: text/markdown" (analyze, compare) for Markdown',
  };
}

// ---- the server ----

export async function createApp(options = {}) {
  const cfg = resolveConfig(options);
  const log = cfg.log ? (o) => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...o }) + '\n') : () => {};
  const local = await createWuica({ threads: 1, ...(cfg.dataDir ? { dataDir: cfg.dataDir } : {}) });
  const pool = new Pool({
    size: cfg.workers, maxQueue: cfg.maxQueue, timeoutMs: cfg.timeoutMs, log,
    workerData: {
      dataDir: cfg.dataDir, warm: cfg.warm, maxInstructions: cfg.maxInstructions,
      analyzerMemoryMb: cfg.analyzerMemoryMb, recycleMemoryMb: cfg.recycleMemoryMb,
    },
  });
  try {
    await pool.start();
  } catch (e) {
    await pool.close();
    throw e;
  }
  const facade = new Facade(local, pool, cfg);
  const limiter = new RateLimiter({ burst: cfg.rateBurst, perMinute: cfg.ratePerMinute });
  let draining = false;

  function clientIp(req) {
    const cf = cfg.trustCfHeader ? req.headers['cf-connecting-ip'] : undefined;
    return (typeof cf === 'string' && cf) || req.socket.remoteAddress || 'unknown';
  }

  // Reads the body up to maxBodyBytes. Beyond that: 413; the rest of a moderately larger body is read and dropped (so
  // that the client sees the response), a much larger one closes the connection.
  function readBody(req) {
    const max = cfg.maxBodyBytes;
    const tooLarge = (close) => new HttpError(413, `the request body is larger than ${max / 1024} KB, the limit of this server`, close ? { Connection: 'close' } : {});
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (declared > max) { req.resume(); return reject(tooLarge(declared > 4 * max)); }
      const chunks = [];
      let size = 0, done = false;
      req.on('data', (c) => {
        size += c.length;
        if (done) { if (size > 4 * max) req.destroy(); return; }
        if (size > max) { done = true; return reject(tooLarge(false)); }
        chunks.push(c);
      });
      req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
      req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
  }

  async function readJson(req) {
    const text = await readBody(req);
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'the request body is not valid JSON');
    }
  }

  function send(res, status, body, { text = false, headers = {}, type = 'text/plain' } = {}) {
    const isText = typeof body === 'string';
    const payload = isText ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': isText || text ? `${type}; charset=utf-8` : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }

  // A result of the contract: status from its code (or the server's refusal), JSON or text.
  function sendResult(res, r, wantText, toText, extraStatus) {
    const status = r[STATUS] ?? extraStatus ?? (r.code === 1 ? 400 : 200);
    const headers = r[RETRY_AFTER] ? { 'Retry-After': String(r[RETRY_AFTER]) } : {};
    send(res, status, wantText ? (r.code ? stderrText(r) : toText(r)) : r, { headers });
  }

  const wantsText = (req) => {
    const a = String(req.headers.accept ?? '');
    return /\btext\/plain\b/i.test(a) && !/\bapplication\/json\b/i.test(a);
  };
  const wantsMarkdown = (req) => {
    const a = String(req.headers.accept ?? '');
    return /\btext\/markdown\b/i.test(a) && !/\bapplication\/json\b/i.test(a);
  };
  const archTitle = (id) => { const a = facade.archs().find((x) => x.id === id); return a ? `${id} · ${a.name}${a.year ? ` (${a.year})` : ''}` : id; };
  // a result as Markdown: status as for JSON
  function sendMarkdown(res, r, md, extraStatus) {
    const status = r[STATUS] ?? extraStatus ?? (r.code === 1 ? 400 : 200);
    send(res, status, md, { type: 'text/markdown', headers: r[RETRY_AFTER] ? { 'Retry-After': String(r[RETRY_AFTER]) } : {} });
  }

  function checkKeys(body, allowed) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return failure('the request body must be a JSON object');
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    return unknown.length ? failure(`unknown request field(s): ${unknown.join(', ')} (known: ${allowed.join(', ')})`) : null;
  }

  async function handleMcp(req, res, ctx) {
    if (req.method !== 'POST') {
      // stateless: no SSE stream to open (GET) and no session to delete (DELETE)
      return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless; use POST' }, id: null }, { headers: { Allow: 'POST, OPTIONS' } });
    }
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      // invalid JSON is a JSON-RPC parse error (as the MCP SDK answers it); a body that is too large stays a 413
      if (e instanceof HttpError && e.status === 400) return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: the request body is not valid JSON' }, id: null });
      throw e;
    }
    const msgs = Array.isArray(body) ? body : [body];
    if (msgs.length > MAX_MCP_BATCH) {
      return send(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: `a batch may hold at most ${MAX_MCP_BATCH} messages` }, id: null });
    }
    ctx.rpc = msgs.map((m) => (typeof m?.method === 'string' ? m.method.slice(0, 40) : 'response')).join(',').slice(0, 200);
    const call = msgs.find((m) => m?.method === 'tools/call');
    if (call && typeof call.params?.name === 'string') ctx.tool = call.params.name.slice(0, 40);
    rateLimit(req, ctx, Math.max(1, msgs.reduce((n, m) => n + toolCost(m), 0)));
    watchGone(res, ctx);
    const server = createMcpServer(facade.forRequest(ctx));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  // Tokens: a request costs in proportion to the analyses it can start, a compare of every microarchitecture costing
  // compareCost; at least 1 (any request), at most the burst (a request that costs more could never run). The same for
  // REST and /mcp. Analyses: analyze 1; compare the microarchitectures asked for (default all); what-if the base and
  // each variant that analyzes (not nochain), align 64; diff 2.
  function cost(analyses) {
    const n = Math.max(1, facade.archs().length);
    return Math.max(1, Math.min(cfg.rateBurst || Infinity, Math.ceil((analyses * cfg.compareCost) / n)));
  }
  const compareAnalyses = (archs) => (Array.isArray(archs) && archs.length ? archs.length : facade.archs().length);
  function whatIfAnalyses(variants) {
    const v = Array.isArray(variants) ? variants : WHAT_IF_VARIANTS;
    return 1 + v.filter((x) => x !== 'nochain' && x !== 'align').length + (v.includes('align') ? 64 : 0);
  }
  function toolCost(m) {
    if (m?.method !== 'tools/call') return 1;
    const a = m.params?.arguments ?? {};
    switch (m.params?.name) {
      case 'analyze': return cost(1);
      case 'compare_archs': return cost(compareAnalyses(a.archs));
      case 'what_if': return cost(whatIfAnalyses(a.variants));
      case 'diff_blocks': return cost(2);
      default: return 1;
    }
  }
  // a client that goes away before the response: the jobs not yet started are not started (Facade#session)
  const watchGone = (res, ctx) => res.on('close', () => { if (!res.writableFinished) ctx.gone = true; });

  function rateLimit(req, ctx, cost = 1) {
    const r = limiter.take(clientIp(req), cost);
    if (!r.ok) {
      ctx.rateLimited = true;
      throw new HttpError(429, 'too many requests; try again later', { 'Retry-After': String(r.retryAfter) });
    }
  }

  async function route(req, res, url, ctx) {
    const p = url.pathname;
    const isApi = p.startsWith('/api/') || p === '/mcp';
    if (isApi) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After, Mcp-Session-Id, Mcp-Protocol-Version');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
          'Access-Control-Max-Age': '86400',
        });
        return res.end();
      }
    }
    if (draining) throw new HttpError(503, 'the server is restarting; try again shortly', { 'Retry-After': '5', Connection: 'close' });
    const wantText = wantsText(req);
    const method = (allowed) => {
      if (!allowed.includes(req.method)) throw new HttpError(405, `use ${allowed.join(' or ')} for ${p}`, { Allow: [...allowed, ...(isApi ? ['OPTIONS'] : [])].join(', ') });
    };

    if (p === '/') {
      method(['GET', 'HEAD']);
      const i = index();
      return send(res, 200, wantText ? `${i.name}: ${i.description}\nSite: ${i.site}\nDocs: ${i.docs}\n\n${Object.entries(i.endpoints).map(([k, v]) => `${k.padEnd(32)} ${v}`).join('\n')}\n` : i);
    }
    if (p === '/healthz') {
      method(['GET', 'HEAD']);
      const ok = pool.ready > 0;
      return send(res, ok ? 200 : 503, { ok, workers: pool.size, ready: pool.ready, busy: pool.busy, queued: pool.queued }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (p === '/mcp') return handleMcp(req, res, ctx);
    if (!isApi) throw new HttpError(404, `not found: ${p} (see ${SITE} or GET /)`);

    if (p === '/api/archs') {
      method(['GET']);
      rateLimit(req, ctx);
      const fields = url.searchParams.get('fields') || undefined;
      const unknown = (fields ?? '').split(',').map((f) => f.trim()).filter((f) => f !== '' && f !== 'all' && !ARCH_FIELDS.includes(f));
      if (unknown.length) throw new HttpError(400, `unknown field(s): ${unknown.join(', ')} (valid: ${ARCH_FIELDS.join(', ')})`);
      const archs = facade.archs(fields);
      return send(res, 200, wantText ? archsText(facade.archs()) : archs, { headers: { 'Cache-Control': 'public, max-age=3600' } });
    }
    if (p === '/api/version') {
      method(['GET']);
      rateLimit(req, ctx);
      const v = versionInfo();
      return send(res, 200, wantText ? flatText(v) : v, { headers: { 'Cache-Control': 'public, max-age=300' } });
    }
    if (p === '/api/analyze' || p.startsWith('/api/analyze/')) {
      method(['POST']);
      let arch;
      try { arch = decodeURIComponent(p.slice('/api/analyze/'.length)).trim(); } catch { arch = ''; }
      if (!arch) throw new HttpError(404, 'give the microarchitecture in the path: POST /api/analyze/<arch> (see GET /api/archs)');
      rateLimit(req, ctx);
      const body = await readJson(req);
      const r = await facade.analyze(arch, body, ctx);
      ctx.code = r.code;
      // the derived diagnosis of the page's bound view (the package's insights.js), as in the MCP tool's summary
      const ins = r.code === 0 && !wantText ? facade.insights(r) : null;
      if (ins) r.insights = { ...ins, ...detailInsights(r) }; // with options.details: portSet, issueSlots
      const unknownArch = r.code === 1 && facade.resolveArch(arch) === null && /^unknown microarchitecture/.test(r.error ?? '');
      if (!wantText && wantsMarkdown(req)) {
        return sendMarkdown(res, r, markdown.report(r, { arch: r.code ? arch : archTitle(r.arch), insights: r.insights ?? null, source: typeof body?.source === 'string' ? body.source : undefined }), unknownArch ? 404 : undefined);
      }
      return sendResult(res, r, wantText, (x) => x.text, unknownArch ? 404 : undefined);
    }
    if (p === '/api/what-if' || p.startsWith('/api/what-if/')) {
      method(['POST']);
      let arch;
      try { arch = decodeURIComponent(p.slice('/api/what-if/'.length)).trim(); } catch { arch = ''; }
      if (!arch) throw new HttpError(404, 'give the microarchitecture in the path: POST /api/what-if/<arch> (see GET /api/archs)');
      const body = await readJson(req);
      rateLimit(req, ctx, cost(whatIfAnalyses(body?.variants)));
      watchGone(res, ctx);
      const r = await facade.whatIf(arch, body, ctx);
      ctx.code = r.code;
      const unknownArch = r.code === 1 && facade.resolveArch(arch) === null && /^unknown microarchitecture/.test(r.error ?? '');
      if (!wantText && wantsMarkdown(req)) return sendMarkdown(res, r, r.code ? markdown.report(r) : markdown.whatIfAlignment(r), unknownArch ? 404 : undefined);
      return sendResult(res, r, wantText, whatIfText, unknownArch ? 404 : undefined);
    }
    if (p === '/api/diff' || p.startsWith('/api/diff/')) {
      method(['POST']);
      let arch;
      try { arch = decodeURIComponent(p.slice('/api/diff/'.length)).trim(); } catch { arch = ''; }
      if (!arch) throw new HttpError(404, 'give the microarchitecture in the path: POST /api/diff/<arch> (see GET /api/archs)');
      const body = await readJson(req);
      rateLimit(req, ctx, cost(2));
      watchGone(res, ctx);
      const x = /** @type {any} */ (await facade.diff(arch, body, ctx));
      const r = x.failure ?? x.result;
      ctx.code = r.code;
      const unknownArch = r.code === 1 && facade.resolveArch(arch) === null && /unknown microarchitecture/.test(r.error ?? '');
      if (!wantText && wantsMarkdown(req)) return sendMarkdown(res, r, diffMarkdown(x, { archTitle: r.code ? undefined : archTitle(r.arch) }), unknownArch ? 404 : undefined);
      return sendResult(res, r, wantText, diffText, unknownArch ? 404 : undefined);
    }
    if (p === '/api/compare') {
      method(['POST']);
      const body = await readJson(req);
      rateLimit(req, ctx, cost(compareAnalyses(body?.archs)));
      const r = await facade.compare(body, ctx);
      ctx.code = r.code;
      if (!wantText && wantsMarkdown(req)) return sendMarkdown(res, r, r.code ? markdown.report(r) : markdown.cpuTable(r, { per: r.elementsPerIteration }));
      return sendResult(res, r, wantText, compareText);
    }
    if (p === '/api/assemble') {
      method(['POST']);
      rateLimit(req, ctx);
      const body = await readJson(req);
      const bad = checkKeys(body, ['source', 'syntax']);
      const r = bad ?? await facade.assemble(body.source, body.syntax ?? 'intel', ctx);
      ctx.code = r.code;
      return sendResult(res, r, wantText, (x) => x.hex + '\n');
    }
    throw new HttpError(404, `not found: ${p} (see GET /)`);
  }

  const server = http.createServer(async (req, res) => {
    const t0 = performance.now();
    const ctx = {};
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      url = new URL('http://localhost/');
    }
    res.on('finish', () => {
      const entry = { method: req.method, path: url.pathname.slice(0, 200), status: res.statusCode, ms: Math.round((performance.now() - t0) * 10) / 10 };
      for (const k of ['arch', 'instructions', 'bytes', 'code', 'tool', 'rpc', 'queueMs', 'runMs', 'jobs', 'parts', 'timedOut', 'gone', 'rateLimited', 'busy', 'error']) {
        if (ctx[k] !== undefined) entry[k] = typeof ctx[k] === 'number' && k.endsWith('Ms') ? Math.round(ctx[k] * 10) / 10 : ctx[k];
      }
      log(entry);
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await route(req, res, url, ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) ctx.error = String(e?.message ?? e).slice(0, 200);
      if (res.headersSent) { res.destroy(); return; }
      const message = status === 500 ? 'internal server error' : e.message;
      send(res, status, wantsText(req) ? message + '\n' : failure(message), { headers: e.headers ?? {} });
    }
  });
  // Idle keep-alive connections stay open longer than cloudflared keeps them (30 s), so that the proxy, not the server,
  // closes them (no request races a close). Only cloudflared reaches the server (it listens on 127.0.0.1).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 75_000;

  return {
    config: cfg, pool, facade, limiter, server,
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    // Graceful shutdown: no new connections, new requests on open connections get 503, running jobs finish (up to
    // shutdownGraceMs), then the workers are terminated.
    async close(graceMs = cfg.shutdownGraceMs) {
      draining = true;
      const closed = new Promise((r) => server.close(r));
      server.closeIdleConnections();
      await pool.close(graceMs);
      setTimeout(() => server.closeAllConnections(), Math.min(1000, graceMs)).unref();
      await closed;
      limiter.close();
    },
  };
}
