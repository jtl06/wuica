// The opt-in analysis views below the result (rows of the "more" section): each is computed only while it is open.
// app.js makes one createViews() and calls decorate() after each single-mode result is drawn (draw), and setOpen()
// with the page state (writeControls); onToggle(patch) gives the open flags back for the URL (url-state.js VIEWS).

import { createBound } from './bound.js';

export function createViews(env) {
  const bound = createBound({ onToggle: (open) => env.onToggle?.({ bound: open }) });
  const parts = [bound];
  return {
    decorate(root, view) { for (const p of parts) p.decorate(root, view); },
    setOpen(state) { bound.setOpen(state.bound); },
  };
}
