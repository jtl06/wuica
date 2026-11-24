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
import { statements, preparePaste, loopName, normalizeText, isText } from './loop-find.js';

const MAGIC = 0x77756963; // 'ciuw'
// a cheap test first: without any of these the text is assembled as it is (no other work)
const QUICK = /LLVM-MCA-|wuica-|\.loc\s|\b111\b/i;
const MARKER = /^\s*(?:#|\/\/|;)\s*(LLVM-MCA-BEGIN|LLVM-MCA-END|wuica-begin|wuica-end)(?![\w-])[ \t]*([^\s#;]*)/i;
const IACA_MOV = /^mov[l]?\s+(?:ebx\s*,\s*(111|222)|\$(111|222)\s*,\s*%ebx)$/i;
const IACA_BYTES = /^\.byte\s+(?:0x64|100)\s*,\s*(?:0x67|103)\s*,\s*(?:0x90|144)$/i;
const LABELS = /^(?:\s*(?:[\w.$@]+|"[^"]*")\s*:)*\s*/;

export const MARKERS_TITLE = 'region markers: # LLVM-MCA-BEGIN [name] … # LLVM-MCA-END, # wuica-begin … # wuica-end (also // or ;), '
  + "IACA's mov ebx, 111 / 222 + .byte 0x64,0x67,0x90; only the first region is analyzed";

const quoted = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
const sectionName = (args) => (/^\s*("?)([^",\s]+)\1/.exec(args)?.[2] ?? '');

// text: the pasted assembly. Returns null (nothing marked: assemble the text as it is) or
//   { text: the text to assemble, labels: [name], regions: [{name, line}], region: {name, line, begin, end} | null
//     (begin/end: indexes into labels; end null: to the end of the code), locs: [{label, file, line}],
//     files: Map(number -> name), shifts: Map(line -> [{col, len}]), lineCount, error: {line, message} | null }
// opts (loop-find.js, preparePaste): pick {begin, end}: lines (1-based) of the code to analyze when nothing is marked (the
// loop: its first instruction at or after `begin` to the end of line `end`); stubs: symbols to define right after the
// analyzed code (the loop's exits: its conditional branches out of it are then short and not taken).
/**
 * @param {string} text
 * @param {{pick?: {begin: number, end: number} | null, stubs?: string[]}} [opts]
 * @returns {any}
 */
export function planMarked(text, { pick = null, stubs = [] } = {}) {
  text = String(text ?? '');
  if (!QUICK.test(text) && !pick && !stubs.length) return null;
  const lines = stripHints(text.replace(/^\uFEFF/, '')).split('\n');
  const labels = [];
  const inserts = []; // {line, col, label}
  const regions = [];
  /** @type {any} */
  let region = null;
  let pendingBegin = false;
  /** @type {{line: number, message: string} | null} */
  let error = null;
  const locs = [], files = new Map(), views = new Set();
  let inText = true, prev = false;
  const stack = [];
  /** @type {any} */
  let iaca = null; // {kind: '111' | '222', line, col} of a mov that can be an IACA marker
  let block = false;
  const label = (line, col) => { const name = `.Lwuica_${labels.length}`; labels.push(name); inserts.push({ line, col, label: name }); return labels.length - 1; };
  const replaced = new Map(); // line -> new text (marker comments)
  const stubText = stubs.map((n) => ` ${n}:`).join('');
  let stubsPlaced = !stubs.length;
  let pickPending = false;
  if (pick) { region = { name: 'loop', line: pick.begin, begin: null, end: null, auto: true }; pickPending = true; }

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
        replaced.set(i, labels[region.end] + ':' + stubText);
        stubsPlaced = true;
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
    const sts = statements(line);
    for (const st of sts) {
      const lead = /** @type {RegExpExecArray} */ (LABELS.exec(st.text))[0].length;
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
        // an objdump line with its bytes (loop-find.js) starts the picked code like an instruction
        if (name === 'byte' && pickPending && inText && i + 1 >= Number(pick?.begin)) { region.begin = label(i, col); pickPending = false; }
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
        else if (name === 'section') { prev = inText; inText = isText(args); }
        else if (name === 'pushsection') { stack.push(inText); prev = inText; inText = isText(args); }
        else if (name === 'popsection') { prev = inText; inText = stack.pop() ?? true; }
        else if (name === 'previous') { [inText, prev] = [prev, inText]; }
        continue;
      }
      if (/^[\w.$@]+\s*=/.test(body)) continue; // a symbol assignment
      // an instruction
      if (pickPending && inText && i + 1 >= Number(pick?.begin)) { region.begin = label(i, col); pickPending = false; }
      // (a mov that can be an IACA marker is decided by the next statement)
      const im = IACA_MOV.exec(body);
      if (im) iaca = { kind: im[1] ?? im[2], line: i, col, inText };
      else if (pendingBegin && inText) { region.begin = label(i, col); pendingBegin = false; }
    }
    // the end of the picked code: a label after the last statement of its last line (and the exits)
    if (pick && i + 1 === pick.end && region.begin !== null && region.end === null && sts.length) {
      const st = sts[sts.length - 1];
      region.end = labels.length;
      const name = `.Lwuica_${labels.length}`;
      labels.push(name);
      inserts.push({ line: i, col: st.at + st.text.length, text: `; ${name}:${stubText}` });
      stubsPlaced = true;
    }
  }
  if (pick && region.begin === null) error ??= { line: pick.begin, message: 'the loop has no instructions' };
  if (pendingBegin) error ??= { line: region.line, message: 'the marked region has no instructions' };
  if (!regions.length && !locs.length && !pick && !stubs.length) return null;
  // the new text: marker lines replaced, labels put in front of statements (right to left within a line)
  const shifts = new Map();
  const byLine = new Map();
  for (const x of inserts) (byLine.get(x.line) ?? byLine.set(x.line, []).get(x.line)).push(x);
  for (const [i, xs] of byLine) {
    xs.sort((a, b) => b.col - a.col);
    let l = lines[i];
    const sh = [];
    for (const x of xs) { const ins = x.text ?? `${x.label}: `; l = l.slice(0, x.col) + ins + l.slice(x.col); sh.push({ col: x.col, len: ins.length }); }
    lines[i] = l;
    shifts.set(i + 1, sh);
  }
  for (const [i, t] of replaced) lines[i] = t;
  const lineCount = lines.length;
  const parts = [];
  for (let k = 0; k < labels.length; k += 32) parts.push(`.long ${labels.slice(k, k + 32).map((n) => `.Lwuica_z-${n}`).join(', ')}`);
  const sets = [...views].map((n) => `.set ${n}, 0\n`).join('');
  const tail = stubsPlaced ? '' : `${stubs.map((n) => `${n}:`).join('\n')}\n`; // the exits at the end of the code
  const out = `${lines.join('\n')}\n${sets}.text\n${tail}.Lwuica_z:\n.long ${MAGIC}\n${parts.join('\n')}\n`;
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
  let start = 0, end = code.length;
  /** @type {any} */
  let region = null;
  if (plan.region) {
    const r = plan.region;
    if (plan.error) return { error: plan.error };
    start = offsets[r.begin];
    end = r.end === null ? code.length : offsets[r.end];
    if (!(end > start)) return { error: { line: r.line, message: 'the marked region has no machine code in .text' } };
    region = r.auto ? { auto: true } : { name: r.name, line: r.line, index: 0, count: plan.regions.length };
  }
  /** @type {any} */
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

// One assembly of a text with its marked region (or picked loop) and .loc lines.
async function assembleOnce(assemble, text, prep) {
  const plan = planMarked(text, prep ? { pick: prep.pick, stubs: prep.stubs } : {});
  if (!plan) return assemble(text);
  const r = await assemble(plan.text);
  if (r.ok) {
    const t = readTrailer(plan, r.bytes);
    if (!t) return assemble(text); // not the real assembler (the mock): the plain text
    const c = cutPlan(plan, t.code, t.offsets);
    const diagnostics = mapDiagnostics(plan, r.diagnostics);
    if (c.error) return { ok: false, diagnostics: [{ line: c.error.line, column: null, severity: 'error', message: c.error.message }] };
    return { ok: true, bytes: c.bytes, diagnostics, region: c.region?.auto ? null : c.region, source: c.source };
  }
  const own = r.diagnostics.some((d) => d.severity === 'error' && (!d.line || d.line > plan.lineCount));
  if (!own) return { ...r, diagnostics: mapDiagnostics(plan, r.diagnostics) };
  // the labels or the trailer failed (a region or a .loc outside .text): the plain text
  const p = await assemble(text);
  if (!p.ok || !plan.region || plan.region.auto) return p;
  return { ok: false, diagnostics: [{ line: plan.region.line, column: null, severity: 'error', message: 'the marked region is not in .text' }] };
}

// ';' after a statement. LLVM (like GNU as) reads it as a separator: what follows is assembled as a statement if it can
// be. Pasted listings use it for comments (MASM, NASM, Compiler Explorer). The rule:
//   - what follows assembles: it is assembled (a separator), with a note that names it, unless the ';' chains
//     statements as GNU as code writes it (no space before the ';': "dec rcx; jnz 1b")
//   - it does not assemble, for any reason: it is a comment (nothing after a ';' turns a valid line into an error),
//     with a note if it starts with a mnemonic ("add the next element"); silently if it does not ("sum += a[i]")
// A ';' at the start of a line is always a comment (loop-find.js, leadingSemicolons).

// The columns (0-based) of the ';' separators of a line, outside quotes and before a comment.
function separators(line) {
  const out = [];
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === '"') q = false; continue; }
    if (c === '"') q = true;
    else if (c === '#' || (c === '/' && line[i + 1] === '/')) break;
    else if (c === ';') out.push(i);
  }
  return out;
}

// After a failed assembly: the lines whose error lies after a ';' get that ';' as '#'. {fixes: Map line -> new text,
// notes: [{line, column, severity: 'note', message}]}.
export function commentFixes(diagnostics, text) {
  const lines = String(text).split('\n');
  const fixes = new Map(), notes = [];
  for (const d of diagnostics ?? []) {
    if (d.severity !== 'error' || !d.line || !d.column) continue;
    const l = fixes.get(d.line) ?? lines[d.line - 1] ?? '';
    const at = separators(l).filter((p) => p < d.column - 1).pop();
    if (at === undefined || !l.slice(0, at).trim()) continue;
    fixes.set(d.line, l.slice(0, at) + '#' + l.slice(at + 1));
    if (!/^(?:invalid instruction mnemonic|unexpected token at start of statement)/.test(d.message)) {
      notes.push({ line: d.line, column: at + 1, severity: 'note', message: "text after ';' taken as a comment" });
    }
  }
  return { fixes, notes };
}

// After a successful assembly: a note for each ';' whose rest was assembled as a statement (see above), unless the ';'
// is written as GNU as chains statements, right after the statement ("dec rcx; jnz 1b").
export function separatorNotes(text) {
  const notes = [];
  String(text).split('\n').forEach((l, i) => {
    const seps = separators(l);
    seps.forEach((at, k) => {
      const before = l.slice(0, at), seg = l.slice(at + 1, seps[k + 1] ?? l.length).replace(/(#|\/\/).*$/, '').trim();
      if (!before.trim() || !seg || !/\s$/.test(before)) return;
      notes.push({ line: i + 1, column: at + 1, severity: 'note', message: `';' separates statements: '${seg}' was assembled (use # for a comment)` });
    });
  });
  return notes;
}

// Assembles text with its marked region and .loc lines: assembler.assemble's result plus region ({name, line, index,
// count} | null) and source ({text: null, file, spans: [{off, line}]} | null). assemble(text) -> promise of that result.
// A ';' comment after a statement is retried as '#' (above).
// opts.loop ('auto', 'whole' or a loop's index): the text is assembled for an analysis (loop-find.js): objdump lines,
// the loop or the body of a function, the exits as not taken. The result then also has loop ({index, count, name, line,
// endLine, address, alignment} | null: what was picked), loops ([{begin, end, label}]: the choices), body ({begin, end}
// | null), choosable (a choice matters: code around the loop or the body) and alignment (from
// the text's addresses, or null), and the notes (exits, undefined jump targets) among its diagnostics.
export async function assembleMarked(assemble, text, opts = {}) {
  const analysis = opts.loop !== undefined && opts.loop !== null;
  const prep = analysis ? preparePaste(text, { loop: opts.loop, func: opts.func }) : null;
  if (prep?.error) return { ok: false, diagnostics: [{ line: null, column: null, severity: 'error', message: prep.error }] };
  let work = prep ? prep.text : normalizeText(text);
  const fallback = new Map(prep?.fallback ?? []);
  const commentNotes = [];
  let r;
  for (let round = 0; ; round++) {
    r = await assembleOnce(assemble, work, prep);
    if (r.ok || round >= 8) break;
    // retry: ';' comments; objdump lines the assembler rejects, as their bytes
    const { fixes, notes } = commentFixes(r.diagnostics, work);
    commentNotes.push(...notes);
    for (const d of r.diagnostics) {
      if (d.severity === 'error' && d.line && !fixes.has(d.line) && fallback.has(d.line)) { fixes.set(d.line, fallback.get(d.line)); fallback.delete(d.line); }
    }
    if (!fixes.size) break;
    const lines = work.split('\n');
    for (const [l, t] of fixes) lines[l - 1] = t;
    work = lines.join('\n');
  }
  if (r.ok) {
    const notes = [...commentNotes, ...separatorNotes(work)];
    if (notes.length) r = { ...r, diagnostics: [...r.diagnostics, ...notes] };
  }
  if (!prep) return r;
  const loop = prep.choice === null ? null : {
    index: prep.choice === 'body' ? null : prep.choice, count: prep.loops.length, name: loopName(prep),
    line: prep.pick.begin, endLine: prep.pick.end, lines: prep.pick.lines, address: prep.address, alignment: prep.alignment,
  };
  // the source line of each analyzed instruction: of the pick, or of the whole text (not with a marked region)
  const lines = prep.pick ? prep.pick.lines : r.region ? null : prep.lines ?? null;
  const out = { ...r, loop, loops: prep.loops, body: prep.body, choosable: prep.choosable, alignment: prep.alignment, lines };
  if (r.ok && prep.notes.length) out.diagnostics = [...r.diagnostics, ...prep.notes];
  return out;
}

// The assembler with marked regions (assemble() as assembleMarked; everything else as the assembler's own).
// assemble(text, syntax, {loop, ...}): loop as assembleMarked's; the other options go to the assembler.
export function withRegions(assembler) {
  if (!assembler) return assembler;
  const assemble = (text, syntax, opts) => {
    const { loop, ...rest } = opts ?? {};
    return assembleMarked((t) => assembler.assemble(t, syntax, opts ? rest : opts), text, { loop });
  };
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
