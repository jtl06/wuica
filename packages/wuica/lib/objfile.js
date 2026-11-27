// Object files as input (wuica foo.o): the container is read here (no dependency): ELF (relocatable objects,
// executables, shared objects) and Mach-O (objects and executables; a universal file's x86-64 slice), x86-64 only. The
// instructions come from the analyzer's own decoder (wuica_decode), and the result is the text llvm-objdump -d prints for
// the code sections (addresses, bytes, a mnemonic, branch targets as "0x1b <dot+0x1b>"), so that the objdump path of
// loop-find.js picks the loop: a .o and `objdump -d` of it give the same pick and the same throughput.

const ELF_X86_64 = 62, ELF_AARCH64 = 183, ELF_386 = 3;
const MACHO_X86_64 = 0x01000007, MACHO_ARM64 = 0x0100000c, MACHO_I386 = 7;
const td = new TextDecoder();

// What a file is, from its first bytes: {kind: 'elf' | 'macho' | 'fat' | 'coff' | 'pe' | 'archive', ...} or null.
export function objectKind(b) {
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x7f, 0x45, 0x4c, 0x46)) return { kind: 'elf' };
  if (at(0, 0xcf, 0xfa, 0xed, 0xfe)) return { kind: 'macho' };
  if (at(0, 0xce, 0xfa, 0xed, 0xfe) || at(0, 0xfe, 0xed, 0xfa, 0xcf) || at(0, 0xfe, 0xed, 0xfa, 0xce)) return { kind: 'macho32' };
  if (at(0, 0xca, 0xfe, 0xba, 0xbe)) return { kind: 'fat' };
  if (at(0, 0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a)) return { kind: 'archive' };
  if (at(0, 0x4d, 0x5a)) return { kind: 'pe' };
  if (at(0, 0x64, 0x86) && b.length >= 20) return { kind: 'coff' };
  return null;
}

const ARCH_HELP = 'compile for x86-64: clang --target=x86_64-linux-gnu -c (Linux objects) or clang -arch x86_64 -c (macOS)';

// The code of an object file: {format, functions: [{name, section, address, size, bytes[, symbol]}]} or {error}.
// Names are unique (uniqueNames): a function whose symbol name occurs more than once has its address in its name, and
// `symbol` is the name in the file.
/** @returns {any} */
export function readObject(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const k = objectKind(b);
  if (!k) return { error: 'not an object file' };
  try {
    const r = readContainer(b, k);
    if (r.functions) uniqueNames(r.functions);
    return r;
  } catch (e) {
    return { error: `a damaged or truncated object file (${e.message})` };
  }
}

// A static executable (or a relocatable object made by ld -r) has local symbols with the same name: static functions of
// different translation units, their .cold parts, glibc's helpers. In llvm-objdump -d's text each function's header
// ("0000000000401000 <step>:") becomes a label, and a label defined twice fails to assemble. So every function whose
// name occurs more than once is named NAME.0xADDR (its address; a plain label as loop-find.js reads one), all of them:
// none is the NAME of a -func, which says that NAME is ambiguous (resolveFunction). A file without repeated names keeps
// its names: its text is llvm-objdump's, as before.
function uniqueNames(functions) {
  const count = new Map();
  for (const f of functions) count.set(f.name, (count.get(f.name) ?? 0) + 1);
  const taken = new Set(functions.map((f) => f.name));
  for (const f of functions) {
    if (count.get(f.name) === 1) continue;
    let name = `${f.name}.0x${f.address.toString(16)}`;
    for (let k = 2; taken.has(name); k++) name = `${f.name}.0x${f.address.toString(16)}.${k}`; // (a symbol of that name too)
    taken.add(name);
    f.symbol = f.name;
    f.name = name;
  }
}

function readContainer(b, k) {
  if (k.kind === 'elf') return readElf(b);
  if (k.kind === 'macho') return readMachO(b);
  if (k.kind === 'fat') return readFat(b);
  if (k.kind === 'macho32') return { error: `a 32-bit Mach-O file: wuica analyzes x86-64 code; ${ARCH_HELP}` };
  if (k.kind === 'archive') return { error: 'an archive (.a): extract an object from it (ar x lib.a foo.o) and give that' };
  return { error: `${k.kind === 'pe' ? 'a PE (Windows) executable' : 'a COFF object file'}: not supported yet; disassemble it and pipe the listing (llvm-objdump -d FILE | wuica)` };
}

function view(b) { return new DataView(b.buffer, b.byteOffset, b.byteLength); }
const u64 = (dv, o) => Number(dv.getBigUint64(o, true));
const cstr = (b, o) => { let e = o; while (e < b.length && b[e] !== 0) e++; return td.decode(b.subarray(o, e)); };

function readElf(b) {
  if (b[4] !== 2) return { error: `a 32-bit ELF file: wuica analyzes x86-64 code; ${ARCH_HELP}` };
  if (b[5] !== 1) return { error: 'a big-endian ELF file: wuica analyzes x86-64 code' };
  const dv = view(b);
  const type = dv.getUint16(16, true), machine = dv.getUint16(18, true);
  if (machine !== ELF_X86_64) {
    const what = machine === ELF_AARCH64 ? 'an AArch64 (arm64)' : machine === ELF_386 ? 'a 32-bit x86' : `a (machine ${machine})`;
    return { error: `${what} ELF file: wuica analyzes x86-64 code; ${ARCH_HELP}` };
  }
  const shoff = u64(dv, 0x28), shentsize = dv.getUint16(0x3a, true), shnum = dv.getUint16(0x3c, true), shstrndx = dv.getUint16(0x3e, true);
  const sh = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    sh.push({ nameOff: dv.getUint32(o, true), type: dv.getUint32(o + 4, true), flags: u64(dv, o + 8), addr: u64(dv, o + 16), offset: u64(dv, o + 24), size: u64(dv, o + 32), link: dv.getUint32(o + 40, true), entsize: u64(dv, o + 56) });
  }
  const strtab = sh[shstrndx];
  for (const s of sh) s.name = strtab ? cstr(b, strtab.offset + s.nameOff) : '';
  const relocatable = type === 1;
  // a relocatable object's code sections all start at 0 (-ffunction-sections: one per function): they are laid out one
  // after another at multiples of 64, so that an address modulo 64 (the alignment of a loop) is the one in its section
  // code sections: allocated and executable, with bytes in the file
  const code = sh.map((s, i) => ({ ...s, index: i })).filter((s) => (s.flags & 0x6) === 0x6 && s.type !== 8 && s.size > 0);
  if (!code.length) return { error: 'no code sections (.text) in the file' };
  // the symbols: .symtab, else .dynsym (a stripped executable)
  const symtab = sh.find((s) => s.type === 2) ?? sh.find((s) => s.type === 11);
  const syms = [];
  if (symtab) {
    const names = sh[symtab.link];
    for (let o = symtab.offset; o + 24 <= symtab.offset + symtab.size; o += 24) {
      const info = b[o + 4], shndx = dv.getUint16(o + 6, true), type = info & 0xf;
      const name = cstr(b, names.offset + dv.getUint32(o, true));
      if (!name || (type !== 2 && type !== 0) || shndx === 0 || shndx >= 0xff00) continue;
      syms.push({ name, shndx, value: u64(dv, o + 8), size: u64(dv, o + 16), func: type === 2 });
    }
  }
  const functions = [];
  let next = 0;
  for (const s of code) {
    const base = relocatable ? 0 : s.addr;
    const at = relocatable ? next : s.addr;
    next = Math.ceil((next + s.size) / 64) * 64;
    let list = syms.filter((x) => x.shndx === s.index && !x.name.startsWith('.L'));
    // functions if the file says which (STT_FUNC), else every label in it (hand-written code)
    if (list.some((x) => x.func)) list = list.filter((x) => x.func);
    functions.push(...ranges(list.map((x) => ({ name: x.name, start: x.value - base, size: x.size })), s.size, s.name).map((f) => ({
      ...f, section: s.name, address: at + f.start, bytes: b.subarray(s.offset + f.start, s.offset + f.start + f.size),
    })));
  }
  return { format: `elf64-x86-64${relocatable ? '' : type === 2 ? ' (executable)' : ' (shared object)'}`, functions };
}

// Function ranges in a section of `size` bytes: each symbol to its size, or to the next symbol (or the end); code before
// the first symbol (or a section without symbols) as one function named after the section.
function ranges(list, size, section) {
  const sorted = [...list].filter((x) => x.start >= 0 && x.start < size).sort((a, c) => a.start - c.start || a.name.localeCompare(c.name));
  const out = [];
  const seen = new Set();
  if (!sorted.length || sorted[0].start > 0) out.push({ name: section, start: 0, size: sorted.length ? sorted[0].start : size });
  sorted.forEach((x, k) => {
    if (seen.has(x.start)) return; // aliases: the first name
    seen.add(x.start);
    const next = sorted.slice(k + 1).find((y) => y.start > x.start)?.start ?? size;
    out.push({ name: x.name, start: x.start, size: x.size > 0 ? Math.min(x.size, size - x.start) : next - x.start });
  });
  return out.filter((f) => f.size > 0);
}

function readFat(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); // big-endian header
  const n = dv.getUint32(4, false);
  const archs = [];
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 20;
    const cpu = dv.getUint32(o, false), offset = dv.getUint32(o + 8, false), size = dv.getUint32(o + 12, false);
    archs.push({ cpu, offset, size });
  }
  const x = archs.find((a) => a.cpu === MACHO_X86_64);
  if (!x) return { error: `a universal Mach-O file without x86-64 code (${archs.map((a) => cpuName(a.cpu)).join(', ')}): wuica analyzes x86-64 code; ${ARCH_HELP}` };
  return readMachO(b.subarray(x.offset, x.offset + x.size));
}

const cpuName = (c) => (c === MACHO_ARM64 ? 'arm64' : c === MACHO_X86_64 ? 'x86_64' : c === MACHO_I386 ? 'i386' : `cpu ${c}`);

function readMachO(b) {
  const dv = view(b);
  const cpu = dv.getUint32(4, true), filetype = dv.getUint32(12, true), ncmds = dv.getUint32(16, true);
  if (cpu !== MACHO_X86_64) return { error: `${cpu === MACHO_ARM64 ? 'an arm64' : `a ${cpuName(cpu)}`} Mach-O file: wuica analyzes x86-64 code; ${ARCH_HELP}` };
  const sects = [];
  /** @type {{symoff: number, nsyms: number, stroff: number} | null} */
  let symtab = null;
  let o = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = dv.getUint32(o, true), size = dv.getUint32(o + 4, true);
    if (cmd === 0x19) { // LC_SEGMENT_64
      const nsects = dv.getUint32(o + 64, true);
      for (let k = 0; k < nsects; k++) {
        const s = o + 72 + k * 80;
        sects.push({ name: cstr(b.subarray(0, s + 16), s), segment: cstr(b.subarray(0, s + 32), s + 16), addr: u64(dv, s + 32), size: u64(dv, s + 40), offset: dv.getUint32(s + 48, true), flags: dv.getUint32(s + 64, true) });
      }
    } else if (cmd === 0x2) { // LC_SYMTAB
      symtab = { symoff: dv.getUint32(o + 8, true), nsyms: dv.getUint32(o + 12, true), stroff: dv.getUint32(o + 16, true) };
    }
    o += size;
  }
  // code: sections with instructions (S_ATTR_PURE_INSTRUCTIONS or S_ATTR_SOME_INSTRUCTIONS), with bytes in the file
  const code = sects.map((s, i) => ({ ...s, index: i + 1 })).filter((s) => (s.flags & 0x80000400) !== 0 && (s.flags & 0xff) !== 1 && s.size > 0);
  if (!code.length) return { error: 'no code sections (__text) in the file' };
  const syms = [];
  if (symtab) {
    for (let k = 0; k < symtab.nsyms; k++) {
      const e = symtab.symoff + k * 16;
      const type = b[e + 4], sect = b[e + 5];
      if (type & 0xe0 || (type & 0x0e) !== 0x0e) continue; // debugging entries; not defined in a section
      const name = cstr(b, symtab.stroff + dv.getUint32(e, true));
      // the assembler's local labels (ltmp0, l_..., L...) are not functions
      if (!name || /^(?:ltmp\d+|l_|L)/.test(name)) continue;
      syms.push({ name, sect, value: u64(dv, e + 8) });
    }
  }
  const functions = [];
  for (const s of code) {
    const list = syms.filter((x) => x.sect === s.index).map((x) => ({ name: x.name, start: x.value - s.addr, size: 0 }));
    const label = `${s.segment},${s.name}`;
    functions.push(...ranges(list, s.size, label).map((f) => ({ ...f, section: label, address: s.addr + f.start, bytes: b.subarray(s.offset + f.start, s.offset + f.start + f.size) })));
  }
  return { format: `mach-o x86-64${filetype === 1 ? '' : ' (executable)'}`, functions };
}

// llvm-objdump -d's text of the functions: decode(bytes) -> [{addr, opcode, asm, category}] from the analyzer's decoder
// (addr relative to the bytes; a branch's target in `asm` relative to its own address, as XED prints it).
export function objdumpText(obj, decode, name = 'input') {
  const lines = [`${name}:\tfile format ${obj.format}`, ''];
  let section = null;
  for (const f of obj.functions) {
    if (f.section !== section) { lines.push(`Disassembly of section ${f.section}:`, ''); section = f.section; }
    lines.push(`${f.address.toString(16).padStart(16, '0')} <${f.name}>:`);
    const instrs = decode(f.bytes);
    let pos = 0;
    const bytesOf = (from, to) => [...f.bytes.subarray(from, to)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
    const line = (at, len, text) => lines.push(`${(f.address + at).toString(16).padStart(8)}: ${bytesOf(at, at + len).padEnd(29)}\t${text}`);
    for (const i of instrs) {
      for (; pos < i.addr; pos++) line(pos, 1, '<unknown>'); // bytes the decoder could not read
      const len = i.opcode.length / 2;
      let text = i.asm.trim().replace(/\s+/g, ' ');
      const m = /^(\S+) (0x[0-9a-f]+)$/i.exec(text);
      if (m && /^(?:COND_BR|UNCOND_BR|CALL)$/.test(i.category)) {
        const t = f.address + i.addr + Number(BigInt.asIntN(64, BigInt(m[2])));
        const inside = t >= f.address && t < f.address + f.bytes.length;
        text = `${m[1]}\t0x${t.toString(16)}${inside ? ` <${f.name}${t > f.address ? `+0x${(t - f.address).toString(16)}` : ''}>` : ''}`;
      }
      line(i.addr, len, text);
      pos = i.addr + len;
    }
    for (; pos < f.bytes.length; pos++) line(pos, 1, '<unknown>');
    lines.push('');
  }
  return lines.join('\n');
}

// The function a -func name means among an object's functions: exact, else without Mach-O's leading underscore, else a
// unique part of a name. {name} or {error} (the candidates when ambiguous, the functions when none matches). A name the
// file gives to several functions (uniqueNames: NAME.0xADDR) is ambiguous: the error lists them with their addresses.
export function resolveFunction(functions, func) {
  const names = [...new Set(functions.map((f) => f.name))];
  if (names.includes(func)) return { name: func };
  for (const symbol of [func, `_${func}`]) {
    const same = functions.filter((f) => f.symbol === symbol);
    if (!same.length) continue;
    const shown = same.slice(0, 10).map((f) => `0x${f.address.toString(16)}`);
    const at = `${shown.slice(0, -1).join(', ')}${same.length > 2 ? ',' : ''} and ${shown[shown.length - 1]}${same.length > 10 ? ` (and ${same.length - 10} more: -funcs lists them)` : ''}`;
    return { error: `func: ${JSON.stringify(func)} names ${same.length} functions of the file, at ${at} (static functions of different source files, or parts of one): give it with its address, -func ${same[0].name}${same.length === 2 ? ` or -func ${same[1].name}` : ''}` };
  }
  const under = names.filter((n) => n === `_${func}`);
  if (under.length === 1) return { name: under[0] };
  const part = names.filter((n) => n.includes(func));
  if (part.length === 1) return { name: part[0] };
  // (a static executable has thousands of functions: a long list is left to -funcs)
  const list = (xs) => (xs.length <= 20 ? xs.join(', ') : `${xs.slice(0, 20).join(', ')}, and ${xs.length - 20} more: -funcs lists them`);
  if (part.length > 1) return { error: `func: ${JSON.stringify(func)} is part of ${part.length} function names (${list(part)}): give one of them` };
  return { error: `func: ${JSON.stringify(func)} is not a function of the file (functions: ${list(names) || 'none'})` };
}
