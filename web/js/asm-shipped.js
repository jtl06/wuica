// The built-in examples' machine code (examples.js: the same source as the command line's examples) as the assembler's
// answer for their text, so that an example's result can be shown before the assembler (wuica_asm.wasm, the largest
// download of a first visit) has loaded: app.js loads it in the background after the first result.
//
// An example's text goes through every step it goes through with the assembler (asm-regions.js, assembleMarked: loop
// finding, marked regions, notes); only the assembler's own call is answered, with the example's bytes. Where the steps
// would call it more than once (labels added for a marked region or .loc lines, then the plain text), nothing is
// answered and the assembler is needed. Every example's machine code is what its text assembles to (examples.js);
// tests-js/web_asm_shipped.mjs assembles every example both ways: the same bytes, the same result and the same analysis.
import { assembleMarked } from './asm-regions.js';
import { hexToBytes } from './hex-input.js';
import { LEGACY_AUTO } from './loop-find.js';

// examples: [{id, hex, text: {intel, att}}]. Returns shipped(text, syntax, loop): a promise of assembleMarked's result for
// that text (as with the assembler), or of null (not an example's text, another loop picked, or not answerable).
export function createShipped(examples) {
  const memo = new Map();
  return async function shipped(text, syntax, loop = 'auto') {
    if ((loop !== 'auto' && loop !== LEGACY_AUTO) || (syntax !== 'intel' && syntax !== 'att')) return null;
    const ex = examples.find((e) => typeof e.hex === 'string' && e.hex !== '' && e.text?.[syntax] === text);
    if (!ex) return null;
    const key = `${syntax}\n${loop}\n${text}`;
    if (!memo.has(key)) {
      memo.set(key, (async () => {
        const bytes = hexToBytes(ex.hex);
        let calls = 0;
        const r = await assembleMarked(async () => { calls++; return { ok: true, bytes: bytes.slice(), diagnostics: [] }; }, text, { loop });
        return calls === 1 && r.ok ? r : null;
      })());
    }
    const r = await memo.get(key);
    return r ? { ...r, bytes: r.bytes.slice(), diagnostics: [...r.diagnostics] } : null;
  };
}
