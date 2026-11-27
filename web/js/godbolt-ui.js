// Compiler Explorer links in a code box: when a box holds nothing but a godbolt.org link (pasted, dropped or
// typed), its code is imported at once: link -> compiler pane -> compiled output -> a function and a range of it
// (the innermost loop) -> the box. With one pane and an obvious choice it imports without asking; otherwise a
// small picker opens under the box. One status line under the box says what happened and offers "undo" (the
// link again). The format and the API are in godbolt.js. This is the only part of the page that talks to a third
// party (godbolt.org), and only after the user put a link into a box.

import { h } from './render.js';
import {
  parseCeLink, isCeLink, resolveShortLink, compilersOf, compilePane, parseListing, findLoops, defaultSelection, defaultLoopOf,
  extractRange, sourceAsAssembly, compilerMessages, targetProblem, is32bit, rangeLines,
} from './godbolt.js';

const hex2 = (b) => (b < 16 ? '0' : '') + b.toString(16);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const TYPING_DELAY = 1000; // a typed link is imported after this pause; a pasted or dropped one at once
const MODE_NOTE = {
  binaryObject: 'machine code of the object file',
  binary: 'machine code of the linked program',
  asm: 'assembly text, assembled here (encodings can differ)',
};
const inner = (fn) => findLoops(fn).filter((l) => l.inner);

// api: importInto(side, {mode, syntax, text}, {alignment, undo}), getCode(side) -> {mode, syntax, text},
//      sides() -> ['A'] or ['A', 'B'], fetch (optional)
export function createCeImport(api) {
  const opts = () => (api.fetch ? { fetch: api.fetch } : {});
  const boxes = new Map(); // side -> box

  // ---- a box --------------------------------------------------------------------------------------------------
  function watch(textarea, side, messages) {
    const line = h('div', { class: 'ce-line', role: 'status', 'aria-live': 'polite', 'data-for': textarea.id });
    const picker = h('div', { class: 'ce-pick', hidden: true, role: 'group', 'aria-label': 'what to import from Compiler Explorer' });
    (messages ?? textarea).after(line, picker);
    const b = { side, textarea, line, picker, ctrl: null, timer: 0, skip: null };
    boxes.set(side, b);

    textarea.addEventListener('paste', (e) => {
      const text = (e.clipboardData?.getData('text/plain') ?? '').trim();
      if (!isCeLink(text)) return;
      e.preventDefault(); // the link replaces the box's text (undo after the import gives the link back)
      b.skip = null;      // pasted again (e.g. after undo): import it
      textarea.value = text;
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    });
    textarea.addEventListener('input', (e) => {
      clearTimeout(b.timer);
      const v = textarea.value.trim();
      if (!isCeLink(v)) { if (b.ctrl || !b.picker.hidden) reset(b); else if (b.line.firstChild) say(b, ''); b.skip = null; return; }
      if (v === b.skip) return;
      const now = !e.inputType || e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop';
      if (now) start(b, v); else b.timer = setTimeout(() => start(b, v), TYPING_DELAY);
    });
  }

  function say(b, content, { error = false, busy = false, title = null } = {}) {
    b.line.replaceChildren(...(Array.isArray(content) ? content : [content]));
    b.line.classList.toggle('error', error);
    b.line.classList.toggle('busy', busy);
    if (title) b.line.title = title; else b.line.removeAttribute('title');
  }
  function reset(b) {
    b.ctrl?.abort();
    b.ctrl = null;
    b.picker.hidden = true;
    b.picker.replaceChildren();
    say(b, '');
  }

  // The box of a visible side that holds only a link (app.js: such a box is not analyzed), or null.
  function linkBox() {
    for (const s of api.sides()) {
      const b = boxes.get(s);
      if (b && isCeLink(b.textarea.value)) return b;
    }
    return null;
  }

  // ---- loading a link -------------------------------------------------------------------------------------------
  async function start(b, link) {
    reset(b);
    const c = b.ctrl = new AbortController();
    const signal = c.signal;
    const before = api.getCode(b.side);
    const s = { b, link, undo: { mode: before.mode, syntax: before.syntax, text: link }, st: null, infos: new Map(), compiled: new Map(), choice: null, sel: null };
    try {
      const parsed = parseCeLink(link);
      say(b, 'importing from godbolt.org…', { busy: true });
      const st = parsed.kind === 'short' ? await resolveShortLink(parsed.id, { ...opts(), signal }) : parsed.state;
      const langs = [...new Set(st.compilers.map((p) => p.lang).filter(Boolean))];
      await Promise.all(langs.map(async (l) => {
        try { s.infos.set(l, await compilersOf(l, { ...opts(), signal })); } catch (e) { if (signal.aborted) throw e; /* names unknown: ids are shown */ }
      }));
      if (signal.aborted) return;
      s.st = st;
      const choices = paneChoices(s);
      const good = choices.filter((ch) => !ch.problem);
      if (!good.length) {
        const why = choices.map((ch) => ch.problem).filter(Boolean);
        say(b, 'nothing to import: no x86-64 compiler pane', { error: true, title: [...why, ...st.notes].join('\n') || null });
        b.ctrl = null;
        return;
      }
      s.choices = choices;
      await choose(s, good[0], { auto: good.length === 1 });
    } catch (e) {
      if (signal.aborted) return;
      b.ctrl = null;
      say(b, e?.message ?? String(e), { error: true });
    }
  }

  const infoOf = (s, p) => s.infos.get(p.lang)?.get(p.compiler) ?? null;
  // the compiler's name; without the list, from the pane's title ("x86-64 gcc 9.1 (Editor #1, Compiler #1) C++")
  const nameOf = (s, p) => infoOf(s, p)?.name ?? (p.title ? p.title.replace(/\s*\([^()]*Editor #\d+[^()]*\).*$/, '') || p.compiler : p.compiler);

  // compiler panes, and assembly sources without one
  function paneChoices(s) {
    const { st } = s;
    const out = st.compilers.map((p) => ({ kind: 'compiler', id: `c${p.n}`, pane: p, editor: st.editors.find((e) => e.id === p.editorId) ?? null,
      problem: targetProblem(infoOf(s, p), p, null) }));
    for (const e of st.editors) {
      if (e.lang === 'assembly' && !st.compilers.some((p) => p.editorId === e.id)) out.push({ kind: 'source', id: `e${e.id}`, editor: e, problem: null });
    }
    for (const ch of out) if (ch.kind === 'compiler' && !ch.editor) ch.problem = `its source (editor #${ch.pane.editorId}) is not in the link`;
    return out;
  }
  const choiceName = (s, ch) => (ch.kind === 'compiler' ? `${nameOf(s, ch.pane)}${ch.pane.options ? ' ' + ch.pane.options : ''}` : `assembly source #${ch.editor.id}`);

  // auto: import at once if the choice is obvious (one function with one innermost loop, or one function)
  async function choose(s, ch, { auto = false } = {}) {
    const { b } = s;
    s.choice = ch;
    s.sel = null;
    if (ch.kind === 'source') {
      s.sel = { source: sourceAsAssembly(ch.editor) };
      if (auto) { doImport(s); return; }
      paintPicker(s);
      say(b, 'choose what to import');
      return;
    }
    if (ch.problem) { say(b, `${choiceName(s, ch)}: ${ch.problem}`, { error: true }); return; }
    let result = s.compiled.get(ch.id);
    if (!result) {
      if (!b.ctrl || b.ctrl.signal.aborted) b.ctrl = new AbortController();
      const signal = b.ctrl.signal;
      say(b, 'importing from godbolt.org…', { busy: true, title: `compiling with ${nameOf(s, ch.pane)}` });
      try {
        const r = await compilePane(ch.pane, ch.editor.source, infoOf(s, ch.pane), { ...opts(), signal });
        if (signal.aborted || s.choice !== ch) return;
        result = { failed: r.failed, mode: r.mode, messages: compilerMessages(r.response), problem: targetProblem(infoOf(s, ch.pane), ch.pane, r.response),
          warn32: is32bit(infoOf(s, ch.pane), ch.pane), listing: r.failed ? null : parseListing(r.response) };
        s.compiled.set(ch.id, result);
      } catch (e) {
        if (signal.aborted) return;
        say(b, e?.message ?? String(e), { error: true });
        return;
      }
    }
    const name = nameOf(s, ch.pane);
    const fail = (text, title = null) => { if (s.choices.length > 1) paintPicker(s); else { b.picker.hidden = true; b.ctrl = null; } say(b, text, { error: true, title }); };
    if (result.failed) { fail(`compilation failed: ${result.messages.find((m) => /error/i.test(m)) ?? result.messages[0] ?? name}`, result.messages.slice(0, 40).join('\n')); return; }
    if (result.problem) { fail(result.problem, name); return; }
    if (!result.listing.functions.length) { fail('no instructions in the output', name); return; }
    const d = defaultSelection(result.listing);
    s.sel = { fn: d.fn, start: d.start, end: d.end, anchor: d.start, align: false };
    const fns = result.listing.functions;
    const withLoops = fns.filter((f) => inner(f).length);
    const obvious = (withLoops.length === 1 && inner(withLoops[0]).length === 1) || (withLoops.length === 0 && fns.length === 1);
    if (auto && obvious) { doImport(s); return; }
    paintPicker(s);
    say(b, 'choose what to import', { title: `${name} · ${MODE_NOTE[result.mode]}` });
  }

  // ---- the picker: pane, function, range ---------------------------------------------------------------------------
  function paintPicker(s) {
    const { b } = s;
    const ch = s.choice;
    const result = ch.kind === 'compiler' ? s.compiled.get(ch.id) : null;
    const parts = [];
    const id = (x) => `ce-${x}-${b.side.toLowerCase()}`;
    if (s.choices.length > 1) {
      const paneSel = h('select', { id: id('pane') }, s.choices.map((c) => h('option', { value: c.id, disabled: !!c.problem, title: c.problem, text: choiceName(s, c) + (c.problem ? ' (not x86-64)' : '') })));
      paneSel.value = ch.id;
      paneSel.addEventListener('change', () => { const c = s.choices.find((x) => x.id === paneSel.value); if (c) choose(s, c); });
      parts.push(h('label', { class: 'inline' }, 'pane', paneSel));
    }
    const ok = result?.listing && !result.failed && !result.problem && s.sel;
    if (ok) {
      const { listing } = result;
      const fn = listing.functions[s.sel.fn];
      if (listing.functions.length > 1) {
        const fnSel = h('select', { id: id('fn') }, listing.functions.map((f, k) => h('option', { value: String(k), text: f.name + (inner(f).length ? ' ↻' : '') })));
        fnSel.value = String(s.sel.fn);
        fnSel.addEventListener('change', () => {
          const f = listing.functions[Number(fnSel.value)];
          const l = defaultLoopOf(f);
          const first = f.items.findIndex((it) => it.kind === 'instr');
          s.sel = { ...s.sel, fn: Number(fnSel.value), ...(l ? { start: l.start, end: l.end, anchor: l.start } : { start: first, end: f.items.length - 1, anchor: first }) };
          paintPicker(s);
        });
        parts.push(h('label', { class: 'inline', title: '↻: has a loop' }, 'function', fnSel));
      }
      const lineOf = (k) => fn.items.slice(0, k + 1).filter((it) => it.kind === 'instr').length;
      const chips = h('span', { class: 'ce-quick' });
      findLoops(fn).forEach((l, k) => {
        const n = fn.items.slice(l.start, l.end + 1).filter((it) => it.kind === 'instr').length;
        const c = h('button', { type: 'button', class: 'ce-chip' + (s.sel.start === l.start && s.sel.end === l.end ? ' on' : ''),
          title: `${l.inner ? 'innermost loop' : 'loop'}: instructions ${lineOf(l.start)}–${lineOf(l.end)}, ${plural(n, 'instruction')}` }, `loop ${k + 1}`);
        c.addEventListener('click', () => { s.sel = { ...s.sel, start: l.start, end: l.end, anchor: l.start }; paintPicker(s); });
        chips.append(c);
      });
      const firstInstr = fn.items.findIndex((it) => it.kind === 'instr');
      const whole = h('button', { type: 'button', class: 'ce-chip' + (s.sel.start === firstInstr && s.sel.end === fn.items.length - 1 ? ' on' : '') }, 'whole');
      whole.addEventListener('click', () => { s.sel = { ...s.sel, start: firstInstr, end: fn.items.length - 1, anchor: firstInstr }; paintPicker(s); });
      chips.append(whole);
      parts.push(chips);
    }
    const sel = current(s);
    const go = h('button', { type: 'button', class: 'primary', id: id('import'), disabled: !sel }, 'import');
    go.addEventListener('click', () => doImport(s));
    const cancel = h('button', { type: 'button', class: 'plain', id: id('cancel') }, 'cancel');
    cancel.addEventListener('click', () => { reset(b); b.textarea.focus(); });
    parts.push(go, cancel);
    const out = [h('div', { class: 'ce-bar' }, ...parts)];
    if (sel?.info) {
      const e = sel.info;
      const what = `${plural(e.instructions, 'instruction')}${e.bytes !== null ? `, ${plural(e.bytes, 'byte')}` : ''}${e.endsInBranch ? ' · loop' : ' · unrolled'}${result?.warn32 ? ' · 32-bit?' : ''}`;
      const extra = [];
      if (e.startAddress !== null) {
        const off = e.startAddress % 64;
        const align = h('input', { type: 'checkbox', id: id('align'), checked: s.sel.align });
        align.checked = s.sel.align;
        align.addEventListener('change', () => { s.sel.align = align.checked; });
        extra.push(' · ', h('label', { title: `where the block starts in the ${result?.mode === 'binary' ? 'program' : 'object file'}, if its code is 64-byte aligned` }, align, ` alignment ${off}`));
      }
      out.push(h('details', { class: 'ce-range', open: !!s.rangeOpen },
        h('summary', { title: result?.warn32 ? 'looks like 32-bit code (-m32?): wuica decodes x86-64' : null }, what), ...extra, listingTable(s, result)));
      out.at(-1).addEventListener('toggle', (ev) => { s.rangeOpen = ev.currentTarget.open; });
    }
    if (result?.failed && result.messages.length) out.push(h('pre', { class: 'ce-messages error', tabindex: '0', text: result.messages.slice(0, 40).join('\n') }));
    b.picker.replaceChildren(...out);
    b.picker.hidden = false;
  }

  // the listing: click selects an instruction, shift+click extends the range (keyboard: Enter, Shift+Enter)
  function listingTable(s, result) {
    const { b } = s;
    const fn = result.listing.functions[s.sel.fn];
    const srcLines = String(s.choice.editor?.source ?? '').split('\n');
    const inLoop = new Set();
    for (const l of findLoops(fn)) for (let k = l.start; k <= l.end; k++) inLoop.add(k);
    const body = h('tbody');
    let count = 0;
    fn.items.forEach((it, k) => {
      const on = k >= s.sel.start && k <= s.sel.end;
      if (it.kind === 'label') {
        body.append(h('tr', { class: 'ce-label' + (on ? ' on' : '') }, h('td', { class: 'ce-mark' }), h('td', { colspan: '4', text: `${it.name}:` })));
        return;
      }
      count++;
      const back = it.target !== null && it.target <= k;
      const tr = h('tr', { class: ['ce-row', on ? 'on' : '', inLoop.has(k) ? 'loop' : ''].filter(Boolean).join(' '), tabindex: '0', 'data-k': String(k),
        'aria-selected': on ? 'true' : 'false', title: it.line && srcLines[it.line - 1] !== undefined ? `line ${it.line}: ${srcLines[it.line - 1].trim()}` : null },
        h('td', { class: 'ce-mark', text: back ? '↰' : '' }),
        h('td', { class: 'ce-addr', text: it.address !== null ? it.address.toString(16) : String(count) }),
        h('td', { class: 'ce-bytes', text: it.bytes ? it.bytes.map(hex2).join(' ') : '' }),
        h('td', { class: 'ce-text', text: it.text }),
        h('td', { class: 'ce-line-no', text: it.line ? `L${it.line}` : '' }));
      const act = (extend) => {
        if (extend) s.sel = { ...s.sel, start: Math.min(s.sel.anchor, k), end: Math.max(s.sel.anchor, k) };
        else s.sel = { ...s.sel, start: k, end: k, anchor: k };
        paintPicker(s);
        b.picker.querySelector(`tr[data-k="${k}"]`)?.focus();
      };
      tr.addEventListener('click', (e) => act(e.shiftKey));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(e.shiftKey); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const rows = [...b.picker.querySelectorAll('tr.ce-row')];
          rows[rows.indexOf(tr) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
        }
      });
      body.append(tr);
    });
    return h('div', { class: 'ce-listing-wrap', tabindex: '-1', role: 'region', 'aria-label': `the instructions of ${fn.name}; click, shift+click: range`, title: 'click: start of the range; shift+click: end' },
      h('table', { class: 'ce-listing' }, body));
  }

  // ---- importing --------------------------------------------------------------------------------------------------
  function current(s) {
    const ch = s.choice;
    if (!ch || !s.sel) return null;
    if (ch.kind === 'source') return { code: s.sel.source, info: null };
    const result = s.compiled.get(ch.id);
    if (!result?.listing || result.problem) return null;
    const fn = result.listing.functions[s.sel.fn];
    const ext = extractRange(fn, s.sel.start, s.sel.end, result.listing);
    if (!ext.instructions) return null;
    return { code: { mode: ext.mode, syntax: /** @type {{syntax?: string}} */ (ext).syntax ?? 'intel', text: ext.text }, info: ext, result, fn };
  }

  function doImport(s) {
    const { b } = s;
    const c = current(s);
    if (!c) return;
    const alignment = c.info && c.info.startAddress !== null && s.sel.align ? c.info.startAddress % 64 : null;
    b.ctrl = null;
    b.picker.hidden = true;
    b.picker.replaceChildren();
    b.skip = null;
    // the source line of each instruction (srcmap.js: cost per source line)
    const source = c.info && c.fn && s.choice.kind === 'compiler' ? { text: String(s.choice.editor?.source ?? ''), lines: rangeLines(c.fn, s.sel.start, s.sel.end) } : null;
    api.importInto(b.side, c.code, { alignment, source });
    const isLoop = c.info && findLoops(c.fn).some((l) => l.start === s.sel.start && l.end === s.sel.end);
    const what = c.info ? `${isLoop ? 'loop' : plural(c.info.instructions, 'instruction')} in ${c.fn.name}` : 'assembly source';
    const undo = h('button', { type: 'button', class: 'plain', id: `ce-undo-${b.side.toLowerCase()}`, title: 'put the link back' }, 'undo');
    undo.addEventListener('click', () => {
      b.skip = s.link; // the link is back: not imported again until the box changes
      api.importInto(b.side, s.undo, { undo: true });
      say(b, '');
      b.textarea.focus();
    });
    const title = c.info ? [choiceName(s, s.choice), MODE_NOTE[c.result.mode], `${plural(c.info.instructions, 'instruction')}${c.info.bytes !== null ? `, ${plural(c.info.bytes, 'byte')}` : ''}`].join(' · ') : null;
    say(b, [`imported: ${what} · `, undo], { title });
  }

  return { watch, linkBox, start: (b) => start(b, b.textarea.value.trim()), isLink: isCeLink };
}
