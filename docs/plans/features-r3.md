# Features, round 3: first result without a click, latencies and slack, trace ranges, regions, keys

Continues [features-r1.md](features-r1.md) (the ranked list and the research) and [features-r2.md](features-r2.md) (simulator
details, instruction cards, slots). Branch `features-r3`, built on `12c0c3a`. Status: **r3** = built in this round; **next** = not
started.

## Built in this round

| # | What | Where on the page | Module | Idea |
|---|---|---|---|---|
| 1 | **First result without a click**: a fresh visit (no state in the link, nothing typed) analyzes the default example once the analyzer is ready, after the next frame (the analysis runs in the worker). The address keeps no fragment while nothing changes. A link with state, a typed edit, live mode and Analyze work as before | result | app.js (`autoFirst`) | — |
| 2 | **Dependency arcs with latency and slack**: the latency on each arc of the critical chain (the simulator's, `criticalPath`), and on the selected instruction's arcs; the others are estimates from the details (the producer's output that the consumer reads; eliminable moves 0), marked `≈` in the tooltips. The chain's instructions are marked. A slack column: the cycles an instruction could be delayed in every iteration without lengthening the loop-carried chain (0 on the chain, `∞` off every loop-carried cycle); the legend shows `chain N`. The graph's latencies are checked to fit the chain; large graphs get their slack in slices | `deps` | deps.js, deps-slack.js | r1 12, r2 next 1 |
| 3 | **Trace range → bound view** (VTune's time-range filter): a drag over the trace's head (cycle axis, port and issue strips), or `[` / `]` on the focused timeline, selects cycles; the bound view then shows that range: busy share per port, issue slots used and lost by cause, `c 88–206 ×`; the gutter percentages of the trace follow. Esc, ×, a click on the head, closing the trace or a new run clear it | `trace`, `bound` | trace-range.js, trace-range-view.js | r2 next 2 |
| 4 | **Marked regions and `.loc` lines in pasted assembly**: `# LLVM-MCA-BEGIN [name]` / `# LLVM-MCA-END`, `# wuica-begin` / `# wuica-end` (also with `//` or `;`), and IACA/OSACA byte markers (`mov ebx, 111` + `.byte 0x64,0x67,0x90` … `222`): the first region is analyzed; the whole text is still assembled, so layout and jumps out of the region are as in the listing. A chip `▣ name 1/2` under the input (its tooltip lists the markers, a click selects the BEGIN line). `.file` / `.loc` lines of `gcc -g -S` / `clang -g -S` output (DWARF 5 forms, gcc's `view` operand) feed the cost per source line (`file:line` rows) | input, `source` | asm-regions.js, region-chip.js, srcmap.js | r1 16, r2 next 3 |
| 5 | **Keyboard shortcuts**: Ctrl/⌘ Enter analyze, `/` code, `j` `k` row ↓ ↑ (as a click: the card and the trace follow), `n` `p` hot rows of the bound view's resource (else the chain), `1`–`5` bound / try / bytes / deps / trace, `a` A–B, Esc, `?` the overlay (a modal dialog; a `?` button at the end of the footer). Nothing fires while typing in a field | page, footer | keys.js | r1 17, r2 next 4 |
| 6 | **Slots in A–B and per CPU**: A–B has a `slots` fold (closed by default) under the bottleneck row with both sides' bars and `issued A% → B%`; the CPU table gets a `slots` column (one bar per CPU, shares in the tooltip) while the bound view is open. The A–B traces already had both issue strips (tested now) | A–B result, CPU table | ab-slots.js, cmp-slots.js | r2 next 6 |

Shared files touched (all additive hooks): app.js (imports; `autoFirst`; the region hooks around the assembler and
`getSource`; `createKeys`; the A–B and CPU-table slots), ab.js (one `drawn` hook), compare-view.js (one `decorateCpus` hook),
trace.js (the range: an import, attach/destroy, pointer and key hooks, the gutter numbers), bound.js (the range block),
srcmap.js (per-instruction lines, `file:line` rows), index.html (four stylesheets, the `?` button), bound.css, deps.css; tests
web_browser, web_layout_browser, web_browser_ab, web_views_browser (the fresh visit is analyzed, the A–B slots row, the arcs'
latencies and slack).

### Speed

- First result of a fresh visit (headless Chrome, 1440×900, six runs each, medians; "before" clicks Analyze the moment it is
  enabled, which a person does not): cold before 165 ms (first paint 76 ms), after 163 ms (first paint 64 ms); with the service
  worker before 84 ms (36), after 65 ms (28). No long task (≥ 50 ms) in either.
- Deps on SHA-256 (2,949 instructions): the drawing task is as long as on main (96–98 ms vs 92–95 ms); the slack
  (about 330 ms in all) runs in slices of 12 ms; arc tooltips of large graphs are made on hover.
- CPU table with SHA-256 on all CPUs and the bound view open: the slots column filled after 0.9 s (table without it 0.7 s),
  no long task; stale requests are dropped.

## Limits of what was built

- Arc latencies off the chain are estimates (the details give one latency per output, not per operand pair along a path):
  on the chain's edges of the examples they equal the simulator's on 41 of 48 (1,384 of 1,392 with SHA-256; the others
  are memory edges, pointer chasing and the stack sync uop). Slack inherits that.
- A range's port shares count dispatches in its cycles; the steady-state numbers count the uops of the iterations, so the two
  differ when dispatch runs ahead of retirement.
- Regions: the first one only (no picker), no markers in hex/objdump input, no chip for side B.
- Dragging the trace's head now selects instead of panning (dragging the rows still pans).
- A fresh visit now also starts the background caching of the other tables after its first result, as a click did before.

## Next ideas

1. Exact latencies per operand pair along the graph (the simulator's edge list with operands, as for the chain), so that
   slack and the arc numbers are not estimates; then the slack column in the uop table and a "what if this were 1 cycle
   faster" experiment.
2. Range in the URL, touch selection, and the range shading the uop table (per instruction: its uops dispatched in the range).
3. A region picker (several marked regions), markers in objdump input, loop detection in pasted compiler output without markers.
4. Source text for `.loc` lines when the source is pasted next to the assembly (a second box, or `.file` with md5 lookups).
5. The issue strip per CPU (a mini strip in the CPU table) and the slots in the alignment sweep (front-end-bound offsets).
6. Keyboard: `t`/`[`/`]` for the trace range from anywhere, `c` for the card, and a shortcut hint in tooltips (`aria-keyshortcuts`).
