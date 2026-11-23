// The objdump-style listing of the analyzed code, from the rows of a response. No DOM.
//
//    0:  48 83 c0 01    add rax, 0x1
//    4:  49 ff cf       dec r15
//
// One line per instruction (rows of kind "instr"; the uops the renamer inserts are not instructions): the offset
// from the start of the block (hex), the bytes and the instruction. The shape is the one the hex input reads, so
// a listing pasted back into it gives the same machine code.

// rows: response.rows. Returns { lines: [{offset, bytes, text}], text } (text: the listing, one line each).
export function formatListing(rows) {
  const lines = [];
  let offset = 0;
  for (const r of rows ?? []) {
    if (r?.kind !== 'instr' || typeof r.opcode !== 'string') continue;
    const pairs = r.opcode.toLowerCase().match(/[0-9a-f]{2}/g) ?? [];
    lines.push({ offset, bytes: pairs.join(' '), text: String(r.label ?? '') });
    offset += pairs.length;
  }
  const ow = Math.max(4, ...lines.map((l) => l.offset.toString(16).length));
  const bw = Math.max(0, ...lines.map((l) => l.bytes.length));
  const text = lines.map((l) => `${l.offset.toString(16).padStart(ow)}:  ${l.bytes.padEnd(bw)}    ${l.text}`.trimEnd()).join('\n');
  return { lines, text: text ? text + '\n' : '' };
}
