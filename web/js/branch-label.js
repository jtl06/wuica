// Branch targets in the uop table as labels. The analyzer disassembles every instruction at address 0, so a loop
// branch reads "jnz 0xfffffffffffffff4": its target relative to the instruction. Added to the instruction's offset in
// the block, that is the target in the block: the block's start is shown as its label ("loop", or the label in front
// of pasted assembly), another position in the block as "loop+0x10"; a target outside the block keeps its address.
// Only what is shown changes: the rows' labels (the listing, the diff, the exports) stay as they are.
// No DOM (tests-js/web_branch_label.mjs).

const BRANCH = /^((?:(?:bnd|notrack)\s+)?(?:j[a-z]{1,4}|loop[a-z]{0,2}|jrcxz|jecxz|xbegin))\s+(0x[0-9a-f]{1,16})$/i;
const LABEL = /^\s*([A-Za-z_.$@][\w.$@]*)\s*:/;

// The label in front of the first instruction of assembly text ("loop", ".L3"), or null.
export function startLabel(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/(#|\/\/|;).*$/, '').trim();
    if (line === '') continue;
    const m = LABEL.exec(line);
    if (m) return m[1];
    if (line.startsWith('.')) continue; // a directive (.p2align, .loc, ...)
    return null;                        // an instruction first
  }
  return null;
}

// The shown label of each row (an array as long as rows): the branch with its target as a label, else null (the row's
// own label). name: the label of the block's start.
export function branchLabels(rows, name = 'loop') {
  const list = Array.isArray(rows) ? rows : [];
  const out = new Array(list.length).fill(null);
  const starts = [];
  let offset = 0;
  for (const r of list) {
    starts.push(offset);
    if (r?.kind === 'instr' && typeof r.opcode === 'string') offset += r.opcode.length >> 1;
  }
  const size = offset;
  const label = name || 'loop';
  list.forEach((r, i) => {
    if (r?.kind !== 'instr') return;
    const m = BRANCH.exec(String(r.label ?? '').trim());
    if (!m) return;
    let t = BigInt(m[2]);
    if (t >= 1n << 63n) t -= 1n << 64n;
    const target = starts[i] + Number(t);
    if (!Number.isSafeInteger(target) || target < 0 || target > size) return;
    out[i] = `${m[1]} ${target === 0 ? label : `${label}+0x${target.toString(16)}`}`;
  });
  return out;
}
