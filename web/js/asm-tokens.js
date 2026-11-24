// Assembly syntax highlighting, the DOM-free half: the tokens of a line of x86-64 assembly (Intel or AT&T syntax, gcc
// and clang output, objdump -d lines with or without the byte column). The page's editor overlay and any later consumer
// (the CLI, a report) colour them through the class names (className) so that they agree; the npm package ships a copy
// (packages/wuica/lib/web, web-modules.json). tests-js/web_asm_tokens.mjs tests it.
//
// tokenize(line, syntax, opts) -> [{start, end, kind}]: every character of the line in exactly one token, in order;
// never throws; linear in the length of the line. Kinds (a small set: the page is deliberately plain):
//   label      a label's definition ("loop:", ".LBB0_3:", "1:", objdump's "<f>:" header)
//   mnemonic   the instruction's mnemonic: the first word after the labels and prefixes (by position, not by a list;
//              AT&T's size suffix is part of it: addq)
//   prefix     lock, rep*, notrack, bnd, data16, segment prefixes before the mnemonic, {vex}, {evex}, ...
//   register   general-purpose (64/32/16/8-bit, ah/bh/ch/dh), rip/eip, xmm/ymm/zmm, k0-k7, segment, x87 st(i)/st, mm,
//              control and debug registers; the mask register in {k1}
//   number     immediates and displacements: 42, -8 (the sign is punct), 0x1f, 1fh, 0b101, $42 (AT&T, with its $)
//   size       dword ptr, ymmword ptr (one token), byte/word/... without ptr, offset, and the operand decorations
//              {z}, {1to8}, {sae}, {rn-sae} (their letters; the braces are punct)
//   symbol     a label's use: a branch target, a memory operand's symbol (.LCPI0_0, printf@PLT, 1b, 1f), $sym's sym,
//              objdump's <f+0x10> name
//   directive  .p2align, .globl, .section, ... (the operands are tokens of their own)
//   comment    # ..., // ..., /* ... */ (on the line; tokenizeText follows one over several lines), a ';' that starts
//              the line, and a ';' after a statement when the assembly diagnostics say the rest was taken as a comment
//              (asm-regions.js commentFixes: the assembler's rule; without diagnostics a ';' separates statements, as
//              LLVM and GNU as read it)
//   punct      , [ ] ( ) { } < > + - * : % $ = and a ';' that separates statements
//   address    objdump's address column ("  4005d0:", with its colon)
//   bytes      objdump's byte column ("48 83 c0 01")
//   space      white space
//   text       anything else: a quoted string, a stray character
//   error      only where the caller passes diagnostics with a column range (opts.diagnostics); never guessed
//
// tokenizeText(text, syntax, opts) -> one token list per line: the syntax detected once for the text ('auto':
// loop-find.js detectSyntax), objdump text recognised once (a line with objdump's indented address and tab, its byte
// column or its function header; then every address-prefixed line is read as objdump's), block comments followed across
// lines; opts.diagnostics [{line, column, endColumn?, severity}] of the whole text.
// className(kind) -> 'tok-' + kind; ansi(line, tokens) -> the line with ANSI colours (not used by the CLI yet).

import { detectSyntax } from './loop-find.js';
import { commentFixes } from './asm-regions.js';

export const KINDS = Object.freeze(['label', 'mnemonic', 'prefix', 'register', 'number', 'size', 'symbol', 'directive', 'comment',
  'punct', 'address', 'bytes', 'space', 'text', 'error']);

export const className = (kind) => `tok-${kind}`;
const ANSI = { label: 33, mnemonic: 1, prefix: 35, register: 36, number: 32, size: 35, symbol: 33, directive: 34, comment: 2, address: 2, bytes: 2, error: 31 };
export const ansi = (line, tokens) => tokens.map((t) => (ANSI[t.kind] ? `\x1b[${ANSI[t.kind]}m${line.slice(t.start, t.end)}\x1b[0m` : line.slice(t.start, t.end))).join('');

// ---- the words ------------------------------------------------------------------------------------------------------

// The registers, one table for both syntaxes (lower case; AT&T writes them with %, which is punct).
const REGISTERS = new Set([
  ...['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp',
    'ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'al', 'bl', 'cl', 'dl', 'sil', 'dil', 'bpl', 'spl', 'ah', 'bh', 'ch', 'dh',
    'rip', 'eip', 'ip', 'cs', 'ds', 'es', 'fs', 'gs', 'ss', 'st'],
  ...Array.from({ length: 8 }, (_, i) => [`r${i + 8}`, `r${i + 8}d`, `r${i + 8}w`, `r${i + 8}b`, `r${i + 8}l`, `k${i}`, `mm${i}`, `st${i}`, `cr${i}`, `dr${i}`]).flat(),
  ...Array.from({ length: 32 }, (_, i) => [`xmm${i}`, `ymm${i}`, `zmm${i}`]).flat(),
  'cr8', 'tmm0', 'tmm1', 'tmm2', 'tmm3', 'tmm4', 'tmm5', 'tmm6', 'tmm7',
]);
export const isRegister = (word) => REGISTERS.has(String(word).toLowerCase());

const SIZES = new Set(['byte', 'word', 'dword', 'qword', 'tbyte', 'tword', 'oword', 'fword', 'xword', 'mmword', 'xmmword', 'ymmword', 'zmmword', 'real4', 'real8', 'real10']);
const SIZE_WORDS = new Set(['ptr', 'offset', 'short', 'near', 'far']);
// prefixes before the mnemonic (as loop-find.js and ab-diff.js read them)
const PREFIXES = new Set(['lock', 'rep', 'repe', 'repz', 'repne', 'repnz', 'bnd', 'notrack', 'xacquire', 'xrelease', 'data16', 'data32',
  'addr32', 'addr16', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'rex', 'rex64']);

// ---- the scanner ----------------------------------------------------------------------------------------------------

const WS = /[ \t\f\v\r\n]+/y;
const IDENT = /[A-Za-z_.$@?][\w.$@?]*/y;
const NUM = /[0-9][\w]*/y;              // a number or a numeric label reference (1b, 1f), classified below
const LABEL = /(?:[A-Za-z_.$@?][\w.$@?]*|[0-9]+|"[^"\n]*")(?=[ \t]*:(?!:))/y;
const BRANCH = /^(?:j[a-z]{1,4}|call[lqw]?|loop[a-z]{0,2}|xbegin)$/i;
const STRING = /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?/y;
const OD_ADDR = /([ \t]*)([0-9a-fA-F]+:)(?=[ \t]|$)/y;
const OD_BYTES = /((?:[0-9a-fA-F]{2} )*[0-9a-fA-F]{2})(?= ?(?:\t|  |[ \t]*$))/y;
const OD_HEADER = /^([ \t]*)([0-9a-fA-F]+)([ \t]+)(<[^>]*>)([ \t]*:)([ \t]*)$/;
const SIZE_PTR = /([A-Za-z]+[0-9]*)([ \t]+)(ptr)\b/iy;

const match = (re, s, i) => { re.lastIndex = i; const m = re.exec(s); return m && m.index === i ? m : null; };
const isNumber = (w) => /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9][0-9a-fA-F]*[hH]|[0-9]+(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[0-9]+[oOqQ])$/.test(w);

// The comment and separator structure of a line: [{start, end, code: bool, sep: bool}] (code: a statement's text;
// sep: a ';' that separates statements; the rest comments). block: a block comment is open at the start of the line.
function segments(line, block, commentFrom) {
  const out = [];
  let i = 0, start = 0, q = false;
  const n = line.length;
  const push = (a, b, type) => { if (b > a) out.push({ start: a, end: b, type }); };
  if (block) {
    const e = line.indexOf('*/');
    if (e < 0) return { segs: [{ start: 0, end: n, type: 'comment' }], open: true };
    push(0, e + 2, 'comment');
    i = start = e + 2;
  }
  // a ';' that starts the line (after white space) is a comment (loop-find.js leadingSemicolons)
  const lead = /^[ \t]*;/.exec(line.slice(i, Math.min(n, i + 256)));
  if (lead && !block) { push(0, lead[0].length - 1, 'code'); push(lead[0].length - 1, n, 'comment'); return { segs: out, open: false }; }
  for (; i < n; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === '"') q = false; continue; }
    if (c === '"') { q = true; continue; }
    if (i === commentFrom) { push(start, i, 'code'); push(i, n, 'comment'); return { segs: out, open: false }; }
    if (c === '#' || (c === '/' && line[i + 1] === '/')) { push(start, i, 'code'); push(i, n, 'comment'); return { segs: out, open: false }; }
    if (c === '/' && line[i + 1] === '*') {
      push(start, i, 'code');
      const e = line.indexOf('*/', i + 2);
      if (e < 0) { push(i, n, 'comment'); return { segs: out, open: true }; }
      push(i, e + 2, 'comment');
      i = e + 1; start = e + 2;
      continue;
    }
    if (c === ';') { push(start, i, 'code'); push(i, i + 1, 'sep'); start = i + 1; }
  }
  push(start, n, 'code');
  return { segs: out, open: false };
}

// The tokens of one statement's text, line[a, b): labels, prefixes, mnemonic or directive, operands.
function statement(line, a, b, att, objdump, out) {
  const s = line.slice(0, b); // the regexes stop at b (a slice of the line up to it: linear overall)
  let i = a;
  const tok = (end, kind) => { if (end > i) { out.push({ start: i, end, kind }); i = end; } };
  const space = () => { const m = match(WS, s, i); if (m) tok(i + m[0].length, 'space'); };
  space();
  if (objdump && i < b) {
    // objdump: the address, the byte column, then the instruction
    const m = match(OD_ADDR, s, i);
    if (m) {
      tok(i + m[2].length, 'address');
      space();
      const by = match(OD_BYTES, s, i);
      if (by) { tok(i + by[1].length, 'bytes'); space(); }
    }
  }
  // labels
  for (;;) {
    const m = match(LABEL, s, i);
    if (!m) break;
    tok(i + m[0].length, 'label');
    space();
    tok(i + 1, 'punct'); // the ':'
    space();
  }
  if (i >= b) return;
  // prefixes, then the mnemonic or a directive
  let first = true, branch = false;
  for (;;) {
    if (s[i] === '{') { // a pseudo-prefix: {vex}, {evex}, {disp32}
      const e = s.indexOf('}', i);
      if (e < 0 || !/^\{[\w ]+\}$/.test(s.slice(i, e + 1))) break;
      tok(e + 1, 'prefix'); space();
      continue;
    }
    const m = match(IDENT, s, i);
    if (!m) break;
    const w = m[0], lw = w.toLowerCase();
    const after = s[i + w.length];
    if (first && w[0] === '.') { tok(i + w.length, 'directive'); space(); break; }
    if ((PREFIXES.has(lw) || /^rex\.\w+$/.test(lw)) && after !== ':' && after !== ',' && /\S/.test(s.slice(i + w.length, b))) { tok(i + w.length, 'prefix'); space(); first = false; continue; }
    if (after === ':' || after === '=') break; // not a mnemonic: an assignment or a segment
    tok(i + w.length, 'mnemonic'); space();
    branch = BRANCH.test(w);
    break;
  }
  operands(s, i, b, att, out, branch);
}

// The operands (and whatever else follows a mnemonic or directive), s[i, b). branch: a direct branch's mnemonic: a bare
// number as its first operand is its target (objdump: "jne 401126 <loop+0x6>"), a symbol.
function operands(s, i, b, att, out, branch = false) {
  const tok = (end, kind) => { if (end > i) { out.push({ start: i, end, kind }); i = end; } };
  let brace = false; // inside { } (a mask or decoration)
  let target = branch; // the next operand is a branch target
  while (i < b) {
    const c = s[i];
    let m;
    if ((m = match(WS, s, i))) { tok(i + m[0].length, 'space'); continue; }
    if (c === '%') {
      tok(i + 1, 'punct');
      continue;
    }
    if (c === '$' && /[0-9]/.test(s[i + 1] ?? '')) {
      m = match(NUM, s, i + 1);
      tok(i + 1 + m[0].length, isNumber(m[0]) ? 'number' : 'symbol');
      continue;
    }
    if (c === '"' || c === "'") { m = match(STRING, s, i); tok(i + m[0].length, 'text'); continue; }
    if ((m = match(NUM, s, i))) {
      const w = m[0];
      if (brace && /^1to\d+$/i.test(w)) tok(i + w.length, 'size');
      else if (target && /^(?:0[xX])?[0-9a-fA-F]+$/.test(w)) tok(i + w.length, 'symbol');
      else tok(i + w.length, isNumber(w) ? 'number' : /^[0-9]+[bf]$/i.test(w) ? 'symbol' : 'text');
      continue;
    }
    if ((m = match(IDENT, s, i))) {
      const w = m[0], lw = w.toLowerCase();
      if (c === '$') { tok(i + 1, 'punct'); continue; } // $sym: the $ alone, the symbol next
      if (REGISTERS.has(lw)) {
        // st(1): the register with its parentheses
        if (lw === 'st' && /^\(\d\)$/.test(s.slice(i + 2, i + 5)) && i + 5 <= b) { tok(i + 5, 'register'); continue; }
        tok(i + w.length, 'register');
        continue;
      }
      if (SIZES.has(lw)) {
        const p = match(SIZE_PTR, s, i);
        tok(p && p.index + p[0].length <= b && p[1].toLowerCase() === lw ? i + p[0].length : i + w.length, 'size');
        continue;
      }
      if (SIZE_WORDS.has(lw) || (brace && /^(?:z|sae|r[nduz]-sae)$/i.test(w))) { tok(i + w.length, 'size'); continue; }
      tok(i + w.length, 'symbol');
      continue;
    }
    target = false;
    if (c === '{') brace = true;
    else if (c === '}') brace = false;
    tok(i + 1, '[](){}<>,+-*:%$=!~&|^/'.includes(c) ? 'punct' : 'text');
  }
}

// After the tokens are made: the diagnostics' column ranges (1-based columns, end exclusive or the end of the token at
// the column) become 'error', splitting tokens where they begin and end.
function markErrors(tokens, ranges) {
  if (!ranges.length) return tokens;
  const out = [];
  for (const t of tokens) {
    let parts = [{ ...t }];
    for (const [a, b] of ranges) {
      if (b <= t.start || a >= t.end) continue;
      const next = [];
      for (const p of parts) {
        if (b <= p.start || a >= p.end || p.kind === 'error') { next.push(p); continue; }
        if (a > p.start) next.push({ start: p.start, end: a, kind: p.kind });
        next.push({ start: Math.max(a, p.start), end: Math.min(b, p.end), kind: 'error' });
        if (b < p.end) next.push({ start: b, end: p.end, kind: p.kind });
      }
      parts = next;
    }
    out.push(...parts);
  }
  return out;
}

// The column ranges [start, end) of a line's error diagnostics: from the column to endColumn, else to the end of the
// word at the column (to the end of the line for a column past the code).
function errorRanges(line, diags) {
  const out = [];
  for (const d of diags) {
    if (d.severity && d.severity !== 'error') continue;
    const col = Number(d.column);
    if (!(col >= 1)) continue;
    const a = Math.min(col - 1, line.length);
    let b = Number(d.endColumn) > col ? Number(d.endColumn) - 1 : -1;
    if (b < 0) { const m = /^\S*/.exec(line.slice(a, a + 256)); b = a + Math.max(1, m[0].length); }
    out.push([a, Math.min(b, Math.max(line.length, a + 1))]);
  }
  return out.filter(([a, b]) => b > a && a < line.length);
}

// The column (0-based) from which the line is a comment because of a ';' the assembler could not read as a separator
// (asm-regions.js commentFixes, given the line's diagnostics), or -1.
function semicolonComment(line, diags) {
  const errs = diags.filter((d) => d.severity === 'error' || /taken as a comment/.test(d.message ?? ''));
  if (!errs.length) return -1;
  const { fixes } = commentFixes(errs.map((d) => ({ ...d, line: 1, severity: 'error', column: d.message && /taken as a comment/.test(d.message) ? d.column + 1 : d.column })), line);
  const fixed = fixes.get(1);
  if (!fixed) return -1;
  for (let i = 0; i < line.length; i++) if (line[i] !== fixed[i]) return i;
  return -1;
}

function lineTokens(line, att, objdump, block, diags) {
  const n = line.length;
  if (!n) return { tokens: [], open: block };
  const out = [];
  const header = objdump && !block ? OD_HEADER.exec(line) : null;
  if (header) {
    let at = 0;
    for (const [k, kind] of [[1, 'space'], [2, 'address'], [3, 'space'], [4, 'label'], [5, 'punct'], [6, 'space']]) {
      if (header[k]) out.push({ start: at, end: at + header[k].length, kind });
      at += header[k].length;
    }
    return { tokens: out, open: false };
  }
  const commentFrom = diags.length ? semicolonComment(line, diags) : -1;
  const { segs, open } = segments(line, block, commentFrom);
  let firstCode = true;
  for (const g of segs) {
    if (g.type === 'comment') out.push({ start: g.start, end: g.end, kind: 'comment' });
    else if (g.type === 'sep') out.push({ start: g.start, end: g.end, kind: 'punct' });
    else { statement(line, g.start, g.end, att, objdump && firstCode, out); firstCode = false; }
  }
  const ranges = diags.length ? errorRanges(line, diags).filter(([a]) => commentFrom < 0 || a < commentFrom) : [];
  return { tokens: ranges.length ? markErrors(out, ranges) : out, open };
}

// A line whose tokens cannot be made (not expected): one text token.
const whole = (line) => (line.length ? [{ start: 0, end: line.length, kind: 'text' }] : []);

// The objdump form of one line on its own: an address column ended by a tab (as objdump writes it), a byte column, or
// the function header (objdump indents the address; a numeric label at the start of the line, "2:\tdecq %rcx", stays a
// label).
const looksObjdump = (line) => /^[ \t]+[0-9a-fA-F]+:\t/.test(line) || /^[ \t]*[0-9a-fA-F]+:[ \t]+(?:[0-9a-fA-F]{2} )*[0-9a-fA-F]{2}(?:\t|  )/.test(line) || OD_HEADER.test(line);

// The tokens of one line. syntax: 'intel', 'att' or 'auto' (detectSyntax of the line, else Intel). opts: {objdump
// (true/false; default: from the line), diagnostics: [{column, endColumn?, severity, message}] of this line, block
// (a block comment is open at its start)}.
export function tokenize(line, syntax = 'auto', opts = {}) {
  const s = typeof line === 'string' ? line : String(line ?? '');
  try {
    const att = syntax === 'att' || (syntax !== 'intel' && detectSyntax(s) === 'att');
    const od = typeof opts.objdump === 'boolean' ? opts.objdump : looksObjdump(s);
    return lineTokens(s, att, od, !!opts.block, Array.isArray(opts.diagnostics) ? opts.diagnostics : []).tokens;
  } catch {
    return whole(s);
  }
}

// The tokens of every line of a text (lines split at \n; a CR before it is white space). syntax 'auto': detected
// once for the text. opts: {diagnostics: [{line (1-based), column, endColumn?, severity, message}]}.
export function tokenizeText(text, syntax = 'auto', opts = {}) {
  const t = typeof text === 'string' ? text : String(text ?? '');
  const lines = t.split('\n');
  let att = syntax === 'att', od = false;
  try {
    if (syntax !== 'att' && syntax !== 'intel') att = detectSyntax(t) === 'att';
    od = lines.some(looksObjdump);
  } catch { /* plain */ }
  const byLine = new Map();
  for (const d of Array.isArray(opts.diagnostics) ? opts.diagnostics : []) if (d && d.line >= 1) (byLine.get(d.line) ?? byLine.set(d.line, []).get(d.line)).push(d);
  let block = false;
  return lines.map((l, k) => {
    try {
      const r = lineTokens(l, att, od && looksObjdumpLine(l), block, byLine.get(k + 1) ?? []);
      block = r.open;
      return r.tokens;
    } catch {
      block = false;
      return whole(l);
    }
  });
}
// in objdump text: a line with an address column or the header
const looksObjdumpLine = (l) => /^[ \t]*[0-9a-fA-F]+:/.test(l) || OD_HEADER.test(l);
