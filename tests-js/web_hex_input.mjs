// Tests of the hex input parser of the web page. Usage: node tests-js/web_hex_input.mjs
import { parseHexInput, toHex, hexToBytes } from '../web/js/hex-input.js';

let failed = 0, count = 0;
function ok(name, text, hex, format) {
  count++;
  const r = parseHexInput(text);
  if (!r.ok || r.hex !== hex || (format && r.format !== format) || toHex(r.bytes) !== hex) {
    failed++;
    console.log(`FAIL ${name}: expected ${hex}${format ? ' (' + format + ')' : ''}, got ${JSON.stringify(r.ok ? [r.hex, r.format] : r)}`);
  }
}
function bad(name, text, code, messageRe, line) {
  count++;
  const r = parseHexInput(text);
  if (r.ok || r.code !== code || (messageRe && !messageRe.test(r.message)) || (line && r.line !== line)) {
    failed++;
    console.log(`FAIL ${name}: expected error ${code}, got ${JSON.stringify(r.ok ? r.hex : r)}`);
  }
}

const LOOP = '4801d84801c349ffcf75f5';

// plain forms
ok('plain', '4801d84801c349ffcf75f5', LOOP, 'plain');
ok('upper', '4801D84801C349FFCF75F5', LOOP, 'plain');
ok('spaces', '48 01 d8 48 01 c3 49 ff cf 75 f5', LOOP, 'plain');
ok('newlines', '4801d8\n4801c3\r\n49ffcf\n75f5\n', LOOP, 'plain');
ok('groups split inside a byte', '4801d 84801c349ffcf75f 5', LOOP, 'plain');
ok('double spaces between groups', '48 01 d8  48 01 c3  49 ff cf  75 f5', LOOP, 'plain');
ok('0x list', '0x48, 0x01, 0xd8, 0x48, 0x01, 0xc3, 0x49, 0xff, 0xcf, 0x75, 0xf5', LOOP, 'plain');
ok('0X upper', '0X48,0X01,0XD8', '4801d8', 'plain');
ok('0x word', '0x4801d8', '4801d8', 'plain');
ok('0x one digit is padded', '0x1 0x48 0x5', '014805', 'plain');
ok('C array', 'unsigned_char: { 0x48, 0x01, 0xd8 }'.replace('unsigned_char: ', ''), '4801d8', 'plain');
ok('\\x escapes', '\\x48\\x01\\xd8\\x48\\x01\\xc3', '4801d84801c3', 'plain');
ok('\\x string', '"\\x48\\x01\\xd8"', '4801d8', 'plain');
ok('python bytes', 'b"\\x48\\x01\\xd8" b\'\\x90\'', '4801d890', 'plain');
ok('h suffix', '48h, 01h, 0d8h'.replace('0d8h', 'd8h'), '4801d8', 'plain');
ok('comments', '4801d8 ; add rax, rbx\n4801c3 # add rbx, rax\n49ffcf // dec r15\n75f5', LOOP, 'plain');
ok('mixed', '48 0x01 \\xd8', '4801d8', 'plain');
ok('one byte', '90', '90', 'plain');
ok('hex-looking words are bytes in plain mode', 'dead beef', 'deadbeef', 'plain');

// GNU objdump -d (tabs)
const OBJDUMP = `
loop.o:     file format elf64-x86-64


Disassembly of section .text:

0000000000000000 <loop>:
   0:\t48 01 d8             \tadd    %rbx,%rax
   3:\t48 01 c3             \tadd    %rax,%rbx
   6:\t49 ff cf             \tdec    %r15
   9:\t75 f5                \tjne    0 <loop>
`;
ok('objdump -d', OBJDUMP, LOOP, 'listing');
ok('objdump, tabs pasted as spaces', OBJDUMP.replace(/\t/g, '    '), LOOP, 'listing');
ok('objdump, white space collapsed', OBJDUMP.replace(/[ \t]+/g, ' '), LOOP, 'listing');

// traps: mnemonics and operands that look like hex
const TRAPS = `
0000000000401000 <f>:
  401000:\t01 d8                \tadd    %ebx,%eax
  401002:\t11 d8                \tadc    %ebx,%eax
  401004:\tff c8                \tdec    %eax
  401006:\td8 c1                \tfadd   %st(1),%st
  401008:\tb8 ad de 00 00       \tmov    $0xdead,%eax
  40100d:\t06                   \t(bad)
  40100e:\tfc                   \tcld
  40100f:\tc3                   \tret
`;
const TRAPS_HEX = '01d811d8ffc8d8c1b8adde000006fcc3';
ok('hex-looking mnemonics', TRAPS, TRAPS_HEX, 'listing');
ok('hex-looking mnemonics, spaces', TRAPS.replace(/\t/g, '  '), TRAPS_HEX, 'listing');
ok('hex-looking mnemonics, collapsed', TRAPS.replace(/[ \t]+/g, ' '), TRAPS_HEX, 'listing');

// wrapped instruction (continuation line with bytes only)
ok('continuation lines', `
   0:\t48 b8 00 00 00 00 00 \tmovabs $0x4000000000000000,%rax
   7:\t00 00 40
   a:\t66 4c 0f 6e c0       \tmovq   %rax,%xmm8
`, '48b80000000000000040664c0f6ec0', 'listing');

// llvm-objdump -d (one space after the address)
ok('llvm-objdump', `
loop.o:\tfile format elf64-x86-64

Disassembly of section .text:

0000000000000000 <loop>:
       0: 48 01 d8                     \taddq\t%rbx, %rax
       3: 48 01 c3                     \taddq\t%rax, %rbx
       6: 49 ff cf                     \tdecq\t%r15
       9: 75 f5                        \tjne\t0x0 <loop>
`, LOOP, 'listing');

// Compiler Explorer, binary output
ok('compiler explorer with addresses', `
loop:
 401000:\t48 01 d8             \tadd    rax,rbx
 401003:\t48 01 c3             \tadd    rbx,rax
 401006:\t49 ff cf             \tdec    r15
 401009:\t75 f5                \tjne    401000 <loop>
`, LOOP, 'listing');
ok('compiler explorer without addresses', `
loop:
 48 01 d8             \tadd    rax,rbx
 48 01 c3             \tadd    rbx,rax
 49 ff cf             \tdec    r15
 75 f5                \tjne    401000 <loop>
`, LOOP, 'listing');
ok('bytes, gap, mnemonic (spaces)', '48 01 d8    add rax, rbx\n49 ff cf    dec r15\nc3    ret', '4801d849ffcfc3', 'listing');

// other tools
ok('lldb / capstone style', '0x1000:\t48 01 d8\tadd rax, rbx\n0x1003:\tc3\tret', '4801d8c3', 'listing');
ok('xxd', '00000000: 4801 d848 01c3 49ff cf75 f5              H..H..I..u.', LOOP, 'listing');
ok('xxd ascii column with hex letters', '00000000: 6162 6364 6566                           abcdef', '616263646566', 'listing');
ok('llvm-mc --show-encoding', '\taddq\t%rbx, %rax                # encoding: [0x48,0x01,0xd8]\n\tdecq\t%r15  # encoding: [0x49,0xff,0xcf]', '4801d849ffcf', 'listing');
ok('listing of the page itself', '   0:  48 83 c0 01    add rax, 0x1\n   4:  49 ff cf       dec r15\n   7:  75 f7          jnz 0x0', '4883c00149ffcf75f7', 'listing');

// errors
bad('empty', '', 'empty');
bad('white space', ' \n\t\n', 'empty');
bad('only a comment', '; nothing here', 'no-bytes');
bad('odd', '4801d', 'odd', /Odd number of hex digits \(5\)/);
bad('odd over lines', '48 01\nd', 'odd');
bad('odd 0x token', '0x123', 'odd');
bad('odd before a prefixed token', '480 0x01', 'odd');
bad('not hex', '48 01 zz', 'invalid', /"zz"/);
bad('assembly text', 'add rax, rbx', 'invalid', /"rax"/);
bad('line number', '48\n01\nxyz', 'invalid', /"xyz"/, 3);
bad('line number of an odd run', '48\n01 5\n; end', 'odd', null, 2);
bad('objdump --no-show-raw-insn', `
loop.o:     file format elf64-x86-64

Disassembly of section .text:

0000000000000000 <loop>:
   0:\tadd    %rbx,%rax
   3:\tadd    %rax,%rbx
   6:\tdec    %r15
   9:\tjne    0 <loop>
`, 'no-bytes', /byte column/);
bad('no-show-raw-insn, spaces', '   0:   add    %rbx,%rax\n   3:   dec    %eax\n', 'no-bytes');
bad('unresolved fixup in llvm-mc output', '\tjne\tloop  # encoding: [0x75,A]', 'invalid');

// helpers
count++;
if (toHex(hexToBytes('00ff10a5')) !== '00ff10a5') { failed++; console.log('FAIL hexToBytes/toHex round trip'); }

console.log(`${count} hex input cases, ${failed} failed`);
process.exit(failed ? 1 : 0);
