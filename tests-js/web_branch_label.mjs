// Tests of the shown branch targets (web/js/branch-label.js) and of the A–B table per CPU (web/js/ab-cpus.js,
// abCpuRows). Usage: node tests-js/web_branch_label.mjs
import { branchLabels, codeStatements, analyzedLines } from '../web/js/branch-label.js';
import { abCpuRows } from '../web/js/ab-cpus.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const j = JSON.stringify;

// ---- branchLabels ------------------------------------------------------------------------------------------------------------
// rows as the analyzer gives them: the target relative to the instruction (disassembled at address 0)
const instr = (label, opcode) => ({ kind: 'instr', label, opcode });
const rel = (n) => `0x${(n < 0 ? (1n << 64n) + BigInt(n) : BigInt(n)).toString(16)}`;
const src = (text) => ({ text, from: 1, to: Infinity });
// machine code (the chain example, jnz at 11 to 0): the offset in the block, no invented name
const chain = [instr('add rax, 0x1', '4883C001'), instr('add rax, 0x1', '4883C001'), instr('dec r15', '49FFCF'), instr('jnz 0xfffffffffffffff5', '75F3')];
check(j(branchLabels(chain)) === j([null, null, null, 'jnz 0x0']), 'machine code: the offset in the block', j(branchLabels(chain)));
// the target at a label of the text, not at the block's start
const mid = [instr('add rax, 0x1', '4883C001'), instr('dec rcx', '48FFC9'), instr(`jnz ${rel(-3)}`, '75FB')];
check(branchLabels(mid, src('  add rax, 1\nloop:\n  dec rcx\n  jnz loop\n'))[2] === 'jnz loop', 'a label in the middle: that label', j(branchLabels(mid, src('  add rax, 1\nloop:\n  dec rcx\n  jnz loop\n'))));
// two loops: each branch its own label
const nest = [instr('add rax, 0x1', '4883C001'), instr('dec rcx', '48FFC9'), instr(`jnz ${rel(-3)}`, '75FB'), instr('dec rdx', '48FFCA'), instr(`jnz ${rel(-12)}`, '75F2')];
const nestText = 'outer:\n  add rax, 1\ninner:\n  dec rcx\n  jnz inner\n  dec rdx\n  jnz outer\n';
check(j(branchLabels(nest, src(nestText))) === j([null, null, 'jnz inner', null, 'jnz outer']), 'nested: inner and outer', j(branchLabels(nest, src(nestText))));
// GNU numeric labels, as written
const num = [instr('dec rcx', '48FFC9'), instr(`jnz ${rel(-3)}`, '75FB')];
check(branchLabels(num, src('1:\n  dec rcx\n  jnz 1b\n'))[1] === 'jnz 1b', 'GNU numeric label: as written');
// no symbol written: the label at the target, else the nearest one before it plus the offset; outside: unchanged
const rows = [{ kind: 'regMerge', label: '<Register Merge Uop>' }, instr('add rax, 0x1', '4883C001'), instr('jz 0x2', '7402'), instr('add rax, 0x1', '4883C001'),
  instr('jmp 0x40', 'EB40'), instr(`jb ${rel(-12)}`, '72F2')];
const t1 = 'top:\n  add rax, 1\n  jz .+4\n  add rax, 1\n  jmp far\n  jb .-12\n';
check(j(branchLabels(rows, src(t1))) === j([null, null, 'jz top+0x6', null, null, 'jb top']), 'the nearest label before plus the offset; a label exactly at the target; outside unchanged', j(branchLabels(rows, src(t1))));
// before the first label: the offset, not a name
check(branchLabels(mid, src('  add rax, 1\nx:\n  dec rcx\n  jnz .-7\n'))[2] === 'jnz x', 'at a label (written as an expression): the label');
const before = [instr('add rax, 0x1', '4883C001'), instr('dec rcx', '48FFC9'), instr(`jnz ${rel(-7)}`, '75F7')];
check(branchLabels(before, src('  add rax, 1\nx:\n  dec rcx\n  jnz .-7\n'))[2] === 'jnz 0x0', 'before the first label: the offset in the block');
// the end of the block: a loop's exit (defined right after the picked code), or a label defined there
const exit = [instr('dec rcx', '48FFC9'), instr('jz 0x4', '7402'), instr(`jmp ${rel(-5)}`, 'EBF9')];
check(j(branchLabels(exit, src('loop:\n  dec rcx\n  jz .Lout\n  jmp loop\n'))) === j([null, 'jz .Lout', 'jmp loop']), 'an exit of the loop: its label', j(branchLabels(exit, src('loop:\n  dec rcx\n  jz .Lout\n  jmp loop\n'))));
check(branchLabels(exit, src('loop:\n  dec rcx\n  jz .+4\n  jmp loop\ndone:\n'))[1] === 'jz done', 'the end of the block: the label defined there');
check(branchLabels(exit, src('loop:\n  dec rcx\n  jz .+4\n  jmp loop\n'))[1] === 'jz loop+0x7', 'the end of the block, no label there: the nearest one before');
// statements that do not match the rows one to one: offsets only
check(branchLabels(mid, src('  add rax, 1\n  .p2align 4\nloop:\n  dec rcx\n  jnz loop\n'))[2] === 'jnz 0x4', 'an alignment directive in the code: offsets only');
check(branchLabels(mid, src('loop:\n  dec rcx\n  jnz loop\n'))[2] === 'jnz 0x4', 'more rows than statements: offsets only');
check(j(branchLabels([instr('call 0x10', 'E80B000000')])) === j([null]), 'calls unchanged');
check(j(branchLabels(null)) === '[]', 'no rows');
// the statements of the text: comments, ';' lines, labels on an instruction's line, directives without code
check(j(codeStatements('# c\n; d\nx: y: add rax, 1 # e\n  .loc 1 2 3\n  lock add [rax], 1\n')) === j([{ kind: 'label', name: 'x' }, { kind: 'label', name: 'y' }, { kind: 'instr', operand: 'rax, 1' }, { kind: 'instr', operand: '[rax], 1' }]),
  'codeStatements', j(codeStatements('# c\n; d\nx: y: add rax, 1 # e\n  .loc 1 2 3\n  lock add [rax], 1\n')));
// the analyzed lines: the picked loop, a marked region, the whole text
check(j(analyzedLines('a\nb\nc\nd', { loop: { line: 2, endLine: 3 } })) === j({ text: 'a\nb\nc\nd', from: 2, to: 3 }), 'analyzedLines: the picked loop');
check(j(analyzedLines('a\n# wuica-begin\nb\nc\n# wuica-end\nd', { region: { line: 2 } })) === j({ text: 'a\n# wuica-begin\nb\nc\n# wuica-end\nd', from: 3, to: 4 }), 'analyzedLines: a marked region');

// ---- abCpuRows ---------------------------------------------------------------------------------------------------------------
const items = [{ key: 'SKL', title: 'Skylake' }, { key: 'ZEN3', title: 'Zen 3', experimental: true }, { key: 'ADL-P' }, { key: 'ICL' }];
const res = new Map([['a:SKL', { tp: 4 }], ['b:SKL', { tp: 2 }], ['a:ZEN3', { tp: 2 }], ['b:ZEN3', { tp: 4 }], ['a:ADL-P', { tp: 3 }], ['b:ADL-P', { error: 'boom' }], ['a:ICL', { tp: 1 }]]);
const r = abCpuRows(items, res, { current: 'ZEN3' });
check(r[0].state === 'ok' && r[0].a === 4 && r[0].b === 2 && r[0].delta === -2 && r[0].pct === -50 && r[0].speedup === 2 && r[0].verdict === 'better', 'abCpuRows: B better', j(r[0]));
check(r[1].verdict === 'worse' && r[1].current && r[1].experimental && r[1].speedup === 0.5, 'abCpuRows: B worse; the current CPU', j(r[1]));
check(r[2].state === 'error' && r[2].a === 3 && r[2].b === null && r[2].error === 'boom', 'abCpuRows: an error', j(r[2]));
check(r[3].state === 'pending' && r[3].a === 1 && r[3].b === null, 'abCpuRows: pending', j(r[3]));
const w = abCpuRows(items.slice(0, 1), res, { workA: 1, workB: 4 });
check(w[0].a === 4 && w[0].b === 0.5 && w[0].speedup === 8 && w[0].verdict === 'better', 'abCpuRows: per element (B does 4 elements per iteration)', j(w[0]));
const tiny = abCpuRows(items.slice(0, 1), new Map([['a:SKL', { tp: 2 }], ['b:SKL', { tp: 2 }]]), { workA: 128, workB: 160 });
check(tiny[0].verdict === 'better' && Math.abs(tiny[0].pct + 20) < 1e-9 && Math.abs(tiny[0].speedup - 1.25) < 1e-9, 'abCpuRows: small values per element, relative and unrounded', j(tiny[0]));
const same = abCpuRows(items.slice(0, 1), new Map([['a:SKL', { tp: 2 }], ['b:SKL', { tp: 2.001 }]]));
check(same[0].delta === 0 && same[0].verdict === 'same', 'abCpuRows: the same at two decimals', j(same[0]));

console.log(`${count} branch label checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
