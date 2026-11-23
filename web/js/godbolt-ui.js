// The "Import from Compiler Explorer" dialog: a link -> its compiler panes -> the compiled output -> a function
// and a range of it (the innermost loop is preselected) -> the page's input. The format and the API are in
// godbolt.js. This is the only part of the page that talks to a third party (godbolt.org), and only after the
// user presses Load (or Import on a pasted link).

import { h } from './render.js';
import {
  parseCeLink, isCeLink, resolveShortLink, compilersOf, compilePane, parseListing, findLoops, defaultSelection,
  extractRange, sourceAsAssembly, compilerMessages, targetProblem, is32bit,
} from './godbolt.js';

const hex2 = (b) => (b < 16 ? '0' : '') + b.toString(16);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const MODE_NOTE = {
  binaryObject: 'machine code of the compiled object file: the exact encoding the compiler produced',
  binary: 'machine code of the linked program: the exact encoding the compiler produced',
  asm: 'this compiler gives no machine code: its assembly text is imported and assembled here (branch encodings and padding can differ)',
};

// api: importInto(side, {mode, syntax, text}, {alignment}), sides() -> ['A'] or ['A', 'B'], fetch (optional)
export function createCeImport(api) {
  const opts = () => (api.fetch ? { fetch: api.fetch } : {});
  let target = 'A';
  let session = null; // {link, st, infos: Map lang -> Map id -> info, compiled: Map pane n -> result, choice}
  let sel = null;     // {fn, start, end, anchor}
  let ctrl = null;    // AbortController of the running requests

  // ---- the dialog ---------------------------------------------------------------------------------------------
  const url = h('input', { type: 'url', id: 'ce-url', placeholder: 'https://godbolt.org/z/…', autocomplete: 'off', spellcheck: 'false', required: true });
  const load = h('button', { type: 'submit', class: 'primary', id: 'ce-load' }, 'Load');
  const form = h('form', { class: 'ce-url', novalidate: true }, h('label', { for: 'ce-url', text: 'link' }), url, load);
  const status = h('div', { class: 'ce-status', id: 'ce-status', role: 'status', 'aria-live': 'polite' });
  const panes = h('div', { class: 'ce-panes' });
  const pick = h('div', { class: 'ce-pick' });
  const selInfo = h('div', { class: 'ce-sel', id: 'ce-sel' });
  const align = h('input', { type: 'checkbox', id: 'ce-align' });
  const alignText = h('span');
  const alignWrap = h('label', { class: 'ce-align', hidden: true }, align, alignText);
  const buttons = h('div', { class: 'ce-buttons' });
  const close = h('button', { type: 'button', class: 'plain ce-close', id: 'ce-close' }, 'close');
  const dialog = h('dialog', { class: 'ce-dialog', id: 'ce-dialog', 'aria-labelledby': 'ce-title' },
    h('div', { class: 'ce-top' }, h('h2', { id: 'ce-title', text: 'Import from Compiler Explorer' }), close),
    h('p', { class: 'ce-privacy' },
      'Loading a link sends requests to ', h('b', { text: 'godbolt.org' }),
      ': a short link is looked up there, and the code in the link is compiled on Compiler Explorer\'s servers (as its own page would). Nothing is sent before you press Load.'),
    form, status, panes, pick,
    h('div', { class: 'ce-foot' }, selInfo, alignWrap, buttons));
  document.body.append(dialog);

  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { ctrl?.abort(); ctrl = null; });
  form.addEventListener('submit', (e) => { e.preventDefault(); start(url.value); });

  function say(text, { error = false, busy = false } = {}) {
    status.replaceChildren(...(Array.isArray(text) ? text : [text]));
    status.classList.toggle('error', error);
    status.classList.toggle('busy', busy);
    load.disabled = busy;
  }

  function open(side = 'A', link = null) {
    target = side;
    if (!dialog.open) dialog.showModal();
    paintButtons();
    if (link) { url.value = link; start(link); } else url.focus();
  }

  // ---- loading a link -------------------------------------------------------------------------------------------
  async function start(text) {
    ctrl?.abort();
    const c = ctrl = new AbortController();
    const signal = c.signal;
    session = null; sel = null;
    panes.replaceChildren(); pick.replaceChildren(); paintFoot();
    let parsed;
    try { parsed = parseCeLink(text); } catch (e) { say(e.message, { error: true }); return; }
    try {
      let st = parsed.state;
      if (parsed.kind === 'short') {
        say(`looking up the short link ${parsed.id} on godbolt.org…`, { busy: true });
        st = await resolveShortLink(parsed.id, { ...opts(), signal });
      }
      const langs = [...new Set(st.compilers.map((p) => p.lang).filter(Boolean))];
      const infos = new Map();
      if (langs.length) {
        say('getting the compilers\' names from godbolt.org…', { busy: true });
        await Promise.all(langs.map(async (l) => {
          try { infos.set(l, await compilersOf(l, { ...opts(), signal })); } catch (e) { if (signal.aborted) throw e; /* names unknown: ids are shown */ }
        }));
      }
      if (signal.aborted) return;
      session = { link: text, st, infos, compiled: new Map(), choice: null };
      const choices = paneChoices();
      if (choices.length === 0) {
        say(st.compilers.length ? 'This link has no compiler pane that can be imported.' : 'This link has no compiler pane (only an editor, an executor or other panes) and no assembly source.', { error: true });
        for (const n of st.notes) panes.append(h('p', { class: 'hint', text: n }));
        return;
      }
      say(`${plural(st.editors.length, 'source')}, ${plural(st.compilers.length, 'compiler pane')}`);
      paintPanes(choices);
      const first = choices.find((ch) => !ch.problem) ?? choices[0];
      await choose(first);
    } catch (e) {
      if (signal.aborted && e?.message === 'cancelled') return;
      if (!signal.aborted) say(e?.message ?? String(e), { error: true });
    }
  }

  const infoOf = (p) => session.infos.get(p.lang)?.get(p.compiler) ?? null;
  // the compiler's name; without the list, from the pane's title ("x86-64 gcc 9.1 (Editor #1, Compiler #1) C++")
  const nameOf = (p) => infoOf(p)?.name ?? (p.title ? p.title.replace(/\s*\([^()]*Editor #\d+[^()]*\).*$/, '') || p.compiler : p.compiler);

  // compiler panes, and assembly sources without one
  function paneChoices() {
    const { st } = session;
    const out = st.compilers.map((p) => ({ kind: 'compiler', id: `c${p.n}`, pane: p, editor: st.editors.find((e) => e.id === p.editorId) ?? null,
      problem: targetProblem(infoOf(p), p, null) }));
    for (const e of st.editors) {
      if (e.lang === 'assembly' && !st.compilers.some((p) => p.editorId === e.id)) out.push({ kind: 'source', id: `e${e.id}`, editor: e, problem: null });
    }
    for (const ch of out) if (ch.kind === 'compiler' && !ch.editor) ch.problem = `its source (editor #${ch.pane.editorId}) is not in the link`;
    return out;
  }

  function paintPanes(choices) {
    const group = h('div', { class: 'ce-pane-list', role: 'radiogroup', 'aria-label': 'compiler pane' });
    for (const ch of choices) {
      const r = h('input', { type: 'radio', name: 'ce-pane', value: ch.id, id: `ce-pane-${ch.id}` });
      r.addEventListener('change', () => { if (r.checked) choose(ch); });
      const label = ch.kind === 'compiler'
        ? [h('span', { class: 'ce-name', text: nameOf(ch.pane) }), ch.pane.options ? h('span', { class: 'ce-opts', text: ` ${ch.pane.options}` }) : null,
          h('span', { class: 'hint', text: ` · ${ch.pane.lang || '?'} · editor #${ch.pane.editorId}` })]
        : [h('span', { class: 'ce-name', text: `assembly source (editor #${ch.editor.id})` }), h('span', { class: 'hint', text: ' · imported as it is' })];
      group.append(h('label', { class: ch.problem ? 'ce-bad' : null }, r, ...label, ch.problem ? h('span', { class: 'caveat', text: ` · ${ch.problem}` }) : null));
    }
    panes.replaceChildren(h('div', { class: 'ce-sub', text: 'pane' }), group);
    for (const n of session.st.notes) panes.append(h('p', { class: 'hint', text: n }));
  }

  async function choose(ch) {
    session.choice = ch;
    sel = null;
    const radio = panes.querySelector(`input[value="${ch.id}"]`);
    if (radio) radio.checked = true;
    pick.replaceChildren();
    paintFoot();
    if (ch.kind === 'source') { paintSource(ch); return; }
    if (ch.problem && !session.compiled.has(ch.id)) { say(`${nameOf(ch.pane)}: ${ch.problem}`, { error: true }); return; }
    let result = session.compiled.get(ch.id);
    if (!result) {
      if (!ctrl || ctrl.signal.aborted) ctrl = new AbortController(); // (the dialog was closed and opened again)
      const signal = ctrl.signal;
      say(`compiling with ${nameOf(ch.pane)} on godbolt.org…`, { busy: true });
      try {
        const r = await compilePane(ch.pane, ch.editor.source, infoOf(ch.pane), { ...opts(), signal });
        if (signal.aborted || session?.choice !== ch) return;
        const messages = compilerMessages(r.response);
        result = { failed: r.failed, mode: r.mode, messages, problem: targetProblem(infoOf(ch.pane), ch.pane, r.response),
          warn32: is32bit(infoOf(ch.pane), ch.pane), listing: r.failed ? null : parseListing(r.response), execTime: r.response?.execTime };
        session.compiled.set(ch.id, result);
      } catch (e) {
        if (signal.aborted) return;
        say(e?.message ?? String(e), { error: true });
        return;
      }
    }
    paintResult(ch, result);
  }

  // ---- the output: function, range, listing ---------------------------------------------------------------------------
  function messagesBox(messages, error) {
    if (!messages.length) return null;
    const pre = h('pre', { class: 'ce-messages' + (error ? ' error' : ''), tabindex: '0', text: messages.slice(0, 60).join('\n') + (messages.length > 60 ? '\n…' : '') });
    return error ? pre : h('details', { class: 'ce-warn' }, h('summary', { text: `compiler messages (${messages.length})` }), pre);
  }

  function paintResult(ch, result) {
    if (result.failed) {
      say(`${nameOf(ch.pane)}: the compilation failed`, { error: true });
      pick.replaceChildren(messagesBox(result.messages.length ? result.messages : ['(no messages)'], true));
      return;
    }
    if (result.problem) {
      say(`${nameOf(ch.pane)}: ${result.problem}`, { error: true });
      return;
    }
    const { listing } = result;
    if (!listing.functions.length) {
      say(`${nameOf(ch.pane)}: the output has no instructions (everything optimized away?)`, { error: true });
      pick.replaceChildren(messagesBox(result.messages, false) ?? '');
      return;
    }
    say([`compiled with ${nameOf(ch.pane)}`, result.execTime ? ` in ${result.execTime} ms` : '', ` · ${MODE_NOTE[result.mode]}`]);
    const d = defaultSelection(listing);
    sel = { fn: d.fn, start: d.start, end: d.end, anchor: d.start };
    paintPick(ch, result);
  }

  function paintPick(ch, result) {
    const { listing } = result;
    const fn = listing.functions[sel.fn];
    const loops = findLoops(fn);
    const fnSelect = h('select', { id: 'ce-fn' }, listing.functions.map((f, k) => {
      const n = findLoops(f).length;
      return h('option', { value: String(k), text: `${f.name}${n ? ` · ${plural(n, 'loop')}` : ''}` });
    }));
    fnSelect.value = String(sel.fn);
    fnSelect.addEventListener('change', () => {
      const f = listing.functions[Number(fnSelect.value)];
      const l = findLoops(f)[0];
      const first = f.items.findIndex((it) => it.kind === 'instr');
      sel = l ? { fn: Number(fnSelect.value), start: l.start, end: l.end, anchor: l.start } : { fn: Number(fnSelect.value), start: first, end: f.items.length - 1, anchor: first };
      paintPick(ch, result);
    });
    const quick = h('div', { class: 'ce-quick' }, h('span', { class: 'hint', text: 'select:' }));
    const lineOf = (k) => fn.items.slice(0, k + 1).filter((it) => it.kind === 'instr').length;
    loops.forEach((l, k) => {
      const n = fn.items.slice(l.start, l.end + 1).filter((it) => it.kind === 'instr').length;
      const b = h('button', { type: 'button', class: 'ce-chip' + (sel.start === l.start && sel.end === l.end ? ' on' : '') },
        `${l.inner ? 'innermost loop' : 'loop'} ${k + 1}: ${lineOf(l.start)}–${lineOf(l.end)} (${plural(n, 'instruction')})`);
      b.addEventListener('click', () => { sel = { ...sel, start: l.start, end: l.end, anchor: l.start }; paintPick(ch, result); });
      quick.append(b);
    });
    const firstInstr = fn.items.findIndex((it) => it.kind === 'instr');
    const whole = h('button', { type: 'button', class: 'ce-chip' + (sel.start === firstInstr && sel.end === fn.items.length - 1 ? ' on' : '') }, 'whole function');
    whole.addEventListener('click', () => { sel = { ...sel, start: firstInstr, end: fn.items.length - 1, anchor: firstInstr }; paintPick(ch, result); });
    quick.append(whole);

    // the listing: click selects an instruction, shift+click extends the range (keyboard: Enter, Shift+Enter)
    const srcLines = String(ch.editor?.source ?? '').split('\n');
    const inLoop = new Set();
    for (const l of loops) for (let k = l.start; k <= l.end; k++) inLoop.add(k);
    const body = h('tbody');
    let count = 0;
    fn.items.forEach((it, k) => {
      const on = k >= sel.start && k <= sel.end;
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
        h('td', { class: 'ce-line', text: it.line ? `L${it.line}` : '' }));
      const act = (extend) => {
        if (extend) sel = { ...sel, start: Math.min(sel.anchor, k), end: Math.max(sel.anchor, k) };
        else sel = { ...sel, start: k, end: k, anchor: k };
        paintPick(ch, result);
        pick.querySelector(`tr[data-k="${k}"]`)?.focus();
      };
      tr.addEventListener('click', (e) => act(e.shiftKey));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(e.shiftKey); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const rows = [...pick.querySelectorAll('tr.ce-row')];
          rows[rows.indexOf(tr) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
        }
      });
      body.append(tr);
    });
    const table = h('table', { class: 'ce-listing' }, body);
    const wrap = h('div', { class: 'ce-listing-wrap', tabindex: '-1', role: 'region', 'aria-label': `the instructions of ${fn.name}` }, table);
    pick.replaceChildren(
      h('div', { class: 'ce-fnrow' }, h('label', { for: 'ce-fn', class: 'ce-sub', text: 'function' }), fnSelect),
      quick,
      h('p', { class: 'hint', text: 'Click an instruction to start the range, shift+click to end it. ↰ marks a backward jump (a loop).' }),
      wrap,
      messagesBox(result.messages, false) ?? '');
    // keep the selection in view
    const first = wrap.querySelector('tr.on');
    if (first) wrap.scrollTop = Math.max(0, first.offsetTop - 40);
    paintFoot(result);
  }

  function paintSource(ch) {
    say('an assembly source without a compiler pane: it is imported as it is (assembly input)');
    const code = sourceAsAssembly(ch.editor);
    pick.replaceChildren(h('pre', { class: 'ce-messages', tabindex: '0', text: code.text }));
    sel = { source: code };
    paintFoot();
  }

  // ---- importing --------------------------------------------------------------------------------------------------
  function current() {
    if (!session?.choice || !sel) return null;
    const ch = session.choice;
    if (ch.kind === 'source') return { code: sel.source, info: null };
    const result = session.compiled.get(ch.id);
    if (!result?.listing || result.problem) return null;
    const fn = result.listing.functions[sel.fn];
    const ext = extractRange(fn, sel.start, sel.end, result.listing);
    if (!ext.instructions) return null;
    return { code: { mode: ext.mode, syntax: ext.syntax ?? 'intel', text: ext.text }, info: ext, result, fn };
  }

  function paintFoot(result) {
    const c = current();
    buttons.replaceChildren();
    if (!c) { selInfo.textContent = ''; alignWrap.hidden = true; paintButtons(false); return; }
    if (c.info) {
      const e = c.info;
      selInfo.replaceChildren(
        h('span', { text: `${plural(e.instructions, 'instruction')}${e.bytes !== null ? `, ${plural(e.bytes, 'byte')}` : ''} from ${c.fn.name}` }),
        h('span', { class: 'hint', text: e.endsInBranch ? ' · ends in a branch: analyzed as a loop' : ' · no branch at the end: analyzed unrolled' }),
        result?.warn32 ? h('span', { class: 'caveat', text: ' · this looks like 32-bit code (-m32 or a 32-bit compiler): wuica decodes x86-64' }) : '');
      if (e.startAddress !== null) {
        const off = e.startAddress % 64;
        alignText.textContent = ` also set the alignment offset to ${off} (where the block starts in the ${c.result?.mode === 'binary' ? 'program' : 'object file'}, if its code is 64-byte aligned)`;
        alignWrap.hidden = false;
      } else alignWrap.hidden = true;
    } else {
      selInfo.textContent = 'the whole source, as assembly';
      alignWrap.hidden = true;
    }
    paintButtons(true);
  }

  function paintButtons(enabled = !!current()) {
    const sides = api.sides();
    const order = sides.includes(target) ? [target, ...sides.filter((s) => s !== target)] : sides;
    buttons.replaceChildren(...order.map((side, k) => {
      const b = h('button', { type: 'button', class: k === 0 ? 'primary' : null, id: `ce-import-${side.toLowerCase()}`, disabled: !enabled },
        sides.length > 1 ? `Import into ${side}` : 'Import');
      b.addEventListener('click', () => doImport(side));
      return b;
    }));
  }

  function doImport(side) {
    const c = current();
    if (!c) return;
    const alignment = c.info && c.info.startAddress !== null && !alignWrap.hidden && align.checked ? c.info.startAddress % 64 : null;
    api.importInto(side, c.code, { alignment });
    dialog.close();
  }

  // ---- a pasted link ------------------------------------------------------------------------------------------------
  function watchPaste(textarea, side) {
    textarea.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!isCeLink(text)) return;
      e.preventDefault();
      offer(textarea, typeof side === 'function' ? side() : side, text.trim());
    });
  }

  function offer(textarea, side, link) {
    textarea.parentElement.querySelector(`.ce-offer[data-for="${textarea.id}"]`)?.remove();
    const yes = h('button', { type: 'button', class: 'primary' }, 'Import from godbolt.org');
    const text = h('button', { type: 'button', class: 'plain' }, 'paste the link as text');
    const no = h('button', { type: 'button', class: 'plain', 'aria-label': 'dismiss' }, 'dismiss');
    const box = h('div', { class: 'ce-offer', role: 'status', 'data-for': textarea.id },
      h('span', { text: 'That is a Compiler Explorer link. Import its code? This fetches from godbolt.org. ' }), yes, ' ', text, ' ', no);
    textarea.after(box);
    yes.addEventListener('click', () => { box.remove(); open(side, link); });
    text.addEventListener('click', () => {
      box.remove();
      textarea.focus();
      textarea.setRangeText(link, textarea.selectionStart, textarea.selectionEnd, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    no.addEventListener('click', () => { box.remove(); textarea.focus(); });
    yes.focus();
  }

  return { open, watchPaste, dialog };
}
