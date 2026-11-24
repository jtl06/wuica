// The chip next to the input's messages while a marked region of the assembly is analyzed (asm-regions.js):
// "▣ name 1/3" (the name, if the marker has one; the count, if there are several regions). A click selects the
// region's first marker line in the editor; the tooltip lists the markers.

import { h } from './render.js';
import { MARKERS_TITLE } from './asm-regions.js';

// after: the element the chip follows (the messages); select(line): selects a line of the editor
export function createRegionChip(after, select) {
  let chip = null, line = 0;
  let last = null; // {region, text}: the last region shown and the text it was found in
  function paint(region) {
    if (!region) { if (chip) chip.hidden = true; return; }
    if (!chip?.isConnected) {
      chip = h('button', { type: 'button', class: 'plain region-chip', id: 'region-chip' });
      chip.addEventListener('click', () => { if (line) select(line); });
      after.after(chip);
    }
    line = region.line;
    const n = region.count > 1 ? ` ${region.index + 1}/${region.count}` : '';
    chip.textContent = `▣ ${region.name || 'region'}${n}`;
    chip.title = `analyzed: the marked region at line ${region.line}${region.count > 1 ? ` (the first of ${region.count})` : ''}; click selects it\n${MARKERS_TITLE}`;
    chip.hidden = false;
  }
  return {
    // region: {name, line, index, count} | null; text: the assembly it is in
    show(region, text = null) { last = region ? { region, text } : null; paint(region); },
    // the editor's text now (null: not assembly): the chip stays (or comes back) only for the text it was shown for
    sync(text) { paint(last && text !== null && text === last.text ? last.region : null); },
  };
}

// The loop chip (loop-find.js, through asm-regions.js): when pasted assembly has code around its loop (a whole function,
// objdump output), a small select of what is analyzed: each loop ("loop .L3"), the function's body, or the whole text.
// pick(value): 'whole', 'body' or a loop's index. after: the element it follows in its side's row of controls;
// places: () => [elements], where it follows instead, the first whose row has room (the row would not wrap, so the
// editor keeps its height); the last one is taken in any case.
export function createLoopChip(after, pick, id = 'loop-chip', places = null) {
  let sel = null, last = null;
  function place() {
    if (!places || !sel || sel.hidden || document.activeElement === sel) return; // (moving it would take the focus away)
    const list = [after, ...places()];
    for (let k = 0; k < list.length; k++) {
      const at = list[k], row = at.parentElement;
      if (sel.previousElementSibling !== at) at.after(sel);
      if (k === list.length - 1) return;
      sel.hidden = true;
      const h0 = row.getBoundingClientRect().height;
      sel.hidden = false;
      if (row.getBoundingClientRect().height < h0 + sel.offsetHeight / 2) return; // (taller than the row is not a wrap)
    }
  }
  // again when the row changes (its width, or what is in it: the syntax menu comes and goes); place() ends where it
  // started or in the place it settles on, so this does not loop
  if (places && typeof ResizeObserver === 'function') { let t = 0; new ResizeObserver(() => { cancelAnimationFrame(t); t = requestAnimationFrame(place); }).observe(after.parentElement); }
  function paint(info) {
    if (!info) { if (sel) sel.hidden = true; return; }
    if (!sel?.isConnected) {
      sel = h('select', { class: 'plain region-chip loop-chip', id, 'aria-label': 'analyzed code' });
      sel.addEventListener('change', () => pick(sel.value === 'whole' || sel.value === 'body' ? sel.value : Number(sel.value)));
      after.after(sel);
    }
    const { loop, loops, body } = info;
    const opts = loops.map((l, k) => h('option', { value: String(k), text: `loop ${l.label}` }));
    if (body) opts.push(h('option', { value: 'body', text: 'body' }));
    opts.push(h('option', { value: 'whole', text: 'whole' }));
    sel.replaceChildren(...opts);
    sel.value = loop ? (loop.index === null ? 'body' : String(loop.index)) : 'whole';
    const at = loop ? `lines ${loop.line}–${loop.endLine}${loop.address !== null && loop.address !== undefined ? ` at 0x${loop.address.toString(16)}` : ''}` : 'the whole text';
    sel.title = `analyzed: ${at}; branches out of it are taken as not taken`;
    sel.hidden = false;
    place();
  }
  return {
    // info: the assembly's {loop, loops, body, choosable} (null or nothing to choose: hidden); text: the assembly it is for
    show(info, text = null) {
      const has = !!info?.choosable;
      last = has ? { info, text } : null;
      paint(last?.info ?? null);
    },
    sync(text) { paint(last && text !== null && text === last.text ? last.info : null); },
  };
}
