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

/** "auto" (the default): detected from the text (%registers, $immediates: AT&T; else Intel noprefix). */
export type Syntax = 'auto' | 'intel' | 'att';

/** What of `source` is analyzed: "auto" (default: of the deepest innermost loops in the function of the first of them, the one with the
 * widest vector registers, then the most vector instructions, then the most instructions, then the first; its body if
 * it has no loop; else the text as it is), "whole", the index of a loop (as listLoops lists them), or its label. */
export type LoopChoice = 'auto' | 'whole' | number | string;
/** The named loop choices ('auto', 'whole'); a number is a loop's index (0-based), any other string its label. */
export declare const LOOP_CHOICES: readonly ['auto', 'whole'];
/** A loop of the text that was not analyzed (analyze's `otherLoops`): listLoops' entry without `auto`. */
export type OtherLoop = Omit<LoopListing, 'auto'>;
/** A loop of assembly text (listLoops; the CLI's -loops; the MCP tool list_loops). */
export interface LoopListing {
  /** Its index for `loop` (0-based): the deepest innermost loops first, then in code order (the default, `auto`, need
   * not be the first). */
  index: number;
  label: string;
  /** The function it is in (the last non-local label before it), or null. */
  function: string | null;
  line: number;
  endLine: number;
  instructions: number;
  /** 1 for a loop in no other loop (clang's Depth when its notes say). */
  depth: number;
  /** The loop "auto" analyzes. */
  auto: boolean;
}
/** The loops of assembly text, as `loop` and `func` choose among them (no assembling). */
export function listLoops(source: string, options?: { func?: string | null }): LoopListing[] | { error: string };
/** A built-in example: the web page's set (the CLI's -examples / -example NAME). */
export interface Example {
  /** "saxpy", "dot1", ... (findExample and the CLI take it in any case). */
  name: string;
  title: string;
  group: 'basics' | 'classic' | 'showcase';
  /** The CPU the page shows it on first. */
  arch: string;
  instructions: number;
  /** Its machine code. */
  hex: string;
  /** Its assembly (a request's `source` with syntax 'intel' or 'att'); absent for the showcase (machine code only). */
  intel?: string;
  att?: string;
}
/** What a file is from its first bytes ('elf', 'macho', 'fat', 'macho32', 'coff', 'pe', 'archive'), or null. */
export function objectKind(bytes: Uint8Array): { kind: string } | null;
/** The built-in examples: basics, classic loops, the SHA-256 showcase. */
export function examples(): readonly Example[];
/** The example called `name` (case-insensitive), or null. */
export function findExample(name: string): Example | null;
/** 'att' or 'intel' from the text's signs, or null. */
export function detectSyntax(source: string): 'att' | 'intel' | null;
/** Per instruction details and the port set / issue slots of an analysis with options.details (the MCP summary's). */
export function detailInsights(result: AnalyzeResult): Partial<Insights>;

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
  /** The source line of each of its instructions, in order (a picked loop or body): row k of the analysis is line lines[k]. */
  lines?: number[];
  /** The function it is in, its nesting depth and its instruction count (for a loop). */
  function?: string | null;
  depth?: number;
  instructions?: number;
  /** Its address (objdump input). */
  address?: number;
  /** The alignment offset from the addresses (objdump input): used unless options.alignmentOffset is given. */
  alignmentOffset?: number;
}

/** The code: exactly one of `source` (assembly; `asm` is accepted as an alias) and `hex` (machine code). */
export type CodeRequest =
  | { source: string; asm?: undefined; hex?: undefined; syntax?: Syntax; loop?: LoopChoice; func?: string }
  | { asm: string; source?: undefined; hex?: undefined; syntax?: Syntax; loop?: LoopChoice; func?: string }
  | { hex: string | Uint8Array; source?: undefined; asm?: undefined; syntax?: Syntax; loop?: LoopChoice };

/** Body of POST /api/analyze/<arch>. */
export type AnalyzeRequest = CodeRequest & { options?: AnalysisOptions };

/** Body of POST /api/compare. */
/** `per`: elements per iteration (also cycles per element: `elementsPerIteration` and each row's `perElement`). */
export type CompareRequest = CodeRequest & { archs?: string[]; options?: AnalysisOptions; per?: number };

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
  /** Assembly input: the instruction's 1-based line in the text, and its `.loc` source line ("file.c:12") when the text has .file/.loc directives. Absent for machine code. */
  line?: number;
  loc?: string;
  /** objdump -S and perf annotate input: the interleaved source line in force ("s += a[i] * b[i];"). */
  source?: string;
  /** perf annotate input: the instruction's percent of all the samples of the output (each symbol's own percent weighted
   * by its sample count). */
  samples?: number;
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
  /** With options.details: per row its allowed ports, latencies, front-end facts; the port set and issue slots
   * (docs/WASM-API.md, "Details"). */
  details?: { rows: unknown[]; ports?: unknown; slots?: unknown };
  /** The assembled machine code (lower-case hex), when `source` was given. */
  hex?: string;
  /** What of `source` was analyzed, when not the whole text as given (request.loop). */
  loop?: LoopInfo;
  /** The loops of the text that were not analyzed, when it has more than one (listLoops without `auto`). */
  otherLoops?: OtherLoop[];
  /** The syntax `source` was read in (detected unless the request said). */
  syntax?: 'intel' | 'att';
  /** Assembler warnings, notes (exits taken as not taken), and the decode warning. */
  stderr: StderrLine[];
  /** Only when this CPU cannot run the code (positions its decoder skipped, or an instruction of an extension it lacks,
   * e.g. AVX-512 on ZEN3): why ("needs AVX-512", "12 undecodable"). `tp` is then the reference's number, which leaves
   * that code out: not a result for this CPU. */
  unsupported?: string;
  /** Only when the CPU can run the code but some of its instructions are not in its instruction tables (rows with the
   * note X: x87 tbyte loads, syscall, ...): their count. The result stands; their cost is left out. */
  noData?: number;
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
  /** As AnalyzeResult's: why this CPU cannot run the code, only then. */
  unsupported?: string;
  /** As AnalyzeResult's: the instructions without data of code it can run, only if any. */
  noData?: number;
  hex?: string;
  loop?: LoopInfo;
  /** The loops of the text that were not analyzed, when it has more than one (listLoops without `auto`). */
  otherLoops?: OtherLoop[];
  stderr: StderrLine[];
  instructions: Array<{
    instr: string;
    line?: number;
    loc?: string;
    source?: string;
    samples?: number;
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
  /** The bottleneck(s) uiCA names: the same as the response's `bottlenecks` (limit names, and "Divider", which has no limit of its own). [] when it names none (no
   * single limit explains tp; the web page says "unknown"): then see `largest`. */
  binding: string[];
  /** Only when `binding` is []: the largest limit(s), the nearest bound, which alone does not reach tp. */
  largest?: string[];
  /** The largest limit below the binding (or largest) one; maxSpeedup = tp / next.tp (an upper bound). */
  next?: { limit: string; tp: number; maxSpeedup: number | null };
  /** Cycles per iteration that no single limit explains. */
  unexplained?: number;
  /** The critical loop-carried dependency chain (index: into `instructions`). */
  chain?: { index: number; instr: string; line?: number; loc?: string; operand: string; latency: number; carried: boolean }[];
  /** The instructions with the largest share of the binding resource, or of the largest limit (top 5). */
  hot?: { resource: string; ports?: string[]; instructions: { index: number; instr: string; line?: number; loc?: string; share: number }[] };
  /** Known blind spots of the model the block meets (absent if none): rmw-index, paths, exit, split. */
  caveats?: Caveat[];
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
  | { arch: string; name: string; year: number | null; prototype: boolean; code: 0; tp: number; mode: 'loop' | 'unroll'; bottlenecks: string[]; limits: Limit[]; decodeErrors: number; unsupported?: string; noData?: number; perElement?: number }
  | { arch: string; name: string; year: number | null; prototype: boolean; code: 1 | 2 | 3; error: string };

export interface CompareResult {
  code: 0;
  /** The assembled machine code, when `source` was given. */
  hex?: string;
  loop?: LoopInfo;
  /** The loops of the text that were not analyzed, when it has more than one (listLoops without `auto`). */
  otherLoops?: OtherLoop[];
  /** With the request's `per`. */
  elementsPerIteration?: number;
  stderr: StderrLine[];
  results: CompareRow[];
}
/** A compare() result with cycles per element (`per` elements per iteration); unchanged without `per`. */
export function comparePerElement(result: CompareResult | Failure, per?: number): CompareResult | Failure;

export interface Wuica {
  /** POST /api/analyze/<arch>. Failures resolve to a Failure (never throw for bad input). */
  analyze(arch: string, request: AnalyzeRequest): Promise<AnalyzeResult | Failure>;
  /** Single-object form: `arch` in the request (default "SKL"). */
  analyze(request: AnalyzeRequest & { arch?: string }): Promise<AnalyzeResult | Failure>;
  /** The machine code an analysis of assembly text gets (as the web page reads it: the loop of a whole function, objdump
   * lines, exits as not taken, ';' comments, a marked region); `bytes` and `hex` of the analyzed code, `loop` what was picked. */
  machineCode(source: string, syntax?: Syntax, loop?: LoopChoice, func?: string | null): Promise<{ code: 0; hex: string; bytes: Uint8Array; stderr: StderrLine[]; loop: LoopInfo | null } | Failure>;
  /** POST /api/compare: one block on several microarchitectures (default: all of archs()); assembled once. The
   * microarchitectures are analyzed on worker threads (CreateOptions.threads); the response is the same either way. */
  compare(request: CompareRequest): Promise<CompareResult | Failure>;
  /** Several blocks on one microarchitecture: each result exactly what analyze(arch, request) returns, in the same
   * order. The code is assembled on the calling thread; the analyses run on worker threads when the work is worth it. */
  analyzeMany(arch: string, requests: AnalyzeRequest[]): Promise<(AnalyzeResult | Failure)[]>;
  /** Several blocks on several microarchitectures: each result exactly what compare() returns for that request (its
   * `archs`, else options.archs, else all); every block x microarchitecture is one job for the threads. */
  compareMany(requests: CompareRequest[], options?: { archs?: string[] }): Promise<(CompareResult | Failure)[]>;
  /** An object file or executable (ELF or Mach-O, x86-64; a universal file's x86-64 slice) as llvm-objdump -d's text
   * of its code sections, which analyze() and compare() read as `source` (the loop at its address, the alignment from
   * it). Another architecture or format is a Failure that says what it is and how to get x86-64. `func` is resolved
   * (exact, without Mach-O's "_", or a unique part of a name) and returned as `func`. */
  disassemble(bytes: Uint8Array, options?: { name?: string; func?: string | null }): { code: 0; text: string; format: string; functions: { name: string; section: string; address: number; size: number }[]; func?: string } | Failure;
  /** GET /api/archs: in order of release (uiCA's ablation variants, ids with "_", are left out). */
  archs(): ArchInfo[];
  archs(fields: ArchField[] | string): Partial<ArchInfo>[];
  /** POST /api/assemble: LLVM's x86 assembler (Intel noprefix by default). */
  assemble(source: string, syntax?: Syntax): Promise<AssembleResult | Failure>;
  /** The compact form of a successful analyze() result; a Failure is returned unchanged. */
  summarize(result: AnalyzeResult): AnalyzeSummary;
  summarize(result: Failure): Failure;
  /** The derived diagnosis of a successful analyze() result with its microarchitecture's configuration (as in the REST
   * response and summarize()); null for a failure. */
  insights(result: AnalyzeResult | Failure): Insights | null;
  /** The what-if experiments (the MCP tool what_if, POST /api/what-if/<arch>): analyze's request with `variants`
   * (default all) and `per` (elements per iteration: also cycles per element). */
  whatIf(arch: string, request: WhatIfRequest): Promise<WhatIfPerElement | Failure>;
  /** Two blocks, A (before) and B (after), on one microarchitecture (wuica diff, the MCP tool diff_blocks,
   * POST /api/diff/<arch>). A failure's error starts with "A: " or "B: ". */
  diff(arch: string, request: DiffRequest): Promise<DiffResult | Failure>;
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
  /** The most worker threads compare(), analyzeMany() and compareMany() use. A number: up to that many (one per job at
   * most); 1: none (one after another on the calling thread). Default: the environment variable WUICA_THREADS, else
   * "auto": by the amount of work (blocks x microarchitectures, their instructions, the tables to load): none when it
   * would take less than about 0.3 s on one thread, else 2 to 8, at most the cores but one (none inside a worker
   * thread). */
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

/** The derived diagnosis of an analysis (the web page's bound view; also `insights` in the MCP summary and the REST response).
 * `config` is the microarchitecture's configuration in uarch.json (only `splitLoadCycles` is read, for the `split` caveat);
 * without it, as on a CPU without a split-load cost. The instance's insights() passes it. */
export function insights(result: AnalyzeResult, config?: { splitLoadCycles?: number } | null): Insights | null;

/** A known blind spot of the model that the block meets (Insights.caveats; the CLI's -json, one CPU or several). */
export interface Caveat {
  /** rmw-index: a read-modify-write to an indexed address (store forwarding depends on the data); paths: a conditional
   * branch inside the block (an if/else, a second back edge): both sides are simulated, a real iteration takes one;
   * exit: an exit before the loop's branch (its mispredict); split: loads that may cross a cache line. */
  id: 'rmw-index' | 'paths' | 'exit' | 'split';
  /** The short form ("both paths"). */
  text: string;
  /** The explanation (paths: the branch's source line when the result has loop.lines, else its instruction number). */
  title: string;
  /** Indexes into the instructions (rows). */
  instructions: number[];
}

export type WhatIfVariant = 'unroll2' | 'unroll4' | 'unroll8' | 'acc2' | 'acc3' | 'acc4' | 'acc8' | 'simpleFrontEnd' | 'noMacroFusion' | 'noMicroFusion' | 'nochain' | 'align';
/** The default variants (not align). */
export const WHAT_IF_VARIANTS: readonly WhatIfVariant[];
/** The variants that run only when asked for: align (64 analyses). */
export const WHAT_IF_OPT_IN_VARIANTS: readonly WhatIfVariant[];
export interface WhatIfResult {
  code: 0;
  arch: string;
  tp: number;
  mode: 'loop' | 'unroll';
  bottlenecks: string[];
  unit: 'cycles per original iteration';
  loop?: LoopInfo;
  /** The base's decode errors and warnings (they hold for the variants too). */
  decodeErrors?: number;
  stderr?: StderrLine[];
  /** Only when the CPU cannot run the base (as AnalyzeResult's): why. `variants` is then empty: no variant compares with
   * a number that is not a result. */
  unsupported?: string;
  /** tp per original iteration, delta = tp − base tp, speedup = base tp / tp; estimate: no analysis (nochain);
   * renamed (accN): the chain's registers and the ones of the copies after the first; approx: the simulation (tp) came
   * out under the variant's own Ports or Issue limit by at most 1% (a short steady state): the text and the Markdown
   * show `shown`, that limit per original iteration, marked ≈ (~ in text). */
  variants: { id: WhatIfVariant; label: string; tp?: number; delta?: number; speedup?: number | null; estimate?: boolean; bottlenecks?: string[]; renamed?: { from: string; to: string[] }[]; error?: string;
    approx?: { limit: 'Ports' | 'Issue'; shown: number };
    /** align: the 64 alignment offsets (tp: the median); best and worst: the first offset with the minimum, the maximum; offset: this block's. */
    alignment?: { min: number; median: number; max: number; best: number; worst: number; spread: number; offset: number } }[];
  /** With accumulator variants: the best N (the smallest within 1% of the fastest; 1 = as it is) and its tp. */
  accumulators?: { best: number; tp: number };
  /** From the API server: its time limit for the whole request ("deadline") ran out, or it was busy, after the base:
   * the variants without a result have error "not run: <notRun>" (align: with how many offsets were analyzed). */
  notRun?: string;
}

/** The CLI's `-json -whatif`: one WhatIfResult per CPU, keyed by its id, with one CPU as with several. With `-per N`,
 * each has elementsPerIteration (N) and perElement (tp / N), and each variant with a tp its perElement. */
export type CliWhatIf = Record<string, WhatIfPerElement | Failure>;
/** A what-if result; with `per`, elementsPerIteration and perElement (tp / per), and each variant with a tp its perElement. */
export type WhatIfPerElement = WhatIfResult & { elementsPerIteration?: number; perElement?: number; variants: (WhatIfResult['variants'][number] & { perElement?: number })[] };
/** The request of Wuica.diff: two blocks (each as analyze's request), `options` for both (unless a block has its own),
 * `per` elements per iteration (N for both, or [A, B]). */
export interface DiffRequest { a: AnalyzeRequest; b: AnalyzeRequest; options?: AnalysisOptions; per?: number | [number, number] }
/** One side of a DiffResult: as analyze gives it; perElement = tp / per (unrounded, as compare's and what-if's). */
export interface DiffSide { tp: number; mode: 'loop' | 'unroll'; bottlenecks: string[]; decodeErrors: number; unsupported?: string; perElement?: number; loop?: LoopInfo; stderr?: StderrLine[] }
/** The result of Wuica.diff. tp and limits as analyze gives them; delta (B − A, 0 when the same within 0.25 %) and
 * speedup (A / B) rounded to two decimals; perElement's a, b and delta unrounded; uop changes rounded to two decimals.
 * Both blocks must be analyzed the same way (both loops, or both unrolled): else a Failure "not comparable". */
export interface DiffResult {
  code: 0;
  arch: string;
  a: DiffSide;
  b: DiffSide;
  /** Not when a side's CPU cannot run its code (a side with `unsupported`): the verdict is then "not comparable". */
  delta?: number;
  speedup?: number | null;
  verdict: 'better' | 'worse' | 'same' | 'not comparable';
  perElement?: { a: number; b: number; delta?: number; speedup?: number | null; verdict: 'better' | 'worse' | 'same' | 'not comparable' };
  /** The warnings of both sides (decode errors, assembler warnings), each starting with "A: " or "B: ". */
  stderr?: StderrLine[];
  bottlenecks: { a: string[]; b: string[]; gone: string[]; new: string[] };
  limits: { name: string; a: number | null; b: number | null; delta: number | null }[];
  /** uops per iteration of each execution port (both sides' ports; [] if they differ). */
  ports: { port: string; a: number; b: number; delta: number }[];
  /** The instructions aligned as a diff: changed (same instruction, other uops), modified (other operands), added (only
   * in B), removed (only in A); `uops`: the change of the issued uops and of each port's, where not 0; `minor`: a change
   * of uops under 0.05 per iteration in every column (left out of the Markdown and the text). */
  instructions: { counts: Record<'same' | 'changed' | 'modified' | 'added' | 'removed', number>; changes: { status: 'changed' | 'modified' | 'added' | 'removed'; a: string | null; b: string | null; uops: Record<string, number>; minor?: true }[] };
}
/** Wuica.diff with any w that has analyze. */
export function diffRequest(w: Pick<Wuica, 'analyze'>, arch: string, request: DiffRequest): Promise<DiffResult | Failure>;
/** The two analyses and the result (for diffMarkdown), or the failure. */
export function diffAnalyses(w: Pick<Wuica, 'analyze'>, arch: string, request: DiffRequest): Promise<{ result: DiffResult; a: AnalyzeResult; b: AnalyzeResult; per: [number, number] | null; sourceA: string | null; sourceB: string | null } | { failure: Failure }>;
/** The result from two analyze() responses. */
export function diffResult(a: AnalyzeResult, b: AnalyzeResult, options?: { per?: [number, number] | null; sourceA?: string | null; sourceB?: string | null }): DiffResult | Failure;
/** Markdown of diffAnalyses' result (the page's A–B tables; markdown.compare), naming the microarchitecture (archTitle, else its id), with the warnings. */
export function diffMarkdown(x: Awaited<ReturnType<typeof diffAnalyses>>, options?: { archTitle?: string }): string;
/** The result as text (wuica diff; REST text/plain). */
export function diffText(result: DiffResult | Failure): string;
/** The request of Wuica.whatIf, the MCP tool what_if and POST /api/what-if/<arch>. */
export type WhatIfRequest = AnalyzeRequest & { variants?: readonly WhatIfVariant[]; per?: number };
/** whatIf with a request as the interfaces take it (`variants`, `per`), with w's analyze and assemble. */
export function whatIfRequest(w: Pick<Wuica, 'analyze' | 'assemble'>, arch: string, request: WhatIfRequest): Promise<WhatIfPerElement | Failure>;
/** A what-if result per element (`per` elements per iteration); unchanged without `per` or for a failure. */
export function whatIfPerElement(result: WhatIfResult | Failure, per?: number): WhatIfPerElement | Failure;
/** The what-if table as the CLI prints it (-whatif; REST text/plain). */
export function whatIfText(result: WhatIfPerElement | Failure): string;
/** The CLI's `-json` with one CPU: the analyze result with insights (caveats in insights.caveats), perElement (-per)
 * and whatIf (-whatif). */
export type CliAnalyzeJson = AnalyzeResult & { insights?: Insights; perElement?: number; whatIf?: CliWhatIf };
/** The CLI's `-json` with several CPUs: the compare result; each result with perElement (-per) and caveats (the same
 * objects as insights.caveats with one CPU); whatIf (-whatif) as with one CPU. */
export type CliCompareJson = CompareResult & { results: (CompareResult['results'][number] & { perElement?: number; caveats?: Caveat[] })[]; whatIf?: CliWhatIf };
/** The CLI's `--version -json`: the package's version and the uiCA reference whose data and model it has (from the
 * repository's ci/data-asset.txt at build time; null if the package was not built). */
/** The CLI's `-json` with several inputs (wuica a.s b.s ..., -files LIST): `code` is the largest of the files' codes
 * (the exit status); each entry is what a single run prints for that file (CliAnalyzeJson, CliCompareJson, a Failure,
 * or with -loops {code, loops}), with the file's name as given. */
export interface CliBatchJson { code: number; files: ({ file: string } & (CliAnalyzeJson | CliCompareJson | Failure | { code: 0; loops: LoopListing[] }))[] }
export interface CliVersionJson { wuica: string; uiCA: { repository: string; commit: string; branch?: string } | null; node: string }
/** The what-if experiments of the web page (the MCP tool `what_if`), with `analyze` (e.g. a Wuica's analyze, bound) and,
 * for the accumulator variants, `assemble` (e.g. a Wuica's assemble, bound). */
export function whatIf(analyze: (arch: string, request: AnalyzeRequest) => Promise<AnalyzeResult | Failure>, arch: string, request: AnalyzeRequest, variants?: readonly WhatIfVariant[],
  tools?: { assemble?: (text: string) => Promise<AssembleResult | Failure> }): Promise<WhatIfResult | Failure>;
/** Results as GitHub-flavoured Markdown (the page's copy controls and `wuica -md`; lib/web/markdown.js): deterministic
 * text, columns padded for a monospace font, pipes and backticks escaped, numbers as the CLI prints them. Every
 * generator returns text that ends with one newline. */
/** Where the Markdown's branch targets come from (branch-label.js): the labels per row as shown, the analyzed lines of
 * the assembly ({text, from, to}), or the request's source text; else the offset in the block ("jnz 0x0"). */
export interface MarkdownLabels { shown?: (string | null)[] | null; src?: { text: string; from?: number; to?: number } | null; source?: string }
export namespace markdown {
  /** The whole result: headline, limits, next limit, caveats ("not modelled"), critical chain, uop table, the code
   * (meta.code) in a fenced block, a link (meta.link). A failure: its error and stderr lines. */
  function report(result: AnalyzeResult | Failure, meta?: MarkdownLabels & { arch?: string; archTitle?: string; per?: number; insights?: Insights | null;
    config?: { splitLoadCycles?: number } | null; code?: string; lang?: string; link?: string; title?: string }): string;
  /** The headline alone (one line, no newline). */
  function headline(result: AnalyzeResult, meta?: { arch?: string; archTitle?: string; per?: number }): string;
  /** The uop table: every row, the used columns, the totals (no newline at the end). */
  function uopTable(result: AnalyzeResult, meta?: MarkdownLabels): string;
  /** Each row's instruction text with its branch target as a label. */
  function shownLabels(result: AnalyzeResult, meta?: MarkdownLabels): string[];
  /** Several CPUs, one row each (a compare result or its rows); or files x CPUs: [{file, result}]. */
  function cpuTable(input: CompareResult | CliCompareJson | CompareResult['results'] | Failure | { file: string; result: CompareResult | AnalyzeResult | Failure }[],
    options?: { per?: number }): string;
  /** The what-if table of one CPU (per element with elementsPerIteration). */
  function whatIf(result: (WhatIfResult & { elementsPerIteration?: number }) | (Failure & { arch?: string })): string;
  /** whatIf's table, and the alignment line when the result has the variant align. */
  function whatIfAlignment(result: (WhatIfResult & { elementsPerIteration?: number }) | (Failure & { arch?: string })): string;
  /** The loops of assembly text (listLoops). */
  function loops(list: LoopListing[]): string;
  /** A against B (as the page's A–B view): summary, bottlenecks, limits, the aligned instructions with B − A per column;
   * meta.cpus adds the A/B/Δ table per CPU. workA, workB: elements per iteration of each side (cycles per element). */
  function compare(a: AnalyzeResult | Failure, b: AnalyzeResult | Failure, meta?: { workA?: number; workB?: number; archA?: string; archB?: string;
    cpus?: { arch: string; a: number | null; b: number | null }[];
    shownA?: (string | null)[]; srcA?: MarkdownLabels['src']; shownB?: (string | null)[]; srcB?: MarkdownLabels['src'] }): string;
  /** The uop table as CSV (RFC 4180, CRLF). */
  function toCSV(result: AnalyzeResult): string;
  /** The request and the response as JSON (without trace and text). */
  function toJSON(result: AnalyzeResult, request?: unknown): string;
  /** Building blocks for further generators: a padded GFM table, a code span, escaped text, a fenced block. */
  function table(head: string[], rows: string[][], align?: ('l' | 'r' | 'c')[]): string;
  function code(text: string): string;
  function text(s: unknown): string;
  function fence(body: string, lang?: string): string;
  /** A cycle count as the page shows it (two decimals; three significant digits below 0.1); with its sign. */
  function cycles(v: number): string;
  function signedCycles(v: number): string;
  /** A uop-table value as uiCA prints it (up to two decimals, zero blank). */
  function uopValue(v: number): string;
}
