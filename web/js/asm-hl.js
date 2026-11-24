// Assembly in colour on the page (the tokens: asm-tokens.js; the colours: style.css, --tok-*).
//
// attachHighlight(textarea, {mode(), syntax()}): a code box in colour. The box stays the real text field (typing,
// selection, undo, IME, find-in-page, the shortcuts, its accessible name); while the layer is on, the box's text is
// transparent and a layer over it shows the same text in colour at the same place:
// - the layer has the box's border (transparent), padding, font, line height and tab size (copied from the box's computed
//   style), lies over it (inset 0, no pointer events) and is clipped to the box's inside without its scroll bars;
// - it draws only the lines near the view; the lines above them are as many empty lines, so the browser puts the drawn
//   lines where the box has its own (no line height multiplied out: a line is 18.84 px, not 18.85, after layout);
// - it scrolls with the box (its own scroll position set to the box's; a 1 px element at the box's scroll size gives it
//   the same scroll range);
// - the tokens' text is generated content (::before with attr()): a find-in-page meets the text once, in the box.
// Lines the assembler's messages point at are underlined (setDiagnostics); the token at the message's column too.
// Anything that throws turns the layer off for good: the box shows its own text again.
//   mode(): 'asm' | 'hex' (hex: in colour only when the text is objdump's), syntax(): 'intel' | 'att' (assembly)
//   -> {refresh() (the mode or the syntax changed), setDiagnostics(items), active() (the layer is on)}
//
// colorInstr(el, text): an instruction's text (Intel, as the analyzer prints it) as tokens in el (the uop table's
// instruction column and the views' instruction lists); el's textContent stays the text.

import { tokenize, tokenizeLine, objdumpText, objdumpLine, className } from './asm-tokens.js';
import { detectSyntax } from './loop-find.js';

const MARGIN = 12;        // lines drawn above and below the view
const LONG_LINE = 2000;   // a longer line is drawn without colours (a link can hold one line of 200,000 characters)
// the box's metrics the layer copies (its border style is its own: solid, transparent)
const METRICS = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant', 'font-feature-settings',
  'font-variation-settings', 'font-kerning', 'font-optical-sizing', 'line-height', 'letter-spacing', 'word-spacing', 'tab-size',
  'text-indent', 'text-rendering', 'text-transform', 'direction', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'];
const MARKS = { error: 'ed-err', warning: 'ed-warn' };

export function attachHighlight(ta, opts) {
  const doc = ta.ownerDocument;
  const wrap = doc.createElement('div');
  wrap.className = 'ed';
  const layer = doc.createElement('div');
  layer.className = 'ed-hl';
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  const body = doc.createElement('div');
  body.className = 'ed-text';
  const sizer = doc.createElement('div');
  sizer.className = 'ed-size';
  layer.append(body, sizer);
  ta.before(wrap);
  wrap.append(ta, layer);

  let dead = false, on = false, ime = false;
  let dirty = true, version = 0;
  let lines = [''], empty = true, od = false, hasBlock = false, hexSyntax = null;
  let pitch = 18;               // the line height (px): which lines are near the view (see sync)
  let padV = 0;                 // the box's padding, top and bottom (px)
  let blockK = 0, blockOpen = false; // a block comment is open at the start of line blockK (computed up to it)
  let drawn = null;             // {version, key, a, b}: the lines drawn
  let shown = null, shownCount = 0, shownOd = false, shownBlock = false; // the drawn lines' texts and elements; the text then
  let diags = new Map();        // line (1-based) -> {text, items}: the line's messages while it has this text
  let diagVersion = 0, diagKey = '';
  let frame = 0;
  let size = '';

  const fail = () => {
    dead = true;
    cancelAnimationFrame(frame);
    wrap.classList.remove('ed-on');
    on = false;
    try { body.replaceChildren(); } catch { /* gone */ }
  };
  const guard = (fn) => (...a) => { if (dead) return undefined; try { return fn(...a); } catch { fail(); return undefined; } };

  function setOn(v) {
    if (v === on) return;
    on = v;
    wrap.classList.toggle('ed-on', v);
    if (!v) { body.replaceChildren(); drawn = null; shown = null; }
  }

  // the box's metrics onto the layer, and the clip that leaves its scroll bars out
  function restyle() {
    const cs = getComputedStyle(ta);
    for (const p of METRICS) layer.style.setProperty(p, cs.getPropertyValue(p));
    const lh = parseFloat(cs.lineHeight);
    pitch = lh > 0 ? lh : 1.2 * (parseFloat(cs.fontSize) || 13);
    padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    clip(cs);
  }
  function clip(cs = getComputedStyle(ta)) {
    const bt = parseFloat(cs.borderTopWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0, bl = parseFloat(cs.borderLeftWidth) || 0;
    const sw = Math.max(0, ta.offsetWidth - ta.clientWidth - bl - br), sh = Math.max(0, ta.offsetHeight - ta.clientHeight - bt - bb);
    const key = `${bt} ${br + sw} ${bb + sh} ${bl}`;
    if (key !== size) { size = key; layer.style.clipPath = `inset(${bt}px ${br + sw}px ${bb + sh}px ${bl}px)`; }
  }

  function read() {
    const text = ta.value;
    lines = text.split('\n');
    empty = text === '';
    od = text.length > 0 && /^[ \t]*[0-9a-fA-F]+:/m.test(text) && objdumpText(lines);
    hasBlock = text.includes('/*');
    hexSyntax = null;
    blockK = 0; blockOpen = false;
    version++;
    dirty = false;
  }

  const syntaxNow = () => {
    if (opts.mode() === 'asm') return opts.syntax() === 'att' ? 'att' : 'intel';
    hexSyntax ??= detectSyntax(lines.join('\n')) === 'att' ? 'att' : 'intel';
    return hexSyntax;
  };

  // a block comment is open at the start of line k (only lines with "/*" or "*/" are tokenized for it)
  function blockAt(k, syntax) {
    if (!hasBlock) return false;
    if (k < blockK) { blockK = 0; blockOpen = false; }
    for (; blockK < k; blockK++) {
      const l = lines[blockK];
      if (l.length > LONG_LINE) continue;
      if (blockOpen ? l.includes('*/') : l.includes('/*')) blockOpen = tokenizeLine(l, syntax, { objdump: od && objdumpLine(l), block: blockOpen }).open;
    }
    return blockOpen;
  }

  // a token: an element whose text is generated content (style.css: .ed-hl [data-t]::before)
  const piece = (text, cls) => {
    const s = doc.createElement('span');
    if (cls) s.className = cls;
    s.dataset.t = text;
    return s;
  };

  function lineNodes(k, syntax, block) {
    const l = lines[k];
    if (l.length > LONG_LINE) return { nodes: [piece(l, '')], open: block };
    const d = diags.get(k + 1);
    const mark = d && d.text === l ? d : null;
    const r = tokenizeLine(l, syntax, { objdump: od && objdumpLine(l), block, diagnostics: mark ? mark.items : [] });
    // the pieces: a token, with the white space after it and the tokens of its class next to it (fewer elements: a long
    // block's editors are part of the page's element budget); an error stands alone; the indentation is a piece
    const parts = [];
    for (const t of r.tokens) {
      const cls = t.kind === 'space' || t.kind === 'text' ? '' : className(t.kind);
      const last = parts.at(-1);
      if (last && last.cls !== 'tok-error' && cls !== 'tok-error' && (t.kind === 'space' ? !last.space : cls === last.cls && !last.trail)) {
        last.text += l.slice(t.start, t.end);
        if (t.kind === 'space') last.trail = true;
        continue;
      }
      parts.push({ text: l.slice(t.start, t.end), cls, space: t.kind === 'space', trail: false });
    }
    const nodes = parts.map((x) => piece(x.text, x.cls));
    if (mark?.cls) {
      // the line's words underlined (from its first word to its last piece; not its indentation)
      const a = parts[0]?.space ? 1 : 0;
      if (parts.length > a) {
        const m = doc.createElement('span');
        m.className = mark.cls;
        m.append(...nodes.slice(a));
        nodes.splice(a, nodes.length - a, m);
      }
    }
    return { nodes, open: r.open };
  }

  // a line: a block of its own (an edit lays out that line only), its tokens and a line break (one line: a block's
  // last line break makes no line of its own, and an empty line is the line break alone)
  function lineEl(k, syntax, block) {
    const div = doc.createElement('div');
    const r = lineNodes(k, syntax, block);
    div.append(...r.nodes, '\n');
    return { el: div, open: r.open };
  }

  function render(a, b, syntax) {
    const frag = doc.createDocumentFragment();
    // the lines above: as many line breaks (a line with characters of another font is not taller: tests-js/
    // web_asm_hl_browser.mjs, at a fixed line height)
    if (a > 0) {
      const pad = doc.createElement('div');
      pad.textContent = '\n'.repeat(a);
      frag.append(pad);
    }
    let block = blockAt(a, syntax);
    shown = [];
    for (let k = a; k <= b; k++) {
      const r = lineEl(k, syntax, block);
      block = r.open;
      shown.push({ text: lines[k], el: r.el });
      frag.append(r.el);
    }
    shownCount = lines.length;
    shownOd = od;
    shownBlock = hasBlock;
    body.replaceChildren(frag);
  }
  // the text changed in place (as many lines, the same view, no block comment): the changed lines only;
  // false: draw them all
  function update(a, b, syntax) {
    if (!shown || shown.length !== b - a + 1 || shownCount !== lines.length || shownOd !== od || hasBlock || shownBlock) return false;
    for (let k = a; k <= b; k++) {
      const s = shown[k - a];
      if (s.text === lines[k]) continue;
      const r = lineEl(k, syntax, false);
      s.el.replaceWith(r.el);
      shown[k - a] = { text: lines[k], el: r.el };
    }
    return true;
  }

  function sync() {
    frame = 0;
    if (dirty) read();
    const mode = opts.mode();
    const want = !ime && !empty && (mode === 'asm' || od);
    setOn(want);
    if (!want) return;
    const syntax = syntaxNow();
    const st = ta.scrollTop, sl = ta.scrollLeft, ch = ta.clientHeight, sh = ta.scrollHeight, sw = ta.scrollWidth;
    clip();
    // the line pitch as the box lays its lines out (18.84 px where the style says 18.85: a line in 3,000 at the end of a
    // long text), from its scroll height when it scrolls
    if (sh > ch + 1 && lines.length > 1) pitch = (sh - padV) / lines.length;
    const vf = Math.max(0, Math.floor(st / pitch) - 2), vl = Math.min(lines.length - 1, Math.ceil((st + ch) / pitch) + 2);
    const key = `${mode} ${syntax} ${diagVersion}`;
    const inView = drawn && drawn.key === key && vf >= drawn.a && vl <= drawn.b;
    if (!inView || (drawn.version !== version && !update(drawn.a, drawn.b, syntax))) {
      const a = Math.max(0, vf - MARGIN), b = Math.min(lines.length - 1, vl + MARGIN);
      render(a, b, syntax);
      drawn = { version, key, a, b };
    } else drawn.version = version;
    // the same scroll range as the box (the layer is as large as the box with its scroll bars)
    if (sizer.dataset.at !== `${sw} ${sh}`) {
      sizer.dataset.at = `${sw} ${sh}`;
      sizer.style.top = `${sh}px`;
      sizer.style.left = `${sw}px`;
    }
    if (layer.scrollTop !== st) layer.scrollTop = st;
    if (layer.scrollLeft !== sl) layer.scrollLeft = sl;
  }

  const schedule = guard(() => { if (!frame) frame = requestAnimationFrame(guard(sync)); });
  const changed = () => { dirty = true; schedule(); };

  // the box's text set by the page (no input event): its value setter and setRangeText of this box
  const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  if (proto?.get && proto.set) {
    Object.defineProperty(ta, 'value', {
      configurable: true, enumerable: true,
      get() { return proto.get.call(this); },
      set(v) { const same = proto.get.call(this) === String(v); proto.set.call(this, v); if (!same) changed(); },
    });
  }
  const setRange = ta.setRangeText;
  ta.setRangeText = function (...args) { const r = setRange.apply(this, /** @type {any} */ (args)); changed(); return r; };

  ta.addEventListener('input', changed);
  const follow = guard(sync);
  ta.addEventListener('scroll', () => { if (on) follow(); }); // (at once: the layer follows in the same frame)
  // an IME's composition: the box shows its own text meanwhile
  ta.addEventListener('compositionstart', guard(() => { ime = true; setOn(false); }));
  ta.addEventListener('compositionend', guard(() => { ime = false; changed(); }));
  if (typeof ResizeObserver === 'function') new ResizeObserver(guard(() => { restyle(); schedule(); })).observe(ta);
  guard(restyle)();
  doc.fonts?.ready?.then(guard(() => { restyle(); schedule(); }));
  schedule();

  return {
    refresh: guard(() => { drawn = null; hexSyntax = null; schedule(); }),
    // items: [{line, column, endColumn?, severity, message}] (render.js messageList's)
    setDiagnostics: guard((items) => {
      const key = JSON.stringify(items ?? []);
      if (key === diagKey) return;
      diagKey = key;
      if (dirty) read();
      const next = new Map();
      for (const d of items ?? []) {
        const n = Number(d?.line);
        if (!(n >= 1 && n <= lines.length) || !(d.severity in MARKS)) continue;
        const e = next.get(n) ?? next.set(n, { text: lines[n - 1], items: [], cls: '' }).get(n);
        e.items.push(d);
        if (e.cls !== MARKS.error) e.cls = MARKS[d.severity];
      }
      diags = next;
      diagVersion++;
      schedule();
    }),
    active: () => on && !dead,
  };
}

// the kinds that get a colour of their own in an instruction's text in a table or a list: the mnemonic and a branch's
// target (one or two elements per row: the windowed tables' rows are part of the page's element budget); the rest is
// the text's own colour
const OWN = new Set(['mnemonic', 'prefix', 'symbol', 'label']);
export function colorInstr(el, text) {
  const s = String(text ?? '');
  const tokens = s.length > LONG_LINE ? [] : tokenize(s, 'intel', { objdump: false });
  if (!tokens.length) { el.textContent = s; return el; }
  const doc = el.ownerDocument;
  const out = [];
  let plain = '';
  for (const t of tokens) {
    const part = s.slice(t.start, t.end);
    if (!OWN.has(t.kind)) { plain += part; continue; }
    if (plain) { out.push(plain); plain = ''; }
    const span = doc.createElement('span');
    span.className = className(t.kind);
    span.textContent = part;
    out.push(span);
  }
  if (plain) out.push(plain);
  el.replaceChildren(...out);
  return el;
}
