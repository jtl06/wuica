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
//     (padding: "cs nop ...") is left out. objdump text is told apart from assembly by a header line, a byte column or
//     a <sym+off> branch target; without those, by three or more lines that are all address-prefixed, with
//     increasing addresses whose steps fit their instructions and no branch to a GNU numeric label ("jnz 1b"). In
//     objdump text, a branch target is always an address ("jne 1b <psum+0x1b>" goes to 0x1b).
//   - line ends: CRLF and a lone CR are line feeds (normalizeText).
//   - a ';' that starts a line is a comment (as '#'); one after a statement stays a separator unless the assembler
//     rejects what follows it (asm-regions.js: commentFixes, separatorNotes).
//   - the loops: backward branches to a label (or to an address); innermost first, in the order of the code. A span
//     that holds a ret or a function's label is not a loop (a tail call to an earlier function). The pick is the default
//     loop (defaultLoop: among the deepest innermost loops in the function of the first of them, the widest vector loop,
//     else the largest), unless the text is
//     that loop already; with no loop, a compiler's function (a function label, directives, or
//     a prologue/epilogue) that ends in ret is analyzed without its prologue, epilogue and ret (its body); a bare snippet
//     is analyzed as typed. Region markers (LLVM-MCA-BEGIN, wuica-begin, IACA) win: no pick. loop "whole": no pick.
//   - conditional branches to a symbol the text does not define (the loop's exits: jae .Lout) are "not taken": the
//     symbol is defined right after the analyzed code (stubs), so they assemble, short, as a compiler would emit them.
//     An undefined target of a jmp is a warning (it is encoded as a 32-bit jump to an external symbol).
//   - alignment: the analyzed code's address modulo 64, when the text has addresses.

const MARKER = /^\s*(?:#|\/\/|;)\s*(?:LLVM-MCA-BEGIN|wuica-begin)(?![\w-])/im;
const IACA = /^\s*mov[l]?\s+(?:ebx\s*,\s*111|\$111\s*,\s*%ebx)\s*$/im;
const LABELS = /^(?:\s*(?:[\w.$@]+|"[^"]*")\s*:)*\s*/;
const LABEL_ONE = /\s*([\w.$@]+|"[^"]*")\s*:/y;
// data directives: bytes in the code that are not an instruction's line
const DATA = /^(?:byte|short|word|hword|long|int|quad|octa|zero|fill|space|skip|ascii|asciz|string(?:8|16|32|64)?|[248]byte|value|single|float|double|[su]leb128|incbin|dc(?:b|\.\w)?|ds(?:\.\w)?)$/;
const PREFIX = /^(?:lock|rep|repe|repz|repne|repnz|bnd|notrack|data16|data32|addr32|cs|ds|es|ss|fs|gs|rex(?:\.\w+)?|\{[\w ]+\})$/i;
export const JCC = /^(?:j(?:a|ae|b|be|c|e|g|ge|l|le|na|nae|nb|nbe|nc|ne|ng|nge|nl|nle|no|np|ns|nz|o|p|pe|po|s|z|rcxz|ecxz)|loop(?:e|ne|z|nz)?|xbegin)$/i;
export const JMP = /^jmp[lqw]?$/i;
const CALL = /^call[lqw]?$/i;
const RET = /^ret[lqw]?$/i;
const SYMBOL = /^[A-Za-z_.$@][\w.$@]*$/;
const GPR = /^(?:[re]?(?:ax|bx|cx|dx|si|di|sp|bp|ip)|[abcd][lh]|(?:si|di|sp|bp)l|r(?:[89]|1[0-5])[dwb]?)$/i;

export const OUTSIDE_PREFIX = '.Lwuica_x';
// directives after which the lines of a text are not its instructions one to one
const STRUCTURAL = /^[ \t]*(?:[\w.$@]+:[ \t]*)*(\.(?:rept|irpc?|macro|if\w*))\b/im; // an objdump branch to an address that is not in the text
const ADDR_LABEL = (a) => `.Lwuica_a${a.toString(16)}`;
// The page's links made before the default loop was defaultLoop's (a link without lp=) pick what "auto" picked then: the
// first loop of findLoops' list (url-state.js). Not a label (a label has no '-').
export const LEGACY_AUTO = 'auto-v1';

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

// The syntax of assembly text: 'att' or 'intel' (null: no sign of either). A directive (.att_syntax, .intel_syntax
// [noprefix]) before the first instruction decides; else the signs: AT&T's %registers, $immediates and (%base,...)
// memory operands against Intel's "ptr [" and [register...] operands. Comments are left out.
/** @returns {'att' | 'intel' | null} */
export function detectSyntax(text) {
  const lines = normalizeText(text).split('\n');
  let att = 0, intel = 0;
  for (const l of lines) {
    const code = l.replace(/(?:#|\/\/).*$/, '');
    const d = /^\s*\.(att|intel)_syntax\b/i.exec(code);
    if (d && att + intel === 0) return /** @type {'att' | 'intel'} */ (d[1].toLowerCase());
    const n = syntaxSigns(code);
    att += n.att;
    intel += n.intel;
  }
  return att > intel ? 'att' : intel > att ? 'intel' : null;
}

// The signs of each syntax in one line of code (comments left out): {att, intel} counts.
export function syntaxSigns(code) {
  let att = (code.match(/%(?:[re]?(?:[abcd]x|[sd]i|[sb]p|ip)|[abcd][lh]|(?:[sd]i|[sb]p)l|r(?:[89]|1[0-5])[dwb]?|[xyz]mm\d+|k[0-7]|[cdefgs]s)\b/gi) ?? []).length;
  att += (code.match(/(?:^|[\s,])\$-?(?:0x[0-9a-f]+|\d+)\b/gi) ?? []).length;
  let intel = (code.match(/\bptr\s*\[|\[\s*(?:[re]?(?:[abcd]x|[sd]i|[sb]p|ip)|r(?:[89]|1[0-5]))\b/gi) ?? []).length;
  if (!/%/.test(code)) intel += (code.match(/^\s*(?:\w+:\s*)*[a-z]\w*\s+(?:[re]?(?:[abcd]x|[sd]i|[sb]p)|r(?:[89]|1[0-5])[dwb]?|[xyz]mm\d+)\s*,/gi) ?? []).length;
  return { att, intel };
}

// CRLF and a lone CR as LF (lines stay).
export const normalizeText = (text) => String(text ?? '').replace(/\r\n?/g, '\n');

// Block comments blanked (columns and lines stay).
function blankBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

// ---- ';' comments ----------------------------------------------------------------------------------------------------

// A ';' at the start of a line (after white space) is a comment: it becomes '#' (same column).
export function leadingSemicolons(text) {
  return String(text).replace(/^([ \t]*);/gm, '$1#');
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

// One-byte instructions that have operands (an objdump step of 1 for an instruction with operands must be one of these).
const ONE_BYTE = /^(?:push|pop|xchg|in|out|ins\w*|outs\w*|stos\w*|lods\w*|movs\w*|scas\w*|cmps\w*|bswap|int)$/i;

// {text, objdump: true, addresses: Map line -> address, bytes: Map line -> the line as .byte, sources: Map line -> the
// source line in force (objdump -dS, -S: the interleaved source text, llvm-objdump's after "; ")} or {objdump: false}.
/** @returns {any} */
export function fromObjdump(text) {
  const lines = normalizeText(text).split('\n');
  let header = false, symbolic = false, column = false, increasing = true, other = 0, plausible = true;
  const rows = [];
  let last = -1; // (addresses increase within a function; perf annotate prints its functions in any order)
  for (const l of lines) {
    if (OD_HEADER.test(l)) { header = true; last = -1; continue; }
    if (OD_NOISE.test(l) || /^\s*(?:$|#|\/\/|;)/.test(l)) continue;
    const m = OD_ADDR.exec(l);
    if (!m) { other++; continue; }
    const a = parseInt(m[2], 16);
    if (/<[^>]*>/.test(m[4])) symbolic = true;
    const bc = byteColumn(m[4]);
    if (bc.bytes && /\t|  /.test(m[4])) column = true;
    if (a <= last) increasing = false;
    last = a;
    rows.push({ a, rest: bc.rest });
  }
  if (rows.length < 2 || !increasing) return { objdump: false };
  if (!(header || column || symbolic)) {
    // weak evidence ("40: crc32 ..."): every line address-prefixed, at least three, the steps fit the instructions
    // (an instruction with operands takes at least 2 bytes, at most 15), no branch to a GNU numeric label (1b, 1f)
    if (other > 0 || rows.length < 3) return { objdump: false };
    for (let k = 0; k + 1 < rows.length; k++) {
      const step = rows[k + 1].a - rows[k].a;
      const [mn, ops] = rows[k].rest.trim().split(/\s+(.*)/);
      if (step > 15 || (step < 2 && ops && !ONE_BYTE.test(mn ?? ''))) plausible = false;
    }
    if (!plausible) return { objdump: false };
    if (rows.some((r) => /^\s*(?:\S+\s+)*?(?:j[a-z]{1,4}|jmp\w*|call\w*|loop[a-z]*)\s+\d+[bf]\s*$/i.test(r.rest))) return { objdump: false };
  }

  /** @type {any[]} */
  const parsed = lines.map((l) => {
    // a function's header ("0000000000000020 <fir8>:") becomes its label (the loops' function), if it is a plain name
    const fh = /^\s*[0-9a-fA-F]+\s+<([A-Za-z_][\w.$]*)>:\s*$/.exec(l);
    if (fh) return { kind: 'keep', text: `${fh[1]}:` };
    if (OD_HEADER.test(l) || OD_NOISE.test(l)) return { kind: 'blank' };
    const m = OD_ADDR.exec(l);
    // other lines of a listing (objdump -S: the source) are not code
    if (!m) return /^\s*(?:$|#|\/\/|;)/.test(l) ? { kind: 'keep', text: l } : { kind: 'blank' };
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
  // objdump -S: a source line (llvm-objdump: "; text"; GNU objdump: the text itself) holds for the instructions after it,
  // up to the next one or the next function; GNU's -l lines ("/path/file.c:12", "dot():") are not source text
  const sources = new Map();
  /** @type {string | null} */
  let src = null;
  lines.forEach((l, k) => {
    const p = parsed[k];
    if (p.kind === 'instr') { if (src !== null) sources.set(k + 1, src); return; }
    if (/^\s*[0-9a-fA-F]+\s+<[^>]*>:\s*$/.test(l)) { src = null; return; }
    if (OD_HEADER.test(l) || OD_NOISE.test(l) || p.kind === 'more' || /^\s*$/.test(l) || /^\s*\/\//.test(l)) return;
    // (llvm-objdump's "; " is "# " here: a ';' that starts a line is read as '#', leadingSemicolons)
    const t = l.replace(/^\s*[;#]\s?/, '').trim();
    if (!t || /^\S+:\d+(?:\s*\(discriminator \d+\))?$/.test(t) || /^[\w.$]+\(\):$/.test(t)) return;
    src = t;
  });
  const addresses = new Map(), byteMap = new Map();
  const out = parsed.map((p, k) => {
    if (p.kind === 'blank' || p.kind === 'more') return '';
    if (p.kind === 'keep') return p.text;
    addresses.set(k + 1, p.address);
    const label = targets.has(p.address) ? `${ADDR_LABEL(p.address)}: ` : '';
    if (p.bytes?.length) byteMap.set(k + 1, `${p.indent}${label}.byte ${p.bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}`);
    return `${p.indent}${label}${p.text}`;
  });
  return { objdump: true, text: out.join('\n'), addresses, bytes: byteMap, sources };
}

// ---- perf annotate --------------------------------------------------------------------------------------------------

// `perf annotate --stdio` output: one block per symbol, each with its header ("Percent | Source code & Disassembly of hot
// for cycles:u (1069 samples, percent: local period)") and its lines: an instruction "   22.59 :   1413:   movaps ...",
// anything else after an empty percent column " :" (perf 7 numbers those lines: " : 39   s += m[...]"). Read as the same
// lines of objdump text (an instruction as "  1413:\tmovaps ...", a source line as "; text", the function header as is),
// line for line. samples: Map line -> the instruction's percent of all the samples of the output: a block's local
// percentages (perf's default) are of its own symbol's samples, weighted by the sample count of its header (an
// approximation of perf's global-period, which weighs by period); global ones, or without a header, as given. {text,
// perf: true, samples} or {perf: false} (stdio2: true for `perf annotate --stdio2` output, which has no addresses).
const PERF_INSN = /^\s*(\d+(?:\.\d+)?)\s*:\s+([0-9a-fA-F]+):\s+(\S.*)$/;
const PERF_OTHER = /^\s*:\s?(.*)$/;
const PERF_HEADER = /^\s*Percent\s*\|/;
const PERF_COUNT = /\((\d[\d,.'\u00a0\u202f]*) samples\b/; // (with a locale's thousands separators: "5,000")
const PERF_TYPE = /percent: ([^),]*)/;
/** @returns {any} */
export function fromPerfAnnotate(text) {
  const lines = normalizeText(text).split('\n');
  if (lines.filter((l) => PERF_INSN.test(l)).length < 2 || !lines.some((l) => /^\s*Percent\s*\|/.test(l) || PERF_OTHER.test(l))) {
    const stdio2 = /^Samples: .*\[percent: /m.test(lines.slice(0, 5).join('\n')) && lines.some((l) => /^Percent\s{2,}\S/.test(l));
    return { perf: false, stdio2 };
  }
  const local = new Map(); // line -> [percent, its block]
  /** @type {{samples: number | null, global: boolean}[]} */
  const blocks = [];
  /** @type {{samples: number | null, global: boolean} | null} */
  let block = null;
  const out = lines.map((l, k) => {
    if (PERF_HEADER.test(l)) {
      // each header its own count (none: unknown, not the previous header's); --percent-type global-*: already of all
      // the samples
      const n = PERF_COUNT.exec(l);
      block = { samples: n ? Number(n[1].replace(/\D/g, '')) : null, global: /global/.test(PERF_TYPE.exec(l)?.[1] ?? '') };
      blocks.push(block);
      return '';
    }
    const m = PERF_INSN.exec(l);
    if (m) { local.set(k + 1, [Number(m[1]), block]); return `  ${m[2]}:\t${m[3].trim()}`; }
    const o = PERF_OTHER.exec(l);
    if (!o) return ''; // the header's rule, a summary
    const t = o[1].trim().replace(/^\d+\s+/, ''); // (perf 7: the listing's line number first)
    if (!t || /^Disassembly of section\b/.test(t)) return '';
    if (/^[0-9a-fA-F]+\s+<[^>]*>:$/.test(t)) return t;
    return `; ${t}`;
  });
  // the percent of all samples: each block's local percentages weighted by its samples, if every such block has its
  // count (one block: as given); else each symbol's own percentages, as given (unweighted: true)
  const locals = blocks.filter((b) => !b.global);
  const unweighted = locals.length > 1 && locals.some((b) => b.samples === null);
  const total = unweighted ? 0 : locals.reduce((a, b) => a + (b.samples ?? 0), 0);
  const samples = new Map();
  for (const [line, [p, b]] of local) samples.set(line, total > 0 && b && !b.global && b.samples !== null ? Math.round(p * b.samples / total * 100) / 100 : p);
  return { perf: true, text: out.join('\n'), samples, unweighted };
}

// ---- the statements of a text ----------------------------------------------------------------------------------------

function splitInstr(body) {
  const words = body.replace(/\s+/g, ' ').trim().split(' ');
  let i = 0;
  while (i < words.length - 1 && PREFIX.test(words[i])) i++;
  return { mnemonic: (words[i] ?? '').toLowerCase(), operands: words.slice(i + 1).join(' ').trim() };
}

const sectionName = (args) => (/^\s*("?)([^",\s]+)\1/.exec(args)?.[2] ?? '');
// .text and the code sections of -ffunction-sections and gcc's main (.text.startup, .text.unlikely, .text.f)
export const isText = (args) => { const n = sectionName(args); return n === '.text' || n.startsWith('.text.'); };

// {labels: Map name -> line, symbols: Set (assigned with = / .set / .equ), instrs: [{line, col, mnemonic, operands,
// kind: 'jcc' | 'jmp' | 'call' | 'ret' | 'other', target}], numeric: [{name, line}], data: [line]}. Lines 1-based; only
// .text code. A prefix alone on its line ("lock", then "add [rdi], eax") is part of the next instruction, not one of its
// own; data: the lines of data directives in code (.byte, .fill, ...: bytes the instructions cannot be told from).
export function scan(text) {
  const raw = String(text).split('\n');
  const lines = blankBlockComments(String(text)).split('\n');
  // clang's loop notes on a label's line or the comment line after it ("# =>This Inner Loop Header: Depth=2",
  // "#   in Loop: Header=BB0_4 Depth=1"): label -> text
  const notes = new Map();
  const labels = new Map(), symbols = new Set(), instrs = [], numeric = [], functions = new Set(), data = [];
  let inText = true, prev = true, directives = 0;
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    for (const st of statements(lines[i])) {
      const lead = /** @type {RegExpExecArray} */ (LABELS.exec(st.text))[0].length;
      LABEL_ONE.lastIndex = 0;
      let m;
      const head = st.text.slice(0, lead);
      while ((m = LABEL_ONE.exec(head))) {
        const name = m[1];
        if (/^\d+$/.test(name)) numeric.push({ name, line: i + 1, inText });
        else if (!labels.has(name)) {
          labels.set(name, { line: i + 1, inText });
          const note = `${raw[i] ?? ''} ${/^\s*#/.test(raw[i + 1] ?? '') ? raw[i + 1] : ''}`;
          if (/Loop Header|in Loop:|Parent Loop/.test(note)) notes.set(name, note);
        }
      }
      const body = st.text.slice(lead).trim();
      if (!body) continue;
      if (body[0] === '.') {
        const d = /^\.([\w.]+)\s*(.*)$/.exec(body);
        const name = d?.[1].toLowerCase() ?? '';
        const args = d?.[2] ?? '';
        directives++;
        if (inText && DATA.test(name)) data.push(i + 1);
        if (name === 'set' || name === 'equ' || name === 'equiv') { const s = /^([\w.$@]+)/.exec(args); if (s) symbols.add(s[1]); }
        else if (name === 'globl' || name === 'global') { const s = /^([\w.$@]+)/.exec(args); if (s) functions.add(s[1]); }
        else if (name === 'type') { const s = /^([\w.$@]+)\s*,\s*[@%]function/.exec(args); if (s) functions.add(s[1]); }
        else if (name === 'text') { prev = inText; inText = true; }
        else if (name === 'data' || name === 'bss') { prev = inText; inText = false; }
        else if (name === 'section') { prev = inText; inText = isText(args); }
        else if (name === 'pushsection') { stack.push(inText); prev = inText; inText = isText(args); }
        else if (name === 'popsection') { prev = inText; inText = stack.pop() ?? true; }
        else if (name === 'previous') { [inText, prev] = [prev, inText]; }
        continue;
      }
      const assign = /^([\w.$@]+)\s*=/.exec(body);
      if (assign) { symbols.add(assign[1]); continue; }
      if (!inText) continue;
      if (body.split(/\s+/).every((w) => PREFIX.test(w))) continue; // a prefix alone: the next instruction's
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
  return { labels, symbols, instrs, numeric, functions, directives, notes, data };
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

// The loops: [{begin, end, label, inner, depth, instructions, function, vector: {width, count}}] (begin: the label's line,
// end: the last branch back to it; 1-based), innermost first, then the deepest, then in the order of the code (which may
// put a remainder loop first: clang often does). defaultLoop picks one of them.
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
  // not a loop: a span with a ret, or with a function's label in it (a tail call jumping back to an earlier function)
  const fn = (name, l) => !name.startsWith('.L') && !/^\d+$/.test(name) && (s.functions?.has(name)
    || s.instrs.some((x) => (x.kind === 'call' || x.kind === 'jmp' || x.kind === 'jcc') && x.target === name && (x.line < l.begin || x.line > l.end)));
  const real = loops.filter((l) => !s.instrs.some((x) => x.kind === 'ret' && x.line > l.begin && x.line < l.end)
    && ![...s.labels].some(([name, d]) => d.line > l.begin && d.line <= l.end && fn(name, l)));
  // clang's notes: the loops whose labels belong to one loop header (its blocks, "in Loop: Header=BB0_4") are one loop,
  // named after its header, at clang's depth
  let merged = real;
  if (s.notes?.size) {
    const keyOf = (label) => {
      const n = s.notes.get(label) ?? '';
      if (/This (?:Inner )?Loop Header/.test(n) || !/Header=(\w+)/.test(n)) return label.replace(/^\.L/, '');
      return /** @type {RegExpExecArray} */ (/Header=(\w+)/.exec(n))[1];
    };
    const groups = new Map();
    for (const l of real) {
      const k = keyOf(l.label);
      const g = groups.get(k);
      if (g) { g.begin = Math.min(g.begin, l.begin); g.end = Math.max(g.end, l.end); } else groups.set(k, { ...l, key: k });
    }
    merged = [...groups.values()].map((g) => {
      const header = `.L${g.key}`;
      const label = s.labels.has(header) ? header : g.label;
      const note = s.notes.get(label) ?? '';
      const d = /Loop Header: Depth=(\d+)/.exec(note) ?? /Depth=(\d+)/.exec(note);
      return { begin: g.begin, end: g.end, label, ...(d ? { clangDepth: Number(d[1]) } : {}) };
    });
  }
  for (const l of merged) {
    l.inner = !merged.some((o) => o !== l && o.begin >= l.begin && o.end <= l.end && (o.begin !== l.begin || o.end !== l.end));
    // nesting depth: 1 for a loop in no other (clang's Depth when it says)
    l.depth = l.clangDepth ?? 1 + merged.filter((o) => o !== l && o.begin <= l.begin && o.end >= l.end && (o.begin !== l.begin || o.end !== l.end)).length;
    delete l.clangDepth;
    l.instructions = s.instrs.filter((x) => x.line >= l.begin && x.line <= l.end).length;
    // the function it is in: the last label before it that is not local
    let fname = null, at = -1;
    for (const [name, d] of s.labels) if (d.line <= l.begin && d.line > at && !name.startsWith('.L') && !/^\d+$/.test(name) && !name.startsWith('wuica')) { fname = name; at = d.line; }
    l.function = fname;
  }
  for (const l of merged) {
    // the vector instructions (vectorWidth) and the widest of their registers: the default's preference (defaultLoop)
    let width = 0, count = 0;
    for (const x of s.instrs) {
      if (x.line < l.begin || x.line > l.end) continue;
      const w = vectorWidth(x.mnemonic, x.operands);
      if (w) { count++; width = Math.max(width, w); }
    }
    l.vector = { width, count };
  }
  // the order of the list (the indices of -loop N, lp= in the page's links, the API's loop): the innermost and deepest
  // first, then in the order of the code. Which of them is analyzed by default is defaultLoop's choice, not the first.
  return merged.sort((a, b) => Number(b.inner) - Number(a.inner) || b.depth - a.depth || a.begin - b.begin || a.end - b.end);
}

// ---- the default loop ------------------------------------------------------------------------------------------------
//
// The loop analyzed by default ("auto") among the loops of a text (findLoops' order; after -func):
//   1. only the innermost loops at the greatest depth (clang's "Inner Loop Header: Depth=N" notes count) that are in
//      the function of the first of them (the first loop of the list; loops in no function are one group): a text
//      with several functions is analyzed in the function the first deepest loop is in, never at another's loop;
//   2. among those, the one whose vector instructions use the widest registers (zmm over ymm over xmm over none), then
//      the one with more vector instructions;
//   3. then the one with more instructions, then the first in the text.
// A compiler's vectorized loop comes with a scalar remainder, sometimes a peel loop before it or a narrower vector
// epilogue, often first in the text (clang): rule 2 picks the vector loop. A function without vector code gets its
// largest loop (rule 3), as one whose scalar floating-point code touches xmm registers does (vectorWidth).
//
// A vector instruction (vectorWidth): an SSE, AVX or AVX-512 instruction that works on several elements of a vector
// register. It names an xmm, ymm or zmm register and is none of these, which scalar code uses (gcc and clang compile
// scalar float and double code to them, so they do not make a loop a vector loop):
//   - scalar floating point: a mnemonic (without its v) that does not start with p and ends in ss, sd or sh (addss,
//     vmulsd, vfmadd231sd, movss, ucomisd, sqrtsd, cvtss2sd, vcvtsi2sd, cvtsi2sdq), and the conversions of one value to
//     an integer register (cvttsd2si, vcvtss2usi); not the broadcasts (vbroadcastss fills a whole register);
//   - one element moved between a general-purpose register or memory and a vector register: movd, movq, pinsr*,
//     pextr*, insertps, extractps, movlpd, movhpd (and their v forms, vmovw);
//   - zero idioms (xorps xmm0, xmm0; vpxor xmm1, xmm1, xmm1: the same register throughout): what compilers put before
//     a cvtsi2sd to break its dependency;
//   - copies from register to register (movaps xmm1, xmm0; vmovdqa64 zmm1, zmm2 without a mask): no work on elements;
//   - the floating-point logic of xmm registers (andps, andnps, orps, xorps and their pd forms): fabs, negation and
//     copysign of a scalar (andpd xmm0, [mask]). On ymm and zmm they count (no compiler uses those for scalars); a
//     128-bit vector loop always has other vector instructions (its loads, stores, arithmetic).
// MMX registers (mm0-mm7) and mask registers (k0-k7) do not make an instruction vector by themselves.

const VREG = /(?:^|[^\w])%?([xyz])mm([0-9]|[12][0-9]|3[01])(?![\w])/gi;
const WIDTH = { x: 128, y: 256, z: 512 };
const ELEMENT = /^(?:movd|movq|movw|pinsr[bwdq]|pextr[bwdq]|insertps|extractps|movlpd|movhpd)$/;
const ZERO = /^(?:xorp[sd]|pxor[dq]?|psub[bwdq]|pcmpgt[bwdq]|andnp[sd]|pandn[dq]?)$/;
const COPY = /^mov(?:ap[sd]|up[sd]|dq[au](?:8|16|32|64)?)$/;
const FP_LOGIC = /^(?:andn?p[sd]|orp[sd]|xorp[sd])$/;

// The width (128, 256 or 512) of the widest vector register of a vector instruction (see above), or 0 if it is not one.
export function vectorWidth(mnemonic, operands) {
  let width = 0;
  const regs = [];
  for (const m of String(operands ?? '').matchAll(VREG)) {
    width = Math.max(width, WIDTH[m[1].toLowerCase()]);
    regs.push(`${m[1]}mm${m[2]}`.toLowerCase());
  }
  if (!width) return 0;
  const mn = String(mnemonic).toLowerCase();
  const base = mn.startsWith('v') ? mn.slice(1) : mn;
  if (!base.startsWith('p') && !base.startsWith('broadcast') && /(?:ss|sd|sh)$/.test(base.replace(/^(cvtu?si2s[sdh])[lq]$/, '$1'))) return 0;
  if (/^cvtt?s[sdh]2u?si[lq]?$/.test(base)) return 0;
  if (ELEMENT.test(base)) return 0;
  const ops = String(operands ?? '').split(/,(?![^[(]*[\])])/).map((o) => o.trim()).filter(Boolean);
  const regOnly = ops.every((o) => /^%?[xyz]mm\d+$/i.test(o)); // (no memory operand, no immediate, no mask)
  if (ZERO.test(base) && regOnly && ops.length >= 2 && new Set(regs).size === 1) return 0;
  if (COPY.test(base) && regOnly && ops.length === 2) return 0;
  if (FP_LOGIC.test(base) && width === 128) return 0;
  return width;
}

// The index of the loop analyzed by default (see above) in a list of findLoops (or a part of it), or -1 for none.
export function defaultLoop(loops) {
  if (!loops.length) return -1;
  const top = loops[0];
  let best = -1;
  loops.forEach((l, k) => {
    if (l.inner !== top.inner || l.depth !== top.depth || (l.function ?? null) !== (top.function ?? null)) return;
    if (best < 0 || betterDefault(l, loops[best])) best = k;
  });
  return best;
}

// a before b as the default (rules 2 and 3 above)
function betterDefault(a, b) {
  const va = a.vector ?? { width: 0, count: 0 }, vb = b.vector ?? { width: 0, count: 0 };
  return (va.width - vb.width || va.count - vb.count || (a.instructions ?? 0) - (b.instructions ?? 0) || b.begin - a.begin) > 0;
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
  // trimmed: prologue and epilogue instructions besides the ret
  return { begin: ins[a].line, end: ins[b].line, trimmed: a + (last - b - 1) };
}

// What to analyze: see the top. text: the pasted assembly; loop: 'auto' (default), 'whole', or the index of a loop.
// Returns {text, objdump, loops: [{begin, end, label}], choice: index | 'body' | null, choosable (there is code around the
//   loop or the body: a choice matters), pick: {begin, end, lines: [the line of each instruction]} | null,
//   body: {begin, end} | null, alignment: number | null, address: number | null, stubs: [names], lines: [the line of each
//   instruction of the text],
//   notes: [{line, column, severity, message}], fallback: Map line -> text, error?}
/**
 * @param {string} text
 * @param {{loop?: string | number, func?: string | null}} [opts]
 * @returns {any}
 */
export function preparePaste(text, { loop = 'auto', func = null } = {}) {
  const pf = fromPerfAnnotate(normalizeText(text).replace(/^﻿/, ''));
  if (pf.stdio2) return { error: 'input: this is perf annotate --stdio2 output, which has no addresses: use perf annotate --stdio', loops: [] };
  let t = leadingSemicolons(pf.perf ? pf.text : normalizeText(text).replace(/^﻿/, ''));
  const od = fromObjdump(t);
  if (od.objdump) t = od.text;
  // code sections other than .text (gcc's main in .text.startup, -ffunction-sections): into .text, which the assembler
  // returns (the statement keeps its line; it is the same layout as one .text)
  t = t.replace(/^([ \t]*)\.(?:section|pushsection)[ \t]+"?\.text\.[^\n#;]*/gm, (m, ind) => (/^\s*\.push/.test(m) ? `${ind}.pushsection .text` : `${ind}.text`));
  const s = scan(t);
  const marked = MARKER.test(t) || IACA.test(t);
  const all = findLoops(s);
  let loops = marked ? [] : all;
  // -func: the loops of one function
  if (func !== null && func !== undefined && func !== '') {
    const fnames = new Set(all.map((l) => l.function).filter(Boolean));
    if (!s.labels.has(func)) return { error: `func: ${JSON.stringify(func)} is not a label of the text${fnames.size ? ` (functions with loops: ${[...fnames].join(', ')})` : ''}`, loops: [] };
    loops = loops.filter((l) => l.function === func);
  }
  const named = (l) => (l.label.startsWith('.Lwuica_a') ? `0x${l.label.slice(9)}` : l.label);
  // a loop by its label ("-loop .LBB0_12", "-loop 0x10"): as its index
  if (typeof loop === 'string' && loop !== 'auto' && loop !== 'whole' && loop !== LEGACY_AUTO) {
    const name = loop;
    const hits = loops.flatMap((l, i) => (named(l) === name || l.label === name || named(l) === `.${name}` || (/^0x/i.test(name) && named(l).toLowerCase() === name.toLowerCase()) ? [i] : []));
    const k = hits.length ? hits[0] : -1;
    // the same label in several functions (numeric labels: "1:" ... "jnz 1b"): not a guess
    if (hits.length > 1) return { error: `loop: ${JSON.stringify(loop)} names ${hits.length} loops (${hits.map((i) => `${i} in ${loops[i].function ?? 'no function'}`).join(', ')}): -func NAME or -loop N (0-based) picks one`, loops: [] };
    if (k < 0) return { error: `loop: ${JSON.stringify(loop)} is not the label of a loop${func ? ` in ${func}` : ''} (${loops.length ? `the loops: ${loops.map(named).join(', ')}` : 'the text has none'})`, loops: [] };
    loop = k;
  }
  // objdump lines with their bytes are assembled as those bytes (the exact encodings); their text is only read
  let asm = t;
  if (od.objdump && od.bytes.size) {
    const lines = t.split('\n');
    for (const [line, b] of od.bytes) lines[line - 1] = b;
    asm = lines.join('\n');
  }
  /** @type {any} */
  const out = { text: asm, objdump: od.objdump, loops: loops.map((l) => ({ begin: l.begin, end: l.end, label: named(l), function: l.function, instructions: l.instructions, depth: l.depth, inner: l.inner })),
    choice: null, auto: false, choosable: false, pick: null, body: null, alignment: null, address: null, stubs: [], notes: [], fallback: new Map() };
  if (loop !== 'auto' && loop !== 'whole' && loop !== LEGACY_AUTO && !(Number.isInteger(loop) && loop >= 0)) {
    out.error = `loop: ${JSON.stringify(loop)} is not "auto", "whole", the index of a loop (0-based) or its label`;
    return out;
  }
  const code = s.instrs;
  // .rept, .irp, .irpc, .macro and .if* make a line something else than one instruction (repeated, left out, a macro's
  // call): no source lines then, and no loop picked (it could not be isolated): the whole text, said in a note
  const structural = STRUCTURAL.exec(t);
  out.exactLines = !structural;
  if (structural && loop !== 'whole' && loops.length) {
    const at = t.slice(0, structural.index).split('\n').length;
    out.notes.push({ line: at, column: null, severity: 'note', message: `${structural[1]}: the text repeats or leaves out lines, so a loop cannot be isolated: the whole text is analyzed` });
    loop = 'whole';
  }
  out.lines = code.map((x) => x.line);
  // per instruction line: the interleaved source line (objdump -S, perf annotate) and the percent of samples (perf)
  out.lineInfo = new Map();
  for (const x of code) {
    const source = od.objdump ? od.sources?.get(x.line) : undefined, samples = pf.perf ? pf.samples.get(x.line) : undefined;
    if (source !== undefined || samples !== undefined) out.lineInfo.set(x.line, { ...(source !== undefined ? { source } : {}), ...(samples !== undefined ? { samples } : {}) });
  }
  out.profile = pf.perf ? 'perf' : null;
  if (pf.unweighted) out.notes.push({ line: null, column: null, severity: 'note', message: 'perf annotate: a symbol\'s header has no sample count, so the samples are each symbol\'s own percentages (not of all the samples)' });
  // perf annotate with several loops: "auto" picks the one whose own instructions (not those of a loop nested in it)
  // have the most samples, the first of equals
  // the pick is the default (out.auto: the page says so; not for LEGACY_AUTO, a link's own pick)
  const automatic = loop === 'auto';
  if (pf.perf && (loop === 'auto' || loop === LEGACY_AUTO) && loops.length > 1) {
    const inside = (a, b) => a !== b && a.begin >= b.begin && a.end <= b.end;
    const heat = loops.map((l) => code.filter((x) => x.line >= l.begin && x.line <= l.end && !loops.some((n) => inside(n, l) && x.line >= n.begin && x.line <= n.end))
      .reduce((n, x) => n + (pf.samples.get(x.line) ?? 0), 0));
    loop = heat.indexOf(Math.max(...heat));
  }
  if (Number.isInteger(loop) && Number(loop) >= loops.length) {
    out.error = `loop: ${loop} is not the index of a loop (0-based; the text has ${loops.length === 0 ? 'none' : `${loops.length}: 0 to ${loops.length - 1}`})`;
    return out;
  }
  if (!marked) {
    // choosable: there is code around the loop (or a prologue around the body), so the choice matters
    if (loops.length) out.choosable = !(loops.length === 1 && code.every((x) => x.line >= loops[0].begin && x.line <= loops[0].end));
    else {
      // a compiler's function (a function label, directives, objdump, or a prologue/epilogue): its body; a bare snippet
      // ("add rax, 1 / ret") is analyzed as typed
      const b = functionBody(s);
      const compiled = od.objdump || s.directives > 0 || [...s.labels.keys()].some((n) => !n.startsWith('.L') && !/^\d+$/.test(n)) || (b?.trimmed ?? 0) > 0;
      out.body = b && compiled ? { begin: b.begin, end: b.end } : null;
      out.choosable = !!out.body;
    }
    if (out.choosable && loop !== 'whole') {
      if (loops.length) {
        const k = Number.isInteger(loop) ? loop : loop === LEGACY_AUTO ? 0 : defaultLoop(loops);
        out.choice = k;
        out.pick = { begin: loops[k].begin, end: loops[k].end };
      } else {
        out.choice = 'body';
        out.pick = out.body;
      }
      // the source line of each instruction of the pick (caveats.js names lines with them)
      out.pick = { ...out.pick, lines: code.filter((x) => x.line >= out.pick.begin && x.line <= out.pick.end).map((x) => x.line) };
      out.auto = automatic;
    }
  }
  // data directives among the analyzed instructions (the pick's, or the whole text's): their bytes are instructions of
  // their own or parts of one, so the lines are not the instructions one to one: none
  if (s.data.some((l) => !out.pick || (l >= out.pick.begin && l <= out.pick.end))) out.exactLines = false;
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
    // a line the assembler rejects is left out only outside the analyzed code (padding around a loop); in it, an error
    if (out.pick) for (const line of od.addresses.keys()) if (!od.bytes.has(line) && (line < out.pick.begin || line > out.pick.end)) out.fallback.set(line, '');
    const first = code.find((x) => !out.pick || x.line >= out.pick.begin);
    const a = first ? od.addresses.get(first.line) : undefined;
    if (a !== undefined) { out.address = a; out.alignment = a % 64; }
  }
  return out;
}

// A text that replaces an editor's text (a paste over most of it, an example, an import) starts with the default loop again (the
// page's pick goes back to auto).
// Not an edit: what the old and the new text share at their start and end is less than half of the old one.
export function replacesText(before, after) {
  if (before === after) return false;
  let p = 0;
  const n = Math.min(before.length, after.length);
  while (p < n && before[p] === after[p]) p++;
  let s = 0;
  while (s < n - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return p + s < before.length / 2;
}

// The loops as the page's chip names them: "loop .L3", "loop 0x10", "body".
export function loopName(prep) {
  if (prep.choice === 'body') return 'body';
  if (prep.choice === null) return null;
  return `loop ${prep.loops[prep.choice].label}`;
}
