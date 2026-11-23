// Tests of finding the loop in pasted assembly (web/js/loop-find.js, through asm-regions.js): a whole function from
// gcc -S, objdump -d output (with and without the bytes, Intel and AT&T, addresses with hex letters), the exits taken as
// not taken (also to a non-local symbol), ';' comments, the alignment offset from the addresses, a function without a
// loop (its body), and that nothing changes for a text that is one loop already (the built-in examples). The fixtures in
// tests-js/fixtures/loop-find are from the 0.1.4 dogfood run (gcc 16.2 -O3 -march=native).
// Usage: node tests-js/web_loop_find.mjs
import fs from 'node:fs';
import { preparePaste, fromObjdump, leadingSemicolons, findLoops, scan, replacesText } from '../web/js/loop-find.js';
import { withRegions } from '../web/js/asm-regions.js';
import { WasmAssembler } from '../web/js/assembler.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const fx = (name) => fs.readFileSync(new URL(`tests-js/fixtures/loop-find/${name}`, root), 'utf8');
const hex = (b) => [...(b ?? [])].map((x) => x.toString(16).padStart(2, '0')).join('');
const j = JSON.stringify;

// --- without an assembler ------------------------------------------------------------------------------------------------
{
  const crc = preparePaste(fx('crc_a.s'));
  check(crc.choice === 0 && crc.loops.length === 1 && crc.loops[0].label === '.L3' && crc.choosable, 'gcc -S: the loop .L3', j(crc.loops));
  check(preparePaste(fx('crc_a.s'), { loop: 'whole' }).pick === null, "loop 'whole': no pick");
  check(/not the index of a loop/.test(preparePaste(fx('crc_a.s'), { loop: 3 }).error), 'loop 3 of 1: an error');
  check(/is not the label of a loop/.test(preparePaste('nop', { loop: 'x' }).error) && /is not "auto"/.test(preparePaste('nop', { loop: -1 }).error), 'loop: a bad value');
  const one = preparePaste('.L1:\n  add rax, 1\n  dec rcx\n  jnz .L1\n');
  check(one.choice === null && !one.choosable && one.loops.length === 1, 'one loop and nothing else: no pick, no choice', j(one));
  const pre = preparePaste('  mov ecx, 100\n.L1:\n  add rax, 1\n  dec rcx\n  jnz .L1\n');
  check(pre.choice === 0 && pre.pick.begin === 2 && pre.pick.end === 5, 'code before the loop: the loop is picked', j(pre.pick));
  const nest = findLoops(scan('.L1:\n  mov rcx, 4\n.L2:\n  add rax, 1\n  dec rcx\n  jnz .L2\n  dec rdx\n  jnz .L1\n'));
  check(nest.length === 2 && nest[0].label === '.L2' && nest[0].inner && !nest[1].inner, 'nested loops: the inner one first', j(nest));
  const twice = findLoops(scan('.L:\n  add rdx, 32\n  cmp rdx, rsi\n  jae .L\n  vpcmpeqb ymm0, ymm1, [rdi+rdx]\n  test ecx, ecx\n  je .L\n'));
  check(twice.length === 1 && twice[0].begin === 1 && twice[0].end === 7, 'two branches back to one label (an exit retargeted to the top): one loop, to the last', j(twice));
  const marked = preparePaste('  mov ecx, 9\n# LLVM-MCA-BEGIN\n.L1:\n  dec rcx\n  jnz .L1\n# LLVM-MCA-END\n');
  check(marked.choice === null && !marked.choosable && marked.loops.length === 0, 'region markers win: no pick');
  const numeric = preparePaste('1: add rax, 1\n2: dec rcx\n3: jnz 1b\n');
  check(!numeric.objdump && numeric.loops.length === 1 && numeric.choice === null, 'GNU numeric labels with 1b: assembly, not objdump', j(numeric));
  check(!fromObjdump('1: add rax, 1\n  jnz 1b\n').objdump, 'numeric label + 1b: not objdump');
  check(leadingSemicolons('; note\n  add rax, 1 ; x\n') === '# note\n  add rax, 1 ; x\n', "a ';' at the start of a line is a comment; one after a statement stays");
  const body = preparePaste('f:\n  endbr64\n  push rbp\n  mov rbp, rsp\n  movss DWORD PTR [rbp-20], xmm0\n  mulss xmm0, xmm0\n  pop rbp\n  ret\n');
  check(body.choice === 'body' && body.pick.begin === 5 && body.pick.end === 6 && body.choosable, 'no loop, ends in ret: the body without prologue and epilogue', j(body.pick));
  // a bare snippet that ends in ret is analyzed as typed; a compiler's function (label, directives, prologue) is trimmed
  check(preparePaste('  add rax, 1\n  ret\n').choice === null && !preparePaste('  add rax, 1\n  ret\n').choosable, 'a bare snippet ending in ret: as typed (no trim)');
  check(preparePaste('f:\n  add rax, 1\n  ret\n').choice === 'body' && preparePaste('\t.text\n  add rax, 1\n  ret\n').choice === 'body' && preparePaste('  push rbx\n  add rax, 1\n  pop rbx\n  ret\n').choice === 'body', 'a function label, a directive or a prologue: the body');
  check(preparePaste('.L5:\n  add rax, 1\n  ret\n').choice === null, 'a local label alone is not a function');
  // replacing vs editing a text (the page's pick goes back to auto when the text is replaced)
  check(replacesText('.L1:\n add rax, 1\n jnz .L1\n', 'f:\n mov ecx, 2\n ret\n') && !replacesText('.L1:\n add rax, 1\n jnz .L1\n', '.L1:\n add rax, 2\n jnz .L1\n') && !replacesText('abc', 'abc'), 'replacesText: a new text vs an edit');
  check(preparePaste('  add rax, 1\n  imul rax, rbx\n').choice === null, 'straight-line code without ret: as it is');
  const ex = preparePaste('.L1:\n  add rax, [rdi]\n  jae .Lout\n  jae out\n  jmp far\n  dec rcx\n  jnz .L1\n');
  check(j(ex.stubs) === j(['.Lout', 'out']), 'exits: .Lout and out are stubs (not taken)', j(ex.stubs));
  check(ex.notes.length === 3 && ex.notes[2].severity === 'warning' && /far/.test(ex.notes[2].message) && ex.notes[0].line === 3, 'notes for the exits, a warning for an undefined jmp target', j(ex.notes));
  const od = preparePaste(fx('psum.noraw'));
  check(od.objdump && od.loops.length === 1 && od.loops[0].label === '0x10' && od.alignment === 16 && od.address === 0x10, 'objdump (no bytes): the loop at 0x10, alignment 16', j(od));
  const od2 = preparePaste(fx('psum.noraw'), { loop: 'whole' });
  check(od2.alignment === 0 && od2.pick === null, "objdump 'whole': the alignment of the first instruction");
  const hexLetters = preparePaste('  1c:\tjne 10 <psum+0x10>\n  1e:\tret\n');
  check(hexLetters.objdump && /jne \.Lwuica_x10/.test(hexLetters.text) && hexLetters.stubs[0] === '.Lwuica_x10', 'objdump: 1c: (hex letters) and a target outside the text', hexLetters.text);
}

// --- with the real assembler ---------------------------------------------------------------------------------------------
const asmPath = new URL('assembler/dist/wuica_asm.wasm', root);
if (!fs.existsSync(asmPath)) {
  console.log('(the assembler is missing: only the plans)');
} else {
  const wa = await WasmAssembler.create(fs.readFileSync(asmPath));
  const A = withRegions(wa);
  const an = (t, loop = 'auto', syntax = 'intel') => A.assemble(t, syntax, { loop });
  const plain = async (t, s = 'intel') => hex((await wa.assemble(t, s)).bytes);

  // gcc -S: the whole function gives the bytes of its loop alone (the hand-trimmed loop of the dogfood run)
  const CRC_LOOP = '.L3:\n\tcrc32\trax, QWORD PTR [rdi+rdx]\n\tcrc32\trax, QWORD PTR [rdi+8+rdx]\n\tadd\trdx, 16\n\tcmp\trdx, rsi\n\tjb\t.L3\n';
  const crc = await an(fx('crc_a.s'));
  check(crc.ok && hex(crc.bytes) === await plain(CRC_LOOP), 'gcc -S crc_a: the loop .L3, as trimmed by hand', hex(crc.bytes));
  check(crc.loop && crc.loop.index === 0 && crc.loop.count === 1 && crc.loop.name === 'loop .L3' && crc.loop.line === 23 && crc.loop.endLine === 28, 'the loop: index, name, lines', j(crc.loop));
  const crcWhole = await an(fx('crc_a.s'), 'whole');
  check(crcWhole.ok && crcWhole.bytes.length > 60 && crcWhole.loop === null && crcWhole.choosable, "loop 'whole': the whole function", hex(crcWhole.bytes));
  check(hex((await an(fx('crc_a.s'), 0)).bytes) === hex(crc.bytes), 'loop 0 is the auto pick');
  const bad = await an(fx('crc_a.s'), 2);
  check(!bad.ok && /not the index of a loop/.test(bad.diagnostics[0].message), 'a loop index out of range: an error', j(bad.diagnostics));

  // the scan loop: its exit (jnb .L53) in the function keeps the compiler's distance; trimmed, .Lout is not taken
  const scanFn = await an(fx('scan_a.s'));
  check(scanFn.ok && hex(scanFn.bytes).startsWith('4883c220') && hex(scanFn.bytes).endsWith('74ea') && scanFn.bytes.length === 22, 'gcc -S scan_a: the loop .L49 (exit and back-branch short)', hex(scanFn.bytes));
  const SCAN = '.L:\n\tadd    rdx,0x20\n\tcmp    rdx,rsi\n\tjae    .Lout\n\tvpcmpeqb ymm0,ymm1,YMMWORD PTR [rdi+rdx*1]\n\tvpmovmskb ecx,ymm0\n\ttest   ecx,ecx\n\tje     .L\n';
  const scan1 = await an(SCAN);
  check(scan1.ok && scan1.bytes.length === 22 && hex(scan1.bytes).includes('730d'), 'jae .Lout (undefined): assembles, short, to the end of the loop', hex(scan1.bytes));
  check(scan1.diagnostics.some((d) => d.severity === 'note' && d.line === 4 && /\.Lout/.test(d.message)), 'jae .Lout: a note', j(scan1.diagnostics));
  check(!(await A.assemble(SCAN, 'intel')).ok, 'without loop finding (the converter): .Lout is still an error');
  // item 3: a non-local undefined target is not a rel32 relocation any more
  const scan2 = await an(SCAN.replace('.Lout', 'out'));
  check(scan2.ok && hex(scan2.bytes) === hex(scan1.bytes), 'jae out (undefined, non-local): the same short exit, not a rel32 relocation', hex(scan2.bytes));
  const jmpOut = await an('.L1:\n  add rax, 1\n  jmp out\n  dec rcx\n  jnz .L1\n');
  check(jmpOut.ok && jmpOut.diagnostics.some((d) => d.severity === 'warning' && d.line === 3 && /out is not defined/.test(d.message)), 'jmp out (undefined): a warning', j(jmpOut.diagnostics));
  const call = await an('.L1:\n  call memcpy\n  dec rcx\n  jnz .L1\n');
  check(call.ok && call.diagnostics.length === 0, 'call memcpy: no warning (a call is a relocation anyway)', j(call.diagnostics));

  // objdump: Intel with bytes, without bytes, AT&T; the loop at 0x10 and its alignment
  const PSUM = '0314878914864 8ffc04839c175f2'.replace(/ /g, '');
  for (const [name, syntax] of [['psum.objdump', 'intel'], ['psum.noraw', 'intel'], ['psum.att', 'att']]) {
    const r = await an(fx(name), 'auto', syntax);
    check(r.ok && hex(r.bytes) === PSUM && r.loop?.address === 0x10 && r.alignment === 16, `objdump ${name}: the loop at 0x10 (jne 10 <psum+0x10>), alignment 16`, j([hex(r.bytes), r.loop, r.diagnostics]));
  }
  // the bytes of an objdump line are used as they are, even where the text has another encoding
  const odBytes = await an('   0:\t48 81 c0 01 00 00 00 \tadd    rax,0x1\n   7:\t48 ff c9             \tdec    rcx\n   a:\t75 f4                \tjne    0 <f>\n');
  check(odBytes.ok && hex(odBytes.bytes) === '4881c0010000004 8ffc975f4'.replace(/ /g, ''), 'objdump with bytes: those bytes (add rax, imm32 stays 7 bytes)', hex(odBytes.bytes));
  // a line the assembler rejects outside the loop, without bytes, is left out
  const pad = await an('  10:\tadd edx, [rdi+rax*4]\n  13:\tinc rax\n  16:\tjne 10 <f+0x10>\n  18:\tdata16 cs nopw 0x0(%rax,%rax,1)\n');
  check(pad.ok && hex(pad.bytes) === '031487 48ffc0 75f8'.replace(/ /g, ''), 'objdump: padding the assembler rejects (after the loop) is left out', j([hex(pad.bytes), pad.diagnostics]));

  // ';' comments
  const semi = await an('; the loop\n.L1:\n  add rax, 1 ; one\n  dec rcx; jnz .L1 ; back\n');
  check(semi.ok && hex(semi.bytes) === await plain('.L1:\n add rax, 1\n dec rcx\n jnz .L1\n'), "';' comments: at the start of a line and after a statement; ';' between statements stays a separator", j(semi.diagnostics));
  const semi2 = await wa.assemble('add rax, 1 ; one', 'intel');
  check(!semi2.ok, "(LLVM alone rejects '; one')");
  // after a statement: what does not assemble is a comment (nothing after ';' makes a valid line an error); a note only if
  // it starts with a mnemonic; what assembles is assembled, with a note unless written as GNU as chains ("dec rcx; jnz")
  const typo = await an('  add rax, 1 ; addd rbx, 2\n');
  check(typo.ok && hex(typo.bytes) === '4883c001' && typo.diagnostics.length === 0, "after ';', a non-mnemonic: a comment, silently", j(typo.diagnostics));
  const prose = await an('  add rax, [rdi] ; a[i], next\n  add rbx, 1 ; rax = sum\n');
  check(prose.ok && prose.bytes.length === 7, "';' comments with brackets, commas and '=' in them", j(prose.diagnostics));
  const mnem = await an('  add rax, 1 ; add the next element\n');
  check(mnem.ok && hex(mnem.bytes) === '4883c001' && mnem.diagnostics.length === 1 && mnem.diagnostics[0].severity === 'note' && /text after ';' taken as a comment/.test(mnem.diagnostics[0].message), "after ';', a mnemonic that does not assemble: a comment, with a note", j(mnem.diagnostics));
  const sep = await an('.L1:\n  add rax, [rdi]\n  add rdi, 8 ; call helper\n  dec rcx\n  jnz .L1\n');
  check(sep.ok && /e8000000/.test(hex(sep.bytes)) && sep.diagnostics.some((d) => d.severity === 'note' && d.line === 3 && d.message === "';' separates statements: 'call helper' was assembled (use # for a comment)"), "after ' ; ', an instruction that assembles: assembled, with a note naming it", j(sep.diagnostics));
  const gas = await an('1:\n  add rax, 1\n  dec rcx; jnz 1b\n');
  check(gas.ok && gas.diagnostics.length === 0 && hex(gas.bytes) === await plain('1:\n add rax, 1\n dec rcx\n jnz 1b\n'), "GNU as chaining ('dec rcx; jnz 1b'): no note", j(gas.diagnostics));
  for (const c of ['loop back', 'not taken', 'add the next element', 'i++', 'sum += a[i]', 'x = y', 'mul by 2', 'in loop', 'or else', 'jne next']) {
    const r = await an(`.L1:\n  add rax, [rdi]\n  add rdi, 8 ; ${c}\n  dec rcx\n  jnz .L1\n`);
    check(r.ok, `after ';', "${c}" never makes the line an error`, j(r.diagnostics));
  }
  const semiPlain = await A.assemble('  add rax, 1 ; one\n', 'intel');
  check(semiPlain.ok && hex(semiPlain.bytes) === '4883c001', "';' comments also without loop finding (the converter)", j(semiPlain.diagnostics));

  // a function without a loop: its body
  const q = await an('Q_rsqrt:\n  push rbp\n  mov rbp, rsp\n  movss DWORD PTR [rbp-20], xmm0\n  mulss xmm0, xmm0\n  pop rbp\n  ret\n');
  check(q.ok && hex(q.bytes) === await plain('movss DWORD PTR [rbp-20], xmm0\n  mulss xmm0, xmm0\n') && q.loop?.name === 'body', 'no loop: the body (no prologue)', j([hex(q.bytes), q.loop]));

  // nothing changes for a text that is one loop (the built-in examples)
  let same = 0;
  for (const exm of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
    for (const syntax of ['intel', 'att']) {
      const t = exm.text?.[syntax];
      if (t == null) continue;
      const a = await A.assemble(t, syntax), b = await an(t, 'auto', syntax);
      if (hex(a.bytes) === hex(b.bytes) && !b.choosable && b.loop === null) same++;
      else check(false, `example ${exm.id} (${syntax}): the same bytes with loop finding`, j(b.loop));
    }
  }
  check(same > 10, 'the examples: unchanged', String(same));

  // review round 1 ------------------------------------------------------------------------------------------------------
  // objdump whose branch target looks like a GNU numeric label (1b): an address
  const od1b = '0000000000000000 <psum>:\n   0:\t85 f6                \ttest   esi,esi\n   2:\t7e 1f                \tjle    23 <psum+0x23>\n   4:\t31 c0                \txor    eax,eax\n'
    + '  1b:\t03 14 87             \tadd    edx,DWORD PTR [rdi+rax*4]\n  1e:\t48 83 c0 01          \tadd    rax,0x1\n  22:\t48 39 c6             \tcmp    rsi,rax\n  25:\t75 f4                \tjne    1b <psum+0x1b>\n  27:\tc3                   \tret\n';
  const r1 = await an(od1b);
  check(r1.ok && hex(r1.bytes) === '0314874883c0014839c675f4' && r1.loop?.address === 0x1b, 'objdump: jne 1b <psum+0x1b> is the address 0x1b', j([hex(r1.bytes), r1.loop, r1.diagnostics]));
  const noraw1b = od1b.split('\n').slice(1).map((l) => l.replace(/^(\s*[0-9a-f]+:)\t[0-9a-f ]+\t/, '$1\t')).join('\n');
  check(hex((await an(noraw1b)).bytes) === '0314874883c0014839c675f4', 'objdump without bytes and header: the same');
  check((await an('  mov ecx, 5\n10: add rax, 1\n  dec ecx\n  jne 10b\n  ret\n')).loop?.name === 'loop 10b', 'GNU numeric labels (10: … jne 10b) still work');
  // CRLF
  const crlf = await an(fx('psum.objdump').replace(/\n/g, '\r\n'));
  check(crlf.ok && crlf.loop?.address === 0x10 && hex(crlf.bytes) === PSUM, 'objdump with CRLF line ends', j(crlf.loop));
  check((await an('  mov ecx, 5\r\n.L1:\r\n  add rax, 1\r\n  dec ecx\r\n  jnz .L1\r\n')).loop?.name === 'loop .L1' && preparePaste('a\rb').text === 'a\nb', 'CRLF and a lone CR in assembly');
  // a rejected line inside the analyzed code is an error (with its line); only lines outside the pick are dropped
  const badText = '   0:\tadd rax,0x1\n   4:\tfoo rbx\n   7:\tdec rcx\n   a:\tjne 0 <f>\n';
  const badW = await an(badText, 'whole');
  check(!badW.ok && badW.diagnostics[0].line === 2, 'objdump, whole: a line the assembler rejects is an error', j(badW.diagnostics));
  const badN = await an('   0:\tadd rax,0x1\n   4:\tfoo rbx\n   7:\tdec rcx\n   a:\timul rax,rbx\n');
  check(!badN.ok && badN.diagnostics[0].line === 2, 'objdump without a loop: a rejected line is an error', j(badN.diagnostics));
  // .text.startup (gcc's main), -ffunction-sections
  const main = '\t.text\n\t.section\t.text.startup,"ax",@progbits\n\t.globl\tmain\n\t.type\tmain, @function\nmain:\n\txor\teax, eax\n\tmov\tecx, 100\n.L2:\n\tadd\trax, rcx\n\tdec\trcx\n\tjne\t.L2\n\tret\n';
  const rm = await an(main);
  check(rm.ok && hex(rm.bytes) === '4801c848ffc975f8' && rm.choosable, 'main in .text.startup: its loop', j([hex(rm.bytes), rm.diagnostics]));
  check(hex((await an(main, 'whole')).bytes) === '31c0b9640000004801c848ffc975f8c3', 'main in .text.startup, whole: all of it');
  check(hex((await an(main.replace('.text.startup', '.text.main'))).bytes) === '4801c848ffc975f8', '-ffunction-sections (.text.main)');
  // the pick fails: the choice is still offered (whole is reachable)
  const failPick = await an('f:\n  mov ecx, 9\n.L1:\n  addd rax, 1\n  dec rcx\n  jnz .L1\n  ret\n');
  check(!failPick.ok && failPick.choosable && failPick.loops.length === 1, 'a pick that does not assemble: still choosable', j(failPick));
  // a tail call jumping back to an earlier function is not a loop
  const tail = 'impl:\n  lea eax, [rdi+rdi]\n  ret\nwrapper:\n  add edi, 1\n  jmp impl\nsum:\n  xor eax, eax\n.L3:\n  add eax, DWORD PTR [rdi]\n  add rdi, 4\n  cmp rdi, rsi\n  jne .L3\n  ret\n';
  const rt = await an(tail);
  check(rt.loop?.name === 'loop .L3' && rt.loops.length === 1, 'a backward tail call (jmp impl) is not a loop: the loop .L3', j(rt.loops));
  check(findLoops(scan('\t.globl\tg\nf:\n  add rax, 1\ng:\n  dec rcx\n  jnz f\n')).length === 0, 'a span over a .globl function label is not a loop');
  // hex-looking labels (a:, b:) are labels, not objdump; whole means no pick
  const ab = 'a: add rax, 1\nb: dec rcx\n   jnz a\n';
  check(!fromObjdump(ab).objdump && preparePaste(ab).loops.length === 1, 'a: / b: labels: assembly, not objdump');
  const rab = await an(ab);
  check(rab.ok && hex(rab.bytes) === '4883c00148ffc975f7' && rab.diagnostics.length === 0, 'a: / b: with jnz a: the 2-instruction loop', j([hex(rab.bytes), rab.diagnostics]));
  check(!fromObjdump('a: add rax, 1\nb: dec rcx\nc: jnz a\n').objdump, 'a:/b:/c: all prefixed: steps of 1 byte do not fit "add rax, 1": not objdump');
  check(fromObjdump('  40: crc32 rax, qword ptr [rdi]\n  45: add rdi, 8\n  49: dec rcx\n  4c: jne 40\n').objdump, '40: crc32 … (every line addressed, plausible steps): objdump');
  check((await an(fx('crc_a.s'), 'whole')).loop === null && preparePaste(fx('psum.noraw'), { loop: 'whole' }).pick === null, "loop 'whole': never a pick");
}

console.log(`${count} loop-find checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
