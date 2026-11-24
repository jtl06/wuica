// The objdump-style listing of the analyzed code, from the rows of a response. No DOM.
//
//    0:  48 83 c0 01    add rax, 0x1
//    4:  49 ff cf       dec r15
//    7:  75 f7          jnz 0x0 <loop>
//
// One line per instruction (rows of kind "instr"; the uops the renamer inserts are not instructions): the offset
// from the start of the block (hex), the bytes and the instruction. The shape is the one the hex input reads, so
// a listing pasted back into it gives the same machine code.
// A direct branch or call shows its real target, as objdump does: the offset in the block (the next instruction's
// offset plus the displacement; the analyzer disassembles each instruction at address 0) and the label the uop table
// shows for it, if it has a name. A target outside the block, or a relocation's placeholder, has no known address: it
// is shown as the uop table shows it, the symbol as written or relative to the instruction (branch-label.js).

import { branchTargets, relativeTarget } from './branch-label.js';

// rows: response.rows; shown: the uop table's label of each row (branch-label.js branchLabels), or null.
// Returns { lines: [{offset, bytes, text}], text } (text: the listing, one line each).
/** @param {any[] | null | undefined} rows @param {(string | null)[] | null} [shown] */
export function formatListing(rows, shown = null) {
  const lines = [];
  const { targets } = branchTargets(rows ?? []);
  let offset = 0;
  (rows ?? []).forEach((r, i) => {
    if (r?.kind !== 'instr' || typeof r.opcode !== 'string') return;
    const pairs = r.opcode.toLowerCase().match(/[0-9a-f]{2}/g) ?? [];
    lines.push({ offset, bytes: pairs.join(' '), text: branchText(targets[i], shown?.[i] ?? null) ?? String(r.label ?? '') });
    offset += pairs.length;
  });
  const ow = Math.max(4, ...lines.map((l) => l.offset.toString(16).length));
  const bw = Math.max(0, ...lines.map((l) => l.bytes.length));
  const text = lines.map((l) => `${l.offset.toString(16).padStart(ow)}:  ${l.bytes.padEnd(bw)}    ${l.text}`.trimEnd()).join('\n');
  return { lines, text: text ? text + '\n' : '' };
}

// a branch's text: "jnbe 0x23 <.LBB0_3>", "call sink@PLT", "jz .+0xc"; null for other instructions
function branchText(b, shown) {
  if (!b) return null;
  const name = typeof shown === 'string' && shown.startsWith(`${b.mnemonic} `) ? shown.slice(b.mnemonic.length + 1) : null;
  if (!b.inside || b.external) return `${b.mnemonic} ${name ?? relativeTarget(b.rel)}`;
  const at = `0x${b.target.toString(16)}`;
  return `${b.mnemonic} ${at}${name && name !== at ? ` <${name}>` : ''}`;
}
