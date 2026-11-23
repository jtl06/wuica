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
}

export type Syntax = 'intel' | 'att';

/** The code: exactly one of `source` (assembly; `asm` is accepted as an alias) and `hex` (machine code). */
export type CodeRequest =
  | { source: string; asm?: undefined; hex?: undefined; syntax?: Syntax }
  | { asm: string; source?: undefined; hex?: undefined; syntax?: Syntax }
  | { hex: string | Uint8Array; source?: undefined; asm?: undefined; syntax?: Syntax };

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
  /** Assembler warnings and the decode warning. */
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
  }>;
  /** A diagnosis derived from the analysis (the web page's bound view); absent if tp is 0. */
  insights?: Insights;
}

export interface Insights {
  /** Each limit (by name) and execution port (by column name): cycles / tp. 1 = busy every cycle. */
  utilization: Record<string, number>;
  /** The bottleneck(s), or the largest limit if uiCA names none. */
  binding: string[];
  /** The largest limit below the binding one; maxSpeedup = tp / next.tp (an upper bound). */
  next?: { limit: string; tp: number; maxSpeedup: number | null };
  /** Cycles per iteration that no single limit explains. */
  unexplained?: number;
  /** The critical loop-carried dependency chain (index: into `instructions`). */
  chain?: { index: number; instr: string; operand: string; latency: number; carried: boolean }[];
  /** The instructions with the largest share of the binding resource (top 5). */
  hot?: { resource: string; ports?: string[]; instructions: { index: number; instr: string; share: number }[] };
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
  stderr: StderrLine[];
  results: CompareRow[];
}

export interface Wuica {
  /** POST /api/analyze/<arch>. Failures resolve to a Failure (never throw for bad input). */
  analyze(arch: string, request: AnalyzeRequest): Promise<AnalyzeResult | Failure>;
  /** Single-object form: `arch` in the request (default "SKL"). */
  analyze(request: AnalyzeRequest & { arch?: string }): Promise<AnalyzeResult | Failure>;
  /** POST /api/compare: one block on several microarchitectures (default: all of archs()); assembled once. */
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
}

export interface CreateOptions {
  /** Directory with uarch.json and arch/<NAME>.json (plain or .br). Default: the tables shipped in the package. */
  dataDir?: string;
  /** Path of wuica_wasm.wasm (plain or .br). */
  analyzerWasm?: string;
  /** Path of wuica_asm.wasm (plain or .br). */
  assemblerWasm?: string;
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
export const ARCH_ORDER: string[];
export const ARCH_INFO: Record<string, { name: string; year: number }>;
