// The built-in examples' machine code (examples.js: the same source as the command line's examples) as the assembler's
// answer for their text, so that an example's result can be shown before the assembler (wuica_asm.wasm, the largest
// download of a first visit) has loaded: app.js loads it in the background after the first result.
//
// An example's text goes through every step it goes through with the assembler (asm-regions.js, assembleMarked: loop
// finding, marked regions, notes); only the assembler's own call is answered, with the example's bytes. Where the steps
// would call it more than once (labels added for a marked region or .loc lines, then the plain text), nothing is
// answered and the assembler is needed. tests-js/web_asm_shipped.mjs assembles every example both ways: the same
// result and the same analysis.
import { assembleMarked } from './asm-regions.js';
import { hexToBytes } from './hex-input.js';

// The examples whose machine code is not what their text assembles to (another encoding of the same instruction: 'avx'
// has the corpus's `4c 03 d1` for `add r10, rcx`, the assembler writes `49 01 ca`): never answered.
// tests-js/web_asm_shipped.mjs checks that this is exactly the list.
export const NOT_AS_ASSEMBLED = new Set(['avx']);

// examples: [{id, hex, text: {intel, att}}]. Returns shipped(text, syntax, loop): a promise of assembleMarked's result for
// that text (as with the assembler), or of null (not an example's text, another loop picked, or not answerable).
export function createShipped(examples) {
  const memo = new Map();
  return async function shipped(text, syntax, loop = 'auto') {
    if (loop !== 'auto' || (syntax !== 'intel' && syntax !== 'att')) return null;
    const ex = examples.find((e) => typeof e.hex === 'string' && e.hex !== '' && e.text?.[syntax] === text && !NOT_AS_ASSEMBLED.has(e.id));
    if (!ex) return null;
    const key = `${syntax}\n${text}`;
    if (!memo.has(key)) {
      memo.set(key, (async () => {
        const bytes = hexToBytes(ex.hex);
        let calls = 0;
        const r = await assembleMarked(async () => { calls++; return { ok: true, bytes: bytes.slice(), diagnostics: [] }; }, text, { loop: 'auto' });
        return calls === 1 && r.ok ? r : null;
      })());
    }
    const r = await memo.get(key);
    return r ? { ...r, bytes: r.bytes.slice(), diagnostics: [...r.diagnostics] } : null;
  };
}
