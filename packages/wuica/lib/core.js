// The result shapes that the library's main thread and its worker threads (threads.js) both build, so that a compare()
// gives the same rows whichever thread analyzed a microarchitecture.

/** Result codes (`code`), like an exit status: 0 = success. */
export const CODES = Object.freeze({ OK: 0, REQUEST: 1, ASSEMBLER: 2, ANALYSIS: 3 });

// A failed call: {code, error, stderr}, stderr as in Compiler Explorer (one entry per line, `tag` on positioned ones).
/**
 * A failure of the contract ({code, error, stderr}: index.d.ts Failure), typed loosely so that a result-or-failure
 * union narrows by its `code` at the call sites.
 * @returns {any}
 */
export function failure(code, error, stderr = [{ text: error }], extra = {}) {
  return { code, error, stderr, ...extra };
}

// The failure when a microarchitecture's instruction table cannot be loaded.
export function tableFailure(id, e) {
  return failure(CODES.ANALYSIS, `could not load the instruction table for ${id}: ${e.message}`);
}

// The analyzer's response (Analyzer.analyze) as a library result: the response itself, or a failure.
export function analysisResult(r) {
  if (r.error) return failure(CODES.ANALYSIS, r.error, undefined, r.trapped ? { trapped: true } : {});
  return r;
}

// The fields of a compare() row taken from an analysis result (after arch, name, year, prototype).
// xLabels: the instructions the CPU's model has no data for (notes X), for compare()'s `unsupported` (web/caveats.js
// cannotRun, index.js); it removes them.
export function compareFields(r) {
  if (r.code !== undefined) return { code: r.code, error: r.error };
  const x = Array.isArray(r.rows) ? r.rows.filter((row) => row?.kind === 'instr' && row.notes === 'X').map((row) => String(row.label)) : [];
  return { code: CODES.OK, tp: r.tp, mode: r.mode, bottlenecks: r.bottlenecks, limits: r.limits, decodeErrors: r.decodeErrors, ...(x.length ? { xLabels: x } : {}) };
}

// A block for warming up the analyzer: ~500 instructions of several kinds in a loop (a 24-instruction mix, 20 times;
// ~10 ms). V8 compiles the module's functions when they are first called, with its baseline compiler, and optimizes the
// hot ones in the background later: after one analysis of this block, the first analysis of a large block runs at
// nearly full speed (docs/PORTING.md, "Speed").
const WARM_MIX = '4883c001' + '488906' + '8b06' + 'c4e2d5aaf4' + '4c03d1' + '4d0fafc0' + 'c5fc100c87' + 'c4e27da80c86' + 'c5fc110c86'
  + 'f3480fb80cc7' + '4801ca' + 'f2480f38f104cf' + '660f6f0f' + '660f74c8' + '660fd7c1' + '488b00' + 'c4626db8c0' + '4839d0'
  + '4883c708' + '4c8d0c49' + '48c1e005' + '4421c0' + 'c5f857c0' + '488d0c0a';
export const WARM_HEX = WARM_MIX.repeat(20) + '49ffcf' + '0f853bf8ffff'; // dec r15; jnz to the start
