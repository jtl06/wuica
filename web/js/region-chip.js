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
// pick(value): 'whole', 'body' or a loop's index.
export function createLoopChip(after, pick) {
  let sel = null, last = null;
  function paint(info) {
    if (!info) { if (sel) sel.hidden = true; return; }
    if (!sel?.isConnected) {
      sel = h('select', { class: 'plain region-chip loop-chip', id: 'loop-chip', 'aria-label': 'analyzed code' });
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
