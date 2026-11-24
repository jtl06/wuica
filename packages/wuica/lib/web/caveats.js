// Known blind spots of the model, found in a response's instructions (no analysis): what uiCA does not simulate and
// that the block is likely to meet. Shown as one small line under the throughput (render.js) and as insights.caveats in
// the API (the npm package has a copy: packages/wuica/lib/web). No DOM.
//   rmw-index  a read-modify-write to an indexed address (inc dword ptr [rsp+rdx*4]), or a load and a store to the same
//              indexed address, where a register of the address is written in the loop other than by advancing it by a
//              constant (rdx loaded from the data): whether an iteration's load waits for an earlier store (store
//              forwarding) depends on the data (a histogram of repeated bytes); uiCA assumes it does not. Not for an
//              address of induction registers only (saxpy's [rsi+rax*4], rax advanced by add rax, 8: never the same
//              location twice) nor for a loop-invariant one (the same location every iteration: the model has that
//              chain through memory, criticalPath operand "mem").
//   exit       a loop with an exit before its branch (a search; a forward branch within the loop, an if, is not an
//              exit): the exit's mispredict, once per call, is not modelled;
//              with short trip counts it can cost more than the loop.
//   call       a call in the block (a loop that calls a function): the call instruction is simulated, the function it
//              calls is not.
//   paths      a conditional branch before the last instruction whose target is inside the block (an if/else, or a
//              second back edge: clang's remainder loop of sum_mod, `jne .LBB0_9` back to the top and the latch to the
//              middle): uiCA runs the block straight through, so both sides of the branch are simulated one after the
//              other, while a real iteration takes one. Not an inner loop's back edge (backward, to after the target
//              of the block's own branch: the outer loop of count_u8). Named by source line when the response has the
//              lines of the picked span (response.loop.lines, the package's analyze; alignment padding, nops the
//              source does not have, left out), else by instruction. Region markers around one side analyze that side.
//   split      loads at an offset that is not a multiple of their width (ymmword ptr [rdi+rax*4+0x4]): with a base
//              aligned to the width, some of them cross a 64-byte line (split loads cost extra). Per CPU (`config`, its
//              configuration in uarch.json): where splitLoadCycles is 0 (the stock Intel models) no crossing is charged,
//              so every such load warns. Where it is > 0 (ZEN3, ADL-P, ICX) the model charges the crossings of a load
//              whose address registers change only by adding an immediate (add, sub, inc, dec; instr_builder.rs,
//              split_load_patterns), assuming the start alignment with the fewest crossings; only loads with an
//              address register written otherwise (mov, lea, a load, ...) warn, worded for that.

import { family } from './accum.js';

const SIZE = { byte: 1, word: 2, dword: 4, qword: 8, xmmword: 16, ymmword: 32, zmmword: 64, tbyte: 10 };
const RMW = /^(?:add|adc|sub|sbb|and|or|xor|inc|dec|neg|not|shl|shr|sar|sal|rol|ror|rcl|rcr|xadd|btc|btr|bts|cmpxchg\w*)$/;
// a memory operand in any position is read and written (xchg [mem], reg or xchg reg, [mem])
const RMW_ANY = /^xchg$/;
// an address that is not an access (lea), or hints that move no data the loop uses
const NO_ACCESS = /^(?:lea|nop\w*|prefetch\w*|clflush\w*|clwb|cldemote)$/;
// instructions whose memory destination is only written (a store, not a read)
const STORE_ONLY = /^(?:v?mov\w*|movnt\w*|stos\w*|set\w+|v?pextr\w+|v?extract\w*|vextract\w+|v?pmovm\w*|vp?scatter\w+|vmaskmov\w*|vpmaskmov\w*|v?cvt\w*|push\w*|pop\w*|fstp?\w*|fistp?\w*)$/;
const COND_BRANCH = /^(?:j(?!mp)[a-z]+|loop\w*)$/;
// Splits with a split-load cost: what writes a general-purpose register. An add or sub of an immediate, inc or dec, to a
// 32- or 64-bit register keeps it advancing by a constant (instr_builder.rs, affine_delta); any other write does not.
// Without a register destination (cmp, test, bt, push, branches) the first operand is only read.
const READS_FIRST = /^(?:cmp|test|bt|push\w*|call\w*|jmp|j[a-z]+|loop\w*|out\w*|v?u?comis[sd]|v?ptest|kortest\w|ktest\w|nop\w*|prefetch\w*|clflush\w*|clwb|cldemote)$/;
const BOTH_WRITTEN = /^(?:xchg|xadd|mulx)$/; // the second register operand is written too
/** @type {[RegExp, string[]][]} */
const IMPLICIT_WRITES = [
  [/^(?:i?div|mul|cdq|cqo|cwd|rdtsc)$/, ['rax', 'rdx']],
  [/^(?:cbw|cwde|cdqe|lahf|cmpxchg|lods\w*)$/, ['rax']],
  [/^(?:cpuid|cmpxchg8b|cmpxchg16b)$/, ['rax', 'rbx', 'rcx', 'rdx']],
  [/^(?:rdtscp|rdmsr|rdpmc|xgetbv)$/, ['rax', 'rcx', 'rdx']],
  [/^(?:syscall)$/, ['rcx', 'r11']],
  [/^(?:loop\w*)$/, ['rcx']],
  [/^(?:movs[bwdq]?|cmps[bwdq]?)$/, ['rsi', 'rdi']],
  [/^(?:stos\w*|scas\w*|ins[bwd]?)$/, ['rdi']],
  [/^(?:lods\w*|outs[bwd]?)$/, ['rsi']],
  [/^(?:v?pcmpestri|v?pcmpistri)$/, ['rcx']],
  [/^(?:push\w*|pop\w*|call\w*|ret\w*|enter|leave)$/, ['rsp']],
  [/^(?:leave)$/, ['rbp']],
];
const IMM = /^-?(?:0x[0-9a-f]+|\d+)$/i;
// {register family: [rows]} of the writes that do not advance a register by a constant. lea: lea r, [r+imm] advances it
// too (for rmw-index; the split-load model, affine_delta, does not count it)
function untrackedWrites(rows, { lea = false } = {}) {
  const out = new Map();
  const add = (reg, row) => { const f = family(reg); if (f?.kind === 'gpr') (out.get(f.base) ?? out.set(f.base, []).get(f.base)).push(row); };
  rows.forEach((x, row) => {
    if (x?.kind !== 'instr') return;
    const t = String(x.label).trim().replace(/\s+/g, ' ').toLowerCase();
    const rep = /^rep\w* /.test(t);
    const u = t.replace(/^(?:lock|rep[a-z]*|notrack|bnd) /, '');
    const sp = u.indexOf(' ');
    const mn = sp < 0 ? u : u.slice(0, sp);
    const ops = sp < 0 ? [] : u.slice(sp + 1).split(',').map((o) => o.trim());
    if (rep) add('rcx', row);
    for (const [re, regs] of IMPLICIT_WRITES) if (re.test(mn)) for (const r of regs) add(r, row);
    if (mn === 'imul' && ops.length === 1) { add('rax', row); add('rdx', row); }
    if (!ops.length || READS_FIRST.test(mn)) return;
    const f = family(ops[0]);
    if (f?.kind === 'gpr') {
      const self = lea && mn === 'lea' && ops.length === 2 && new RegExp(`^(?:(?:\\w+ )?ptr )?\\[${ops[0]}(?:[+-](?:0x[0-9a-f]+|\\d+))?\\]$`).test(ops[1]);
      const affine = f.size <= 1 && (((mn === 'add' || mn === 'sub') && ops.length === 2 && IMM.test(ops[1])) || ((mn === 'inc' || mn === 'dec') && ops.length === 1) || self);
      if (!affine) add(ops[0], row);
    }
    if (BOTH_WRITTEN.test(mn) && ops[1]) add(ops[1], row);
  });
  return out;
}

// The memory operand of an instruction label (XED's Intel syntax): {first, size, base, index, disp, text} or null.
export function memOperand(label) {
  const t = String(label).trim().replace(/\s+/g, ' ').replace(/^(?:lock|rep[a-z]*|notrack|bnd) /i, '');
  const sp = t.indexOf(' ');
  if (sp < 0) return null;
  const mnemonic = t.slice(0, sp).toLowerCase();
  if (NO_ACCESS.test(mnemonic)) return null;
  const ops = t.slice(sp + 1);
  const m = /(?:(\w+) ptr )?\[([^\]]*)\]/.exec(ops);
  if (!m) return null;
  const inner = m[2].replace(/\s/g, '').toLowerCase();
  const parts = inner.split(/(?=[+-])/);
  /** @type {string | null} */
  let base = null;
  /** @type {string | null} */
  let index = null;
  let disp = 0;
  for (const p of parts) {
    const v = p.replace(/^\+/, '');
    if (/\*/.test(v)) index = v.split('*')[0];
    else if (/^-?(?:0x[0-9a-f]+|\d+)$/.test(v)) disp += Number(v.startsWith('-') ? -Number(v.slice(1)) : Number(v));
    else if (/^[a-z]\w*$/.test(v)) { if (base === null) base = v; else index = v; }
  }
  if (base === 'rip') return null;
  return { mnemonic, first: ops.indexOf('[') <= (ops.indexOf(',') < 0 ? ops.length : ops.indexOf(',')), size: SIZE[String(m[1] ?? '').toLowerCase()] ?? null, base, index, disp, text: m[0].replace(/^\w+ ptr /, '') };
}

// [{id, text, title, rows}] (rows: indices into response.rows), in the order rmw-index, paths, exit, split; [] if none.
// config: the CPU's configuration in uarch.json (configs[response.arch]); only splitLoadCycles is read. Without it, as on
// a CPU without a split-load cost. Kept per response and split-load cost (the result view is drawn again on every
// change of its own controls).
const memo = new WeakMap();
const some = (rows, ks) => `${ks.slice(0, 4).map((k) => rows[k].label).join('; ')}${ks.length > 4 ? '; …' : ''}`;
/** @param {{splitLoadCycles?: number} | null} [config] */
export function caveats(response, config = null) {
  const splitCost = Number(config?.splitLoadCycles) > 0;
  const kept = response && typeof response === 'object' ? memo.get(response) : undefined;
  if (kept?.has(splitCost)) return kept.get(splitCost);
  const rows = Array.isArray(response?.rows) ? response.rows : [];
  const out = [];
  const rmw = [], split = [], early = [], inside = [];
  const target = (row, op) => {
    const v = /^0x[0-9a-f]+$/i.test(op ?? '') ? Number(BigInt.asIntN(64, BigInt(op))) : null;
    return v === null ? null : offset.get(row) + v;
  };
  const loads = new Map(), stores = new Map();
  let last = -1, total = 0;
  const offset = new Map();
  rows.forEach((x, row) => { if (x?.kind === 'instr') { last = row; offset.set(row, total); total += String(x.opcode ?? '').length / 2; } });
  // where the block's own branch goes (the loop's header; not always the top: a rotated loop)
  const [lastMn, lastOp] = last >= 0 ? String(rows[last].label).trim().split(/\s+/) : [];
  const latch = last >= 0 && /^(?:j[a-z]+|loop\w*)$/.test(String(lastMn).toLowerCase()) ? target(last, lastOp) : null;
  const head = latch !== null && latch >= 0 && latch < total ? latch : 0;
  rows.forEach((x, row) => {
    if (x?.kind !== 'instr') return;
    const [mn, op] = String(x.label).trim().split(/\s+/);
    if (row !== last && COND_BRANCH.test(mn.toLowerCase())) {
      // the label's target is relative to the branch (XED, as if it were at address 0): inside the loop's code (an
      // if) it is not an exit
      const to = target(row, op);
      if (to === null || to < 0 || to >= total) early.push(row);
      // forward (an if/else), or back to the header or before it (a second back edge, a rotated if/else); backward to
      // after the header is an inner loop's back edge
      else if (to > offset.get(row) || to <= head) inside.push(row);
    }
    const m = memOperand(x.label);
    if (!m) return;
    const storeOnly = m.first && STORE_ONLY.test(m.mnemonic);
    // read-modify-write, or a load and a store, to the same indexed address
    if (m.index) {
      if ((m.first && RMW.test(m.mnemonic)) || RMW_ANY.test(m.mnemonic)) rmw.push(row);
      else if (storeOnly) (stores.get(m.text) ?? stores.set(m.text, []).get(m.text)).push(row);
      else if (!m.first) (loads.get(m.text) ?? loads.set(m.text, []).get(m.text)).push(row);
    }
    // a load that may split a cache line
    if (!storeOnly && m.size && m.size >= 2 && m.size <= 64 && ((m.disp % m.size) + m.size) % m.size !== 0) split.push(row);
  });
  for (const [addr, st] of stores) if (loads.has(addr)) rmw.push(...loads.get(addr), ...st);
  // only where the address can repeat with the data: a register of it written other than by advancing it by a constant
  const dynamic = rmw.length ? untrackedWrites(rows, { lea: true }) : null;
  const hit = rmw.filter((row) => { const m = memOperand(rows[row].label); return [m?.base, m?.index].some((r) => dynamic?.has(family(r)?.base)); });
  if (hit.length) {
    const r = [...new Set(hit)].sort((a, b) => a - b);
    out.push({ id: 'rmw-index', text: 'store forwarding', rows: r,
      title: `a read-modify-write to an indexed address (${some(rows, r)}): when iterations hit the same address (repeated data), each waits for the previous store; not modelled` });
  }
  // a call: the function it calls is not part of the block
  const calls = rows.flatMap((x, row) => (x?.kind === 'instr' && /^call/i.test(String(x.label).trim()) ? [row] : []));
  if (calls.length) {
    out.push({ id: 'call', text: 'calls', rows: calls,
      title: `the block calls a function (${some(rows, calls)}): the call instruction is simulated, the function it calls is not; a real iteration also runs that function` });
  }
  // a branch within the block: both sides are simulated
  if (inside.length) {
    const instrRows = rows.flatMap((x, row) => (x?.kind === 'instr' ? [row] : []));
    // the source line of each row: as many lines as instructions, or as many once the padding (nops of .p2align) is out
    const given = Array.isArray(response?.loop?.lines) ? response.loop.lines : null;
    const real = instrRows.filter((row) => !/^(?:nop|data16|cs nop|xchg ax, ax)\b/i.test(String(rows[row].label).trim()));
    const mapped = given?.length === instrRows.length ? instrRows : given?.length === real.length ? real : null;
    const where = inside.map((row) => (mapped && mapped.includes(row) ? given[mapped.indexOf(row)] : null));
    const lines = where.every((x) => x !== null) ? where : null;
    if (!lines) where.splice(0, where.length, ...inside.map((row) => instrRows.indexOf(row) + 1));
    const at = `${lines ? 'line' : 'instruction'}${where.length > 1 ? 's' : ''} ${where.join(', ')}`;
    const one = inside.length === 1;
    out.push({ id: 'paths', text: 'both paths', rows: inside,
      title: `both sides of the branch${one ? '' : 'es'} at ${at} (${[...new Set(inside.map((row) => String(rows[row].label).trim().split(/\s+/)[0]))].join(', ')}) are simulated, one after the other; a real iteration takes one, so the cycles per iteration (and the step) count both. To analyze one side, put # wuica-begin and # wuica-end around it` });
  }
  // an exit before the loop's branch
  if (response?.mode === 'loop' && early.length) {
    out.push({ id: 'exit', text: 'exit mispredict', rows: early,
      title: 'the loop has an exit before its branch: its mispredict when the loop ends (once per call) is not modelled; with short trip counts it can cost more than the loop' });
  }
  if (split.length && !splitCost) {
    out.push({ id: 'split', text: `split loads? (${split.length})`, rows: split,
      title: `${split.length} load${split.length === 1 ? '' : 's'} at an offset that is not a multiple of the width (${some(rows, split)}): some cross a 64-byte line, which costs extra; not modelled` });
  } else if (split.length) {
    // this CPU's model charges the crossings of loads whose address advances by a constant: only the others warn
    const writes = untrackedWrites(rows);
    const regsOf = (row) => { const m = memOperand(rows[row].label); return [m?.base, m?.index].map((r) => family(r)?.base).filter((r) => r && writes.has(r)); };
    const untracked = split.filter((row) => regsOf(row).length);
    if (untracked.length) {
      const regs = [...new Set(untracked.flatMap(regsOf))];
      const by = [...new Set(regs.flatMap((r) => writes.get(r)))].sort((a, b) => a - b);
      out.push({ id: 'split', text: `split loads? (${untracked.length})`, rows: untracked,
        title: `${untracked.length} load${untracked.length === 1 ? '' : 's'} at an offset that is not a multiple of the width (${some(rows, untracked)}): some may cross a 64-byte line. This CPU's model charges a crossing only for a load whose address advances by a constant each iteration (its registers changed only by add, sub, inc or dec of an immediate); ${regs.join(', ')} ${regs.length === 1 ? 'is' : 'are'} written otherwise here (${some(rows, by)}), so these crossings are not modelled` });
    }
  }
  if (response && typeof response === 'object') (kept ?? memo.set(response, new Map()).get(response)).set(splitCost, out);
  return out;
}

// ---- code a CPU cannot run ------------------------------------------------------------------------------------------
// A block with positions the CPU's decoder skipped (decodeErrors: instructions its XED chip does not have, e.g. AVX-512
// on SKL, whose bytes it then decodes as other instructions) still gets the reference's throughput, which leaves them out:
// a number, but not a result for that CPU. So does a block with an instruction the decoder accepts but that is of an
// extension the CPU lacks (ZEN3's model decodes with XED's chip ALL, which accepts everything: its AVX-512 instructions
// get the note X and no data). The page (headline, the table of CPUs, A–B), the Markdown and the CLI's text say so with
// cannotRun's reason, keep the number reachable, and leave such a CPU out of any "fastest". The engine's numbers do not
// change.
// Any other instruction with the note X (accepted by the CPU's decoder, of no extension it lacks: x87 tbyte loads,
// syscall, endbr64, CLWB on ICX, TSX on HSW, ...) is a gap in the instruction tables: the result stands, with a note
// (noData: "N instructions without data", whose cost the throughput leaves out).
//
// Which extension an instruction with the note X is of comes from its encoding (the row's opcode bytes), as XED's ISA
// set says (tests-js/web_cannot_run.mjs checks the two agree on the fixtures): extensionOf. The reason names the
// extension: of such an instruction, or, for the positions the decoder skipped (whose rows are other instructions), from
// the analyzed assembly text (`code`, comments and strings left out), only an extension the CPU lacks; machine code
// without text: the count ("12 undecodable").
const EXTENSIONS = /** @type {[string, RegExp][]} */ ([
  ['AMX', /\btmm\d|\b(?:tdp\w+|tileloadd\w*|tilestored|ldtilecfg|sttilecfg|tilezero|tilerelease)\b/i],
  ['AVX-512', /\bzmm\d|%?\bk[1-7]\b|\{1to\d+\}|\b(?:kmov|kand|kor|kxor|knot|kshift|kunpck|kortest|ktest|kadd)\w*|\bv(?:pternlog|pcompress|pexpand|compress|expand|permt2|permi2|pmov[a-z]*2m|pmovm2|range|reduce|getexp|getmant|scalef|fixupimm|rcp14|rsqrt14|pconflict|plzcnt|dbpsadbw|align[dq]|pror|prol|psrav[wq]|psllv[w]|psrlvw|cvtt?p[sd]2u|cvtu)\w*/i],
  ['AVX-VNNI', /\bvpdp(?:bus|ws)ds?\b/i],
  ['SHA', /\bsha(?:1|256)\w+/i],
  ['FMA', /\bvf(?:n?m(?:add|sub)|maddsub|msubadd)\w*/i],
  ['AVX2', /\bv(?:pbroadcast[bwdq]|broadcasti128|perm[dq]\b|permp[sd]|perm2i128|inserti128|extracti128|p?gather\w+|ps[lr]lv[dq]|psravd|pmaskmov[dq]|pblendd)\b|\bvp(?!(?:extr|insr|cmp[ei]str|clmul|ermilp|erm2f128|test|dp(?:bus|ws)))\w+\s[^\n]*\bymm/i],
  ['BMI2', /\b(?:bzhi|mulx|pdep|pext|rorx|sarx|shlx|shrx)[lq]?\b/i],
  ['BMI1', /\b(?:andn|bextr|blsi|blsmsk|blsr)[lq]?\b/i],
  ['ADX', /\b(?:adcx|adox)[lq]?\b/i],
  ['TSX', /\b(?:xbegin|xend|xabort|xtest)\b/i],
]);
const SNB_LACKS = ['AMX', 'AVX-512', 'AVX-VNNI', 'SHA', 'FMA', 'AVX2', 'BMI2', 'BMI1', 'ADX'];
const SKL_LACKS = ['AMX', 'AVX-512', 'AVX-VNNI', 'SHA'];
const AVX512_LACKS = ['AMX', 'AVX-VNNI', 'SHA'];
const ICL_LACKS = ['AMX', 'AVX-VNNI'];
// the extensions of the list each CPU (the keys of archs.js) does not have (TSX: only where no model of it had it)
export const LACKS = Object.freeze({
  SNB: SNB_LACKS, IVB: SNB_LACKS, HSW: ['AMX', 'AVX-512', 'AVX-VNNI', 'SHA', 'ADX'], BDW: SKL_LACKS, SKL: SKL_LACKS, KBL: SKL_LACKS, CFL: SKL_LACKS,
  SKX: AVX512_LACKS, CLX: AVX512_LACKS, ICL: ICL_LACKS, TGL: ICL_LACKS, RKL: ICL_LACKS, ICX: ICL_LACKS, ZEN3: ['AMX', 'AVX-512', 'AVX-VNNI', 'TSX'], 'ADL-P': ['AMX', 'AVX-512', 'TSX'],
});

const LEGACY = new Set([0x66, 0x67, 0xf0, 0xf2, 0xf3, 0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65]);
// The extension of an instruction of the list above that an encoding is of (hex of its bytes), or null: EVEX (AVX-512),
// VEX map 0F38 0x49/0x4B/0x5C/0x5E (AMX), VEX.66 map 0F38 0x50-0x53 (AVX-VNNI), XBEGIN/XABORT/XEND/XTEST (TSX). The
// extensions whose instructions any CPU's decoder rejects that lacks them (FMA, AVX2, BMI, SHA, ADX) never get here.
export function extensionOf(opcode) {
  const b = String(opcode ?? '').match(/[0-9a-f]{2}/gi)?.map((x) => parseInt(x, 16)) ?? [];
  let i = 0;
  while (i < b.length && (LEGACY.has(b[i]) || (b[i] & 0xf0) === 0x40)) i++;
  const [o, p0, p1, p2] = b.slice(i);
  if (o === 0x62) return 'AVX-512';
  if (o === 0xc4 && p0 !== undefined && p1 !== undefined && (p0 & 0x1f) === 2) {
    if ([0x49, 0x4b, 0x5c, 0x5e].includes(p2)) return 'AMX';
    if ((p1 & 3) === 1 && p2 >= 0x50 && p2 <= 0x53) return 'AVX-VNNI';
  }
  if (o === 0x0f && p0 === 0x01 && (p1 === 0xd5 || p1 === 0xd6)) return 'TSX';
  if ((o === 0xc7 || o === 0xc6) && p0 === 0xf8) return 'TSX';
  return null;
}

// the analyzed text without comments and strings (a "zmm" in a comment names nothing)
// (a ';' only at the start of a line: elsewhere it can separate statements)
const codeOnly = (code) => String(code).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/(?:#|\/\/)[^\n]*|^\s*;[^\n]*/gm, ' ');
// the opcodes of a response's rows with the note X, or of a summary's (xOps)
const xOpsOf = (r) => (Array.isArray(r.rows) ? r.rows.filter((x) => x?.kind === 'instr' && x.notes === 'X').map((x) => String(x.opcode ?? ''))
  : Array.isArray(r.xOps) ? r.xOps.map(String) : []);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {any} r a response (rows: notes X, opcode), or a summary with decodeErrors and the X rows' opcodes (xOps)
 * @param {{arch?: string | null, code?: string | null}} [opts] the CPU's key; the analyzed assembly text, if any
 * @returns {{reason: string, title: string, decodeErrors: number, unsupported: number, needs: string[]} | null}
 */
export function cannotRun(r, { arch = null, code = null } = {}) {
  if (!r || typeof r !== 'object' || 'error' in r) return null;
  const decodeErrors = Number(r.decodeErrors) || 0;
  const lacks = arch ? LACKS[arch] ?? [] : [];
  // (with skipped positions, the X rows are other instructions than the code's: not counted)
  const lacked = decodeErrors ? [] : xOpsOf(r).map(extensionOf).filter((x) => x && lacks.includes(x));
  if (!decodeErrors && !lacked.length) return null;
  const text = decodeErrors && code ? codeOnly(code) : '';
  const needs = decodeErrors ? EXTENSIONS.filter(([name, re]) => lacks.includes(name) && re.test(text)).map(([name]) => name)
    : EXTENSIONS.map(([name]) => name).filter((name) => lacked.includes(name));
  const unsupported = lacked.length;
  const reason = needs.length ? `needs ${needs.join(', ')}` : `${decodeErrors} undecodable`;
  const what = decodeErrors ? plural(decodeErrors, 'position its decoder skipped', 'positions its decoder skipped') : plural(unsupported, 'instruction of an extension it lacks', 'instructions of an extension it lacks');
  const title = `${arch ? `${arch} cannot run this code` : 'code this CPU cannot run'}${needs.length ? ` (it needs ${needs.join(', ')})` : ''}: ${what}. The throughput leaves them out, so it is not a result for this CPU`;
  return { reason, title, decodeErrors, unsupported, needs };
}

// The instructions with the note X of a block the CPU can run (cannotRun null): gaps in its instruction tables, whose
// cost the throughput leaves out; 0 if none (or if the CPU cannot run the block: its reason says it).
/** @param {any} r @param {{arch?: string | null}} [opts] @returns {number} */
export function noData(r, { arch = null } = {}) {
  if (!r || typeof r !== 'object' || 'error' in r || cannotRun(r, { arch })) return 0;
  return xOpsOf(r).length;
}
export const noDataText = (n) => plural(n, 'instruction without data', 'instructions without data');
export const NO_DATA_TITLE = 'not in the instruction tables of this CPU (uops.info has no data for them): the throughput leaves their cost out';
