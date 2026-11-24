// Mock analyzer with the interface of WasmEngine (engine.js), used with ?mock=1: for work on the page without
// the analyzer. It returns recorded results of the Python reference for the built-in examples (mock-data.js)
// and, for any other input, one of those results as a stand-in. Every response carries a `mock` field that says
// which, so that the page can label it; the real engine never sets it.

import { RECORDED } from './mock-data.js';

const URL_PREFIX = 'https://www.uops.info/html-instr/';

function expand(c) {
  const r = structuredClone(c.response);
  r.text = r.text.replace(/(.)~(\d+)~/gsu, (_, ch, n) => ch.repeat(Number(n)));
  for (const row of r.rows) if (row.url) row.url = URL_PREFIX + row.url;
  return { hex: c.hex, source: c.source, response: r };
}

// Not a uiCA result. A hand-written response that contains everything the page has to render and that the
// recorded cases lack: register-merge and stack-sync rows, the notes J and X, the divider column, an unrolled
// block, a fractional throughput, and a position that could not be decoded (the byte 06).
export const SYNTHETIC_HEX = '48f7f188dc4801c8500f0b4839d874000690';
const SYNTHETIC = {
  hex: SYNTHETIC_HEX,
  source: 'synthetic',
  response: {
    arch: 'SKL', tp: 23.57, mode: 'unroll', decodeErrors: 1,
    bottlenecks: ['Dependencies', 'Ports'],
    limits: [
      { name: 'Predecoder', tp: 2.25 }, { name: 'Decoder', tp: 4.0 }, { name: 'Issue', tp: 4.5 },
      { name: 'Ports', tp: 21.0 }, { name: 'Dependencies', tp: 23.0 },
    ],
    columns: ['MITE', 'MS', 'DSB', 'LSD', 'Issued', 'Exec.', 'Port 0', 'Port 1', 'Port 2', 'Port 3', 'Port 4', 'Port 5', 'Port 6', 'Port 7', 'Div'],
    rows: [
      { kind: 'instr', label: 'div rcx', opcode: '48F7F1', instrStr: 'DIV (R64)', url: URL_PREFIX + 'DIV_R64.html', notes: '', values: [4, 6, 0, 0, 10, 10, 3.5, 2.25, 0, 0, 0, 2.5, 1.75, 0, 21] },
      { kind: 'instr', label: 'mov ah, bl', opcode: '88DC', instrStr: 'MOV_88 (R8h, R8l)', url: URL_PREFIX + 'MOV_88_R8h_R8l.html', notes: '', values: [1, 0, 0, 0, 1, 1, 0.25, 0.25, 0, 0, 0, 0.25, 0.25, 0, 0] },
      { kind: 'regMerge', label: '<Register Merge Uop>', notes: '', values: [0, 0, 0, 0, 1, 1, 0.5, 0.25, 0, 0, 0, 0.25, 0, 0, 0] },
      { kind: 'instr', label: 'add rax, rcx', opcode: '4801C8', instrStr: 'ADD_01 (R64, R64)', url: URL_PREFIX + 'ADD_01_R64_R64.html', notes: '', values: [1, 0, 0, 0, 1, 1, 0.25, 0.25, 0, 0, 0, 0.25, 0.25, 0, 0] },
      { kind: 'stackSync', label: '<Stack Sync Uop>', notes: '', values: [0, 0, 0, 0, 1, 1, 0.25, 0.25, 0, 0, 0, 0.25, 0.25, 0, 0] },
      { kind: 'instr', label: 'push rax', opcode: '50', instrStr: 'PUSH (R64)', url: URL_PREFIX + 'PUSH_R64.html', notes: '', values: [1, 0, 0, 0, 1, 2, 0, 0, 0.33, 0.33, 1, 0, 0, 0.34, 0] },
      { kind: 'instr', label: 'ud2', opcode: '0F0B', instrStr: '', url: null, notes: 'X', values: [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'instr', label: 'cmp rax, rbx', opcode: '4839D8', instrStr: 'CMP_39 (R64, R64)', url: URL_PREFIX + 'CMP_39_R64_R64.html', notes: 'J', values: [1, 0, 0, 0, 1, 1, 0.5, 0, 0, 0, 0, 0, 0.5, 0, 0] },
      { kind: 'instr', label: 'jz 0x2', opcode: '7400', instrStr: 'JZ (Rel8)', url: URL_PREFIX + 'JZ_Rel8.html', notes: 'M', values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'instr', label: 'nop', opcode: '90', instrStr: 'NOP', url: URL_PREFIX + 'NOP.html', notes: '', values: [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    ],
    text: 'Synthetic mock response: not a uiCA report.\n\nIt exists to exercise the page: register-merge and stack-sync uops, the notes J, M and X,\nthe divider column, an unrolled block and a position that could not be decoded.\n',
    trace: null,
  },
};

// Machine code for which the mock answers with an error response instead of a result.
export const MOCK_ERROR_HEX = '0f0b';

const CASES = [...RECORDED.map(expand), SYNTHETIC];

// Machine code that is another encoding of a recorded block (the same instructions): answered with that block's result.
// examples.js 'avx' ships the assembler's `49 01 ca` for `add r10, rcx`; the corpus's block has `4c 03 d1`.
const SAME_AS = new Map([['c4e2d5aaf44901ca4d0fafc049ffcf75ef', 'c4e2d5aaf44c03d14d0fafc049ffcf75ef']]);

export function recordedCases() {
  return CASES.map((c) => ({ hex: c.hex, arch: c.response.arch, source: c.source }));
}

export class MockEngine {
  #configs = null;
  #archs = new Set();
  capabilities = Object.freeze({ decode: false, analyze: true, mock: true });

  async loadUarch(json) {
    const text = typeof json === 'string' ? json : new TextDecoder().decode(json);
    let u;
    try { u = JSON.parse(text); } catch { throw new Error('uarch.json: invalid JSON'); }
    if (!u?.configs) throw new Error('uarch.json: no configurations');
    this.#configs = u.configs;
  }

  async loadArch(name, _json) { this.#archs.add(name); }
  hasUarch() { return this.#configs !== null; }
  hasArch(name) { return this.#archs.has(name); }

  async decode(_code, _chip) { return { error: 'the mock has no decoder' }; }

  // The same failures as the specification lists, then a canned response.
  async analyze(request) {
    const given = String(request?.hex ?? '').toLowerCase();
    const hex = SAME_AS.get(given) ?? given;
    const arch = request?.arch;
    if (!this.#configs) return { error: 'uarch.json has not been loaded' };
    const cfg = this.#configs[arch];
    if (!cfg) return { error: `unknown configuration: ${arch}` };
    if (!this.#archs.has(cfg.name)) return { error: `the instruction table ${cfg.name} has not been loaded` };
    if (hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) return { error: 'hex: invalid machine code' };
    if (hex === '') return { error: 'no instructions' };
    if (hex === MOCK_ERROR_HEX) return { error: 'mock: this input always fails (it is here to show an analysis error)' };

    let c = CASES.find((x) => x.hex === hex && x.response.arch === arch);
    const exact = !!c;
    if (!c) c = CASES.find((x) => x.hex === hex); // the same code, recorded for another microarchitecture
    if (!c) c = CASES.find((x) => x.response.arch === arch) ?? CASES[0];
    const r = structuredClone(c.response);
    r.mock = {
      exact,                                  // true: the reference's result for exactly this code and microarchitecture
      synthetic: c.source === 'synthetic',    // hand-written, not a result of the reference
      source: c.source,
      hex: c.hex,
      arch: c.response.arch,
      optionsIgnored: true,
    };
    if (request.includeTrace) r.trace = null; // the mock has no traces
    return r;
  }
}
