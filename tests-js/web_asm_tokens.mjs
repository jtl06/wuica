// Tests of the assembly tokenizer (web/js/asm-tokens.js): golden token lists for representative lines of each syntax
// and of objdump output; every character of any input in exactly one token (random bytes, every example's text, every
// file in tests-js/fixtures); the time of a 3,000-line paste (the SHA-256 showcase's instructions, from the analyzer, as
// Intel text and as objdump lines with their bytes). Usage: node tests-js/web_asm_tokens.mjs
import fs from 'node:fs';
import { tokenize, tokenizeText, tokenizeLine, objdumpText, objdumpLine, className, ansi, KINDS, isRegister } from '../web/js/asm-tokens.js';
import { detectSyntax } from '../web/js/loop-find.js';
import { EXAMPLES, CLASSIC_EXAMPLES, SHOWCASE_EXAMPLES } from '../web/js/examples.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { tableBytes } from './tables.mjs';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);

// the tokens as "kind:text" (white space left out)
const words = (line, tokens) => tokens.filter((t) => t.kind !== 'space').map((t) => `${t.kind}:${line.slice(t.start, t.end)}`).join(' ');
const golden = (line, syntax, want, opts) => {
  const got = words(line, tokenize(line, syntax, opts));
  check(got === want, `${syntax}: ${JSON.stringify(line)}`, `\n  got  ${got}\n  want ${want}`);
};

// ---- Intel -----------------------------------------------------------------------------------------------------------
golden('  vmovups ymm0, ymmword ptr [rdi + 4*rcx + 32]', 'intel', 'mnemonic:vmovups register:ymm0 punct:, size:ymmword ptr punct:[ register:rdi punct:+ number:4 punct:* register:rcx punct:+ number:32 punct:]');
golden('  mov rax, qword ptr [rip + .LCPI0_0]', 'intel', 'mnemonic:mov register:rax punct:, size:qword ptr punct:[ register:rip punct:+ symbol:.LCPI0_0 punct:]');
golden('  vfmadd231ps zmm0 {k1} {z}, zmm1, dword ptr [rsi + 8*rax - 0x40]{1to16}', 'intel',
  'mnemonic:vfmadd231ps register:zmm0 punct:{ register:k1 punct:} punct:{ size:z punct:} punct:, register:zmm1 punct:, size:dword ptr punct:[ register:rsi punct:+ number:8 punct:* register:rax punct:- number:0x40 punct:] punct:{ size:1to16 punct:}');
golden('.LBB0_3:                                # =>This Inner Loop Header: Depth=1', 'intel', 'label:.LBB0_3 punct:: comment:# =>This Inner Loop Header: Depth=1');
golden('loop@x.y: add rax, 1 // c++ comment', 'intel', 'label:loop@x.y punct:: mnemonic:add register:rax punct:, number:1 comment:// c++ comment');
golden('1:  dec rcx; jnz 1b', 'intel', 'label:1 punct:: mnemonic:dec register:rcx punct:; mnemonic:jnz symbol:1b');
golden('  lock xadd dword ptr fs:[rax], ecx', 'intel', 'prefix:lock mnemonic:xadd size:dword ptr register:fs punct:: punct:[ register:rax punct:] punct:, register:ecx');
golden('  rep movsb', 'intel', 'prefix:rep mnemonic:movsb');
golden('  {vex} vpdpbusd xmm0, xmm1, xmm2', 'intel', 'prefix:{vex} mnemonic:vpdpbusd register:xmm0 punct:, register:xmm1 punct:, register:xmm2');
golden('  add rax, 1 /* block */ # and more', 'intel', 'mnemonic:add register:rax punct:, number:1 comment:/* block */ comment:# and more');
golden('  call printf@PLT', 'intel', 'mnemonic:call symbol:printf@PLT');
golden('  fadd st(0), st(1)', 'intel', 'mnemonic:fadd register:st(0) punct:, register:st(1)');
golden('  add eax, 10h', 'intel', 'mnemonic:add register:eax punct:, number:10h');
golden('  movzx ecx, ah', 'intel', 'mnemonic:movzx register:ecx punct:, register:ah');
golden('  kmovw k1, r8d', 'intel', 'mnemonic:kmovw register:k1 punct:, register:r8d');
golden('; a whole-line comment', 'intel', 'comment:; a whole-line comment');
// ';' after a statement: a separator, as LLVM reads it; a comment where the assembly's diagnostics say so (commentFixes)
golden('  add rax, 1 ; add the next', 'intel', 'mnemonic:add register:rax punct:, number:1 punct:; mnemonic:add symbol:the symbol:next');
golden('  add rax, 1 ; note here', 'intel', 'mnemonic:add register:rax punct:, number:1 comment:; note here',
  { diagnostics: [{ column: 16, severity: 'error', message: "invalid instruction mnemonic 'note'" }] });
// errors only where the caller says (1-based columns, the end exclusive; without an end, the word at the column)
golden('  add rax, rbx', 'intel', 'mnemonic:add register:rax punct:, error:rbx', { diagnostics: [{ column: 12, endColumn: 15, severity: 'error' }] });
golden('  frob rax', 'intel', 'error:frob register:rax', { diagnostics: [{ column: 3, severity: 'error' }] });
golden('  frob rax', 'intel', 'mnemonic:frob register:rax', { diagnostics: [{ column: 3, severity: 'warning' }] });

// ---- AT&T ------------------------------------------------------------------------------------------------------------
golden('\tvmovups\t32(%rdi,%rcx,4), %ymm0', 'att', 'mnemonic:vmovups number:32 punct:( punct:% register:rdi punct:, punct:% register:rcx punct:, number:4 punct:) punct:, punct:% register:ymm0');
golden('\taddq\t$8, %rcx', 'att', 'mnemonic:addq number:$8 punct:, punct:% register:rcx');
golden('\tmovq\t.LCPI0_0(%rip), %rax', 'att', 'mnemonic:movq symbol:.LCPI0_0 punct:( punct:% register:rip punct:) punct:, punct:% register:rax');
golden('\tvfmadd231ps\t(%rsi){1to16}, %zmm1, %zmm0 {%k1} {z}', 'att',
  'mnemonic:vfmadd231ps punct:( punct:% register:rsi punct:) punct:{ size:1to16 punct:} punct:, punct:% register:zmm1 punct:, punct:% register:zmm0 punct:{ punct:% register:k1 punct:} punct:{ size:z punct:}');
golden('.L3:\tleaq\t-8(%rbp), %rsi  # tail', 'att', 'label:.L3 punct:: mnemonic:leaq punct:- number:8 punct:( punct:% register:rbp punct:) punct:, punct:% register:rsi comment:# tail');
golden('\tjmp\t*%rax', 'att', 'mnemonic:jmp punct:* punct:% register:rax');
golden('\tmovl\t$foo, %eax', 'att', 'mnemonic:movl punct:$ symbol:foo punct:, punct:% register:eax');
golden('\tmovabsq\t$0x123456789, %rax', 'att', 'mnemonic:movabsq number:$0x123456789 punct:, punct:% register:rax');
golden('\t.p2align\t4, 0x90', 'att', 'directive:.p2align number:4 punct:, number:0x90');
golden('\t.section\t.text,"ax",@progbits', 'att', 'directive:.section symbol:.text punct:, text:"ax" punct:, symbol:@progbits');
golden('\tlock incl\t(%rdi) /* atomic */', 'att', 'prefix:lock mnemonic:incl punct:( punct:% register:rdi punct:) comment:/* atomic */');
golden('2:\tdecq\t%rcx\n', 'att', 'label:2 punct:: mnemonic:decq punct:% register:rcx');
golden('\tjne\t.LBB0_3  // back', 'att', 'mnemonic:jne symbol:.LBB0_3 comment:// back');
golden('\tmovb\t%ah, %sil', 'att', 'mnemonic:movb punct:% register:ah punct:, punct:% register:sil');

// ---- objdump ---------------------------------------------------------------------------------------------------------
golden('  401126:\t48 83 c0 01          \tadd    $0x1,%rax', 'auto', 'address:401126: bytes:48 83 c0 01 mnemonic:add number:$0x1 punct:, punct:% register:rax');
golden('  40112a:\t75 fa                \tjne    401126 <loop+0x6>', 'auto', 'address:40112a: bytes:75 fa mnemonic:jne symbol:401126 punct:< symbol:loop punct:+ number:0x6 punct:>');
golden('0000000000401120 <loop>:', 'auto', 'address:0000000000401120 label:<loop> punct::');
golden('   0:\tadd    rax,0x1', 'auto', 'address:0: mnemonic:add register:rax punct:, number:0x1');
golden('  1c:\tf3 0f b8 c7          \tpopcnt eax,edi', 'auto', 'address:1c: bytes:f3 0f b8 c7 mnemonic:popcnt register:eax punct:, register:edi');

// ---- the whole text: syntax once, objdump once, a block comment over lines --------------------------------------------
{
  const t = tokenizeText('x /* one\ntwo */ add rax, 1\n\tmovl %eax, %ebx\n', 'auto');
  check(t.length === 4 && t[1][0].kind === 'comment' && words('two */ add rax, 1', t[1]) === 'comment:two */ mnemonic:add register:rax punct:, number:1', 'tokenizeText: a block comment over two lines', JSON.stringify(t[1]));
  const d = tokenizeText('  add rax, 1\n  frob rax\n', 'intel', { diagnostics: [{ line: 2, column: 3, severity: 'error' }] });
  check(d[1][1].kind === 'error' && d[0].every((x) => x.kind !== 'error'), 'tokenizeText: diagnostics by line');
  check(className('mnemonic') === 'tok-mnemonic' && KINDS.includes('bytes') && KINDS.length === 15, 'className, KINDS');
  check(ansi('  add rax, 1', tokenize('  add rax, 1', 'intel')) === '  \x1b[1madd\x1b[0m \x1b[36mrax\x1b[0m, \x1b[32m1\x1b[0m', 'ansi', JSON.stringify(ansi('  add rax, 1', tokenize('  add rax, 1', 'intel'))));
  const regs = ['rax', 'R15D', 'r8b', 'sil', 'ah', 'xmm31', 'YMM7', 'zmm0', 'k7', 'cs', 'gs', 'st', 'st7', 'mm3', 'rip', 'cr0', 'dr7'];
  check(regs.every(isRegister) && !['raxx', 'r16', 'k8', 'xmm32', 'loop'].some(isRegister), 'the register table');
}

// ---- every character exactly once, never a throw -------------------------------------------------------------------
function covers(line, tokens) {
  let at = 0;
  for (const t of tokens) {
    if (t.start !== at || !(t.end > t.start) || !KINDS.includes(t.kind)) return false;
    at = t.end;
  }
  return at === line.length;
}
function coversText(text, syntax, name) {
  let lines;
  try { lines = tokenizeText(text, syntax); } catch (e) { check(false, `${name}: no throw`, e.message); return; }
  const src = text.split('\n');
  const bad = src.findIndex((l, k) => !covers(l, lines[k] ?? []));
  check(lines.length === src.length && bad < 0, `${name} (${syntax}): every character in one token`, bad >= 0 ? `line ${bad + 1}: ${JSON.stringify(src[bad])}` : '');
}
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const ALPHA = 'abcdefxyzr0123456789.$@%_[](){},:;#/*+-<>"\'\\ \t\x00\u00e9\u2014\ud83d\ude00rax ptr {z}{1to8} /* */ // ';
let randomOk = true;
for (let n = 0; n < 3000; n++) {
  const len = Math.floor(rand() * 120);
  let s = '';
  for (let i = 0; i < len; i++) s += rand() < 0.5 ? String.fromCharCode(Math.floor(rand() * 256)) : ALPHA[Math.floor(rand() * ALPHA.length)];
  for (const syntax of ['intel', 'att', 'auto']) {
    let t;
    try { t = tokenize(s, syntax, { diagnostics: rand() < 0.3 ? [{ column: Math.floor(rand() * 40), endColumn: Math.floor(rand() * 60), severity: 'error', message: 'x' }] : [] }); } catch { t = null; }
    if (!t || !covers(s, t)) { randomOk = false; console.log(`  random line not covered (${syntax}): ${JSON.stringify(s)}`); break; }
  }
  if (!randomOk) break;
}
check(randomOk, 'random bytes: every character in one token, no throw');
check(covers('', tokenize('')) && tokenize(null).length === 0 && tokenize(undefined).length === 0 && covers('42', tokenize(42)) && tokenizeText(null).length === 1, 'odd inputs');
for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES, ...SHOWCASE_EXAMPLES]) for (const [k, text] of Object.entries(ex.text ?? {})) for (const syntax of ['auto', 'intel', 'att']) coversText(String(text), syntax, `example ${ex.id} (${k})`);

// ---- tokenizeLine: a line at a time (the page's editor, asm-hl.js: the syntax and objdump decided once for the text,
// each line with the block-comment state of the line before) gives tokenizeText's tokens
function lineByLine(text, syntax, diagnostics = []) {
  const lines = text.split('\n');
  const syn = syntax === 'auto' ? (detectSyntax(text) === 'att' ? 'att' : 'intel') : syntax;
  const od = objdumpText(lines);
  let block = false;
  return lines.map((l, k) => {
    const r = tokenizeLine(l, syn, { objdump: od && objdumpLine(l), block, diagnostics: diagnostics.filter((d) => d.line === k + 1) });
    block = r.open;
    return r.tokens;
  });
}
const sameAsText = (text, syntax, name, diagnostics = []) => {
  const a = JSON.stringify(lineByLine(text, syntax, diagnostics)), b = JSON.stringify(tokenizeText(text, syntax, { diagnostics }));
  check(a === b, `${name} (${syntax}): tokenizeLine line by line = tokenizeText`, a === b ? '' : `${a.slice(0, 300)}\n  vs ${b.slice(0, 300)}`);
};
for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES, ...SHOWCASE_EXAMPLES]) for (const [k, text] of Object.entries(ex.text ?? {})) for (const syntax of ['auto', 'intel', 'att']) sameAsText(String(text), syntax, `example ${ex.id} (${k})`);
sameAsText('x /* one\ntwo */ add rax, 1\n/* a */ /* b\n c\n d */ dec rcx # /* not\n\tmovl %eax, %ebx /* e */\n', 'intel', 'block comments over lines');
sameAsText('  add rax, 1\n  frob rax; add rbx, 2\n  bogus\n', 'intel', 'diagnostics', [{ line: 2, column: 3, severity: 'error', message: 'invalid instruction mnemonic' }, { line: 3, column: 3, endColumn: 8, severity: 'error' }]);
check(tokenizeLine('/* open', 'intel').open && !tokenizeLine('/* closed */', 'intel').open && tokenizeLine('still */ add', 'intel', { block: true }).tokens[0].kind === 'comment'
  && !tokenizeLine('# /* in a comment', 'intel').open, 'tokenizeLine: the block-comment state at the end of the line');
check(objdumpText(['  401120:\t48 83 c0 01          \tadd    $0x1,%rax']) && !objdumpText(['loop:', '  add rax, 1']) && objdumpLine('  401124:\t49 ff cf  dec') && !objdumpLine('  add rax, 1'), 'objdumpText, objdumpLine');
const fixtures = new URL('tests-js/fixtures/', root);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
const files = walk(fixtures);
for (const f of files) coversText(fs.readFileSync(f, 'utf8'), 'auto', f.pathname.split('/fixtures/')[1]);

// ---- linear, and fast on a 3,000-line paste ------------------------------------------------------------------------
{
  const long = 'add rax, qword ptr [rsi + 8*rcx + 0x10] '.repeat(5000);
  const t0 = performance.now();
  const t = tokenize(long, 'intel');
  const ms = performance.now() - t0;
  check(covers(long, t) && ms < 200, `a 200 KB line: ${ms.toFixed(1)} ms`);
  const semis = ';'.repeat(100000), quotes = '"'.repeat(100000), braces = '{'.repeat(100000);
  const t1 = performance.now();
  for (const s of [semis, quotes, braces, '/*'.repeat(50000), '1:'.repeat(50000), 'st('.repeat(33000), 'a:'.repeat(50000), '{1to'.repeat(25000)]) check(covers(s, tokenize(s, 'intel')), `pathological line (${s.slice(0, 2)}...)`);
  const ms2 = performance.now() - t1;
  check(ms2 < 500, `pathological lines: ${ms2.toFixed(1)} ms`);
}
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (fs.existsSync(wasm) && fs.existsSync(new URL('data/uarch.json', root))) {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  await e.loadArch('SKL', tableBytes('SKL'));
  const sha = SHOWCASE_EXAMPLES.find((x) => x.id === 'sha256');
  const r = await e.analyze(makeRequest(sha.hex, 'SKL'));
  const rows = r.rows.filter((x) => x.kind === 'instr');
  const intel = ['sha256_block:', ...rows.map((x) => `  ${x.label}`)].join('\n');
  let addr = 0;
  const objdump = ['0000000000000000 <sha256_block>:', ...rows.map((x) => {
    const line = `${addr.toString(16).padStart(8)}:\t${x.opcode.toLowerCase().match(/../g).join(' ').padEnd(21)}\t${x.label}`;
    addr += x.opcode.length / 2;
    return line;
  })].join('\n');
  for (const [name, text] of [['Intel', intel], ['objdump', objdump]]) {
    coversText(text, 'auto', `the SHA-256 showcase (${name})`);
    sameAsText(text, 'auto', `the SHA-256 showcase (${name})`);
    for (let i = 0; i < 5; i++) tokenizeText(text, 'auto'); // warm
    const n = 20, t0 = performance.now();
    for (let i = 0; i < n; i++) tokenizeText(text, 'auto');
    const ms = (performance.now() - t0) / n;
    console.log(`  the SHA-256 showcase, ${text.split('\n').length} lines (${name}): ${ms.toFixed(2)} ms per tokenizeText`);
    check(ms < 50, `the SHA-256 showcase (${name}) in a few milliseconds`, `${ms.toFixed(2)} ms`);
  }
}

console.log(`${count} asm-token checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
