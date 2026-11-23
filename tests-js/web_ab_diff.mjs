// Tests of the A–B comparison (web/js/ab-diff.js): instruction matching, the alignment of two uop tables, and the
// comparison of two responses; with the real analyzer if it is built.  Usage: node tests-js/web_ab_diff.mjs
import fs from 'node:fs';
import {
  normalizeInstr, instructionUnits, lcsPairs, alignUnits, compareResponses, diffTables, sharedColumns, signed, verdict,
} from '../web/js/ab-diff.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { DEFAULT_STATE, encodeState, decodeState } from '../web/js/url-state.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const j = (x) => JSON.stringify(x);
const root = new URL('../', import.meta.url);

// --- matching instructions ---------------------------------------------------------------------------------------------
check(normalizeInstr('jnz 0xfffffffffffffff5').key === normalizeInstr('jnz 0xfffffffffffffff2').key && normalizeInstr('jnz 0xfff5').key !== normalizeInstr('jz 0xfff5').key, 'branch targets do not matter, the condition does');
check(normalizeInstr('jne    10 <sum(int const*, int)+0x10>').key === 'jne →' && normalizeInstr('call 0x1234').key === 'call →', 'objdump-style targets and calls');
check(normalizeInstr('jmp rax').key === 'jmp rax' && normalizeInstr('call qword ptr [rip+0x10]').key === 'call qword ptr [rip+0x10]', 'indirect branches keep their operand');
check(normalizeInstr('ADD  RAX,  0x1').key === 'add rax, 0x1' && normalizeInstr('lock add qword ptr [rdi], 1').mnemonic === 'add' && normalizeInstr('rep movsb').mnemonic === 'movsb', 'case, spacing and prefixes');

check(j(lcsPairs(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd'])) === j([[0, 0], [2, 2], [3, 3]]), 'lcs: one replaced');
check(j(lcsPairs([], ['a'])) === '[]' && j(lcsPairs(['a', 'b'], ['b', 'a'])).length > 2, 'lcs: edge cases');
check(j(lcsPairs(['p', 'a', 'b', 's'], ['p', 'b', 'a', 's'], 1)) === j([[0, 0], [3, 3]]), 'lcs: past the size limit only prefix and suffix are matched');

// --- alignment ------------------------------------------------------------------------------------------------------------
const COLS = ['MITE', 'MS', 'DSB', 'LSD', 'Issued', 'Exec.', 'Port 0', 'Port 1', 'Port 5', 'Port 6'];
const instr = (label, ports, extra = {}) => ({ kind: 'instr', label, notes: extra.notes ?? '', values: [0, 0, 1, 0, extra.uops ?? 1, extra.uops ?? 1, ...ports] });
const resp = (rows, extra = {}) => ({ arch: 'SKL', tp: 1, mode: 'loop', decodeErrors: 0, bottlenecks: ['Ports'], limits: [{ name: 'Ports', tp: 1 }], columns: COLS, rows, text: '', ...extra });
{
  const A = resp([
    instr('mov rax, qword ptr [rdi]', [0, 0, 0, 0]),
    instr('imul rax, rbx', [0, 1, 0, 0]),
    instr('add rcx, rax', [0.5, 0, 0.5, 0]),
    { kind: 'regMerge', label: '<Register Merge Uop>', values: [0, 0, 0, 0, 1, 1, 0.5, 0.5, 0, 0] },
    instr('add rdx, 1', [0.25, 0.25, 0.25, 0.25]),
    instr('dec r15', [0, 0, 0, 1]),
    instr('jnz 0xffffffffffffffe0', [0, 0, 0, 0], { notes: 'M', uops: 0 }),
  ]);
  const B = resp([
    instr('mov rax, qword ptr [rdi]', [0, 0, 0, 0]),
    instr('lea rax, [rax+rax*2]', [0, 0.5, 0.5, 0]),
    instr('add rcx, rax', [0, 0, 1, 0]),
    instr('add rdx, 2', [0.25, 0.25, 0.25, 0.25]),
    instr('prefetcht0 byte ptr [rdi+0x40]', [0, 0, 0, 0]),
    instr('dec r15', [0, 0, 0, 1]),
    instr('jnz 0xffffffffffffffd8', [0, 0, 0, 0], { notes: 'M', uops: 0 }),
  ]);
  const ua = instructionUnits(A);
  check(ua.length === 6 && j(ua[3].extras) === j(['regMerge']) && ua[3].values[4] === 2 && ua[3].values[6] === 0.75, 'extra uops belong to the instruction after them', j(ua[3]));
  const al = alignUnits(ua, instructionUnits(B));
  check(j(al.map((x) => x.op)) === j(['same', 'removed', 'added', 'same', 'modified', 'added', 'same', 'same']), 'alignment: same / removed+added (other mnemonic) / modified (same mnemonic) / added', j(al));

  const d = diffTables(A, B);
  check(j(d.rows.map((r) => r.status)) === j(['same', 'removed', 'added', 'changed', 'modified', 'added', 'same', 'same']), 'diff: statuses (same text, other ports = changed)', j(d.rows.map((r) => r.status)));
  check(d.portsComparable && j(d.columns.map((c) => c.name)) === j(['Issued', 'Port 0', 'Port 1', 'Port 5', 'Port 6']), 'diff: compared columns (uops and the ports in use)', j(d.columns.map((c) => c.name)));
  const changed = d.rows[3];
  check(j(changed.deltas) === j([0, -0.5, 0, 0.5, 0]), 'diff: port deltas of a changed instruction (B − A)', j(changed.deltas));
  const modified = d.rows[4];
  check(modified.a.label === 'add rdx, 1' && modified.b.label === 'add rdx, 2' && j(modified.deltas) === j([-1, -0.5, -0.5, 0, 0]), 'diff: a modified instruction loses the merge uop of A', j(modified.deltas));
  check(j(d.rows[1].deltas) === j([-1, 0, -1, 0, 0]) && j(d.rows[2].deltas) === j([1, 0, 0.5, 0.5, 0]), 'diff: removed and added rows', j([d.rows[1].deltas, d.rows[2].deltas]));
  check(j(d.totals) === j([0, -1, -1, 1, 0]) && j(d.counts) === j({ same: 3, changed: 1, modified: 1, added: 2, removed: 1 }), 'diff: totals and counts', j([d.totals, d.counts]));

  // the comparison
  const c = compareResponses({ ...A, tp: 2, bottlenecks: ['Dependencies'], limits: [{ name: 'Ports', tp: 1.5 }, { name: 'Dependencies', tp: 2 }] },
    { ...B, tp: 1.5, bottlenecks: ['Ports'], limits: [{ name: 'Ports', tp: 1.5 }, { name: 'Dependencies', tp: 1 }, { name: 'LSD', tp: 1.25 }] });
  check(c.okA && c.okB && c.tp.delta === -0.5 && c.tp.pct === -25 && Math.abs(c.tp.speedup - 4 / 3) < 1e-9 && c.tp.verdict === 'better', 'compare: Δ, percent, speedup, verdict', j(c.tp));
  check(!c.bottlenecks.same && j(c.bottlenecks.gone) === j(['Dependencies']) && j(c.bottlenecks.new) === j(['Ports']), 'compare: bottleneck change', j(c.bottlenecks));
  check(j(c.limits.map((l) => [l.name, l.a, l.b, l.delta])) === j([['Ports', 1.5, 1.5, 0], ['Dependencies', 2, 1, -1], ['LSD', null, 1.25, null]]) && c.limits[1].bottleneckA && c.limits[0].bottleneckB, 'compare: limits of both (also those of one side only)', j(c.limits));
  const unrolled = compareResponses({ ...A, tp: 2 }, { ...B, tp: 3.5 }, { scale: 2 });
  check(unrolled.tp.b === 1.75 && unrolled.tp.bRaw === 3.5 && unrolled.tp.delta === -0.25 && unrolled.tp.verdict === 'better', 'compare: B unrolled ×2 is compared per iteration of A', j(unrolled.tp));
  // elements per iteration: A does 8, B does 32; both per element (limits too)
  const work = compareResponses({ ...A, tp: 4, limits: [{ name: 'Ports', tp: 4 }] }, { ...B, tp: 8, limits: [{ name: 'Ports', tp: 8 }] }, { workA: 8, workB: 32 });
  check(work.tp.a === 0.5 && work.tp.b === 0.25 && work.tp.aRaw === 4 && work.tp.bRaw === 8 && work.tp.speedup === 2 && work.tp.verdict === 'better' && work.perElement && work.scale === 4
    && work.limits[0].a === 0.5 && work.limits[0].b === 0.25, 'compare: per element (8 and 32 elements per iteration)', j([work.tp, work.limits]));
  check(!compareResponses(A, B).perElement && compareResponses(A, B, { workA: 2, workB: 2 }).perElement, 'compare: per element only when given');
  check(compareResponses({ ...A, tp: 2 }, { ...B, tp: 2.004 }).tp.verdict === 'same' && verdict(0.01) === 'worse', 'compare: differences below 0.005 are none');
  const failedB = compareResponses(A, { error: 'no instructions found' });
  check(failedB.okA && !failedB.okB && failedB.tp === null && failedB.diff === null, 'compare: one side failed', j(failedB));
  check(compareResponses(null, B).okB && !compareResponses(null, B).okA, 'compare: one side missing');

  // different microarchitectures: no per-port comparison
  const zen = resp(B.rows.map((r) => ({ ...r, values: [...r.values.slice(0, 6), 0, 0, 0, 0, 0] })), { columns: [...COLS.slice(0, 6), 'ALU0', 'ALU1', 'ALU2', 'ALU3', 'AGU0'] });
  const dz = diffTables(A, zen);
  check(!dz.portsComparable && j(dz.columns.map((c) => c.name)) === j(['Issued']) && sharedColumns(A, zen).length === 6, 'diff: SKL vs ZEN3 compares only the uop counts', j(dz.columns));

  check(signed(0.25) === '+0.25' && signed(-1) === '−1' && signed(0.001) === '' && signed(-0.333) === '−0.33', 'signed numbers');
}

// --- the A–B state in the URL fragment ------------------------------------------------------------------------------------
{
  const single = { ...DEFAULT_STATE, mode: 'hex', text: '48 01 d8', arch: 'ZEN3', bText: 'ignored', bMode: 'asm' };
  check(encodeState(single) === 'v=1&a=ZEN3&c=NDggMDEgZDg', 'url: a single-mode link is as before (B is left out)', encodeState(single));
  check(j(decodeState('v=1&a=ZEN3&c=NDggMDEgZDg')) === j({ ...DEFAULT_STATE, mode: 'hex', text: '48 01 d8', arch: 'ZEN3' }), 'url: old links decode as before (hex)');
  const s = { ...DEFAULT_STATE, ab: true, text: 'add rax, 1\n', mode: 'asm', bMode: 'asm', bSyntax: 'att', bArch: 'ADL-P', bText: 'loop:\n  addq $2, %rax ✓\n', aWork: 8, bWork: 32 };
  const f = encodeState(s);
  check(/^[A-Za-z0-9=&_-]+$/.test(f) && f.includes('&ab=1&bm=asm&bs=att&ba=ADL-P&aw=8&bw=32&bc='), 'url: side B in the fragment', f);
  check(j(decodeState(f)) === j(s), 'url: round trip of both sides', j(decodeState(f)));
  check(decodeState('v=1&ab=1&bm=x&bs=y&ba=%3Cx%3E&bk=999&bc=!!').bWork === 64 && decodeState('v=1&ab=1&aw=0&bw=99999999').bWork === 65536 && j(decodeState('v=1&ab=1&bm=x&bs=y&ba=%3Cx%3E&bk=0&aw=x&bc=!!')) === j({ ...DEFAULT_STATE, mode: 'hex', ab: true, bMode: 'hex' }), 'url: bad B values fall back to the defaults');
  check(decodeState('v=1&ab=1&bk=4').bWork === 4 && decodeState('v=1&ab=1&bk=4').aWork === 1, 'url: an older link\'s B unrolled ×4 is B doing 4 elements per iteration of A');
  check(decodeState('v=1&bm=asm&bc=eA').bText === '' && !decodeState('v=1&bm=asm').ab, 'url: B is only read in A–B mode');
}

// --- with the real analyzer: a block against itself with one change ------------------------------------------------------
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (fs.existsSync(wasm) && fs.existsSync(new URL('data/uarch.json', root))) {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  for (const t of ['SKL', 'ZEN3']) await e.loadArch(t, fs.readFileSync(new URL(`data/arch/${t}.json`, root)));
  const chain = '4883c0014883c00149ffcf75f3';          // add rax,1; add rax,1; dec r15; jnz
  const better = '4883c00249ffcf75f7';                  // add rax,2; dec r15; jnz
  const a = await e.analyze(makeRequest(chain, 'SKL')), b = await e.analyze(makeRequest(better, 'SKL'));
  const c = compareResponses(a, b);
  check(c.tp.a === 2 && c.tp.b === 1 && c.tp.delta === -1 && c.tp.pct === -50 && c.tp.verdict === 'better', 'real: one add instead of two halves the cycles', j(c.tp));
  check(j(c.diff.rows.map((r) => r.status)) === j(['modified', 'removed', 'same', 'same']) && c.diff.counts.removed === 1, 'real: the diff of the two blocks', j(c.diff.rows.map((r) => [r.status, r.a?.label, r.b?.label])));
  const self = compareResponses(a, await e.analyze(makeRequest(chain, 'SKL')));
  check(self.tp.verdict === 'same' && self.diff.rows.every((r) => r.status === 'same') && self.bottlenecks.same, 'real: a block against itself is the same');
  const z = compareResponses(a, await e.analyze(makeRequest(chain, 'ZEN3')));
  check(!z.diff.portsComparable && z.diff.rows.length === 4 && z.diff.rows.every((r) => r.a && r.b), 'real: SKL vs ZEN3 aligns all instructions', j(z.diff.rows.map((r) => r.status)));
} else {
  console.log('the analyzer or data/ is missing: the checks with the real analyzer are skipped');
}

console.log(`${count} A–B checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
