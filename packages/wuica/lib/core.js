// The result shapes that the library's main thread and its worker threads (threads.js) both build, so that a compare()
// gives the same rows whichever thread analyzed a microarchitecture.

/** Result codes (`code`), like an exit status: 0 = success. */
export const CODES = Object.freeze({ OK: 0, REQUEST: 1, ASSEMBLER: 2, ANALYSIS: 3 });

// A failed call: {code, error, stderr}, stderr as in Compiler Explorer (one entry per line, `tag` on positioned ones).
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
export function compareFields(r) {
  if (r.code !== undefined) return { code: r.code, error: r.error };
  return { code: CODES.OK, tp: r.tp, mode: r.mode, bottlenecks: r.bottlenecks, decodeErrors: r.decodeErrors };
}
