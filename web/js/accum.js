// The "N accumulators" what-if: the loop unrolled N times with its loop-carried register renamed in each copy, so the
// copies form N independent chains (as N accumulators, or N CRC streams, written by hand). The register is the one of
// the critical chain (the response's criticalPath); each copy after the first gets a free register of the same kind,
// and the loop's branch (with its macro-fused compare) stays once at the end, as in the unrolled variants (whatif.js).
// No DOM and no assembling here: the variant is assembly text (.byte lines for what is not renamed, so it keeps its
// exact encoding) that the caller assembles. The npm package has a copy (packages/wuica/lib/web) for MCP what_if.

export const ACCUMULATORS = Object.freeze([2, 3, 4, 8]);

const GPR = [
  ['rax', 'eax', 'ax', 'al', 'ah'], ['rbx', 'ebx', 'bx', 'bl', 'bh'], ['rcx', 'ecx', 'cx', 'cl', 'ch'], ['rdx', 'edx', 'dx', 'dl', 'dh'],
  ['rsi', 'esi', 'si', 'sil'], ['rdi', 'edi', 'di', 'dil'], ['rbp', 'ebp', 'bp', 'bpl'], ['rsp', 'esp', 'sp', 'spl'],
  ...Array.from({ length: 8 }, (_, k) => [`r${k + 8}`, `r${k + 8}d`, `r${k + 8}w`, `r${k + 8}b`]),
];
const FAMILY = new Map(GPR.flatMap((names) => names.map((n, size) => [n, { kind: 'gpr', base: names[0], size }])));
// the registers a copy can get, in this order (not rsp; the ones with implicit uses last)
const GPR_FREE = ['r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'rbx', 'rbp', 'rsi', 'rdi', 'rcx', 'rdx', 'rax'];
// Instructions with implicit register operands (the response has no operand sets without the details: this list is
// the x86-64 instructions that read or write a register they do not name): [test, registers]. 'vall': every vector
// register. Renaming such a register would change what they do, and none of them may get a copy's register.
const IMPLICIT = [
  [/^(?:i?div|mul|cdq|cqo|cwd|rdtsc|xsave\w*|xrstor\w*|in|out)$/, ['rax', 'rdx']],
  [/^(?:cbw|cwde|cdqe|lahf|sahf|cmpxchg|stos\w*|lods\w*|scas\w*)$/, ['rax']],
  [/^(?:cpuid|cmpxchg8b|cmpxchg16b)$/, ['rax', 'rbx', 'rcx', 'rdx']],
  [/^(?:rdtscp|xgetbv|xsetbv|rdmsr|wrmsr|rdpmc|monitor\w*)$/, ['rax', 'rcx', 'rdx']],
  [/^(?:mwait\w*)$/, ['rax', 'rcx']],
  [/^(?:mulx)$/, ['rdx']],
  [/^(?:xlatb?)$/, ['rax', 'rbx']],
  [/^(?:syscall|sysret\w*)$/, ['rax', 'rcx', 'r11']],
  [/^(?:rep\w*|loop\w*|jrcxz|jecxz)$/, ['rcx']],
  [/^(?:movs[bwdq]?|cmps[bwdq]?|stos\w*|lods\w*|scas\w*|ins[bwd]?|outs[bwd]?)$/, ['rsi', 'rdi', 'rcx']],
  [/^(?:ins[bwd]?|outs[bwd]?)$/, ['rdx']],
  [/^(?:v?maskmovq|maskmovdqu|vmaskmovdqu)$/, ['rdi']],
  [/^(?:push\w*|pop\w*|call\w*|ret\w*|enter|leave)$/, ['rsp']],
  [/^(?:enter|leave)$/, ['rbp']],
  // the legacy (non-VEX) blends and SHA-256 rounds read xmm0; the string compares write ecx or xmm0
  [/^(?:blendvps|blendvpd|pblendvb|sha256rnds2)$/, ['v0']],
  [/^(?:v?pcmpestri)$/, ['rax', 'rdx', 'rcx']],
  [/^(?:v?pcmpestrm)$/, ['rax', 'rdx', 'v0']],
  [/^(?:v?pcmpistri)$/, ['rcx']],
  [/^(?:v?pcmpistrm)$/, ['v0']],
  [/^(?:vzeroupper|vzeroall)$/, ['vall']],
];
// a one-operand imul uses rax and rdx implicitly
export const implicitUse = (mnemonic, operands) => {
  const m = String(mnemonic).toLowerCase().replace(/^(?:lock|rep\w*)\s+/, '');
  if (m === 'imul' && !String(operands).includes(',')) return ['rax', 'rdx'];
  return IMPLICIT.filter(([re]) => re.test(m)).flatMap(([, regs]) => regs);
};

const VEC = /^([xyz]mm)(\d+)$/;

// The family of a register name: {kind: 'gpr', base: 'rax', size} or {kind: 'vec', index}; null if not renamable.
export function family(name) {
  const n = String(name).toLowerCase();
  const v = VEC.exec(n);
  if (v) return { kind: 'vec', index: Number(v[2]), base: `v${v[2]}` };
  return FAMILY.get(n) ?? null;
}

// The registers on the critical loop-carried chain: {ok, bases: ['rax' | 'v0', ...], names} or {ok: false, reason}.
export function chainRegisters(response) {
  const edges = response?.criticalPath?.edges;
  if (!Array.isArray(edges) || !edges.length) return { ok: false, reason: 'no loop-carried chain' };
  const bases = [], names = [];
  for (const e of edges) {
    const op = String(e.operand ?? '');
    if (/^mem$/i.test(op)) return { ok: false, reason: 'the chain goes through memory' };
    if (/flags/i.test(op)) return { ok: false, reason: 'the chain goes through the flags' };
    const f = family(op);
    if (!f) return { ok: false, reason: `the chain's register ${op.toLowerCase()} cannot be renamed` };
    if (f.kind === 'gpr' && f.size === 4) return { ok: false, reason: `the chain goes through ${op.toLowerCase()}` }; // ah, bh, ...
    if (!bases.includes(f.base)) { bases.push(f.base); names.push(op.toLowerCase()); }
  }
  return { ok: true, bases, names };
}

const REG_TOKEN = /\b(?:[re]?[abcd]x|[abcd][lh]|[re]?(?:si|di|bp|sp)|(?:si|di|bp|sp)l|r(?:[89]|1[0-5])[dwb]?|[xyz]mm\d+)\b/gi;
const regsIn = (text) => (String(text).match(REG_TOKEN) ?? []).map((r) => r.toLowerCase());

// The text of an instruction with registers renamed: map base -> new base ('rax' -> 'r9', 'v0' -> 'v3'). null if a
// register of the map is used in a form the new one does not have (ah).
function renameText(text, map) {
  let bad = false;
  const out = text.replace(REG_TOKEN, (tok) => {
    const f = family(tok);
    if (!f || !map.has(f.base)) return tok;
    const to = map.get(f.base);
    if (f.kind === 'vec') return tok.slice(0, 3) + to.slice(1);
    const names = GPR.find((g) => g[0] === to);
    const n = names[f.size];
    if (!n) { bad = true; return tok; }
    return tok === tok.toUpperCase() ? n.toUpperCase() : n;
  });
  return bad ? null : out;
}

// Instructions whose first operand is only written (with a 32- or 64-bit general register or a whole vector register:
// a byte or word write keeps the rest of the register; a legacy movss/movsd between registers keeps the upper part).
const WRITE_ONLY = /^(?:v?mov(?:aps|apd|ups|upd|dqa\w*|dqu\w*|ss|sd|d|q)|mov|movzx|movsx\w*|lea|vbroadcast\w+|vpbroadcast\w+|v?pmov[sz]x\w+|v?cvt\w+|pop)$/;
const MERGES = /^(?:movss|movsd|cvt\w+)$/; // legacy forms that merge into the destination
// true if `label` writes register family `base` as its first operand and does not read it
export function writesOnly(label, base) {
  const { mnemonic, operands } = splitInstr(label);
  if (!WRITE_ONLY.test(mnemonic)) return false;
  const ops = operands.split(',').map((o) => o.trim());
  const f = family(ops[0]);
  if (!f || f.base !== base) return false;
  if (f.kind === 'gpr' && f.size > 1) return false;
  if (ops.slice(1).some((o) => regsIn(o).some((r) => family(r)?.base === base))) return false;
  if (MERGES.test(mnemonic) && ops.length === 2 && !/\[/.test(ops[1])) return false;
  return true;
}

// XED's Intel syntax where LLVM's reads it differently (as asm-text.js's llvmSyntax).
function llvmSyntax(asm) {
  return asm
    .replace(/(^\S+ |, )ptr \[/, '$1[')
    .replace(/^(nop \S+ ptr \[[^\]]*\]), [a-z0-9]+$/, '$1')
    .replace(/^xlat$/, 'xlatb');
}

const byteLine = (op) => `  .byte ${op.match(/../g).map((b) => '0x' + b).join(', ')}`;
const splitInstr = (label) => { const t = String(label).trim().replace(/\s+/g, ' '); const i = t.indexOf(' '); return i < 0 ? { mnemonic: t.toLowerCase(), operands: '' } : { mnemonic: t.slice(0, i).toLowerCase(), operands: t.slice(i + 1) }; };

// The variant with n accumulators: {ok: true, text, per: n, renamed: [{from, to: [names]}]} or {ok: false, reason}.
// response: the analysis of hex (a loop); the rows must make up the code (as for the unrolled variants).
export function accumulatorText(response, hex, n) {
  if (response?.mode !== 'loop') return { ok: false, reason: 'not a loop' };
  const rows = Array.isArray(response.rows) ? response.rows : [];
  const ins = [];
  let at = 0;
  rows.forEach((x, row) => {
    if (x.kind !== 'instr') return;
    const op = String(x.opcode ?? '').toLowerCase();
    ins.push({ op, row, label: String(x.label ?? ''), fused: x.notes === 'M', start: at });
    at += op.length / 2;
  });
  if (!ins.length || ins.map((i) => i.op).join('') !== String(hex ?? '').toLowerCase()) return { ok: false, reason: 'the code has bytes that are not instructions' };
  const chain = chainRegisters(response);
  if (!chain.ok) return chain;
  const last = ins.length - 1;
  const tailFrom = ins[last].fused && last > 0 ? last - 1 : last;
  if (tailFrom === 0) return { ok: false, reason: 'nothing but the branch' };
  const body = ins.slice(0, tailFrom), tail = ins.slice(tailFrom);
  // registers in use (any form: al/ax/eax/rax, xmm/ymm/zmm are one register), and the implicit ones
  const uses = (i) => { const s = splitInstr(i.label); return new Set([...regsIn(i.label).map((r) => family(r)?.base).filter(Boolean), ...implicitUse(s.mnemonic, s.operands)]); };
  const usesOf = new Map(ins.map((i) => [i, uses(i)]));
  const used = new Set(ins.flatMap((i) => [...usesOf.get(i)]));
  const implicit = new Set(ins.flatMap((i) => { const s = splitInstr(i.label); return implicitUse(s.mnemonic, s.operands); }));
  for (const b of chain.bases) {
    if (implicit.has(b) || (b.startsWith('v') && implicit.has('vall'))) return { ok: false, reason: `${chain.names[chain.bases.indexOf(b)]} is an implicit operand` };
  }
  // a register used in an address is the loop's induction variable (a pointer or an index), not an accumulator
  const addressed = new Set(ins.flatMap((i) => [...i.label.matchAll(/\[([^\]]*)\]/g)].flatMap((m) => regsIn(m[1]))).map((r) => family(r)?.base));
  const induction = chain.bases.find((b) => addressed.has(b));
  if (induction) return { ok: false, reason: `the chain is the induction variable ${chain.names[chain.bases.indexOf(induction)]} (used in an address), not an accumulator` };
  // the chain's register read by an instruction off the chain (a store of a running sum): splitting the chain would
  // change what it reads. Writing it off the chain is sound (clang reuses the chain's registers for loads: the copy's
  // registers are renamed as a whole, the load with them).
  const onChain = new Set(response.criticalPath.edges.flatMap((e) => [e.from, e.to]));
  for (const i of ins) {
    if (onChain.has(i.row)) continue;
    const b = chain.bases.find((x) => usesOf.get(i).has(x) && !writesOnly(i.label, x));
    if (b) return { ok: false, reason: `${chain.names[chain.bases.indexOf(b)]}'s running value is also read off the chain (${i.label}): it cannot be split` };
  }
  // free registers for the copies after the first
  const freeGpr = GPR_FREE.filter((r) => !used.has(r) && !implicit.has(r));
  const usesEvex = ins.some((i) => /\b[xyz]mm(?:1[6-9]|2\d|3[01])\b/i.test(i.label));
  const freeVec = Array.from({ length: usesEvex ? 32 : 16 }, (_, k) => `v${k}`).filter((v) => !used.has(v) && !implicit.has(v));
  const maps = Array.from({ length: n }, () => new Map());
  const renamed = [];
  for (const b of chain.bases) {
    const pool = b.startsWith('v') ? freeVec : freeGpr;
    if (pool.length < n - 1) return { ok: false, reason: `${n - 1} free registers needed for ${chain.names[chain.bases.indexOf(b)]}` };
    const to = pool.splice(0, n - 1);
    to.forEach((r, k) => maps[k + 1].set(b, r));
    renamed.push({ from: chain.names[chain.bases.indexOf(b)], to: to.map((r) => renameText(chain.names[chain.bases.indexOf(b)], new Map([[b, r]]))) });
  }
  const lines = [];
  for (let k = 0; k < n; k++) {
    for (const i of body) {
      const touches = k > 0 && regsIn(i.label).some((r) => maps[k].has(family(r)?.base));
      if (!touches) { lines.push(byteLine(i.op)); continue; }
      const t = renameText(llvmSyntax(i.label), maps[k]);
      if (t === null) return { ok: false, reason: `${i.label}: the register has no such form in its copy` };
      lines.push(`  ${t}`);
    }
  }
  for (const i of tail) lines.push(byteLine(i.op));
  return { ok: true, text: lines.join('\n') + '\n', per: n, renamed };
}

// The best number of accumulators from the throughput per original iteration of each (n -> tp; 1: the loop as it is):
// the smallest n within 1% of the fastest. {n, tp} or null.
export function bestAccumulators(tps) {
  const all = [...tps].filter(([, tp]) => Number.isFinite(tp) && tp > 0).sort((a, b) => a[0] - b[0]);
  if (!all.length) return null;
  const min = Math.min(...all.map(([, tp]) => tp));
  const [n, tp] = all.find(([, t]) => t <= min * 1.01 + 0.005);
  return { n, tp };
}
