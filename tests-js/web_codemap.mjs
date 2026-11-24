// Tests of the code layout map's data side (web/js/codemap.js): instruction positions on the cache lines at an alignment
// offset, the boundary crossings, the tones of macro-fused pairs; with the real analyzer (if built), every example at every
// offset against positions this test computes from the examples' objdump listings, and the JCC-erratum marks against the
// notes of the uop table.
// Usage: node tests-js/web_codemap.mjs
import fs from 'node:fs';
import { codeMapModel } from '../web/js/codemap.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { encodeState, decodeState } from '../web/js/url-state.js';
import { tableBytes } from './tables.mjs'; // the binary tables (the module reads no JSON tables)

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);

const instr = (label, opcode, notes = '') => ({ kind: 'instr', label, opcode, notes, values: [] });
const CHAIN_HEX = '4883c0014883c00149ffcf75f3';
const CHAIN = { rows: [{ kind: 'regMerge', label: '<Register Merge Uop>', notes: '', values: [] }, instr('add rax, 0x1', '4883C001'), instr('add rax, 0x1', '4883C001'), instr('dec r15', '49FFCF'), instr('jnz 0x0', '75F3', 'M')] };

{
  const m = codeMapModel(CHAIN, CHAIN_HEX, 0);
  check(m.bytes === 13 && m.offset === 0 && m.lines.length === 1 && m.lines[0].addr === 0, 'one line at offset 0');
  check(m.instrs.map((i) => `${i.row}:${i.start}-${i.end}`).join() === '1:0-4,2:4-8,3:8-11,4:11-13', 'instructions: rows of the table (inserted uops skipped), byte ranges', JSON.stringify(m.instrs));
  check(m.instrs.map((i) => i.tone).join() === '0,1,0,0' && m.instrs[3].fused, 'tones alternate; a macro-fused pair shares one');
  check(m.lines[0].segs.map((s) => `${s.i}:${s.from}-${s.to}`).join() === '0:0-4,1:4-8,2:8-11,3:11-13', 'segments of the line');
  check(m.counts.cross16 === 0 && m.counts.cross32 === 0 && m.counts.cross64 === 0, 'no crossings at offset 0');

  const s = codeMapModel(CHAIN, CHAIN_HEX, 58);
  check(s.lines.length === 2 && s.lines[1].addr === 64 && s.instrs[1].start === 62 && s.instrs[1].cross64 && s.instrs[1].cross32 && s.instrs[1].cross16, 'offset 58: the second add is split across the cache lines', JSON.stringify(s.instrs[1]));
  check(s.lines[0].segs.map((x) => `${x.i}:${x.from}-${x.to}`).join() === '0:58-62,1:62-64' && s.lines[1].segs.map((x) => `${x.i}:${x.from}-${x.to}`).join() === '1:0-2,2:2-5,3:5-7', 'offset 58: the segments on both lines', JSON.stringify(s.lines));
  check(s.counts.cross64 === 1 && s.counts.cross16 === 1, 'offset 58: counts');
  const t = codeMapModel(CHAIN, CHAIN_HEX, 14);
  check(t.instrs[0].cross16 && !t.instrs[0].cross32 && t.counts.cross16 === 1, 'offset 14: the first add crosses a 16-byte boundary only');
  check(codeMapModel(CHAIN, CHAIN_HEX, 99).offset === 63 && codeMapModel(CHAIN, CHAIN_HEX, -3).offset === 0, 'the offset is clamped to 0–63');
  check(codeMapModel(CHAIN, CHAIN_HEX + '06', 0) === null && codeMapModel({ error: 'x' }, CHAIN_HEX) === null, 'no map for bytes that are not instructions, or errors');
  check(codeMapModel({ rows: [instr('jz', '7400', 'J')] }, '7400', 0).instrs[0].jcc, 'note J: marked');
  const f = encodeState({ text: 'x', codemap: true });
  check(/(^|&)codemap=1(&|$)/.test(f) && decodeState(f).codemap === true && decodeState(encodeState({ text: 'x' })).codemap === false, 'url: codemap=1');
}

const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(wasm) || !fs.existsSync(new URL('data/uarch.json', root))) {
  console.log('(analyzer or data/ missing: only the hand-written cases)');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  await e.loadArch('SKL', tableBytes('SKL'));
  let jccSeen = 0;
  for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
    const lens = ex.text.hex.trimEnd().split('\n').map((l) => l.split(/:\s+/)[1].split(/\s{2,}/)[0].split(' ').length);
    const total = lens.reduce((a, b) => a + b, 0);
    for (let off = 0; off < 64; off++) {
      const r = await e.analyze(makeRequest(ex.hex, 'SKL', { alignmentOffset: off }));
      const m = codeMapModel(r, ex.hex, off);
      let at = off, ok = !!m && m.bytes === total && m.lines.length === Math.floor((off + total - 1) / 64) + 1;
      lens.forEach((n, k) => {
        const ins = m?.instrs[k];
        const cross = (b) => Math.floor(at / b) !== Math.floor((at + n - 1) / b);
        ok &&= !!ins && ins.start === at && ins.end === at + n && ins.cross16 === cross(16) && ins.cross32 === cross(32) && ins.cross64 === cross(64);
        at += n;
      });
      ok &&= m.lines.reduce((s, l) => s + l.segs.reduce((t, x) => t + x.to - x.from, 0), 0) === total;
      const jRows = r.rows.map((x, i) => (x.notes === 'J' ? i : -1)).filter((i) => i >= 0);
      ok &&= m.instrs.filter((x) => x.jcc).map((x) => x.row).join() === jRows.join();
      jccSeen += jRows.length;
      check(ok, `${ex.id} at offset ${off}: positions, crossings, JCC marks`, JSON.stringify(m?.instrs));
    }
  }
  check(jccSeen > 0, 'some example hits the JCC erratum at some offset', String(jccSeen));
}

console.log(`${count} code map checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
