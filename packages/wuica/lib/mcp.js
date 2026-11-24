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
import { createWuica } from './index.js';
import { whatIfRequest, VARIANTS } from './web/whatif-core.js';
import { diffRequest } from './web/block-diff.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const SERVER_INFO = Object.freeze({ name: 'wuica', version: pkg.version });
export const CAPABILITIES = Object.freeze({ tools: { listChanged: true } });

const ASSUMPTIONS =
  'The number is the predicted steady-state throughput in core clock cycles per iteration of the block: a block that ends ' +
  'with a (conditional) branch is simulated as a loop body; any other block as if it were unrolled, i.e. repeated back to ' +
  'back. Lower is faster. Assumptions: all memory accesses hit the L1 data cache, no branch mispredictions, no ' +
  'interference from other code or hyperthreads; the result does not depend on register or memory values except through ' +
  'dependencies. ZEN3, ADL-P and ICX are prototype models (experimental, from the fork jtl06/uiCA), less validated than ' +
  "uiCA's Intel models (SNB through RKL).";

const INPUT_NOTE =
  'Give the block either as `source` (x86-64 assembly in Intel (noprefix) or AT&T syntax: detected unless `syntax` says; one instruction per ' +
  'line; labels and directives are allowed, e.g. "loop: add rax, [rsi]\\n dec rcx\\n jnz loop") or as `hex` (machine ' +
  'code bytes, e.g. "4801d8"). A whole function (gcc -S or clang -S output, objdump -d lines with addresses, with or ' +
  'without the bytes) is fine: by default (`loop: "auto"`) its innermost loop is analyzed (the first one in the code), ' +
  'or the body without prologue and epilogue if it is a compiler\'s function without a loop; the deepest loop is ' +
  'preferred (clang\'s "Inner Loop Header" notes count), among equals the first; branches out of the loop count as not taken (so an exit ' +
  'to a label that is not in the text assembles); with addresses, the alignment offset is the loop\'s address mod 64 ' +
  'unless options.alignmentOffset is given. The response\'s `loop` says what was analyzed (index, count, name, lines, ' +
  'address, function, depth). `loop: "whole"` analyzes the whole text; `loop: N` the N-th loop (0-based: deepest first, ' +
  'then in code order); `loop: ".LBB0_12"` a loop by its label; `func: "name"` only the loops of that function.';

const ERRORS_NOTE =
  'Failures are tool errors whose JSON is {code, error, stderr}: code 1 = bad request (e.g. unknown arch, bad hex), ' +
  '2 = assembler error (stderr lines as llvm-mc prints them; positioned ones carry tag {line, column, severity, text}), ' +
  '3 = the analysis failed for this input.';

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
    minIterations: int('simulate at least this many iterations (default 10; large values take long and much memory; the API server allows at most 1000)', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    minCycles: int('simulate at least this many cycles (default 500; the API server allows at most 20000)', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
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
        '(before and after), `list_archs` for the ids, `assemble` to check ' +
        'that assembly text is accepted and see its encoding. ' + ASSUMPTIONS;

const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const execution = { taskSupport: 'forbidden' };

// The tools: [{name, title, description, inputSchema, annotations, execution, handler(args) -> CallToolResult}]. w: a
// wuica instance (createWuica) or anything with its analyze, compare, assemble, archs and summarize.
export function mcpTools(w) {
  return [
    {
      name: 'list_archs',
      title: 'List microarchitectures',
      description:
        'Lists the microarchitecture models in order of release: id (to pass as `arch`), name, release year, and ' +
        '`prototype` (true for the experimental models ZEN3, ADL-P and ICX of the fork jtl06/uiCA, which are less ' +
        'validated than uiCA\'s Intel models). `fields` selects fields (also available: table, xedChip).',
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
        'Simulates an x86-64 basic block on one microarchitecture with uiCA\'s pipeline model and returns the predicted ' +
        'throughput, the bottleneck(s), the per-component limits and a per-instruction table. ' + INPUT_NOTE + ' ' +
        ASSUMPTIONS + '\n\nResult (JSON, format "json" or "both"): `tp` = cycles per iteration; `mode` = "loop" or ' +
        '"unroll"; `bottlenecks` = the components that limit the throughput (e.g. Dependencies = a loop-carried ' +
        'dependency chain, Ports = execution-port pressure, Issue/Decoder/Predecoder/DSB/LSD = front end); `limits` = ' +
        'the throughput that would be achieved if that component were the only bottleneck (the largest is the binding ' +
        'one); `instructions[]` = per instruction: average uops per iteration issued/executed, `ports` = uops per ' +
        'iteration on each execution port, `uopSource` = where the uops came from (MITE legacy decoders, DSB uop cache, ' +
        'LSD loop buffer, MS microcode sequencer), `notes` M = macro-fused with the previous instruction, J = not ' +
        'cacheable in the DSB because of the JCC erratum, X = instruction not supported by the model (no data: the ' +
        'result is unreliable); `stderr` = assembler warnings and decode warnings (`decodeErrors` > 0: some bytes could ' +
        'not be decoded); `insights` = a derived diagnosis: `utilization` (each limit and execution port as a fraction ' +
        'of tp; 1 = saturated), `binding` (the limiting component: the same as `bottlenecks`; [] when uiCA names none, then ' +
        '`largest` is the largest limit, the nearest bound, which alone does not reach tp), `next` (the next limit and `maxSpeedup`, an upper ' +
        'bound of the speedup if the binding component were removed), `unexplained` (cycles no single limit explains), ' +
        '`chain` (the loop-carried critical dependency chain: `index` into `instructions`, operand, latency, carried ' +
        'into the next iteration), `hot` (the instructions with the largest share of the binding resource: fix these ' +
        'first), `caveats` (known blind spots of the model the block meets, not simulated: rmw-index = a read-modify-write ' +
        'to an indexed address, whose store forwarding between iterations depends on the data; exit = an exit before the ' +
        'loop\'s branch, whose mispredict is not modelled; split = loads at an offset that is not a multiple of their width, ' +
        'which may cross a cache line (on ZEN3, ADL-P and ICX, whose models charge crossings, only loads whose address register ' +
        'is written other than by adding an immediate); `instructions` = indexes into `instructions`). With `details: true`, each instruction also has `allowedPorts` (uops.info notation, e.g. 1*p0156+1*p23), ' +
        '`uops`, `fusedUops`, `latencies` ("input->output:cycles"), `frontEnd` (length, offset = alignment offset + position in the block, crosses ' +
        '16/32/64-byte boundaries, lcp = length-changing prefix, microcoded, macro-fusion), and `insights` has `portSet` (the ' +
        'ports behind the Ports limit and the instructions whose uops can only use them) and `issueSlots` (issue slots per ' +
        'iteration: issued, or lost to the front end, a full reorder buffer (rob) or scheduler (rs), other). ' +
        'Format "text" (or the second item of "both") is uiCA\'s complete text report. ' + ERRORS_NOTE,
      inputSchema: obj({
        arch: str('microarchitecture id (default "SKL"); see list_archs, e.g. SKL, ICL, TGL, RKL, ADL-P, ZEN3'),
        ...codeShape,
        options: optionsShape,
        format: str('"json" (summary), "text" (uiCA\'s report) or "both" (default)', { enum: ['json', 'text', 'both'] }),
        details: bool('true: per instruction also its allowed ports, latencies and front-end facts, and in insights the port set behind the Ports limit and the issue slots per cause (a slower analysis; default false)'),
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
        'Re-analyzes an x86-64 basic block with one change each and reports the predicted throughput per ORIGINAL ' +
        'iteration, the change `delta` (cycles; negative = faster) and `speedup` (base tp / variant tp) against the base: ' +
        'unroll2/unroll4/unroll8 (n copies of the loop body and its branch once; registers are not renamed, so the ' +
        'dependencies stay and only the loop overhead goes; loops only), acc2/acc3/acc4/acc8 (N accumulators: unrolled ×N ' +
        'with the register of the loop-carried chain renamed into a free register in each copy, so the copies form N ' +
        'independent chains, as N accumulators or N CRC streams written by hand; `renamed` says which registers; the ' +
        'result\'s `accumulators.best` is the smallest N within 1% of the fastest, 1 = as it is: call it per arch for the ' +
        'best N per CPU; not possible when the chain goes through memory or flags or an implicit operand), simpleFrontEnd (a front end limited only by the ' +
        'issue width), noMacroFusion / noMicroFusion (switched; if the base already has the option set, the variant ' +
        'switches it back), nochain (no analysis: the largest limit other than Dependencies, an estimate of the ' +
        'throughput without the loop-carried chain; `estimate: true`). A variant that cannot be made or analyzed has ' +
        '`error`. Use it to decide whether unrolling, breaking the chain or front-end work is worth it. ' + INPUT_NOTE + ' ' +
        ASSUMPTIONS + ' ' + ERRORS_NOTE,
      inputSchema: obj({
        arch: str('microarchitecture id (default "SKL"); see list_archs'),
        ...codeShape,
        options: optionsShape,
        variants: { description: `the experiments (default: all of ${VARIANTS.join(', ')})`, type: 'array', items: { type: 'string', enum: [...VARIANTS] } },
        per: PER,
      }),
      annotations: readOnly, execution,
      handler: async ({ arch, ...request }) => result(await whatIfRequest(w, arch ?? 'SKL', request)),
    },
    {
      name: 'diff_blocks',
      title: 'Compare two versions of a block',
      description:
        'Analyzes two x86-64 blocks, A (before) and B (after), on one microarchitecture and returns in one result: `a` and ' +
        '`b` (tp in cycles per iteration, bottlenecks), `delta` (B - A; negative = faster), `speedup` (A / B), `verdict` ' +
        '(better, worse, same), `perElement` (with `per`: cycles per element of each and their change, for loops that do a ' +
        'different amount of work per iteration, e.g. after unrolling), `bottlenecks` (a, b, gone, new), `limits` (each ' +
        'component\'s limit before and after), `ports` (uops per iteration of each execution port before and after) and ' +
        '`instructions` (counts, and the instructions changed, added or removed, aligned as a diff, with the change of their ' +
        'uops per port). Each block is given as for analyze; `options` apply to both. ' + INPUT_NOTE + ' ' + ERRORS_NOTE +
        ' A failure says which side (A: or B:).',
      inputSchema: obj({
        arch: str('microarchitecture id (default "SKL"); see list_archs'),
        a: { description: 'block A (before)', type: 'object', properties: codeShape, additionalProperties: false },
        b: { description: 'block B (after)', type: 'object', properties: codeShape, additionalProperties: false },
        options: optionsShape,
        per: {
          description: 'elements per iteration: a number for both, or [A, B] (e.g. [8, 32] after unrolling ×4): also cycles per element',
          anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'array', items: { type: 'number', exclusiveMinimum: 0 } }],
        },
      }, ['a', 'b']),
      annotations: readOnly, execution,
      handler: async ({ arch, ...request }) => result(await diffRequest(w, arch ?? 'SKL', request)),
    },
    {
      name: 'compare_archs',
      title: 'Compare a block across microarchitectures',
      description:
        'Predicts the throughput of one x86-64 basic block on several microarchitectures (default: all) and returns, per ' +
        'microarchitecture, `tp` in cycles per iteration and the bottleneck(s) (a row with code != 0 failed on that ' +
        'microarchitecture). Use it to see how a loop behaves on older vs. newer Intel cores or on AMD Zen 3. ' +
        INPUT_NOTE + ' ' + ASSUMPTIONS + ' ' + ERRORS_NOTE,
      inputSchema: obj({
        ...codeShape,
        archs: { description: 'microarchitecture ids to compare (default: all of list_archs)', type: 'array', items: { type: 'string' } },
        options: optionsShape,
      }),
      annotations: readOnly, execution,
      handler: async (request) => result(await w.compare(request)),
    },
    {
      name: 'assemble',
      title: 'Assemble x86-64 code',
      description:
        'Assembles x86-64 assembly text with LLVM\'s assembler (LLVM 22, the same bytes as llvm-mc) and returns ' +
        '{code: 0, hex, length, stderr} (stderr: warnings), or the assembler\'s errors as {code: 2, error, stderr} with ' +
        'line/column tags. The syntax is detected unless given (Intel noprefix or AT&T); the text may switch with .intel_syntax noprefix / ' +
        '.att_syntax. Only .text is returned.',
      inputSchema: obj({
        source: { description: 'the assembly text', type: 'string' },
        syntax: codeShape.syntax,
      }, ['source']),
      annotations: readOnly, execution,
      handler: async ({ source, syntax }) => result(omitBytes(await w.assemble(source, syntax ?? 'auto'))),
    },
  ];
}

// The tool as tools/list shows it (without the handler).
export const toolListing = ({ handler, ...t }) => t;

// ---- a validator for the keywords these schemas use ------------------------------------------------------------------------
// type (object, array, string, integer, number, boolean), properties, required, additionalProperties: false, enum, items,
// minimum, maximum, exclusiveMinimum, minLength, anyOf. Returns the first problem as text ("options.minIterations: expected an integer,
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
