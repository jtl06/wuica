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
