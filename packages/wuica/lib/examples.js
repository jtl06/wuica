// The built-in examples: the web page's set (web/js/examples.js, copied to lib/web with the other shared files, so the
// page and the package cannot drift): the basics, the classic loops and the SHA-256 showcase (machine code only: its
// assembly, about 60 KB, stays on the page). Not the mock engine's entries.

import { EXAMPLES, CLASSIC_EXAMPLES, SHOWCASE_EXAMPLES } from './web/examples.js';

const GROUPS = [['basics', EXAMPLES], ['classic', CLASSIC_EXAMPLES], ['showcase', SHOWCASE_EXAMPLES]];

// [{name, title, group, arch, instructions, hex, intel?, att?}]: arch is the CPU the page shows it on first; intel and
// att the assembly (absent for the showcase, which is machine code only).
const LIST = Object.freeze(GROUPS.flatMap(([group, list]) => list.map((e) => {
  const asm = typeof e.text.intel === 'string';
  // the instructions: the lines of the listing (32-byte lines for the showcase: its title says how many)
  const instructions = asm ? e.text.hex.trim().split('\n').length : Number(/([\d,]+) instr/.exec(e.title)?.[1].replace(/,/g, '') ?? 0);
  return Object.freeze({ name: e.id, title: e.title, group, arch: e.arch, instructions, hex: e.hex, ...(asm ? { intel: e.text.intel, att: e.text.att } : {}) });
})));

export function examples() {
  return LIST;
}

// The example called `name` (case-insensitive), or null.
export function findExample(name) {
  const n = String(name ?? '').toLowerCase();
  return LIST.find((e) => e.name.toLowerCase() === n) ?? null;
}
