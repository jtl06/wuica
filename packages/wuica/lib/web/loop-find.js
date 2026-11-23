// Find the loop in pasted assembly: a whole function (gcc -S, clang -S, objdump -d with or without the byte column, a
// Compiler Explorer import) is analyzed at its innermost loop, or at its body if it has none. No DOM and no assembling
// here (asm-regions.js assembles the plan; tests-js/web_loop_find.mjs runs this under Node; the npm package ships a
// copy, packages/wuica/lib/web).
//
// preparePaste(text, {loop}) reads the text once and returns what the assembly of an analysis needs:
//   - objdump lines ("  40:\tcrc32 rax, ...", "  1c: jne 10 <psum+0x10>", with or without the bytes) become plain
//     statements, line for line (diagnostics keep their lines): addresses that are branch targets become labels
//     .Lwuica_a<hex>, a branch to an address outside the text a branch to a symbol. A line with its bytes is assembled
//     as those bytes (the exact encoding); a line without them that the assembler rejects outside the analyzed code
//     (padding: "cs nop ...") is left out. A GNU numeric label ("1: ... jnz 1b") is not an address: objdump
//     text is told apart by a header line, hex letters in an address, a <sym+off> target, a byte column, or three or
//     more increasing addresses without any "1b"/"1f" reference.
//   - a ';' that starts a line is a comment (as '#'); one after a statement stays a separator unless the assembler
//     rejects what follows it (asm-regions.js retries with semicolonFixes).
//   - the loops: backward branches to a label (or to an address); innermost first, in the order of the code. The pick is
//     the first one, unless the text is that loop already; with no loop, a text that ends in ret is analyzed without its
//     prologue and epilogue (its body). Region markers (LLVM-MCA-BEGIN, wuica-begin, IACA) win: no pick.
//   - conditional branches to a symbol the text does not define (the loop's exits: jae .Lout) are "not taken": the
//     symbol is defined right after the analyzed code (stubs), so they assemble, short, as a compiler would emit them.
//     An undefined target of a jmp is a warning (it is encoded as a 32-bit jump to an external symbol).
//   - alignment: the analyzed code's address modulo 64, when the text has addresses.

const MARKER = /^\s*(?:#|\/\/|;)\s*(?:LLVM-MCA-BEGIN|wuica-begin)(?![\w-])/im;
const IACA = /^\s*mov[l]?\s+(?:ebx\s*,\s*111|\$111\s*,\s*%ebx)\s*$/im;
const LABELS = /^(?:\s*(?:[\w.$@]+|"[^"]*")\s*:)*\s*/;
const LABEL_ONE = /\s*([\w.$@]+|"[^"]*")\s*:/y;
const PREFIX = /^(?:lock|rep|repe|repz|repne|repnz|bnd|notrack|data16|data32|addr32|cs|ds|es|ss|fs|gs|rex(?:\.\w+)?|\{[\w ]+\})$/i;
export const JCC = /^(?:j(?:a|ae|b|be|c|e|g|ge|l|le|na|nae|nb|nbe|nc|ne|ng|nge|nl|nle|no|np|ns|nz|o|p|pe|po|s|z|rcxz|ecxz)|loop(?:e|ne|z|nz)?|xbegin)$/i;
export const JMP = /^jmp[lqw]?$/i;
const CALL = /^call[lqw]?$/i;
const RET = /^ret[lqw]?$/i;
const SYMBOL = /^[A-Za-z_.$@][\w.$@]*$/;
const GPR = /^(?:[re]?(?:ax|bx|cx|dx|si|di|sp|bp|ip)|[abcd][lh]|(?:si|di|sp|bp)l|r(?:[89]|1[0-5])[dwb]?)$/i;

export const OUTSIDE_PREFIX = '.Lwuica_x'; // an objdump branch to an address that is not in the text
const ADDR_LABEL = (a) => `.Lwuica_a${a.toString(16)}`;

// Splits a line (block comments already removed) into its statements outside comments: [{at, text}] (at: the column
// of the statement's first character, 0-based). '#' and '//' start a comment, ';' separates statements; quotes kept.
export function statements(line) {
  const out = [];
  let start = 0, q = false;
  for (let i = 0; i <= line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === '"') q = false; continue; }
    if (c === '"') { q = true; continue; }
    const end = i === line.length || c === '#' || c === ';' || (c === '/' && line[i + 1] === '/');
    if (!end) continue;
    const s = line.slice(start, i);
    const lead = s.length - s.trimStart().length;
    if (s.trim()) out.push({ at: start + lead, text: s.trim() });
    if (c !== ';') break;
    start = i + 1;
  }
  return out;
}

// Block comments blanked (columns and lines stay).
function blankBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

// ---- ';' comments ----------------------------------------------------------------------------------------------------

// A ';' at the start of a line (after white space) is a comment: it becomes '#' (same column).
export function leadingSemicolons(text) {
  return String(text).replace(/^([ \t]*);/gm, '$1#');
}

// The lines to change after a failed assembly: an error right after a ';' ("invalid instruction mnemonic 'note'" in
// "add rax, 1 ; note") means the ';' was meant as a comment. Map line (1-based) -> the line with that ';' as '#'.
export function semicolonFixes(diagnostics, text) {
  const lines = String(text).split('\n');
  const out = new Map();
  for (const d of diagnostics ?? []) {
    if (d.severity !== 'error' || !d.line || !d.column || !/^(invalid instruction mnemonic|unexpected token at start of statement|unknown use of instruction mnemonic)/.test(d.message)) continue;
    const l = out.get(d.line) ?? lines[d.line - 1] ?? '';
    const before = l.slice(0, d.column - 1);
    const m = /;\s*$/.exec(before);
    if (!m) continue;
    out.set(d.line, l.slice(0, m.index) + '#' + l.slice(m.index + 1));
  }
  return out;
}

// ---- objdump -------------------------------------------------------------------------------------------------------

const OD_ADDR = /^(\s*)([0-9a-fA-F]+):(\s+)(\S.*)$/;
const OD_HEADER = /^\s*[0-9a-fA-F]+\s+<[^>]*>:\s*$/;
const OD_NOISE = /^\s*(?:Disassembly of section\b.*|\S.*:\s+file format\s.*|[0-9a-fA-F]+:\s+R_X86_64_\S+.*|\.\.\.)\s*$/;
const OD_BRANCH = /^((?:\S+\s+)*?)(j[a-z]{1,4}|jmp[lqw]?|call[lqw]?|loop[a-z]{0,2}|xbegin)(\s+)(?:0x)?([0-9a-fA-F]+)(?:\s*<[^>]*>)?\s*(?:#.*)?$/i;

// The byte column at the start of `rest` (objdump: two hex digits separated by single spaces, ended by a tab or two
// spaces, or by the end of the line on a continuation line): {bytes, rest}.
function byteColumn(rest) {
  const m = /^((?:[0-9a-fA-F]{2} )*[0-9a-fA-F]{2}) ?(?:\t|  |\s*$)/.exec(rest);
  if (!m) return { bytes: null, rest };
  return { bytes: m[1].split(' ').map((b) => parseInt(b, 16)), rest: rest.slice(m[0].length).trim() };
}

// {text, objdump: true, addresses: Map line -> address, bytes: Map line -> the line as .byte} or {objdump: false}.
export function fromObjdump(text) {
  const lines = String(text).split('\n');
  let count = 0, header = false, letters = false, symbolic = false, column = false, increasing = true, last = -1;
  for (const l of lines) {
    if (OD_HEADER.test(l)) { header = true; continue; }
    if (OD_NOISE.test(l)) continue;
    const m = OD_ADDR.exec(l);
    if (!m) continue;
    const a = parseInt(m[2], 16);
    count++;
    if (/[a-f]/i.test(m[2])) letters = true;
    if (/<[^>]*>/.test(m[4])) symbolic = true;
    if (byteColumn(m[4]).bytes && /\t|  /.test(m[4])) column = true;
    if (a <= last) increasing = false;
    last = a;
  }
  if (count < 2 || !increasing) return { objdump: false };
  // a GNU numeric label referenced as 1b / 1f: assembly, not a listing
  if (/\b(?:j[a-z]{1,4}|jmp|call|loop[a-z]*)\s+\d+[bf]\b/i.test(text)) return { objdump: false };
  if (!(header || letters || symbolic || column || count >= 3)) return { objdump: false };

  const parsed = lines.map((l) => {
    if (OD_HEADER.test(l) || OD_NOISE.test(l)) return { kind: 'blank' };
    const m = OD_ADDR.exec(l);
    if (!m) return { kind: 'keep', text: l };
    const { bytes, rest } = byteColumn(m[4]);
    if (!rest) return { kind: 'more', bytes: bytes ?? [] }; // a continuation line: more bytes of the instruction above
    return { kind: 'instr', indent: m[1] || '  ', address: parseInt(m[2], 16), bytes, text: rest.replace(/\s+#.*$/, '').replace(/\s+/g, ' ').trim() };
  });
  for (let k = parsed.length - 1; k > 0; k--) { // continuation bytes belong to the instruction above
    if (parsed[k].kind !== 'more') continue;
    let j = k - 1;
    while (j >= 0 && parsed[j].kind === 'more') j--;
    if (j >= 0 && parsed[j].kind === 'instr' && parsed[j].bytes) parsed[j].bytes = [...parsed[j].bytes, ...parsed.slice(j + 1, k + 1).flatMap((p) => p.bytes)];
  }
  const at = new Set(parsed.filter((p) => p.kind === 'instr').map((p) => p.address));
  const targets = new Set();
  for (const p of parsed) {
    if (p.kind !== 'instr') continue;
    const b = OD_BRANCH.exec(p.text);
    if (!b) continue;
    const mn = b[2].toLowerCase();
    if (!JCC.test(mn) && !JMP.test(mn) && !CALL.test(mn)) continue;
    const t = parseInt(b[4], 16);
    let name;
    if (at.has(t)) { name = ADDR_LABEL(t); targets.add(t); } else if (CALL.test(mn) || JMP.test(mn)) name = `wuica_ext_${t.toString(16)}`;
    else name = `${OUTSIDE_PREFIX}${t.toString(16)}`;
    p.text = `${b[1]}${b[2]}${b[3]}${name}`;
  }
  const addresses = new Map(), byteMap = new Map();
  const out = parsed.map((p, k) => {
    if (p.kind === 'blank' || p.kind === 'more') return '';
    if (p.kind === 'keep') return p.text;
    addresses.set(k + 1, p.address);
    const label = targets.has(p.address) ? `${ADDR_LABEL(p.address)}: ` : '';
    if (p.bytes?.length) byteMap.set(k + 1, `${p.indent}${label}.byte ${p.bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}`);
    return `${p.indent}${label}${p.text}`;
  });
  return { objdump: true, text: out.join('\n'), addresses, bytes: byteMap };
}

// ---- the statements of a text ----------------------------------------------------------------------------------------

function splitInstr(body) {
  const words = body.replace(/\s+/g, ' ').trim().split(' ');
  let i = 0;
  while (i < words.length - 1 && PREFIX.test(words[i])) i++;
  return { mnemonic: (words[i] ?? '').toLowerCase(), operands: words.slice(i + 1).join(' ').trim() };
}

const sectionName = (args) => (/^\s*("?)([^",\s]+)\1/.exec(args)?.[2] ?? '');

// {labels: Map name -> line, symbols: Set (assigned with = / .set / .equ), instrs: [{line, col, mnemonic, operands,
// kind: 'jcc' | 'jmp' | 'call' | 'ret' | 'other', target}], numeric: [{name, line}]}. Lines 1-based; only .text code.
export function scan(text) {
  const lines = blankBlockComments(String(text)).split('\n');
  const labels = new Map(), symbols = new Set(), instrs = [], numeric = [];
  let inText = true, prev = true;
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    for (const st of statements(lines[i])) {
      const lead = LABELS.exec(st.text)[0].length;
      LABEL_ONE.lastIndex = 0;
      let m;
      const head = st.text.slice(0, lead);
      while ((m = LABEL_ONE.exec(head))) {
        const name = m[1];
        if (/^\d+$/.test(name)) numeric.push({ name, line: i + 1, inText });
        else if (!labels.has(name)) labels.set(name, { line: i + 1, inText });
      }
      const body = st.text.slice(lead).trim();
      if (!body) continue;
      if (body[0] === '.') {
        const d = /^\.([\w.]+)\s*(.*)$/.exec(body);
        const name = d?.[1].toLowerCase() ?? '';
        const args = d?.[2] ?? '';
        if (name === 'set' || name === 'equ' || name === 'equiv') { const s = /^([\w.$@]+)/.exec(args); if (s) symbols.add(s[1]); }
        else if (name === 'text') { prev = inText; inText = true; }
        else if (name === 'data' || name === 'bss') { prev = inText; inText = false; }
        else if (name === 'section') { prev = inText; inText = sectionName(args) === '.text' || sectionName(args).startsWith('.text.'); }
        else if (name === 'pushsection') { stack.push(inText); prev = inText; inText = sectionName(args) === '.text'; }
        else if (name === 'popsection') { prev = inText; inText = stack.pop() ?? true; }
        else if (name === 'previous') { [inText, prev] = [prev, inText]; }
        continue;
      }
      const assign = /^([\w.$@]+)\s*=/.exec(body);
      if (assign) { symbols.add(assign[1]); continue; }
      if (!inText) continue;
      const { mnemonic, operands } = splitInstr(body);
      let kind = 'other', target = null;
      if (JCC.test(mnemonic)) kind = 'jcc';
      else if (JMP.test(mnemonic)) kind = 'jmp';
      else if (CALL.test(mnemonic)) kind = 'call';
      else if (RET.test(mnemonic)) kind = 'ret';
      if (kind === 'jcc' || kind === 'jmp' || kind === 'call') {
        const op = operands.replace(/^\*/, '');
        if (/^\d+[bf]$/.test(op) || (SYMBOL.test(op) && !GPR.test(op) && !op.startsWith('%'))) target = op;
      }
      instrs.push({ line: i + 1, col: st.at + lead, end: st.at + st.text.length, mnemonic, operands, kind, target, body });
    }
  }
  return { labels, symbols, instrs, numeric };
}

// The line a branch target refers to (a label, or a numeric label "1b" / "1f" seen from `line`), or null.
function targetLine(s, target, line) {
  const n = /^(\d+)([bf])$/.exec(target);
  if (n) {
    const cands = s.numeric.filter((x) => x.name === n[1] && x.inText);
    const c = n[2] === 'b' ? cands.filter((x) => x.line <= line).pop() : cands.find((x) => x.line > line);
    return c ? c.line : null;
  }
  const l = s.labels.get(target);
  return l && l.inText ? l.line : null;
}

// The loops: [{begin, end, label, inner}] (begin: the label's line, end: the last branch back to it; 1-based), innermost first,
// in the order of the code (a compiler puts the main loop before its remainder loop), then the outer ones.
export function findLoops(s) {
  const loops = [];
  for (const ins of s.instrs) {
    if ((ins.kind !== 'jcc' && ins.kind !== 'jmp') || !ins.target) continue;
    const t = targetLine(s, ins.target, ins.line);
    if (t === null || t > ins.line) continue;
    // several branches back to one label are one loop (to the last of them): an exit retargeted to the top is not a loop
    const same = loops.find((l) => l.begin === t);
    if (same) same.end = Math.max(same.end, ins.line);
    else loops.push({ begin: t, end: ins.line, label: ins.target });
  }
  for (const l of loops) l.inner = !loops.some((o) => o !== l && o.begin >= l.begin && o.end <= l.end && (o.begin !== l.begin || o.end !== l.end));
  return loops.sort((a, b) => Number(b.inner) - Number(a.inner) || a.begin - b.begin || a.end - b.end);
}

const PROLOGUE = [
  /^endbr64$/i,
  /^push[q]?\s+%?[\w]+$/i,
  /^mov[q]?\s+(?:rbp\s*,\s*rsp|%rsp\s*,\s*%rbp)$/i,
  /^(?:sub|and)[q]?\s+(?:rsp\s*,\s*[-\w$]+|\$?[-\w]+\s*,\s*%rsp)$/i,
];
const EPILOGUE = [
  /^(?:rep[z]?\s+)?ret[q]?(?:\s+\S+)?$/i,
  /^leave[q]?$/i,
  /^pop[q]?\s+%?[\w]+$/i,
  /^add[q]?\s+(?:rsp\s*,\s*[-\w$]+|\$?[-\w]+\s*,\s*%rsp)$/i,
  /^lea[q]?\s+(?:rsp\s*,.*|.*,\s*%rsp)$/i,
  /^mov[q]?\s+(?:rsp\s*,\s*rbp|%rbp\s*,\s*%rsp)$/i,
  /^vzeroupper$/i,
];

// A function without a loop: its body without the prologue and the epilogue ({begin, end} lines), or null (no ret at
// the end, or nothing left).
export function functionBody(s) {
  const ins = s.instrs;
  let last = ins.length - 1;
  // padding after the last ret (nop, int3, ud2) is not code of the function
  while (last >= 0 && /^(?:nop[wlq]?|int3|ud2|xchg)$/i.test(ins[last].mnemonic)) last--;
  if (last < 0 || ins[last].kind !== 'ret') return null;
  let a = 0, b = last;
  while (a <= b && PROLOGUE.some((re) => re.test(ins[a].body.replace(/\s+/g, ' ')))) a++;
  while (b >= a && EPILOGUE.some((re) => re.test(ins[b].body.replace(/\s+/g, ' ')))) b--;
  if (a > b) return null;
  return { begin: ins[a].line, end: ins[b].line };
}

// What to analyze: see the top. text: the pasted assembly; loop: 'auto' (default), 'whole', or the index of a loop.
// Returns {text, objdump, loops: [{begin, end, label}], choice: index | 'body' | null, choosable (there is code around the
//   loop or the body: a choice matters), pick: {begin, end} | null,
//   body: {begin, end} | null, alignment: number | null, address: number | null, stubs: [names],
//   notes: [{line, column, severity, message}], fallback: Map line -> text, error?}
export function preparePaste(text, { loop = 'auto' } = {}) {
  let t = leadingSemicolons(String(text ?? '').replace(/^﻿/, ''));
  const od = fromObjdump(t);
  if (od.objdump) t = od.text;
  const s = scan(t);
  const marked = MARKER.test(t) || IACA.test(t);
  const all = findLoops(s);
  const loops = marked ? [] : all;
  // objdump lines with their bytes are assembled as those bytes (the exact encodings); their text is only read
  let asm = t;
  if (od.objdump && od.bytes.size) {
    const lines = t.split('\n');
    for (const [line, b] of od.bytes) lines[line - 1] = b;
    asm = lines.join('\n');
  }
  const out = { text: asm, objdump: od.objdump, loops: loops.map(({ begin, end, label }) => ({ begin, end, label: label.startsWith('.Lwuica_a') ? `0x${label.slice(9)}` : label })),
    choice: null, choosable: false, pick: null, body: null, alignment: null, address: null, stubs: [], notes: [], fallback: new Map() };
  if (loop !== 'auto' && loop !== 'whole' && !(Number.isInteger(loop) && loop >= 0)) {
    out.error = `loop: ${JSON.stringify(loop)} is not "auto", "whole" or the index of a loop`;
    return out;
  }
  const code = s.instrs;
  if (Number.isInteger(loop) && loop >= loops.length) {
    out.error = `loop: ${loop} is not the index of a loop (the text has ${loops.length === 0 ? 'none' : loops.length})`;
    return out;
  }
  if (!marked) {
    // choosable: there is code around the loop (or a prologue around the body), so the choice matters
    if (loops.length) out.choosable = !(loops.length === 1 && code.every((x) => x.line >= loops[0].begin && x.line <= loops[0].end));
    else { out.body = functionBody(s); out.choosable = !!out.body; }
    if (out.choosable && loop !== 'whole') {
      if (loops.length) {
        const k = Number.isInteger(loop) ? loop : 0;
        out.choice = k;
        out.pick = { begin: loops[k].begin, end: loops[k].end };
      } else {
        out.choice = 'body';
        out.pick = out.body;
      }
    }
  }
  // the exits: conditional branches (and jumps to .L labels) whose target the text does not define
  const defined = (name) => s.labels.has(name) || s.symbols.has(name);
  const seen = new Set();
  for (const x of code) {
    if (!x.target || /^\d+[bf]$/.test(x.target) || defined(x.target)) continue;
    if (x.kind === 'jcc' || (x.kind === 'jmp' && (x.target.startsWith('.L') || x.target.startsWith(OUTSIDE_PREFIX)))) {
      if (seen.has(x.target)) continue;
      seen.add(x.target);
      out.stubs.push(x.target);
      if (!x.target.startsWith(OUTSIDE_PREFIX)) out.notes.push({ line: x.line, column: x.col + 1, severity: 'note', message: `${x.target} is not in the code: taken as an exit, not taken` });
    } else if (x.kind === 'jmp' && !x.target.startsWith('wuica_ext_')) {
      if (seen.has(x.target)) continue;
      seen.add(x.target);
      out.notes.push({ line: x.line, column: x.col + 1, severity: 'warning', message: `${x.target} is not defined: encoded as a 32-bit jump to an external symbol` });
    }
  }
  if (od.objdump) {
    for (const line of od.addresses.keys()) if (!od.bytes.has(line) && !(out.pick && line >= out.pick.begin && line <= out.pick.end)) out.fallback.set(line, '');
    const first = code.find((x) => !out.pick || x.line >= out.pick.begin);
    const a = first ? od.addresses.get(first.line) : undefined;
    if (a !== undefined) { out.address = a; out.alignment = a % 64; }
  }
  return out;
}

// The loops as the page's chip names them: "loop .L3", "loop 0x10", "body".
export function loopName(prep) {
  if (prep.choice === 'body') return 'body';
  if (prep.choice === null) return null;
  return `loop ${prep.loops[prep.choice].label}`;
}
