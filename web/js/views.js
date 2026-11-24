// The opt-in analysis views below the result (rows of the "more" section): each is computed only while it is open.
// app.js makes one createViews() and calls decorate() after each single-mode result is drawn (draw), and setOpen()
// with the page state (writeControls); onToggle(patch) gives the open flags back for the URL (url-state.js VIEWS).
// The instruction card (icard.js) and the port-set drill-down of the bound view share the details of the result
// (details.js), fetched once per result when one of them needs them.
// env: { engine(), pool(), onToggle(patch), setAlign(offset), getSel(), getSource() (the last Compiler Explorer import:
// srcmap.js), mca: the llvm-mca view's env (mca.js), assemble(text) (Intel; the accumulator variants of whatif.js),
// cpus() (the checked CPUs) }

import { createBound } from './bound.js';
import { createWhatIf } from './whatif.js';
import { createCodeMap } from './codemap.js';
import { createExport } from './export.js';
import { createDeps } from './deps.js';
import { createDetails } from './details.js';
import { createICard } from './icard.js';
import { createSrcMap } from './srcmap.js';
import { createMca } from './mca.js';

export function createViews(env) {
  const details = createDetails({ engine: env.engine });
  const bound = createBound({ details, work: env.work, onToggle: (open) => env.onToggle?.({ bound: open }) });
  const whatif = createWhatIf({ engine: env.engine, pool: env.pool, assemble: env.assemble, cpus: env.cpus, onToggle: (open) => env.onToggle?.({ whatif: open }) });
  const codemap = createCodeMap({ setAlign: env.setAlign, onToggle: (open) => env.onToggle?.({ codemap: open }) });
  const deps = createDeps({ engine: env.engine, onToggle: (open) => env.onToggle?.({ deps: open }) });
  const icard = createICard({ details, getSel: () => env.getSel?.() ?? -1 });
  const srcmap = createSrcMap({ getSource: () => env.getSource?.() ?? null, onToggle: (open) => env.onToggle?.({ srcmap: open }) });
  const mca = createMca({ ...(env.mca ?? {}), onToggle: (open) => env.onToggle?.({ mca: open }) });
  const parts = [bound, srcmap, whatif, codemap, deps, mca, createExport({ work: env.work }), icard];
  let last = null; // [root, view] of the last decoration
  return {
    decorate(root, view) { last = [root, view]; for (const p of parts) p.decorate(root, view); },
    // the source of an import arrived after the result was drawn
    refreshSource() { if (last) srcmap.decorate(...last); },
    // the checked CPUs changed (the try tab's best N per CPU)
    refreshCpus() { if (last) whatif.decorate(...last); },
    setOpen(state) { bound.setOpen(state.bound); whatif.setOpen(state.whatif); codemap.setOpen(state.codemap); deps.setOpen(state.deps); srcmap.setOpen(state.srcmap); mca.setOpen(state.mca); },
  };
}
