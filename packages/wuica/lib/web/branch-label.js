// Branch targets in the uop table as labels. The analyzer disassembles every instruction at address 0, so a loop
// branch reads "jnz 0xfffffffffffffff4": its target relative to the instruction. Added to the instruction's offset in
// the block, that is the target in the block. Shown as:
//   - the operand as written in the pasted assembly when it is a symbol that the analyzed code does not define (an exit
//     of a picked loop, "call sink@PLT"), wherever the bytes go: an undefined symbol's displacement is a placeholder;
//   - the label written in the pasted assembly, when the branch's own operand names the target (a label defined there,
//     a GNU numeric "1b" / "1f" as written);
//   - else a label of the pasted text defined exactly at the target; else the nearest one before it plus the offset
//     ("loop+0x10");
//   - else (machine code, or no label before the target) the offset in the block ("jnz 0x0");
//   - a target outside the block, or a call or jump whose 32-bit displacement is 0 (the placeholder of a relocation in an
//     object file), relative to the instruction (".+0xc", ".-0x10"): its address is not known. The row's own label (its
//     tooltip, exports) is unchanged.
// The labels' offsets come from the text's statements matched one to one with the instruction rows; when the text
// cannot be matched that way (data or alignment directives in the code, a macro), only offsets are shown.
// No DOM (tests-js/web_branch_label.mjs).

import { statements } from './loop-find.js';

const BRANCH = /^((?:(?:bnd|notrack)\s+)?(?:j[a-z]{1,4}|loop[a-z]{0,2}|jrcxz|jecxz|xbegin|call))\s+(0x[0-9a-f]{1,16})$/i;
const LABEL_ONE = /\s*([A-Za-z_.$@][\w.$@]*|\d+)\s*:(?!:)/y;
const SYMBOL = /^[A-Za-z_.$@][\w.$@]*$/;
const NUMERIC_REF = /^\d+[bf]$/i;
const INTERNAL = /^\.Lwuica_/; // labels the page itself puts into the text (asm-regions.js, loop-find.js)
// directives that put bytes into the code (or repeat it): the statements no longer match the rows one to one
const EMITS = /^\.(?:byte|2byte|4byte|8byte|word|short|hword|int|long|quad|octa|value|ascii|asciz|string\d*|fill|skip|space|zero|align|balign[wl]?|p2align[wl]?|rept|irp|irpc|endr|macro|endm|insn|inst|org|incbin|nops?)\b/i;
const SECTION = /^\.(?:section|data|bss|rodata|pushsection|popsection|previous)\b/i;

// The code of lines from..to (1-based, inclusive) of assembly text: [{kind: 'label', name} | {kind: 'instr', operand}]
// in order, or null if the statements cannot be matched with machine code one to one.
export function codeStatements(text, from = 1, to = Infinity) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) {
    const raw = lines[i - 1];
    if (/^\s*;/.test(raw)) continue; // a comment line (loop-find.js)
    for (const st of statements(raw)) {
      let t = st.text;
      LABEL_ONE.lastIndex = 0;
      let m;
      while ((m = LABEL_ONE.exec(t))) { out.push({ kind: 'label', name: m[1] }); t = t.slice(LABEL_ONE.lastIndex); LABEL_ONE.lastIndex = 0; }
      t = t.trim();
      if (!t) continue;
      if (t[0] === '.') {
        if (EMITS.test(t) || SECTION.test(t)) return null;
        continue; // .loc, .cfi_*, .type, ...: no code
      }
      if (/^[\w.$@]+\s*=/.test(t)) continue; // a symbol assignment
      const op = /^\S+\s+(.*)$/.exec(t.replace(/^(?:(?:lock|rep\w*|bnd|notrack|data16|data32|addr32|[cdefgs]s)\s+)+/i, ''));
      out.push({ kind: 'instr', operand: op ? op[1].trim() : '' });
    }
  }
  return out;
}

// A target relative to the instruction's start, as an assembler reads it: ".+0xc", ".-0x10"
/** @param {number} rel */
export const relativeTarget = (rel) => (rel < 0 ? `.-0x${(-rel).toString(16)}` : `.+0x${rel.toString(16)}`);

// The direct branches and calls of the rows: per row null, or {mnemonic, rel (the target relative to the instruction's
// start: what the analyzer prints), offset (the instruction's in the block), target (offset + rel), inside (0 <= target
// <= the block's size), external (a call or jump with a 32-bit displacement of 0: a relocation's placeholder, as
// asm-text.js itemsOf)}. Also {size, starts, instrRows}.
export function branchTargets(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const starts = [], instrRows = [];
  let offset = 0;
  list.forEach((r, i) => {
    starts.push(offset);
    if (r?.kind === 'instr' && typeof r.opcode === 'string') { instrRows.push(i); offset += r.opcode.length >> 1; }
  });
  const size = offset;
  const targets = list.map((r, i) => {
    if (r?.kind !== 'instr' || typeof r.opcode !== 'string') return null;
    const m = BRANCH.exec(String(r.label ?? '').trim());
    if (!m) return null;
    let t = BigInt(m[2]);
    if (t >= 1n << 63n) t -= 1n << 64n;
    const rel = Number(t);
    if (!Number.isSafeInteger(rel)) return null;
    const target = starts[i] + rel;
    const b = (r.opcode.match(/[0-9a-f]{2}/gi) ?? []).map((x) => parseInt(x, 16)), n = b.length;
    const external = n >= 5 && b.slice(n - 4).every((x) => x === 0)
      && (b[n - 5] === 0xe8 || b[n - 5] === 0xe9 || (n >= 6 && b[n - 6] === 0x0f && (b[n - 5] & 0xf0) === 0x80));
    return { mnemonic: m[1], rel, offset: starts[i], target, inside: target >= 0 && target <= size, external };
  });
  return { targets, size, starts, instrRows };
}

// The shown label of each row (an array as long as rows): a branch with its target shown as above, else null (the row's
// own label). src: {text, from, to} (assembly; the lines of the analyzed code) or null (machine code).
/** @param {{text: string, from?: number, to?: number} | null} [src] */
export function branchLabels(rows, src = null) {
  const list = Array.isArray(rows) ? rows : [];
  const out = new Array(list.length).fill(null);
  const { targets, size, starts, instrRows } = branchTargets(list);
  // the text's labels at their offsets, and each instruction row's operand as written
  const at = new Map();      // offset -> [label] (in the order of the text)
  const placed = [];         // [{name, off}] in order
  const written = new Map(); // row index -> operand
  const inside = new Set();  // labels defined in the analyzed code
  const code = src ? codeStatements(src.text, src.from ?? 1, src.to ?? Infinity) : null;
  if (code && code.filter((x) => x.kind === 'instr').length === instrRows.length) {
    let k = 0, pending = [];
    for (const x of code) {
      if (x.kind === 'label') { pending.push(x.name); inside.add(x.name); continue; }
      const off = starts[instrRows[k]];
      written.set(instrRows[k], x.operand);
      for (const n of pending) { (at.get(off) ?? at.set(off, []).get(off)).push(n); placed.push({ name: n, off }); }
      pending = [];
      k++;
    }
    for (const n of pending) { (at.get(size) ?? at.set(size, []).get(size)).push(n); placed.push({ name: n, off: size }); }
  }
  const real = (n) => !INTERNAL.test(n) && !/^\d+$/.test(n);
  targets.forEach((b, i) => {
    if (!b) return;
    const { target } = b;
    const show = (s) => { out[i] = `${b.mnemonic} ${s}`; };
    const w = written.get(i);
    const here = (at.get(target) ?? []);
    if (w && NUMERIC_REF.test(w)) return show(w);
    // a symbol the analyzed code does not define: as written (its displacement may be a placeholder)
    if (w && SYMBOL.test(w) && !INTERNAL.test(w) && !inside.has(w)) return show(w);
    if (!b.inside || b.external) return show(relativeTarget(b.rel));
    if (w && SYMBOL.test(w) && !INTERNAL.test(w) && here.includes(w)) return show(w);
    const exact = here.find(real);
    if (exact) return show(exact);
    const before = placed.filter((p) => real(p.name) && p.off < target).pop();
    if (before) return show(`${before.name}+0x${(target - before.off).toString(16)}`);
    show(`0x${target.toString(16)}`);
  });
  return out;
}

// The lines of the analyzed code of an assembly result (asm-regions.js): the picked loop or body, a marked region, or
// the whole text. {text, from, to, lines?: the line of each instruction of a picked loop or body}.
export function analyzedLines(text, r) {
  const t = String(text ?? '');
  if (r?.loop?.line) return { text: t, from: r.loop.line, to: r.loop.endLine ?? r.loop.line, ...(r.loop.lines ? { lines: r.loop.lines } : {}) };
  if (r?.region?.line) {
    const lines = t.split('\n');
    let to = lines.length;
    for (let i = r.region.line; i < lines.length; i++) if (/(?:LLVM-MCA-END|wuica-end)/i.test(lines[i])) { to = i; break; }
    return { text: t, from: r.region.line + 1, to };
  }
  return { text: t, from: 1, to: Infinity };
}
// The text of those lines (the analyzed assembly), or null for none: caveats.js cannotRun names the extension a CPU lacks
// from it
export function analyzedText(src) {
  if (!src) return null;
  const lines = String(src.text).split('\n');
  return lines.slice(Math.max(0, src.from - 1), Number.isFinite(src.to) ? src.to : lines.length).join('\n');
}
