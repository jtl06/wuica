// Marked regions and .loc lines of pasted assembly. No DOM (tests-js/web_asm_regions.mjs runs it under Node).
//
// Region markers (the first marked region is analyzed; the text around it is still assembled, so labels, directives
// and a back-branch to a label outside the region keep their meaning and encodings):
//   # LLVM-MCA-BEGIN [name] ... # LLVM-MCA-END [name]     (llvm-mca; also with // or ; as the comment)
//   # wuica-begin [name]    ... # wuica-end                (the same, wuica's own name)
//   IACA / OSACA byte markers: mov ebx, 111 + .byte 0x64, 0x67, 0x90 ... mov ebx, 222 + .byte 0x64, 0x67, 0x90
//   (AT&T: movl $111, %ebx); the markers themselves are not part of the region.
// .loc / .file (gcc -g -S, clang -g -S): each instruction gets the line of the .loc before it (main file only: the
// file with the most .loc lines in the analyzed code); srcmap.js shows the cost per line.
//
// How: the assembler (assembler.js) returns the .text bytes only, without offsets. The text is assembled with local
// labels at the region's ends and at each .loc (labels have no size: the layout is the same), and a trailer appended
// at the end of .text that holds a magic word and the distance of each label to the trailer:
//   .text / .Lwuica_z: / .long MAGIC, .Lwuica_z-.Lwuica_0, ...
// The trailer is cut off again; the distances give the offsets. gcc's ".loc ... view N" (which LLVM rejects) loses
// its view operand (its symbol is set to 0). No line is added or removed (diagnostics keep their
// line numbers; columns are corrected where a label was put in front of a statement). If that text does not assemble
// for a reason of its own (a region or a .loc in another section), the plain text is assembled instead.

import { stripHints } from './assembler.js';

const MAGIC = 0x77756963; // 'ciuw'
// a cheap test first: without any of these the text is assembled as it is (no other work)
const QUICK = /LLVM-MCA-|wuica-|\.loc\s|\b111\b/i;
const MARKER = /^\s*(?:#|\/\/|;)\s*(LLVM-MCA-BEGIN|LLVM-MCA-END|wuica-begin|wuica-end)(?![\w-])[ \t]*([^\s#;]*)/i;
const IACA_MOV = /^mov[l]?\s+(?:ebx\s*,\s*(111|222)|\$(111|222)\s*,\s*%ebx)$/i;
const IACA_BYTES = /^\.byte\s+(?:0x64|100)\s*,\s*(?:0x67|103)\s*,\s*(?:0x90|144)$/i;
const LABELS = /^(?:\s*(?:[\w.$@]+|"[^"]*")\s*:)*\s*/;

export const MARKERS_TITLE = 'region markers: # LLVM-MCA-BEGIN [name] … # LLVM-MCA-END, # wuica-begin … # wuica-end (also // or ;), '
  + "IACA's mov ebx, 111 / 222 + .byte 0x64,0x67,0x90; only the first region is analyzed";

// Splits a line (block comments already removed) into its statements outside comments: [{at, text}] (at: the column
// of the statement's first character, 0-based). '#' and '//' start a comment, ';' separates statements; quotes kept.
function statements(line) {
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

const quoted = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
const sectionName = (args) => (/^\s*("?)([^",\s]+)\1/.exec(args)?.[2] ?? '');

// text: the pasted assembly. Returns null (nothing marked: assemble the text as it is) or
//   { text: the text to assemble, labels: [name], regions: [{name, line}], region: {name, line, begin, end} | null
//     (begin/end: indexes into labels; end null: to the end of the code), locs: [{label, file, line}],
//     files: Map(number -> name), shifts: Map(line -> [{col, len}]), lineCount, error: {line, message} | null }
export function planMarked(text) {
  text = String(text ?? '');
  if (!QUICK.test(text)) return null;
  const lines = stripHints(text.replace(/^\uFEFF/, '')).split('\n');
  const labels = [];
  const inserts = []; // {line, col, label}
  const regions = [];
  let region = null, pendingBegin = false, error = null;
  const locs = [], files = new Map(), views = new Set();
  let inText = true, prev = false;
  const stack = [];
  let iaca = null; // {kind: '111' | '222', line, col} of a mov that can be an IACA marker
  let block = false;
  const label = (line, col) => { const name = `.Lwuica_${labels.length}`; labels.push(name); inserts.push({ line, col, label: name }); return labels.length - 1; };
  const replaced = new Map(); // line -> new text (marker comments)

  const begin = (name, line) => {
    regions.push({ name, line });
    if (regions.length === 1) { region = { name, line, begin: null, end: null }; pendingBegin = true; }
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const mk = !block && MARKER.exec(line);
    if (mk) {
      const kind = mk[1].toLowerCase();
      const name = mk[2] ?? '';
      if (kind.endsWith('begin')) {
        begin(name, i + 1);
        replaced.set(i, '');
      } else if (region && region.end === null && !region.closed && (!name || !region.name || name === region.name)) {
        if (pendingBegin) { error ??= { line: region.line, message: 'the marked region has no instructions' }; pendingBegin = false; }
        region.closed = true;
        region.end = labels.length;
        labels.push('.Lwuica_' + labels.length);
        replaced.set(i, labels[region.end] + ':');
      } else {
        replaced.set(i, '');
      }
      continue;
    }
    // block comments (the columns stay)
    if (block || line.includes('/*')) {
      let out = '', k = 0;
      while (k < line.length) {
        if (block) { const e = line.indexOf('*/', k); if (e < 0) { out += ' '.repeat(line.length - k); k = line.length; } else { out += ' '.repeat(e + 2 - k); k = e + 2; block = false; } } else { const s = line.indexOf('/*', k); if (s < 0) { out += line.slice(k); k = line.length; } else { out += line.slice(k, s); k = s; block = true; } }
      }
      line = out;
    }
    for (const st of statements(line)) {
      const lead = LABELS.exec(st.text)[0].length;
      const body = st.text.slice(lead);
      if (!body) continue;
      const col = st.at + lead;
      if (iaca) {
        const m = iaca;
        iaca = null;
        if (IACA_BYTES.test(body)) {
          if (m.kind === '111') begin('', m.line + 1);
          else if (region && !region.closed) {
            if (pendingBegin) { error ??= { line: region.line, message: 'the marked region has no instructions' }; pendingBegin = false; }
            region.closed = true;
            region.end = label(m.line, m.col);
          }
          continue;
        }
        // a plain mov after all: the region's first instruction, if one is wanted
        if (pendingBegin && m.inText) { region.begin = label(m.line, m.col); pendingBegin = false; }
      }
      if (body[0] === '.') {
        const d = /^\.([\w.]+)\s*(.*)$/.exec(body);
        const name = d?.[1].toLowerCase() ?? '';
        const args = d?.[2] ?? '';
        if (name === 'loc') {
          const m = /^(\d+)\s+(\d+)/.exec(args);
          if (m && inText) locs.push({ label: label(i, col), file: Number(m[1]), line: Number(m[2]) });
          // gcc's "view N" operand, which LLVM rejects ("unknown sub-directive"): blanked (the columns stay)
          // (a symbol of it, which the debug sections can use, is defined as 0 in the trailer)
          const v = /\bview\s+(\S+)/.exec(body);
          if (v) {
            const at = col + v.index;
            lines[i] = lines[i].slice(0, at) + ' '.repeat(v[0].length) + lines[i].slice(at + v[0].length);
            if (/^[A-Za-z_.$][\w.$]*$/.test(v[1])) views.add(v[1]);
          }
        } else if (name === 'file') {
          const m = /^(\d+)\s/.exec(args);
          const q = quoted(args);
          if (m && q.length) files.set(Number(m[1]), q.length > 1 ? q[1] : q[0]);
        } else if (name === 'text') { prev = inText; inText = true; }
        else if (name === 'data' || name === 'bss') { prev = inText; inText = false; }
        else if (name === 'section') { prev = inText; inText = sectionName(args) === '.text'; }
        else if (name === 'pushsection') { stack.push(inText); prev = inText; inText = sectionName(args) === '.text'; }
        else if (name === 'popsection') { prev = inText; inText = stack.pop() ?? true; }
        else if (name === 'previous') { [inText, prev] = [prev, inText]; }
        continue;
      }
      if (/^[\w.$@]+\s*=/.test(body)) continue; // a symbol assignment
      // an instruction
      // (a mov that can be an IACA marker is decided by the next statement)
      const im = IACA_MOV.exec(body);
      if (im) iaca = { kind: im[1] ?? im[2], line: i, col, inText };
      else if (pendingBegin && inText) { region.begin = label(i, col); pendingBegin = false; }
    }
  }
  if (pendingBegin) error ??= { line: region.line, message: 'the marked region has no instructions' };
  if (!regions.length && !locs.length) return null;
  // the new text: marker lines replaced, labels put in front of statements (right to left within a line)
  const shifts = new Map();
  const byLine = new Map();
  for (const x of inserts) (byLine.get(x.line) ?? byLine.set(x.line, []).get(x.line)).push(x);
  for (const [i, xs] of byLine) {
    xs.sort((a, b) => b.col - a.col);
    let l = lines[i];
    const sh = [];
    for (const x of xs) { const ins = `${x.label}: `; l = l.slice(0, x.col) + ins + l.slice(x.col); sh.push({ col: x.col, len: ins.length }); }
    lines[i] = l;
    shifts.set(i + 1, sh);
  }
  for (const [i, t] of replaced) lines[i] = t;
  const lineCount = lines.length;
  const parts = [];
  for (let k = 0; k < labels.length; k += 32) parts.push(`.long ${labels.slice(k, k + 32).map((n) => `.Lwuica_z-${n}`).join(', ')}`);
  const sets = [...views].map((n) => `.set ${n}, 0\n`).join('');
  const out = `${lines.join('\n')}\n${sets}.text\n.Lwuica_z:\n.long ${MAGIC}\n${parts.join('\n')}\n`;
  if (region) delete region.closed;
  return { text: out, labels, regions, region, locs, files, shifts, lineCount, error };
}

// The diagnostics of the rewritten text in the user's columns; those of the trailer dropped.
function mapDiagnostics(plan, diagnostics) {
  const out = [];
  for (const d of diagnostics) {
    if (d.line && d.line > plan.lineCount) continue;
    let column = d.column;
    if (d.line && column) {
      // the inserts in the new text's columns (left to right), each moves what follows it
      let acc = 0, minus = 0;
      for (const s of [...(plan.shifts.get(d.line) ?? [])].sort((a, b) => a.col - b.col)) {
        const at = s.col + acc;
        if (column - 1 >= at + s.len) minus += s.len; else if (column - 1 >= at) { minus = column - 1 - s.col; break; }
        acc += s.len;
      }
      column -= minus;
    }
    out.push({ ...d, column });
  }
  return out;
}

// After a successful assembly of plan.text: {code, offsets} (code: the bytes without the trailer; offsets: one per
// label), or null (no trailer: not the real assembler).
export function readTrailer(plan, bytes) {
  const n = plan.labels.length;
  const z = bytes.length - 4 - 4 * n;
  if (z < 0) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(z, true) !== MAGIC) return null;
  const offsets = [];
  for (let k = 0; k < n; k++) {
    const o = z - dv.getUint32(z + 4 + 4 * k, true);
    if (o < 0 || o > z) return null;
    offsets.push(o);
  }
  return { code: bytes.subarray(0, z), offsets };
}

const base = (p) => String(p).split(/[\\/]/).pop();

// The analyzed bytes and the source lines of a plan: {bytes, region, source} or {error}.
export function cutPlan(plan, code, offsets) {
  let start = 0, end = code.length, region = null;
  if (plan.region) {
    const r = plan.region;
    if (plan.error) return { error: plan.error };
    start = offsets[r.begin];
    end = r.end === null ? code.length : offsets[r.end];
    if (!(end > start)) return { error: { line: r.line, message: 'the marked region has no machine code in .text' } };
    region = { name: r.name, line: r.line, index: 0, count: plan.regions.length };
  }
  let source = null;
  if (plan.locs.length) {
    const at = plan.locs.map((l) => ({ off: offsets[l.label], file: l.file, line: l.line }))
      .filter((x) => x.off >= start && x.off < end);
    // the .loc in force at the region's start (the last one before it) counts too
    const before = plan.locs.map((l) => ({ off: offsets[l.label], file: l.file, line: l.line })).filter((x) => x.off < start).pop();
    if (before) at.unshift({ ...before, off: start });
    const count = new Map();
    for (const x of at) if (x.line > 0) count.set(x.file, (count.get(x.file) ?? 0) + 1);
    let main = null, best = 0;
    for (const [f, c] of count) if (c > best) { best = c; main = f; }
    if (main !== null) {
      const spans = at.map((x) => ({ off: x.off - start, line: x.file === main && x.line > 0 ? x.line : null }))
        .sort((a, b) => a.off - b.off)
        .filter((x, k, all) => k + 1 === all.length || all[k + 1].off !== x.off); // of several at one offset the last
      const name = plan.files.get(main);
      source = { text: null, file: name ? base(name) : null, spans };
    }
  }
  return { bytes: code.slice(start, end), region, source };
}

// Assembles text with its marked region and .loc lines: assembler.assemble's result plus region ({name, line, index,
// count} | null) and source ({text: null, file, spans: [{off, line}]} | null). assemble(text) -> promise of that result.
export async function assembleMarked(assemble, text) {
  const plan = planMarked(text);
  if (!plan) return assemble(text);
  const r = await assemble(plan.text);
  if (r.ok) {
    const t = readTrailer(plan, r.bytes);
    if (!t) return assemble(text); // not the real assembler (the mock): the plain text
    const c = cutPlan(plan, t.code, t.offsets);
    const diagnostics = mapDiagnostics(plan, r.diagnostics);
    if (c.error) return { ok: false, diagnostics: [{ line: c.error.line, column: null, severity: 'error', message: c.error.message }] };
    return { ok: true, bytes: c.bytes, diagnostics, region: c.region, source: c.source };
  }
  const own = r.diagnostics.some((d) => d.severity === 'error' && (!d.line || d.line > plan.lineCount));
  if (!own) return { ...r, diagnostics: mapDiagnostics(plan, r.diagnostics) };
  // the labels or the trailer failed (a region or a .loc outside .text): the plain text
  const p = await assemble(text);
  if (!p.ok || !plan.region) return p;
  return { ok: false, diagnostics: [{ line: plan.region.line, column: null, severity: 'error', message: 'the marked region is not in .text' }] };
}

// The assembler with marked regions (assemble() as assembleMarked; everything else as the assembler's own).
export function withRegions(assembler) {
  if (!assembler) return assembler;
  const assemble = (text, syntax, opts) => assembleMarked((t) => assembler.assemble(t, syntax, opts), text);
  return new Proxy(assembler, {
    get(target, prop) {
      if (prop === 'assemble') return assemble;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// The source line of each instruction row of a response (srcmap.js): spans [{off, line}] sorted by offset; the rows'
// opcodes give the offsets (as listing.js). [line | null per instruction row].
export function spanLines(rows, spans) {
  const out = [];
  let off = 0, k = -1;
  for (const r of rows ?? []) {
    if (r?.kind !== 'instr') continue;
    while (k + 1 < spans.length && spans[k + 1].off <= off) k++;
    out.push(k >= 0 ? spans[k].line : null);
    off += (String(r.opcode ?? '').match(/[0-9a-f]{2}/gi) ?? []).length;
  }
  return out;
}
