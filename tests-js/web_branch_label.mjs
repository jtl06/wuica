// Tests of the shown branch targets (web/js/branch-label.js) and of the A–B table per CPU (web/js/ab-cpus.js,
// abCpuRows). Usage: node tests-js/web_branch_label.mjs
import { startLabel, branchLabels } from '../web/js/branch-label.js';
import { abCpuRows } from '../web/js/ab-cpus.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const j = JSON.stringify;

// ---- startLabel ------------------------------------------------------------------------------------------------------------
check(startLabel('loop:\n  add rax, 1\n  jnz loop\n') === 'loop', 'startLabel: the label in front');
check(startLabel('# comment\n  .p2align 4\n.L3:   # body\n  add rax, 1\n') === '.L3', 'startLabel: after comments and directives');
check(startLabel('; x\n// y\n\n  x1: add rax, 1') === 'x1', 'startLabel: ; and // comments, a label on the instruction\'s line');
check(startLabel('  add rax, 1\nloop:\n  jnz loop') === null, 'startLabel: an instruction first: none');
check(startLabel('') === null && startLabel(null) === null, 'startLabel: no text');

// ---- branchLabels ------------------------------------------------------------------------------------------------------------
const instr = (label, opcode) => ({ kind: 'instr', label, opcode });
// the chain example: 48 83 c0 01 | 48 83 c0 01 | 49 ff cf | 75 f3 (jnz at 11, to 0)
const chain = [instr('add rax, 0x1', '4883C001'), instr('add rax, 0x1', '4883C001'), instr('dec r15', '49FFCF'), instr('jnz 0xfffffffffffffff5', '75F3')];
check(j(branchLabels(chain)) === j([null, null, null, 'jnz loop']), 'branchLabels: the loop branch shows the block\'s label', j(branchLabels(chain)));
check(branchLabels(chain, '.L3')[3] === 'jnz .L3', 'branchLabels: the label of pasted assembly');
// a renamer row does not count as bytes; a branch into the block; one out of it keeps its address
const rows = [{ kind: 'regMerge', label: '<Register Merge Uop>' }, instr('add rax, 0x1', '4883C001'), instr('jz 0x2', '7402'), instr('add rax, 0x1', '4883C001'),
  instr('jmp 0x40', 'EB40'), instr('jb 0xfffffffffffffff4', '72F2')];
const got = branchLabels(rows, 'top');
check(j(got) === j([null, null, 'jz top+0x6', null, null, 'jb top']), 'branchLabels: inside the block as label+offset, outside unchanged', j(got));
check(j(branchLabels([instr('call 0x10', 'E80B000000')])) === j([null]), 'branchLabels: calls unchanged');
check(j(branchLabels(null)) === '[]', 'branchLabels: no rows');

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
const same = abCpuRows(items.slice(0, 1), new Map([['a:SKL', { tp: 2 }], ['b:SKL', { tp: 2.001 }]]));
check(same[0].delta === 0 && same[0].verdict === 'same', 'abCpuRows: the same at two decimals', j(same[0]));

console.log(`${count} branch label checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
