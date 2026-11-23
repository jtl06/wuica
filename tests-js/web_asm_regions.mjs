// Tests of marked regions and .loc lines of pasted assembly (web/js/asm-regions.js): the plan (no assembler), and with
// the real assembler (assembler/dist/wuica_asm.wasm) the bytes of the region, the source lines of .loc and the
// diagnostics; with the analyzer (if built) the cost per source line (srcmap.js) of a pasted -g -S listing.
// Usage: node tests-js/web_asm_regions.mjs
import fs from 'node:fs';
import { planMarked, assembleMarked, withRegions, spanLines, readTrailer } from '../web/js/asm-regions.js';
import { WasmAssembler } from '../web/js/assembler.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { srcModel } from '../web/js/srcmap.js';
import { EXAMPLES, SHOWCASE_EXAMPLES } from '../web/js/examples.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const hex = (b) => [...(b ?? [])].map((x) => x.toString(16).padStart(2, '0')).join('');

// --- the plan, without an assembler -------------------------------------------------------------------------------------
{
  check(planMarked('add rax, 1\ndec rcx\njne .L1\n') === null, 'no markers: no plan');
  check(planMarked('mov eax, 111\nret\n') === null, 'an immediate 111 without the IACA bytes: no plan');
  for (const ex of [...EXAMPLES, ...(SHOWCASE_EXAMPLES ?? [])]) {
    for (const t of Object.values(ex.text ?? {})) {
      const t0 = performance.now();
      const p = planMarked(t);
      const ms = performance.now() - t0;
      check(p === null, `example ${ex.name ?? ex.id}: no plan`);
      check(ms < 50, `example ${ex.name ?? ex.id}: the scan is cheap`, `${ms.toFixed(1)} ms`);
    }
  }
  const p = planMarked('  mov rcx, 9\n# LLVM-MCA-BEGIN hot\n.L1:\n  add rax, 1\n  dec rcx\n  jne .L1\n# LLVM-MCA-END hot\n  ret\n');
  const lines = p.text.split('\n');
  check(p.regions.length === 1 && p.region.name === 'hot' && p.region.line === 2, 'llvm-mca markers: one named region at line 2', JSON.stringify(p.regions));
  check(lines[1] === '' && lines[3] === '  .Lwuica_0: add rax, 1' && lines[6] === '.Lwuica_1:' && p.lineCount === 9, 'the begin label at the first instruction, the end label on the END line, no line added', JSON.stringify(lines.slice(0, 8)));
  check(/\.Lwuica_z:\n\.long 2004183395\n\.long \.Lwuica_z-\.Lwuica_0, \.Lwuica_z-\.Lwuica_1\n$/.test(p.text), 'the trailer', p.text.slice(-90));
  // a long listing scans in linear time
  const big = Array.from({ length: 40000 }, (_, k) => (k % 3 ? `  add rax, ${k}` : `  .loc 1 ${k} 3`)).join('\n');
  const t0 = performance.now();
  const pb = planMarked(`.file 1 "x.c"\n${big}\n`);
  check(pb.locs.length > 13000 && performance.now() - t0 < 300, '40000 lines: fast', `${(performance.now() - t0).toFixed(0)} ms`);
  // spanLines on rows
  const rows = [{ kind: 'instr', opcode: '4883c001' }, { kind: 'regMerge' }, { kind: 'instr', opcode: '48ffc9' }, { kind: 'instr', opcode: '75f7' }];
  check(spanLines(rows, [{ off: 0, line: 4 }, { off: 4, line: 3 }, { off: 7, line: null }]).join() === '4,3,', 'spanLines: by offset', spanLines(rows, [{ off: 0, line: 4 }, { off: 4, line: 3 }, { off: 7, line: null }]).join());
  check(spanLines(rows, [{ off: 4, line: 3 }]).join() === ',3,3', 'spanLines: before the first .loc: no line');
  check(readTrailer(p, new Uint8Array([1, 2, 3])) === null, 'no trailer (the mock assembler): null');
}

// --- with the real assembler -----------------------------------------------------------------------------------------------
const asmPath = new URL('assembler/dist/wuica_asm.wasm', root);
if (!fs.existsSync(asmPath)) {
  console.log('(the assembler is missing: only the plan)');
} else {
  const wa = await WasmAssembler.create(fs.readFileSync(asmPath));
  const A = withRegions(wa);
  const plain = async (t, s = 'intel') => hex((await wa.assemble(t, s)).bytes);
  const LOOP = '  add rax, 1\n  dec rcx\n  jne .L1\n';
  const loopHex = (await wa.assemble(`.L1:\n${LOOP}`, 'intel')).bytes;

  // comment markers, # // ;, Intel and AT&T
  for (const c of ['#', '//', ';']) {
    const t = `  mov rcx, 100\n  xor eax, eax\n${c} LLVM-MCA-BEGIN\n.L1:\n${LOOP}${c} LLVM-MCA-END\n  ret\n`;
    const r = await A.assemble(t, 'intel');
    check(r.ok && hex(r.bytes) === hex(loopHex) && r.region?.count === 1 && r.region.line === 3, `llvm-mca markers with ${c}: the loop's bytes`, JSON.stringify(r.diagnostics) + hex(r.bytes));
  }
  {
    const t = '  movq $100, %rcx\n# LLVM-MCA-BEGIN att\n.L1:\n  addq $1, %rax\n  decq %rcx\n  jne .L1\n# LLVM-MCA-END\n  ret\n';
    const r = await A.assemble(t, 'att');
    check(r.ok && hex(r.bytes) === hex(loopHex) && r.region.name === 'att', 'AT&T: the loop\'s bytes', hex(r.bytes));
  }
  // the back-branch goes to a label outside the region, and a long jump across the marker keeps its encoding
  {
    const t = `.L1:\n  .p2align 4\n# wuica-begin\n${LOOP}  jmp .L2\n# wuica-end\n  .fill 200, 1, 0x90\n.L2:\n  ret\n`;
    const r = await A.assemble(t, 'intel');
    const whole = await plain(t);
    const pre = (await wa.assemble('.L1:\n  .p2align 4\n', 'intel')).bytes.length;
    check(r.ok && whole.includes(hex(r.bytes)) && whole.indexOf(hex(r.bytes)) === 2 * pre && /e9[0-9a-f]{8}$/.test(hex(r.bytes)), 'wuica markers: the same bytes as in the whole listing (rel32 jmp kept)', hex(r.bytes));
  }
  // IACA byte markers, Intel and AT&T: the markers are not in the region
  {
    const t = `  mov rcx, 100\n  mov ebx, 111\n  .byte 0x64, 0x67, 0x90\n.L1:\n${LOOP}  mov ebx, 222\n  .byte 0x64, 0x67, 0x90\n  ret\n`;
    const r = await A.assemble(t, 'intel');
    check(r.ok && hex(r.bytes) === hex(loopHex) && r.region?.line === 2, 'IACA markers (Intel): the loop between them', hex(r.bytes));
    const at = '  movl $111, %ebx\n  .byte 100,103,144\n.L1:\n  addq $1, %rax\n  decq %rcx\n  jne .L1\n  movl $222, %ebx\n  .byte 100,103,144\n';
    const r2 = await A.assemble(at, 'att');
    check(r2.ok && hex(r2.bytes) === hex(loopHex), 'IACA markers (AT&T)', hex(r2.bytes));
  }
  // a mov ebx, 111 that is not a marker is the region's first instruction
  {
    const r = await A.assemble('# wuica-begin\n  mov ebx, 111\n  ret\n# wuica-end\n', 'intel');
    check(r.ok && hex(r.bytes) === 'bb6f000000c3', 'a plain mov ebx, 111 in a region', hex(r.bytes));
  }
  // several regions: the first; a missing END: to the end
  {
    const t = `# LLVM-MCA-BEGIN a\n  nop\n# LLVM-MCA-END a\n# LLVM-MCA-BEGIN b\n  ret\n# LLVM-MCA-END b\n# wuica-begin c\n  int3\n`;
    const r = await A.assemble(t, 'intel');
    check(r.ok && hex(r.bytes) === '90' && r.region.count === 3 && r.region.name === 'a', 'three regions: the first', JSON.stringify(r.region));
    const r2 = await A.assemble('  nop\n# wuica-begin\n  ret\n  int3\n', 'intel');
    check(r2.ok && hex(r2.bytes) === 'c3cc', 'no END: to the end of the code', hex(r2.bytes));
  }
  // errors: an empty region, a region in another section, an error in the listing (its line and column kept)
  {
    const r = await A.assemble('  nop\n# LLVM-MCA-BEGIN\n# LLVM-MCA-END\n  ret\n', 'intel');
    check(!r.ok && r.diagnostics[0].line === 2 && /no instructions/.test(r.diagnostics[0].message), 'an empty region: an error at its BEGIN', JSON.stringify(r.diagnostics));
    const r2 = await A.assemble('  nop\n.section .text.startup,"ax",@progbits\n# LLVM-MCA-BEGIN\n  ret\n# LLVM-MCA-END\n', 'intel');
    check(!r2.ok && r2.diagnostics[0].line === 3 && /not in \.text/.test(r2.diagnostics[0].message), 'a region outside .text: an error', JSON.stringify(r2.diagnostics));
    const bad = '.file 1 "x.c"\n  .loc 1 3 1\n  add rax, 1\n  .loc 1 4 1\n  addd rax, 2\n';
    const r3 = await A.assemble(bad, 'intel');
    const p3 = await wa.assemble(bad, 'intel');
    check(!r3.ok && JSON.stringify(r3.diagnostics) === JSON.stringify(p3.diagnostics), 'an error in the listing: the same line and column as without labels', JSON.stringify([r3.diagnostics, p3.diagnostics]));
    const t4 = '# LLVM-MCA-BEGIN\n  add rax, 1 ; nope\n# LLVM-MCA-END\n';
    const r4 = await A.assemble(t4, 'intel');
    const p4 = await wa.assemble(t4, 'intel');
    check(!r4.ok && r4.diagnostics[0].line === 2 && JSON.stringify(r4.diagnostics) === JSON.stringify(p4.diagnostics), 'an error in the region: the same diagnostics (with the hint)', JSON.stringify([r4.diagnostics, p4.diagnostics]));
  }
  // no markers: exactly the plain assembly
  {
    const t = EXAMPLES[0].text.intel ?? Object.values(EXAMPLES[0].text)[0];
    const r = await A.assemble(t, EXAMPLES[0].text.intel ? 'intel' : 'att');
    check(r.ok && r.region === undefined && r.source === undefined, 'no markers: the assembler\'s own result');
  }
  // .loc of gcc (DWARF 4, view numbers) and clang (DWARF 5, file 0 with a directory and md5)
  const GCC = `\t.file\t"dot.c"
\t.text
.Ltext0:
\t.file 1 "dot.c"
\t.p2align 4
\t.globl\tdot
\t.type\tdot, @function
dot:
.LFB0:
\t.loc 1 1 55 view -0
\t.cfi_startproc
\t.loc 1 2 3 view .LVU1
\t.loc 1 3 3 view .LVU2
\ttestq\t%rdx, %rdx
\tjle\t.L4
\txorl\t%eax, %eax
\tpxor\t%xmm0, %xmm0
\t.p2align 4,,10
\t.p2align 3
.L3:
\t.loc 1 4 5 view .LVU3
\tmovsd\t(%rdi,%rax,8), %xmm1
\tmulsd\t(%rsi,%rax,8), %xmm1
\t.loc 1 3 28 discriminator 3 view .LVU4
\taddq\t$1, %rax
\t.loc 1 4 7 is_stmt 0 discriminator 3 view .LVU5
\taddsd\t%xmm1, %xmm0
\t.loc 1 3 3 is_stmt 1 discriminator 3 view .LVU6
\tcmpq\t%rax, %rdx
\tjne\t.L3
\tret
.L4:
\t.loc 1 2 10 view .LVU7
\tpxor\t%xmm0, %xmm0
\t.loc 1 5 3 view .LVU8
\tret
\t.cfi_endproc
.LFE0:
\t.size\tdot, .-dot
\t.section\t.debug_info,"",@progbits
.Ldebug_info0:
\t.long\t0x10
\t.section\t.note.GNU-stack,"",@progbits
`;
  {
    const r = await A.assemble(GCC, 'att');
    const p = await wa.assemble(GCC.replace(/ view \S+/g, ''), 'att');
    check(r.ok && hex(r.bytes) === hex(p.bytes) && r.source?.file === 'dot.c', 'gcc -g: the same bytes, the source file', JSON.stringify(r.diagnostics) + JSON.stringify(r.source));
    const want = [[0, 3], [16, 4], [26, 3], [30, 4]];
    check(r.source && want.every(([o, l], k) => r.source.spans[k].off === o && r.source.spans[k].line === l), 'gcc -g: the first spans', JSON.stringify(r.source?.spans));
    // the loop marked: its lines
    const marked = GCC.replace('.L3:\n', '# LLVM-MCA-BEGIN\n.L3:\n').replace('\tret\n.L4:', '# LLVM-MCA-END\n\tret\n.L4:');
    const m = await A.assemble(marked, 'att');
    check(m.ok && m.bytes.length > 10 && m.source?.spans.map((x) => `${x.off}:${x.line}`).join() === '0:4,10:3,14:4,18:3', 'gcc -g, a region: the spans start at the region', JSON.stringify(m.source?.spans));
    const CLANG = '\t.text\n\t.file\t"dot.c"\n\t.file\t0 "/src" "dot.c" md5 0x3a0ef1b343c22bb5c44e3046080b425f\n\t.file\t1 "/usr/include" "math.h"\ndot:\n\t.loc\t0 3 22 prologue_end\n\ttestq\t%rdx, %rdx\n\t.loc\t1 9 3\n\tnop\n\t.loc\t0 4 3 is_stmt 0\n\tret\n';
    const c = await A.assemble(CLANG, 'att');
    check(c.ok && c.source?.file === 'dot.c' && c.source.spans.map((s) => s.line).join() === '3,,4', 'clang -g (DWARF 5): main file 0, another file no line', JSON.stringify(c.source));

    const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
    if (!fs.existsSync(wasm) || !fs.existsSync(new URL('data/uarch.json', root))) {
      console.log('(analyzer or data/ missing: no cost per line)');
    } else {
      const e = await WasmEngine.create(fs.readFileSync(wasm));
      await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
      await e.loadArch('SKL', fs.readFileSync(new URL('data/arch/SKL.json', root)));
      const h = hex(m.bytes);
      const resp = await e.analyze(makeRequest(h, 'SKL'));
      const sm = srcModel(resp, { ...m.source, hex: h }, h);
      check(sm && sm.lines.filter((x) => !x.gap).map((x) => x.line).join() === '3,4' && sm.lines.every((x) => x.gap || x.text === `dot.c:${x.line}`), 'cost per line: lines 3 and 4 of dot.c', JSON.stringify(sm?.lines));
      check(sm && Math.abs(sm.lines.reduce((s, x) => s + (x.share ?? 0), 0) + sm.unmapped - 1) < 1e-9, 'cost per line: the shares add up to 1');
      console.log(`dot loop on SKL: ${resp.tp} cycles/iteration, ${sm?.lines.filter((x) => x.rows?.length).map((x) => `${x.text} ${Math.round(x.share * 100)}%`).join(', ')}`);
    }
  }
  // the mock assembler (no trailer): the plain text
  {
    const mock = { assemble: async (t) => ({ ok: true, bytes: new Uint8Array([0x90]), diagnostics: [], text: t }) };
    const r = await assembleMarked((t) => mock.assemble(t), '# wuica-begin\n  nop\n# wuica-end\n');
    check(r.ok && r.text === '# wuica-begin\n  nop\n# wuica-end\n', 'no trailer: the plain text assembled');
  }
}

console.log(`${count} region checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
