// Machine code -> assembly text that the page's assembler (assembler.js) turns back into exactly the same bytes,
// instruction lengths included. Used when code comes in as bytes (a Compiler Explorer import of machine code) and
// when the input is switched between hex and asm (app.js, ab.js). No DOM; the decoder and the assembler are passed
// in, so this runs under Node (tests-js/web_asm_text.mjs).
//
// The text comes from wuica's own decoder (the Intel syntax of the uop table): one line per instruction, branch
// targets inside the block as labels ("loop" at the top, then L1, L2, ...), calls and jumps to an unresolved
// relocation as branches to the symbol "ext". It is then assembled and compared with the bytes. An instruction
// that does not come back as the same bytes (another encoding of the same instruction, a branch out of the block,
// something the assembler rejects) gets a spelling that selects the original encoding ({vex3}, {disp32}, mov.s,
// ...), if one does, or else becomes a .byte line with the disassembly as a comment, so the block as a whole always
// comes back as the same bytes. Undecodable bytes are .byte lines. Blocks above MAX_INSTRUCTIONS / MAX_BYTES are not
// converted (an import stays hex, a switch shows the other format's own text, as without a conversion).

import { toHex, parseHexInput } from './hex-input.js';

// Above this the conversion is not attempted: the checks run on the page's thread (the SHA-256 showcase, 2,949
// instructions, takes about 0.1 s in Chrome), and with many .byte fallbacks they take several times longer.
export const MAX_INSTRUCTIONS = 4000;
export const MAX_BYTES = 32768;

// Other spellings that select one encoding among several of the same instruction (LLVM's assembler accepts them):
// pseudo-prefixes, the ".s" suffix (the reversed register-to-register form of mov and the like), and the x87
// forms without the implicit st operand.
// Each is tried only where it can matter (`when`: the item's text and bytes).
const mem = (it) => it.text.includes('[');
const vex = (it) => it.bytes.includes(0xc4);
const evex = (it) => it.bytes.includes(0x62);
const prefix = (p, when) => ({ when, f: (t) => `${p} ${t}` });
const VARIANTS = [
  prefix('{vex3}', vex), prefix('{disp32}', mem), prefix('{disp8}', mem), prefix('{evex}', evex),
  prefix('{rex}', (it) => it.bytes.some((b) => b >= 0x40 && b <= 0x4f)),
  prefix('{vex3} {disp32}', (it) => vex(it) && mem(it)), prefix('{evex} {disp32}', (it) => evex(it) && mem(it)), prefix('{evex} {disp8}', (it) => evex(it) && mem(it)),
  { when: (it) => !mem(it), f: (t) => t.replace(/^(\S+)/, '$1.s') },
  { when: (it) => /^f/.test(it.text), f: (t) => t.replace(/^(\S+) st, /, '$1 ').replace(/, st$/, '') },
];
// XED's Intel syntax where LLVM's reads it differently.
export function llvmSyntax(asm) {
  return asm
    .replace(/(^\S+ |, )ptr \[/, '$1[') // "lea r12, ptr [rcx+0x8]": no size
    .replace(/^(nop \S+ ptr \[[^\]]*\]), [a-z0-9]+$/, '$1') // "nop word ptr [rax+rax*1], ax": the reg field (0)
    .replace(/^xlat$/, 'xlatb');
}
const BRANCH_CATEGORIES = new Set(['COND_BR', 'UNCOND_BR', 'CALL']);
const TOP = 'loop';
const EXT = 'ext';

const hex2 = (b) => '0x' + (b < 16 ? '0' : '') + b.toString(16);
const offsetText = (n) => (n < 0 ? '-0x' + (-n).toString(16) : '0x' + n.toString(16));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function bytesOf(opcode) {
  return (String(opcode).match(/[0-9a-f]{2}/gi) ?? []).map((p) => parseInt(p, 16));
}

// The instructions of the decoder's output (docs/WASM-API.md, wuica_decode) as items that cover every byte:
// {addr, bytes, asm, target, external} where target is the offset a direct branch goes to (from the start of the
// block), and asm is null for bytes the decoder skipped. external: a call or jump with a 32-bit displacement of 0, the
// placeholder of a relocation in an object file (a call of another function): written as a branch to the symbol EXT,
// which the assembler encodes the same way.
export function itemsOf(instrs, code) {
  const all = Array.from(code);
  const total = all.length;
  const items = [];
  let at = 0;
  const gap = (to) => { if (to > at) items.push({ addr: at, bytes: all.slice(at, to), len: to - at, asm: null, target: null }); };
  for (const ins of [...instrs].sort((a, b) => a.addr - b.addr)) {
    const bytes = bytesOf(ins.opcode);
    if (ins.addr < at || !bytes.length || ins.addr + bytes.length > total || !same(bytes, all.slice(ins.addr, ins.addr + bytes.length))) continue;
    gap(ins.addr);
    let asm = String(ins.asm ?? '').trim().replace(/\s+/g, ' ');
    let target = null;
    const m = / (0x[0-9a-f]+)$/i.exec(asm);
    // XED shows a direct branch's target as if the instruction were at address 0: target = length + displacement
    if (m && BRANCH_CATEGORIES.has(ins.category) && !/ptr|\[/.test(asm)) target = ins.addr + Number(BigInt.asIntN(64, BigInt(m[1])));
    const n = bytes.length;
    const external = target !== null && n >= 5 && bytes.slice(n - 4).every((b) => b === 0)
      && (bytes[n - 5] === 0xe8 || bytes[n - 5] === 0xe9 || (n >= 6 && bytes[n - 6] === 0x0f && (bytes[n - 5] & 0xf0) === 0x80));
    items.push({ addr: ins.addr, bytes, len: n, asm, text: llvmSyntax(asm), target, external, mnemonic: asm.slice(0, m ? m.index : asm.length) });
    at = ins.addr + bytes.length;
  }
  gap(total);
  return items;
}

// The labels: every branch target that is the start of an item or the end of the block. Map offset -> name.
function labelsOf(items, total) {
  const starts = new Set(items.map((it) => it.addr));
  starts.add(total);
  const targets = [...new Set(items.filter((it) => !it.external).map((it) => it.target).filter((t) => t !== null && starts.has(t)))].sort((a, b) => a - b);
  const names = new Map();
  let n = 0;
  for (const t of targets) names.set(t, t === 0 ? TOP : `L${++n}`);
  return names;
}

// The text of an item: {text, kind: 'instr' | 'branch' | 'byte'}
function lineOf(it, labels, { variant = null, asBytes = false } = {}) {
  const comment = () => {
    if (it.asm === null) return '';
    if (it.target === null) return `  # ${it.asm}`;
    return `  # ${it.mnemonic} ${it.external ? EXT : labels.get(it.target) ?? offsetText(it.target)}`;
  };
  if (asBytes || it.asm === null || (it.target !== null && !it.external && !labels.has(it.target))) {
    return { kind: 'byte', text: `.byte ${it.bytes.map(hex2).join(', ')}${comment()}` };
  }
  if (it.target !== null) {
    const t = `${it.mnemonic} ${it.external ? EXT : labels.get(it.target)}`;
    return { kind: 'branch', text: variant ? variant(t) : t };
  }
  const t = variant ? variant(it.text) : it.text;
  return t ? { kind: 'instr', text: t } : null;
}

export function render(items, lines, labels, total) {
  const out = [];
  items.forEach((it, k) => {
    const name = labels.get(it.addr);
    if (name) out.push(`${name}:`);
    out.push(`  ${lines[k].text}`);
  });
  if (labels.has(total)) out.push(`${labels.get(total)}:`);
  return out.join('\n') + '\n';
}

// A long branch (rel32) that would fit in a short one: the assembler would make it short.
function needsLong(it) {
  const b = it.bytes;
  const long = (b[0] === 0x0f && b[1] >= 0x80 && b[1] <= 0x8f && b.length === 6) || (b[0] === 0xe9 && b.length === 5);
  if (!long) return false;
  const d = it.target - (it.addr + 2);
  return d >= -136 && d <= 135; // with a margin: lines before it can still change length
}

// bytes: Uint8Array; decode(hex) -> promise of wuica_decode's result; assemble(text) -> promise of
// {ok, bytes}; pause() (optional) -> a promise, awaited now and then during a long check.
// Resolves to {ok: true, text, instructions, fallback: [{asm, line}], checks, stage} (fallback: the instructions that
// became .byte lines; checks: calls of the assembler; stage: see below) or {ok: false, why}.
export async function bytesToAsm(bytes, { decode, assemble, pause = null }) {
  const want = Array.from(bytes);
  if (!want.length) return { ok: false, why: 'no code' };
  if (want.length > MAX_BYTES) return { ok: false, why: 'too large' };
  const instrs = await decode(toHex(bytes));
  if (!Array.isArray(instrs)) return { ok: false, why: instrs?.error ?? 'not decoded' };
  if (instrs.length > MAX_INSTRUCTIONS) return { ok: false, why: 'too large' };
  const total = want.length;
  const items = itemsOf(instrs, want);
  const labels = labelsOf(items, total);
  const long = (t) => `{disp32} ${t}`;
  const lines = items.map((it) => lineOf(it, labels, { variant: it.target !== null && !it.external && labels.has(it.target) && needsLong(it) ? long : null }));
  let checks = 0;
  const matches = async (text, expect) => {
    checks++;
    if (pause && checks % 64 === 0) await pause();
    const r = await assemble(text);
    return !!r?.ok && same(Array.from(r.bytes), expect);
  };
  const whole = () => matches(render(items, lines, labels, total), want);

  let stage = 0; // 0: as it was; 1: some instructions changed; 2: branches as bytes; 3: everything as bytes
  if (!(await whole())) {
    stage = 1;
    const fixed = new Map(); // text and bytes -> the line found for them (blocks repeat instructions)
    // Another spelling of an instruction, checked on its own (its encoding does not depend on where it is), or .byte.
    const fix = async (k) => {
      const it = items[k];
      const key = `${it.text}|${it.bytes}`;
      if (fixed.has(key)) { lines[k] = fixed.get(key); return; }
      lines[k] = lineOf(it, labels, { asBytes: true });
      for (const v of VARIANTS) {
        if (!v.when(it)) continue;
        const l = lineOf(it, labels, { variant: v.f });
        if (l && l.text !== it.text && await matches(l.text + '\n', it.bytes)) { lines[k] = l; break; }
      }
      fixed.set(key, lines[k]);
    };
    // A branch that comes out with another length: the long form ({disp32}) if it was long, else .byte.
    const fixBranch = (k) => {
      const it = items[k];
      const long = it.bytes.length >= 5 && !/^\{disp32\}/.test(lines[k].text);
      lines[k] = long ? lineOf(it, labels, { variant: (t) => `{disp32} ${t}` }) : lineOf(it, labels, { asBytes: true });
    };
    // The items whose bytes differ: the lines the assembler rejects (its diagnostics), else the output decoded again,
    // instruction by instruction (each line is one instruction); null if that does not line up.
    const locate = async () => {
      const at = [];
      items.forEach((it, k) => { if (labels.has(it.addr)) at.push(-1); at.push(k); });
      checks++;
      const r = await assemble(render(items, lines, labels, total));
      if (!r?.ok) {
        const bad = [...new Set((r?.diagnostics ?? []).filter((d) => d.severity === 'error' && d.line).map((d) => at[d.line - 1]).filter((k) => k >= 0))];
        return bad.length ? bad : null;
      }
      const got = Array.from(r.bytes);
      const decoded = await decode(toHex(got));
      if (!Array.isArray(decoded)) return null;
      const out = itemsOf(decoded, got);
      if (out.length !== items.length) return null;
      return items.map((it, k) => (same(it.bytes, out[k].bytes) ? -1 : k)).filter((k) => k >= 0);
    };
    // The fallback: runs of instructions checked together, halving the runs that fail.
    const bisect = async (ks) => {
      if (!ks.length) return;
      if (await matches(ks.map((k) => lines[k].text).join('\n') + '\n', ks.flatMap((k) => items[k].bytes))) return;
      if (ks.length === 1) { await fix(ks[0]); return; }
      const mid = ks.length >> 1;
      await bisect(ks.slice(0, mid));
      await bisect(ks.slice(mid));
    };
    for (let round = 0; round < 8; round++) {
      const bad = await locate();
      if (bad === null) { await bisect(items.map((_, k) => k).filter((k) => lines[k].kind === 'instr')); break; }
      if (!bad.length) break;
      // instructions first: a branch can differ only because the instructions before it changed length
      const instr = bad.filter((k) => lines[k].kind === 'instr');
      if (instr.length) for (const k of instr) await fix(k);
      else for (const k of bad) if (lines[k].kind === 'branch') fixBranch(k);
      if (pause) await pause();
    }
    if (!(await whole())) {
      // still not the same: branches as bytes, then everything as bytes
      stage = 2;
      items.forEach((it, k) => { if (lines[k].kind === 'branch') lines[k] = lineOf(it, labels, { asBytes: true }); });
      if (!(await whole())) {
        stage = 3;
        items.forEach((it, k) => { lines[k] = lineOf(it, labels, { asBytes: true }); });
        if (!(await whole())) return { ok: false, why: 'does not assemble to the same bytes' };
      }
    }
  }
  // labels of branches that became bytes are not needed any more
  const used = new Set(items.map((it, k) => (lines[k].kind === 'branch' && !it.external ? it.target : null)).filter((t) => t !== null));
  for (const t of [...labels.keys()]) if (!used.has(t)) labels.delete(t);
  const final = items.map((it, k) => (lines[k].kind === 'byte' ? lineOf(it, labels, { asBytes: true }) : lines[k]));
  const text = render(items, final, labels, total);
  // the labels changed only comments and label lines: check once more that nothing else did
  checks++;
  const r = await assemble(text);
  if (!r?.ok || !same(Array.from(r.bytes), want)) return { ok: false, why: 'does not assemble to the same bytes' };
  const fallback = items.flatMap((it, k) => (final[k].kind === 'byte' && it.asm !== null ? [{ asm: it.asm, line: final[k].text }] : []));
  return { ok: true, text, instructions: instrs.length, fallback, checks, stage, mca: await toolText(items, final, total, assemble) };
}

// The same block for a tool that reads instructions, not bytes (llvm-mca, mca.js): a .byte line is no instruction to it,
// so every decoded instruction that became one is written as an instruction again, in any encoding: a branch to its
// label, a branch out of the block to the symbol OUT (llvm-mca needs no definition), anything else as its disassembly if
// that assembles on its own (else it stays .byte). Returns the text, or null if the whole does not assemble.
const OUT = 'out';
async function toolText(items, lines, total, assemble) {
  if (!items.some((it, k) => lines[k].kind === 'byte' && it.asm !== null)) return null; // the same as text
  const labels = labelsOf(items, total);
  const out = [], alone = new Map(); // text -> whether it assembles on its own
  for (const [k, it] of items.entries()) {
    let l = lines[k];
    if (l.kind === 'byte' && it.asm !== null) {
      if (it.target !== null) l = { kind: 'branch', text: `${it.mnemonic} ${it.external ? EXT : labels.get(it.target) ?? OUT}` };
      else if (it.text) {
        if (!alone.has(it.text)) alone.set(it.text, !!(await assemble(it.text + '\n'))?.ok);
        if (alone.get(it.text)) l = { kind: 'instr', text: it.text };
      }
    }
    out.push(l);
  }
  // labels only where a branch goes
  const used = new Set(items.map((it, k) => (out[k].kind === 'branch' && !it.external ? it.target : null)));
  for (const t of [...labels.keys()]) if (!used.has(t)) labels.delete(t);
  const text = render(items, out, labels, total);
  return (await assemble(text))?.ok ? text : null;
}

// An objdump-like listing of machine code (what the hex input reads back), with the decoder's disassembly; branch
// targets as offsets from the start of the block. For a switch from asm to hex.
export function hexListing(bytes, instrs) {
  const items = itemsOf(Array.isArray(instrs) ? instrs : [], bytes);
  const rows = items.map((it) => ({
    addr: it.addr,
    bytes: it.bytes.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join(' '),
    text: it.asm === null ? '' : it.target !== null ? `${it.mnemonic} ${offsetText(it.target)}` : it.asm,
  }));
  const aw = Math.max(4, ...rows.map((r) => r.addr.toString(16).length));
  const bw = Math.max(0, ...rows.map((r) => r.bytes.length));
  return rows.map((r) => `${r.addr.toString(16).padStart(aw)}:  ${r.bytes.padEnd(bw)}    ${r.text}`.trimEnd()).join('\n') + '\n';
}

// The conversions of the page. decoder() -> promise of something with decode(hex, chip) (engine.js) or null;
// assembler() -> promise of an assembler (assembler.js) or null. A result of null means: no conversion (nothing to
// convert, or not possible); the caller then does what it did without one.
//   fromBytes(bytes) -> {mode: 'asm', syntax: 'intel', text}: assembly of exactly these bytes
//   convert({mode, syntax, text}, to, other) -> {mode: to, syntax?, text}: the same machine code in the other input
//     format, or {same: true} when `other` (the box's own text for that format) already is the same machine code
export const SAME = Object.freeze({ same: true });
export function createConverter({ decoder, assembler }) {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  const equal = (a, b) => same(Array.from(a), Array.from(b));
  async function fromBytes(bytes) {
    const [d, a] = await Promise.all([decoder(), assembler()]);
    if (!d || !a) return null;
    const r = await bytesToAsm(bytes, { decode: (hex) => d.decode(hex, 'ALL'), assemble: (text) => a.assemble(text, 'intel'), pause });
    return r.ok ? { mode: 'asm', syntax: 'intel', text: r.text, ...(r.mca ? { mca: r.mca } : {}) } : null;
  }
  async function convert({ mode, syntax, text }, to, other = '') {
    if (mode === to || String(text).trim() === '') return null;
    const a = await assembler();
    if (!a) return null;
    if (mode === 'hex') {
      const p = parseHexInput(text);
      if (!p.ok) return null;
      if (String(other).trim() !== '') {
        const r = await a.assemble(other, syntax);
        if (r.ok && equal(r.bytes, p.bytes)) return SAME;
      }
      return fromBytes(p.bytes);
    }
    const r = await a.assemble(text, syntax);
    if (!r.ok || !r.bytes.length) return null;
    const p = parseHexInput(other);
    if (p.ok && equal(p.bytes, r.bytes)) return SAME;
    const d = await decoder();
    if (!d) return null;
    return { mode: 'hex', text: hexListing(r.bytes, await d.decode(toHex(r.bytes), 'ALL')) };
  }
  return { fromBytes, convert };
}
