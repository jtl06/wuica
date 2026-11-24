// The MCP tools of wuica as plain data (one definition for the stdio server here and the HTTP server in server/): name,
// title, description, input JSON Schema, annotations and the handler; a small JSON Schema validator for exactly the
// keywords these schemas use; and the stdio server (`wuica mcp`, `wuica-mcp`): newline-delimited JSON-RPC 2.0 on
// stdin/stdout, no dependencies. stdout carries protocol messages only.
//
// Protocol: the initialize handshake of the MCP revisions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 (the
// client's version if it is one of these, else the latest); ping; tools/list; tools/call. JSON-RPC batches (arrays) only
// under 2025-03-26, the one revision that has them. Notifications get no reply. The process ends at the end of stdin.

import fs from 'node:fs';
import readline from 'node:readline';
import { createWuica, listLoops } from './index.js';
import { whatIfRequest, VARIANTS, OPT_IN_VARIANTS } from './web/whatif-core.js';
import { diffRequest } from './web/block-diff.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const SERVER_INFO = Object.freeze({ name: 'wuica', version: pkg.version });
export const CAPABILITIES = Object.freeze({ tools: { listChanged: true } });

const ASSUMPTIONS =
  'tp is the predicted steady-state throughput in core cycles per iteration (lower is faster): a block that ends with a ' +
  'branch is simulated as a loop body, any other as if repeated back to back. Assumes all data in L1, no branch ' +
  'mispredictions, nothing else on the core. ZEN3, ADL-P and ICX are prototype models (the fork jtl06/uiCA), less ' +
  "validated than uiCA's Intel models.";

const INPUT_NOTE =
  'The block: `source` (x86-64 assembly, Intel or AT&T, detected; a whole function, gcc/clang -S or objdump -d output ' +
  'is fine: its innermost loop is analyzed; `loop` picks another: "whole", an index or a label; `func` one ' +
  "function's) or `hex` (machine code).";

const ERRORS_NOTE = 'A failure is a tool error {code, error, stderr}: 1 bad request, 2 assembler error (positioned stderr), 3 analysis failed.';

// ---- the input schemas (JSON Schema, draft-07 as before) ----------------------------------------------------------------

const SCHEMA = 'http://json-schema.org/draft-07/schema#';
const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), $schema: SCHEMA, additionalProperties: false });
const str = (description, extra = {}) => ({ description, type: 'string', ...extra });

const codeShape = {
  source: str('x86-64 assembly text of the basic block (give source or hex)'),
  hex: str('machine code as hex bytes, e.g. "4801d84801c349ffcf75f5" (spaces allowed)'),
  syntax: str('syntax of `source`: "auto" (default: detected from the text), "intel" (noprefix) or "att"', { enum: ['auto', 'intel', 'att'] }),
  loop: {
    description: 'what of `source` is analyzed: "auto" (default: the deepest loop of a whole function, else the text), "whole", the index of a loop (0-based), or its label',
    anyOf: [{ type: 'string', enum: ['auto', 'whole'] }, { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: 'string', minLength: 1 }],
  },
  func: str('only the loops of this function (a label of `source`)', { minLength: 1 }),
};

const int = (description, minimum, maximum) => ({ description, type: 'integer', minimum, maximum });
const bool = (description) => ({ description, type: 'boolean' });
const optionsShape = {
  description: 'simulation options of uiCA; all optional',
  type: 'object',
  properties: {
    alignmentOffset: int('offset of the block from a 64-byte boundary (default 0; usually 0-63, other values are simulated as given); affects the front end', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    initPolicy: str('initial register values: "diff" (default: all registers differ), "same", "stack"', { enum: ['diff', 'same', 'stack'] }),
    simpleFrontEnd: bool('model a front end limited only by the issue width (default false)'),
    noMicroFusion: bool('disable micro-fusion (default false)'),
    noMacroFusion: bool('disable macro-fusion (default false)'),
    minIterations: int('simulate at least this many iterations (default 10; the API server allows at most 1000)', 1, 100000),
    minCycles: int('simulate at least this many cycles (default 500; the API server allows at most 20000)', 1, 1000000),
  },
  additionalProperties: false,
};

const PER = { description: 'elements (bytes, floats, ...) one iteration of the loop processes: the result also gives cycles per element (`perElement`)', type: 'number', exclusiveMinimum: 0 };

const json = (value) => ({ type: 'text', text: JSON.stringify(value, null, 1) });
const omitBytes = ({ bytes, ...rest }) => rest;

function result(r) {
  return r.code ? { isError: true, content: [json(r)] } : { content: [json(r)] };
}

export const INSTRUCTIONS =
        'wuica predicts the throughput of x86-64 basic blocks (loop bodies) with uiCA\'s cycle-level pipeline model, ' +
        'locally. Use `analyze` for one block on one microarchitecture (bottlenecks, per-port usage, full report), ' +
        '`what_if` for the effect of unrolling, an ideal front end, fusion, or removing the dependency chain, ' +
        '`compare_archs` to see a block on several microarchitectures, `diff_blocks` for the effect of a code change ' +
        '(before and after), `list_loops` for the loops of a text, `list_archs` for the ids, `assemble` to check ' +
        'that assembly text is accepted and see its encoding. ' + ASSUMPTIONS;

const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const execution = { taskSupport: 'forbidden' };

// The tools: [{name, title, description, inputSchema, annotations, execution, handler(args) -> CallToolResult}]. w: a
// wuica instance (createWuica) or anything with its analyze, compare, whatIf, diff, assemble, archs and summarize.
export function mcpTools(w) {
  return [
    {
      name: 'list_archs',
      title: 'List microarchitectures',
      description:
        'The microarchitecture models in order of release: id (the `arch` of the other tools), name, year, and `prototype` ' +
        '(ZEN3, ADL-P, ICX: experimental models of the fork jtl06/uiCA). `fields` selects (also table, xedChip).',
      inputSchema: obj({
        fields: { description: 'fields to return (default: id, name, year, prototype)', type: 'array', items: { type: 'string', enum: ['id', 'name', 'year', 'prototype', 'table', 'xedChip'] } },
      }),
      annotations: readOnly, execution,
      handler: async ({ fields }) => ({ content: [json(w.archs(fields ?? ['id', 'name', 'year', 'prototype']))] }),
    },
    {
      name: 'analyze',
      title: 'Predict basic-block throughput (uiCA)',
      description:
        'One x86-64 block on one microarchitecture with uiCA\'s pipeline model. ' + INPUT_NOTE + ' ' + ASSUMPTIONS +
        '\n\nResult (format "json"): `tp` (cycles per iteration), `mode` (loop or unroll), `bottlenecks` (Dependencies = a ' +
        'loop-carried chain, Ports, Issue, Decoder, Predecoder, DSB, LSD), `limits` (the tp each component alone would allow), ' +
        '`loop` (what was analyzed) and `otherLoops`, `instructions[]` (per instruction: uops issued and executed per iteration, ' +
        '`ports`, `uopSource` MITE/DSB/LSD/MS, `notes` M macro-fused, J JCC erratum, X not modelled; `line`, and `loc`, ' +
        '`source`, `samples` when the input has them), `stderr`, and `insights`: `utilization` (each limit and port as a ' +
        'fraction of tp), `binding`, `largest` (when uiCA names no bottleneck), `next` (the next limit, `maxSpeedup`), `chain` ' +
        '(the critical dependency chain), `hot` (the instructions to fix first), `caveats` (what the model does not simulate: ' +
        'rmw-index, exit, split, paths). `details: true` adds per instruction allowed ports, latencies and front-end facts, ' +
        'and the issue slots. Format "text" is uiCA\'s report; "both" (default) gives both. ' + ERRORS_NOTE,
      inputSchema: obj({
        arch: str('microarchitecture id (default "SKL"); see list_archs, e.g. SKL, ICL, TGL, RKL, ADL-P, ZEN3'),
        ...codeShape,
        options: optionsShape,
        format: str('"json" (summary), "text" (uiCA\'s report) or "both" (default)', { enum: ['json', 'text', 'both'] }),
        details: bool('true: per instruction also its allowed ports, latencies and front-end facts, and the issue slots (slower; default false)'),
      }),
      annotations: readOnly, execution,
      handler: async ({ arch, format, details, ...request }) => {
        const r = await w.analyze(arch ?? 'SKL', details ? { ...request, options: { ...(request.options ?? {}), details: true } } : request);
        if (r.code) return result(r);
        const content = [];
        if (format !== 'text') content.push(json(w.summarize(r)));
        if (format !== 'json') content.push({ type: 'text', text: r.text });
        return { content };
      },
    },
    {
      name: 'what_if',
      title: 'What-if experiments on a basic block',
      description:
        'Re-analyzes a block with one change each; per variant `tp` per ORIGINAL iteration, `delta` (negative = faster), ' +
        '`speedup`, or `error`: unroll2/4/8 (the body n times, the branch once), acc2/3/4/8 (unrolled with the chain\'s ' +
        'register renamed in each copy: N independent accumulators; `accumulators.best` = the smallest N within 1% of the ' +
        'fastest), simpleFrontEnd, noMacroFusion, noMicroFusion, nochain (an estimate without the loop-carried chain). Only ' +
        'when asked for: align (the 64 alignment offsets, 64 analyses: `tp` the median, `alignment` min, median, max, best, ' +
        'worst, spread). `per`: also cycles per element. ' + INPUT_NOTE + ' ' + ERRORS_NOTE,
      inputSchema: obj({
        arch: str('microarchitecture id (default "SKL"); see list_archs'),
        ...codeShape,
        options: optionsShape,
        variants: { description: `the experiments (default: ${VARIANTS.join(', ')}; also align)`, type: 'array', items: { type: 'string', enum: [...VARIANTS, ...OPT_IN_VARIANTS] } },
        per: PER,
      }),
      annotations: readOnly, execution,
      handler: async ({ arch, ...request }) => result(await (w.whatIf ? w.whatIf(arch ?? 'SKL', request) : whatIfRequest(w, arch ?? 'SKL', request))),
    },
    {
      name: 'diff_blocks',
      title: 'Compare two versions of a block',
      description:
        'Two blocks, A (before) and B (after), on one microarchitecture, in one result: `a` and `b` (tp, bottlenecks, ' +
        'decodeErrors), `delta` (B - A), `speedup` (A / B), `verdict`, `perElement` (with `per`), `bottlenecks` (gone, new), ' +
        '`limits` and `ports` (uops per iteration) before and after, and `instructions` (the ones changed, added or removed, ' +
        'with the change of their uops). Each block as analyze takes it; `options` apply to both unless a block has its own. ' +
        'A loop against a block without a branch is not comparable. A failure of one block starts with "A: " or "B: ".',
      inputSchema: obj({
        arch: str('microarchitecture id (default "SKL"); see list_archs'),
        a: { description: 'block A (before)', type: 'object', properties: { ...codeShape, options: optionsShape }, additionalProperties: false },
        b: { description: 'block B (after)', type: 'object', properties: { ...codeShape, options: optionsShape }, additionalProperties: false },
        options: optionsShape,
        per: {
          description: 'elements per iteration: a number for both, or [A, B] (e.g. [8, 32] after unrolling ×4): also cycles per element',
          anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, minItems: 2, maxItems: 2 }],
        },
      }, ['a', 'b']),
      annotations: readOnly, execution,
      handler: async ({ arch, ...request }) => result(await (w.diff ? w.diff(arch ?? 'SKL', request) : diffRequest(w, arch ?? 'SKL', request))),
    },
    {
      name: 'compare_archs',
      title: 'Compare a block across microarchitectures',
      description:
        'One block on several microarchitectures (default: all): per microarchitecture `tp` and `bottlenecks` (a row with ' +
        'code != 0 failed there); `per`: also cycles per element. ' + INPUT_NOTE + ' ' + ERRORS_NOTE,
      inputSchema: obj({
        ...codeShape,
        archs: { description: 'microarchitecture ids to compare (default: all of list_archs)', type: 'array', items: { type: 'string' } },
        options: optionsShape,
        per: PER,
      }),
      annotations: readOnly, execution,
      handler: async (request) => result(await w.compare(request)),
    },
    {
      name: 'list_loops',
      title: 'List the loops of assembly text',
      description:
        'The loops of assembly text (a function or file; gcc/clang -S, objdump -d, perf annotate) without analyzing it: ' +
        '`index` and `label` (what analyze\'s `loop` takes), `function`, `line`, `endLine`, `instructions`, `depth` (1 = ' +
        'outermost), `auto` (the one analyze picks by default). `func` keeps one function\'s loops.',
      inputSchema: obj({
        source: str('the assembly text'),
        func: codeShape.func,
      }, ['source']),
      annotations: readOnly, execution,
      handler: async ({ source, func }) => {
        const ls = listLoops(source, { func: func ?? null });
        if (!Array.isArray(ls)) return result({ code: 1, error: ls.error, stderr: [{ text: ls.error }] });
        return result({ code: 0, loops: ls, ...(ls.length ? {} : { note: loopsNote(source) }) });
      },
    },
    {
      name: 'assemble',
      title: 'Assemble x86-64 code',
      description:
        'Assembles x86-64 text with LLVM\'s assembler (LLVM 22, the bytes of llvm-mc): {code: 0, hex, length, stderr}, or ' +
        '{code: 2, error, stderr} with line/column tags. The syntax is detected unless given. Only .text is returned.',
      inputSchema: obj({
        source: { description: 'the assembly text', type: 'string' },
        syntax: codeShape.syntax,
      }, ['source']),
      annotations: readOnly, execution,
      handler: async ({ source, syntax }) => result(omitBytes(await w.assemble(source, syntax ?? 'auto'))),
    },
  ];
}

// Why a text has no loops to list: a marked region (analyze takes the region, not a loop), or no backward branch.
function loopsNote(source) {
  if (/^\s*(?:#|\/\/|;)\s*(?:LLVM-MCA-BEGIN|wuica-begin)(?![\w-])/im.test(source) || /^\s*mov[l]?\s+(?:ebx\s*,\s*111|\$111\s*,\s*%ebx)\s*$/im.test(source)) {
    return 'the text has a marked region (LLVM-MCA-BEGIN, wuica-begin or IACA markers): analyze takes the region, not a loop';
  }
  return 'no backward branch to a label of the text: analyze takes the whole text (or a function\'s body)';
}

// The tool as tools/list shows it (without the handler).
export const toolListing = ({ handler, ...t }) => t;

// ---- a validator for the keywords these schemas use ------------------------------------------------------------------------
// type (object, array, string, integer, number, boolean), properties, required, additionalProperties: false, enum, items,
// minimum, maximum, exclusiveMinimum, minLength, minItems, maxItems, anyOf. Returns the first problem as text ("options.minIterations: expected an integer,
// got \"many\""), or null.
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : typeof v === 'string' ? 'a string' : typeof v === 'boolean' ? 'a boolean' : typeof v === 'number' ? (Number.isInteger(v) ? 'an integer' : 'a number') : typeof v);
const show = (v) => JSON.stringify(v)?.slice(0, 60) ?? String(v);
export function validate(schema, value, at = '') {
  const where = at || 'arguments';
  if (schema.anyOf) {
    const errs = schema.anyOf.map((s) => validate(s, value, at));
    if (errs.some((e) => e === null)) return null;
    const allowed = schema.anyOf.map((s) => (s.enum ? s.enum.map((x) => JSON.stringify(x)).join(' or ') : s.type === 'integer' ? `an integer${s.minimum !== undefined ? ` >= ${s.minimum}` : ''}` : s.minLength ? 'a non-empty string' : `a ${s.type}`));
    return `${where}: expected ${allowed.join(', or ')}, got ${show(value)}`;
  }
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${where}: expected an object, got ${kind(value)}`;
      for (const k of schema.required ?? []) if (!(k in value) || value[k] === undefined) return `${at ? `${at}.` : ''}${k}: required`;
      const props = schema.properties ?? {};
      if (schema.additionalProperties === false) {
        const extra = Object.keys(value).filter((k) => !Object.hasOwn(props, k));
        if (extra.length) return `${where}: unknown key${extra.length > 1 ? 's' : ''} ${extra.map((k) => JSON.stringify(k)).join(', ')} (known: ${Object.keys(props).join(', ')})`;
      }
      for (const [k, s] of Object.entries(props)) {
        if (value[k] === undefined) continue;
        const e = validate(s, value[k], at ? `${at}.${k}` : k);
        if (e) return e;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${where}: expected an array, got ${kind(value)}`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${where}: expected at least ${schema.minItems} items, got ${value.length}`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${where}: expected at most ${schema.maxItems} items, got ${value.length}`;
      for (let i = 0; i < value.length; i++) { const e = schema.items ? validate(schema.items, value[i], `${where}[${i}]`) : null; if (e) return e; }
      return null;
    }
    case 'string':
      if (typeof value !== 'string') return `${where}: expected a string, got ${kind(value)}`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${where}: expected at least ${schema.minLength} character${schema.minLength === 1 ? '' : 's'}`;
      break;
    case 'integer':
      if (!Number.isInteger(value)) return `${where}: expected an integer, got ${show(value)}`;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${where}: expected a number, got ${show(value)}`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `${where}: expected true or false, got ${show(value)}`;
      break;
    default:
      break;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${where}: expected one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}, got ${show(value)}`;
  if (schema.minimum !== undefined && value < schema.minimum) return `${where}: expected at least ${schema.minimum}, got ${value}`;
  if (schema.maximum !== undefined && value > schema.maximum) return `${where}: expected at most ${schema.maximum}, got ${value}`;
  if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) return `${where}: expected more than ${schema.exclusiveMinimum}, got ${value}`;
  return null;
}

// tools/call on a table of tools: a CallToolResult, or {error: {code, message}} for a protocol error (an unknown tool).
// Arguments that do not fit the schema are a tool error (isError), as the MCP specification asks, so a model can retry.
export async function callTool(tools, name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  const problem = validate(tool.inputSchema, args ?? {});
  if (problem) return { isError: true, content: [{ type: 'text', text: `Invalid arguments for tool ${name}: ${problem}` }] };
  try {
    return await tool.handler(args ?? {});
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `${name} failed: ${e?.message ?? e}` }] };
  }
}

// ---- the stdio server ----------------------------------------------------------------------------------------------------------

const RPC = { parse: -32700, invalidRequest: -32600, method: -32601, params: -32602, internal: -32603 };
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

// One JSON-RPC message (an object) -> the reply object, or null (a notification, or a response from the client).
export async function handleMessage(state, tools, m) {
  if (m === null || typeof m !== 'object' || Array.isArray(m) || m.jsonrpc !== '2.0') return err(m?.id, RPC.invalidRequest, 'Invalid Request: not a JSON-RPC 2.0 message');
  const isRequest = 'id' in m && m.id !== null && (typeof m.id === 'string' || typeof m.id === 'number');
  if (typeof m.method !== 'string') {
    if ('result' in m || 'error' in m) return null; // a response (this server sends no requests)
    return err(m.id, RPC.invalidRequest, 'Invalid Request: no method');
  }
  if (!isRequest) {
    if ('id' in m) return err(null, RPC.invalidRequest, 'Invalid Request: the id must be a string or a number');
    return null; // notifications/initialized, notifications/cancelled, ...: nothing to answer
  }
  const params = m.params ?? {};
  if (params === null || typeof params !== 'object') return err(m.id, RPC.params, 'Invalid params: expected an object');
  switch (m.method) {
    case 'initialize': {
      if (typeof params.protocolVersion !== 'string') return err(m.id, RPC.params, 'Invalid params: protocolVersion (a string) is required');
      state.version = PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
      return ok(m.id, { protocolVersion: state.version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return ok(m.id, {});
    case 'tools/list':
      return ok(m.id, { tools: tools.map(toolListing) });
    case 'tools/call': {
      if (typeof params.name !== 'string') return err(m.id, RPC.params, 'Invalid params: name (a string) is required');
      if (params.arguments !== undefined && (params.arguments === null || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) return err(m.id, RPC.params, 'Invalid params: arguments must be an object');
      const r = await callTool(tools, params.name, params.arguments);
      return r.error ? err(m.id, r.error.code, r.error.message) : ok(m.id, r);
    }
    default:
      return err(m.id, RPC.method, `Method not found: ${m.method}`);
  }
}

// One line of input -> the line to write, or null.
export async function handleLine(state, tools, line) {
  if (!line.trim()) return null;
  let m;
  try { m = JSON.parse(line); } catch { return JSON.stringify(err(null, RPC.parse, 'Parse error')); }
  if (Array.isArray(m)) {
    // batches: only the 2025-03-26 revision has them
    if (state.version !== '2025-03-26') return JSON.stringify(err(null, RPC.invalidRequest, 'Invalid Request: batches are not supported in this protocol version'));
    if (!m.length) return JSON.stringify(err(null, RPC.invalidRequest, 'Invalid Request: an empty batch'));
    const replies = (await Promise.all(m.map((x) => handleMessage(state, tools, x)))).filter(Boolean);
    return replies.length ? JSON.stringify(replies) : null;
  }
  const r = await handleMessage(state, tools, m);
  return r ? JSON.stringify(r) : null;
}

// The stdio server: requests are answered in the order they arrive; the end of stdin ends it.
export async function runServer(options = {}, io = { stdin: process.stdin, stdout: process.stdout }) {
  const w = await createWuica(options);
  const tools = mcpTools(w);
  const state = { version: null };
  // a client that closes its end early: the writes that follow are dropped, the end of stdin still ends the server
  io.stdout.on?.('error', (e) => { if (e?.code !== 'EPIPE') throw e; });
  const rl = readline.createInterface({ input: io.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const out = await handleLine(state, tools, line);
    if (out !== null) io.stdout.write(out + '\n');
  }
  await w.close?.();
}
