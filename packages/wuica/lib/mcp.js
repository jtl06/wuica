// The MCP server (stdio): tools analyze, what_if, compare_archs, list_archs, assemble. Start with `wuica mcp` or `wuica-mcp`.
// stdout carries JSON-RPC: nothing else may be written to it.

import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createWuica } from './index.js';
import { whatIf, VARIANTS } from './whatif.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const ASSUMPTIONS =
  'The number is the predicted steady-state throughput in core clock cycles per iteration of the block: a block that ends ' +
  'with a (conditional) branch is simulated as a loop body; any other block as if it were unrolled, i.e. repeated back to ' +
  'back. Lower is faster. Assumptions: all memory accesses hit the L1 data cache, no branch mispredictions, no ' +
  'interference from other code or hyperthreads; the result does not depend on register or memory values except through ' +
  'dependencies. ZEN3, ADL-P and ICX are prototype models (experimental, from the fork jtl06/uiCA), less validated than ' +
  "uiCA's Intel models (SNB through RKL).";

const INPUT_NOTE =
  'Give the block either as `source` (x86-64 assembly, Intel syntax without % prefixes by default, one instruction per ' +
  'line; labels and directives are allowed, e.g. "loop: add rax, [rsi]\\n dec rcx\\n jnz loop") or as `hex` (machine ' +
  'code bytes, e.g. "4801d8"). A whole function (gcc -S or clang -S output, objdump -d lines with addresses, with or ' +
  'without the bytes) is fine: by default (`loop: "auto"`) its innermost loop is analyzed (the first one in the code), ' +
  'or the body without prologue and epilogue if it has no loop; branches out of the loop count as not taken (so an exit ' +
  'to a label that is not in the text assembles); with addresses, the alignment offset is the loop\'s address mod 64 ' +
  'unless options.alignmentOffset is given. The response\'s `loop` says what was analyzed (index, count, name, lines, ' +
  'address). `loop: "whole"` analyzes the whole text; `loop: N` the N-th loop (innermost first, in code order).';

const ERRORS_NOTE =
  'Failures are tool errors whose JSON is {code, error, stderr}: code 1 = bad request (e.g. unknown arch, bad hex), ' +
  '2 = assembler error (stderr lines as llvm-mc prints them; positioned ones carry tag {line, column, severity, text}), ' +
  '3 = the analysis failed for this input.';

const codeShape = {
  source: z.string().optional().describe('x86-64 assembly text of the basic block (give source or hex)'),
  hex: z.string().optional().describe('machine code as hex bytes, e.g. "4801d84801c349ffcf75f5" (spaces allowed)'),
  syntax: z.enum(['intel', 'att']).optional().describe('syntax of `source`: "intel" (default, noprefix) or "att"'),
  loop: z.union([z.enum(['auto', 'whole']), z.number().int().min(0)]).optional().describe('what of `source` is analyzed: "auto" (default: the innermost loop of a whole function, else the text), "whole", or the index of a loop'),
};

const optionsShape = z.object({
  alignmentOffset: z.number().int().min(0).max(63).optional().describe('offset of the block from a 64-byte boundary (default 0); affects the front end'),
  initPolicy: z.enum(['diff', 'same', 'stack']).optional().describe('initial register values: "diff" (default: all registers differ), "same", "stack"'),
  simpleFrontEnd: z.boolean().optional().describe('model a front end limited only by the issue width (default false)'),
  noMicroFusion: z.boolean().optional().describe('disable micro-fusion (default false)'),
  noMacroFusion: z.boolean().optional().describe('disable macro-fusion (default false)'),
  minIterations: z.number().int().min(1).max(100000).optional().describe('simulate at least this many iterations (default 10)'),
  minCycles: z.number().int().min(1).max(1000000).optional().describe('simulate at least this many cycles (default 500)'),
}).strict().optional().describe('simulation options of uiCA; all optional');

const json = (value) => ({ type: 'text', text: JSON.stringify(value, null, 1) });
const omitBytes = ({ bytes, ...rest }) => rest;

function result(r) {
  return r.code ? { isError: true, content: [json(r)] } : { content: [json(r)] };
}

export function createServer(w) {
  const server = new McpServer(
    { name: 'wuica', version: pkg.version },
    {
      instructions:
        'wuica predicts the throughput of x86-64 basic blocks (loop bodies) with uiCA\'s cycle-level pipeline model, ' +
        'locally. Use `analyze` for one block on one microarchitecture (bottlenecks, per-port usage, full report), ' +
        '`what_if` for the effect of unrolling, an ideal front end, fusion, or removing the dependency chain, ' +
        '`compare_archs` to see a block on several microarchitectures, `list_archs` for the ids, `assemble` to check ' +
        'that assembly text is accepted and see its encoding. ' + ASSUMPTIONS,
    },
  );

  const readOnly = { readOnlyHint: true, openWorldHint: false, idempotentHint: true };

  server.registerTool(
    'list_archs',
    {
      title: 'List microarchitectures',
      description:
        'Lists the microarchitecture models in order of release: id (to pass as `arch`), name, release year, and ' +
        '`prototype` (true for the experimental models ZEN3, ADL-P and ICX of the fork jtl06/uiCA, which are less ' +
        'validated than uiCA\'s Intel models). `fields` selects fields (also available: table, xedChip).',
      inputSchema: z.object({
        fields: z.array(z.enum(['id', 'name', 'year', 'prototype', 'table', 'xedChip'])).optional().describe('fields to return (default: id, name, year, prototype)'),
      }).strict(),
      annotations: readOnly,
    },
    async ({ fields }) => ({ content: [json(w.archs(fields ?? ['id', 'name', 'year', 'prototype']))] }),
  );

  server.registerTool(
    'analyze',
    {
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
        'first). With `details: true`, each instruction also has `allowedPorts` (uops.info notation, e.g. 1*p0156+1*p23), ' +
        '`uops`, `fusedUops`, `latencies` ("input->output:cycles"), `frontEnd` (length, offset = alignment offset + position in the block, crosses ' +
        '16/32/64-byte boundaries, lcp = length-changing prefix, microcoded, macro-fusion), and `insights` has `portSet` (the ' +
        'ports behind the Ports limit and the instructions whose uops can only use them) and `issueSlots` (issue slots per ' +
        'iteration: issued, or lost to the front end, a full reorder buffer (rob) or scheduler (rs), other). ' +
        'Format "text" (or the second item of "both") is uiCA\'s complete text report. ' + ERRORS_NOTE,
      inputSchema: z.object({
        arch: z.string().optional().describe('microarchitecture id (default "SKL"); see list_archs, e.g. SKL, ICL, TGL, RKL, ADL-P, ZEN3'),
        ...codeShape,
        options: optionsShape,
        format: z.enum(['json', 'text', 'both']).optional().describe('"json" (summary), "text" (uiCA\'s report) or "both" (default)'),
        details: z.boolean().optional().describe('true: per instruction also its allowed ports, latencies and front-end facts, and in insights the port set behind the Ports limit and the issue slots per cause (a slower analysis; default false)'),
      }).strict(),
      annotations: readOnly,
    },
    async ({ arch, format, details, ...request }) => {
      const r = await w.analyze(arch ?? 'SKL', details ? { ...request, options: { ...(request.options ?? {}), details: true } } : request);
      if (r.code) return result(r);
      const content = [];
      if (format !== 'text') content.push(json(w.summarize(r)));
      if (format !== 'json') content.push({ type: 'text', text: r.text });
      return { content };
    },
  );

  server.registerTool(
    'what_if',
    {
      title: 'What-if experiments on a basic block',
      description:
        'Re-analyzes an x86-64 basic block with one change each and reports the predicted throughput per ORIGINAL ' +
        'iteration, the change `delta` (cycles; negative = faster) and `speedup` (base tp / variant tp) against the base: ' +
        'unroll2/unroll4/unroll8 (n copies of the loop body and its branch once; registers are not renamed, so the ' +
        'dependencies stay and only the loop overhead goes; loops only), simpleFrontEnd (a front end limited only by the ' +
        'issue width), noMacroFusion / noMicroFusion (switched; if the base already has the option set, the variant ' +
        'switches it back), nochain (no analysis: the largest limit other than Dependencies, an estimate of the ' +
        'throughput without the loop-carried chain; `estimate: true`). A variant that cannot be made or analyzed has ' +
        '`error`. Use it to decide whether unrolling, breaking the chain or front-end work is worth it. ' + INPUT_NOTE + ' ' +
        ASSUMPTIONS + ' ' + ERRORS_NOTE,
      inputSchema: z.object({
        arch: z.string().optional().describe('microarchitecture id (default "SKL"); see list_archs'),
        ...codeShape,
        options: optionsShape,
        variants: z.array(z.enum(VARIANTS)).optional().describe(`the experiments (default: all of ${VARIANTS.join(', ')})`),
      }).strict(),
      annotations: readOnly,
    },
    async ({ arch, variants, ...request }) => result(await whatIf((a, req) => w.analyze(a, req), arch ?? 'SKL', request, variants ?? VARIANTS)),
  );

  server.registerTool(
    'compare_archs',
    {
      title: 'Compare a block across microarchitectures',
      description:
        'Predicts the throughput of one x86-64 basic block on several microarchitectures (default: all) and returns, per ' +
        'microarchitecture, `tp` in cycles per iteration and the bottleneck(s) (a row with code != 0 failed on that ' +
        'microarchitecture). Use it to see how a loop behaves on older vs. newer Intel cores or on AMD Zen 3. ' +
        INPUT_NOTE + ' ' + ASSUMPTIONS + ' ' + ERRORS_NOTE,
      inputSchema: z.object({
        ...codeShape,
        archs: z.array(z.string()).optional().describe('microarchitecture ids to compare (default: all of list_archs)'),
        options: optionsShape,
      }).strict(),
      annotations: readOnly,
    },
    async (request) => result(await w.compare(request)),
  );

  server.registerTool(
    'assemble',
    {
      title: 'Assemble x86-64 code',
      description:
        'Assembles x86-64 assembly text with LLVM\'s assembler (LLVM 22, the same bytes as llvm-mc) and returns ' +
        '{code: 0, hex, length, stderr} (stderr: warnings), or the assembler\'s errors as {code: 2, error, stderr} with ' +
        'line/column tags. Intel syntax (noprefix) by default; the text may switch with .intel_syntax noprefix / ' +
        '.att_syntax. Only .text is returned.',
      inputSchema: z.object({
        source: z.string().describe('the assembly text'),
        syntax: codeShape.syntax,
      }).strict(),
      annotations: readOnly,
    },
    async ({ source, syntax }) => result(omitBytes(await w.assemble(source, syntax ?? 'intel'))),
  );

  return server;
}

export async function runServer(options = {}) {
  const w = await createWuica(options);
  const server = createServer(w);
  await server.connect(new StdioServerTransport());
  return server;
}
