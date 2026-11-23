// Stand-in for the assembler (assembler.js) in mock mode (?mock=1) when wuica_asm.wasm is not there: it knows
// the built-in examples and reports every other line as an error, which is enough to work on the page.

import { EXAMPLES, MOCK_EXAMPLES } from './examples.js';
import { hexToBytes } from './hex-input.js';

const norm = (line) => line.replace(/(#|\/\/).*$/, '').trim().replace(/\s+/g, ' ');
const normText = (text) => text.split('\n').map(norm).filter((l) => l !== '').join('\n');

export class MockAssembler {
  mock = true;

  async assemble(text, syntax = 'intel') {
    const all = [...EXAMPLES, ...MOCK_EXAMPLES];
    const want = normText(text);
    const hit = all.find((e) => normText(e.text[syntax]) === want);
    if (hit) return { ok: true, bytes: hexToBytes(hit.hex), diagnostics: [] };
    const known = new Set(all.flatMap((e) => e.text[syntax].split('\n').map(norm)));
    const diagnostics = [];
    text.split('\n').forEach((l, i) => {
      const n = norm(l);
      if (n !== '' && !known.has(n)) {
        diagnostics.push({ line: i + 1, column: l.length - l.trimStart().length + 1, severity: 'error', message: 'mock assembler: only the built-in examples can be assembled' });
      }
    });
    if (diagnostics.length === 0) {
      diagnostics.push({ line: null, column: null, severity: 'error', message: 'mock assembler: only the built-in examples can be assembled, unchanged' });
    }
    return { ok: false, diagnostics };
  }
}
