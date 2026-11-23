// Type declarations for the wuica package. The shapes are the API contract of README.md ("API contract").

/** Simulation options (as in uiCA); the defaults are shown. */
export interface AnalysisOptions {
  /** Offset of the block relative to a 64-byte cache line. Default 0. */
  alignmentOffset?: number;
  /** Initial register state. Default "diff". */
  initPolicy?: 'diff' | 'same' | 'stack';
  /** Simulate a front end that is only limited by the issue width. Default false. */
  simpleFrontEnd?: boolean;
  noMicroFusion?: boolean;
  noMacroFusion?: boolean;
  /** Simulate at least this many iterations. Default 10. */
  minIterations?: number;
  /** Simulate at least this many cycles. Default 500. */
  minCycles?: number;
  /** Include uiCA's cycle-by-cycle events (`trace`; large). Default false. */
  includeTrace?: boolean;
  /** Include `details` (per instruction allowed ports, latencies, front-end facts; the port set behind the Ports limit;
   *  issue slots per cause: docs/WASM-API.md). Default false. */
  details?: boolean;
}

export type Syntax = 'intel' | 'att';

/** What of `source` is analyzed: "auto" (default: the innermost loop of a whole function, or its body if it has no
 * loop; else the text as it is), "whole", or the index of a loop (innermost first, in code order). */
export type LoopChoice = 'auto' | 'whole' | number;

/** What was analyzed when it is not the whole text as given (AnalyzeResult.loop). */
export interface LoopInfo {
  /** The loop's index; null for a function's body or the whole text. */
  index: number | null;
  /** The number of loops in the text. */
  count: number;
  /** "loop .L3", "loop 0x10" (objdump), "body" or "whole". */
  name: string;
  /** Its first and last line in the source (null: the whole text). */
  line: number | null;
  endLine: number | null;
  /** Its address (objdump input). */
  address?: number;
  /** The alignment offset from the addresses (objdump input): used unless options.alignmentOffset is given. */
  alignmentOffset?: number;
}

/** The code: exactly one of `source` (assembly; `asm` is accepted as an alias) and `hex` (machine code). */
export type CodeRequest =
  | { source: string; asm?: undefined; hex?: undefined; syntax?: Syntax; loop?: LoopChoice }
  | { asm: string; source?: undefined; hex?: undefined; syntax?: Syntax; loop?: LoopChoice }
  | { hex: string | Uint8Array; source?: undefined; asm?: undefined; syntax?: Syntax; loop?: LoopChoice };

/** Body of POST /api/analyze/<arch>. */
export type AnalyzeRequest = CodeRequest & { options?: AnalysisOptions };

/** Body of POST /api/compare. */
export type CompareRequest = CodeRequest & { archs?: string[]; options?: AnalysisOptions };

/** Result codes, like an exit status. */
export declare const CODES: Readonly<{ OK: 0; REQUEST: 1; ASSEMBLER: 2; ANALYSIS: 3 }>;
export type ResultCode = 0 | 1 | 2 | 3;

/** One line of stderr, as in Compiler Explorer; lines with a source position carry a tag. */
export interface StderrLine {
  text: string;
  tag?: { line: number; column: number; severity: 'error' | 'warning' | 'note'; text: string };
}

/** A failed call. code 1: bad request; 2: assembler error; 3: the analysis failed for this input. */
export interface Failure {
  code: 1 | 2 | 3;
  error: string;
  stderr: StderrLine[];
  /** The WebAssembly module trapped on this input; it has been restarted and the next call works. */
  trapped?: boolean;
}

export interface Limit {
  name: string;
  tp: number;
}

export interface Row {
  kind: 'instr' | 'regMerge' | 'stackSync';
  label: string;
  opcode?: string;
  instrStr?: string;
  url?: string | null;
  /** "M" macro-fused with the previous instruction, "J" JCC erratum, "X" not supported, or "". */
  notes: string;
  /** values[i] belongs to columns[i]; averages per iteration. */
  values: number[];
}

/** A successful analysis: the response of docs/WASM-API.md plus code, hex and stderr. */
export interface AnalyzeResult {
  code: 0;
  arch: string;
  /** Predicted throughput in cycles per iteration. */
  tp: number;
  /** "loop" if the block ends with a branch, else "unroll". */
  mode: 'loop' | 'unroll';
  decodeErrors: number;
  bottlenecks: string[];
  limits: Limit[];
  columns: string[];
  rows: Row[];
  /** uiCA's complete text report. */
  text: string;
  trace: unknown | null;
  /** The loop-carried dependency cycle behind the "Dependencies" limit; only if that limit is not 0 (docs/WASM-API.md). */
  criticalPath?: {
    ratio: number;
    edges: { from: number; to: number; operand: string; latency: number; carried: boolean }[];
  };
  /** The assembled machine code (lower-case hex), when `source` was given. */
  hex?: string;
  /** What of `source` was analyzed, when not the whole text as given (request.loop). */
  loop?: LoopInfo;
  /** Assembler warnings, notes (exits taken as not taken), and the decode warning. */
  stderr: StderrLine[];
}

/** The compact form of an analysis (summarize(); the MCP `analyze` JSON). */
export interface AnalyzeSummary {
  code: 0;
  arch: string;
  name: string;
  year: number | null;
  prototype: boolean;
  tp: number;
  unit: 'cycles per iteration';
  mode: 'loop' | 'unroll';
  bottlenecks: string[];
  limits: Limit[];
  decodeErrors: number;
  hex?: string;
  loop?: LoopInfo;
  stderr: StderrLine[];
  instructions: Array<{
    instr: string;
    bytes?: string;
    kind?: 'regMerge' | 'stackSync';
    issued?: number;
    executed?: number;
    uopSource?: Record<string, number>;
    ports?: Record<string, number>;
    notes?: string;
    uopsInfo?: string;
    /** With options.details: */
    allowedPorts?: string;
    uops?: number;
    fusedUops?: number;
    msUops?: number;
    latencies?: string[];
    frontEnd?: { length: number; offset: number; crosses?: number[]; lcp?: true; microcoded?: true; complexDecoder?: true; macroFusedWithNext?: true; macroFusedWithPrev?: true };
  }>;
  /** A diagnosis derived from the analysis (the web page's bound view); absent if tp is 0. */
  insights?: Insights;
}

export interface Insights {
  /** Each limit (by name) and execution port (by column name): cycles / tp. 1 = busy every cycle. */
  utilization: Record<string, number>;
  /** The bottleneck(s) uiCA names: the same as the response's `bottlenecks` (limits only). [] when it names none (no
   * single limit explains tp; the web page says "unknown"): then see `largest`. */
  binding: string[];
  /** Only when `binding` is []: the largest limit(s), the nearest bound, which alone does not reach tp. */
  largest?: string[];
  /** The largest limit below the binding (or largest) one; maxSpeedup = tp / next.tp (an upper bound). */
  next?: { limit: string; tp: number; maxSpeedup: number | null };
  /** Cycles per iteration that no single limit explains. */
  unexplained?: number;
  /** The critical loop-carried dependency chain (index: into `instructions`). */
  chain?: { index: number; instr: string; operand: string; latency: number; carried: boolean }[];
  /** The instructions with the largest share of the binding resource, or of the largest limit (top 5). */
  hot?: { resource: string; ports?: string[]; instructions: { index: number; instr: string; share: number }[] };
  /** With options.details: the ports behind the Ports limit (cycles = uops / ports) and the instructions that load them. */
  portSet?: { ports: string[]; uops: number; cycles: number; instructions: { index: number; instr: string; uops: number }[] };
  /** With options.details: issue slots per iteration, used and lost by cause. */
  issueSlots?: { width: number; perIteration: { issued: number; frontEnd: number; rob: number; rs: number; other: number } };
}

export interface ArchInfo {
  /** The id to pass as `arch`, e.g. "SKL". */
  id: string;
  /** Display name, e.g. "Skylake". */
  name: string;
  year: number | null;
  /** An experimental model of the fork jtl06/uiCA (ZEN3, ADL-P, ICX). */
  prototype: boolean;
  /** The instruction table it uses (data/arch/<table>.json). */
  table: string;
  /** XED chip name used for decoding. */
  xedChip: string;
}
export type ArchField = keyof ArchInfo;

export interface AssembleResult {
  code: 0;
  hex: string;
  length: number;
  bytes: Uint8Array;
  /** Warnings, if any. */
  stderr: StderrLine[];
}

export type CompareRow =
  | { arch: string; name: string; year: number | null; prototype: boolean; code: 0; tp: number; mode: 'loop' | 'unroll'; bottlenecks: string[]; decodeErrors: number }
  | { arch: string; name: string; year: number | null; prototype: boolean; code: 1 | 2 | 3; error: string };

export interface CompareResult {
  code: 0;
  /** The assembled machine code, when `source` was given. */
  hex?: string;
  loop?: LoopInfo;
  stderr: StderrLine[];
  results: CompareRow[];
}

export interface Wuica {
  /** POST /api/analyze/<arch>. Failures resolve to a Failure (never throw for bad input). */
  analyze(arch: string, request: AnalyzeRequest): Promise<AnalyzeResult | Failure>;
  /** Single-object form: `arch` in the request (default "SKL"). */
  analyze(request: AnalyzeRequest & { arch?: string }): Promise<AnalyzeResult | Failure>;
  /** POST /api/compare: one block on several microarchitectures (default: all of archs()); assembled once. The
   * microarchitectures are analyzed on worker threads (CreateOptions.threads); the response is the same either way. */
  compare(request: CompareRequest): Promise<CompareResult | Failure>;
  /** GET /api/archs: in order of release (uiCA's ablation variants, ids with "_", are left out). */
  archs(): ArchInfo[];
  archs(fields: ArchField[] | string): Partial<ArchInfo>[];
  /** POST /api/assemble: LLVM's x86 assembler (Intel noprefix by default). */
  assemble(source: string, syntax?: Syntax): Promise<AssembleResult | Failure>;
  /** The compact form of a successful analyze() result; a Failure is returned unchanged. */
  summarize(result: AnalyzeResult): AnalyzeSummary;
  summarize(result: Failure): Failure;
  /** The id for a user-supplied name (case-insensitive, "-" optional), DEFAULT_ARCH for empty input, or null. */
  resolveArch(arch?: string | null): string | null;
  /** How many times the analyzer was restarted after a trap. */
  readonly restarts: number;
  /** The number of compare()'s worker threads running now (they stop after 30 s without work). */
  readonly threads: number;
  /** Stops compare()'s worker threads now (idle threads never keep the process alive). The instance stays usable. */
  close(): Promise<void>;
}

export interface CreateOptions {
  /** Directory with uarch.json and arch/<NAME>.json (plain or .br). Default: the tables shipped in the package. */
  dataDir?: string;
  /** Path of wuica_wasm.wasm (plain or .br). */
  analyzerWasm?: string;
  /** Path of wuica_asm.wasm (plain or .br). */
  assemblerWasm?: string;
  /** The most worker threads compare() uses, one per microarchitecture. 1: none (one after another on the calling
   * thread). Default: the environment variable WUICA_THREADS, else "auto": one thread per two microarchitectures, at
   * most os.availableParallelism() (none inside a worker thread). */
  threads?: number | 'auto';
}

export function createWuica(options?: CreateOptions): Promise<Wuica>;

/** Normalizes hex input ("48 01 d8", "0x48,0x01", "\\x48\\x01") to lower-case hex; null if invalid. */
export function normalizeHex(input: string | Uint8Array): string | null;

/** llvm-mc diagnostics as stderr lines with tags. */
export function stderrLines(message: string): StderrLine[];
export function parseDiagnostics(text: string): Array<{ line: number | null; column: number | null; severity: 'error' | 'warning' | 'note'; message: string }>;

export const OPTION_DEFAULTS: Readonly<Required<AnalysisOptions>>;
export const ARCH_FIELDS: readonly ArchField[];
export const DEFAULT_ARCH: string;
/** A 482-instruction loop (hex) for warming up the analyzer: after one analysis of it (and a pause, while V8 optimizes
 * in the background), the first analysis of a large block runs at nearly full speed. */
export const WARM_HEX: string;
export const ARCH_ORDER: string[];
export const ARCH_INFO: Record<string, { name: string; year: number }>;

/** The derived diagnosis of an analysis (the web page's bound view; also `insights` in the MCP summary and the REST response). */
export function insights(result: AnalyzeResult): Insights | null;

export type WhatIfVariant = 'unroll2' | 'unroll4' | 'unroll8' | 'acc2' | 'acc3' | 'acc4' | 'acc8' | 'simpleFrontEnd' | 'noMacroFusion' | 'noMicroFusion' | 'nochain';
export const WHAT_IF_VARIANTS: readonly WhatIfVariant[];
export interface WhatIfResult {
  code: 0;
  arch: string;
  tp: number;
  mode: 'loop' | 'unroll';
  bottlenecks: string[];
  unit: 'cycles per original iteration';
  loop?: LoopInfo;
  /** tp per original iteration, delta = tp − base tp, speedup = base tp / tp; estimate: no analysis (nochain);
   * renamed (accN): the chain's registers and the ones of the copies after the first. */
  variants: { id: WhatIfVariant; label: string; tp?: number; delta?: number; speedup?: number | null; estimate?: boolean; bottlenecks?: string[]; renamed?: { from: string; to: string[] }[]; error?: string }[];
  /** With accumulator variants: the best N (the smallest within 1% of the fastest; 1 = as it is) and its tp. */
  accumulators?: { best: number; tp: number };
}
/** The what-if experiments of the web page (the MCP tool `what_if`), with `analyze` (e.g. a Wuica's analyze, bound) and,
 * for the accumulator variants, `assemble` (e.g. a Wuica's assemble, bound). */
export function whatIf(analyze: (arch: string, request: AnalyzeRequest) => Promise<AnalyzeResult | Failure>, arch: string, request: AnalyzeRequest, variants?: readonly WhatIfVariant[],
  tools?: { assemble?: (text: string) => Promise<AssembleResult | Failure> }): Promise<WhatIfResult | Failure>;
