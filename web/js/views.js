// The opt-in analysis views below the result (rows of the "more" section): each is computed only while it is open.
// app.js makes one createViews() and calls decorate() after each single-mode result is drawn (draw), and setOpen()
// with the page state (writeControls); onToggle(patch) gives the open flags back for the URL (url-state.js VIEWS).
// env: { engine(), pool(), onToggle(patch), setAlign(offset) }

import { createBound } from './bound.js';
import { createWhatIf } from './whatif.js';
import { createCodeMap } from './codemap.js';
import { createExport } from './export.js';
import { createDeps } from './deps.js';

export function createViews(env) {
  const bound = createBound({ onToggle: (open) => env.onToggle?.({ bound: open }) });
  const whatif = createWhatIf({ engine: env.engine, pool: env.pool, onToggle: (open) => env.onToggle?.({ whatif: open }) });
  const codemap = createCodeMap({ setAlign: env.setAlign, onToggle: (open) => env.onToggle?.({ codemap: open }) });
  const deps = createDeps({ engine: env.engine, onToggle: (open) => env.onToggle?.({ deps: open }) });
  const parts = [bound, whatif, codemap, deps, createExport()];
  return {
    decorate(root, view) { for (const p of parts) p.decorate(root, view); },
    setOpen(state) { bound.setOpen(state.bound); whatif.setOpen(state.whatif); codemap.setOpen(state.codemap); deps.setOpen(state.deps); },
  };
}
