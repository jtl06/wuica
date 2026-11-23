# Features, round 1: what the best tools do, and what wuica should take from them

Research of 2026-11-23 (tool documentation and papers; the sources are listed at the end). The ideas are ranked by
value for someone optimizing one hot loop, divided by effort. "Data" says what wuica already has for the idea: the
analysis response (docs/WASM-API.md: `tp`, `limits`, `bottlenecks`, the uop table with per-port averages, `criticalPath`)
and the trace (uiCA's `-json`: per-uop IQ/IDQ/issue/ready/dispatch/execute/retire cycles, port, `dependsOn`, the
configuration's widths).

Status: **done** = exists on main before this round; **r1** = built in this round (branch `features-r1`); **other** =
another branch works on it tonight; **next** = not started.

## What wuica already has (done)

| Feature | Comes from | Where |
|---|---|---|
| Prediction, limits per component, bottleneck | uiCA, Facile | result head, `limits` row |
| Uop table: uops per port and per front-end path, heat shading | uiCA, llvm-mca resource pressure, IACA port binding | `uops` |
| Critical loop-carried chain, marked on its rows | OSACA LCD, IACA CP, llvm-mca critical sequence | `chain` row (insight-view.js) |
| Cost column: Δ cycles/iteration without each instruction (or as NOP) | CQA "gain" estimates, Facile counterfactuals | `cost` toggle (insight-view.js) |
| Cycle-by-cycle trace: uop lanes, port strip, wait colours, table | llvm-mca timeline, Konata, uiCA trace | `trace` (trace.js) |
| Multi-CPU table, alignment sweep 0–63, A–B comparison | uiCA site, CE diff | compare-view.js, ab.js |
| objdump and uiCA text, URL state, offline, CE link import | CE, Firefox Profiler (state in the URL) | |

## Ranked ideas

| # | Idea | From | Why it helps | Data in wuica | Effort | Risk | Status |
|---|---|---|---|---|---|---|---|
| 1 | **Bound view**: every resource's utilization (front-end stages, issue, each port, divider, chain) as % of the predicted cycles, the binding one at 100 %; the next limit and the speedup if the bottleneck were fixed | VTune µPipe / TMA level 1–2, Advisor roofline ceilings, CQA cycles summary, Facile | answers "what limits me, and what comes after it" in one glance; the limits row shows values, not headroom, and has no per-port view | `limits`, `bottlenecks`, column totals, `tp`, `issueWidth` (uarch.json) | S | low (derived) | **r1** |
| 2 | **Blame**: per instruction, its share of the bound resource (busiest ports, issue slots, DSB/MITE/MS uops, chain latency), shaded in the table, with jump to the largest | VTune locator metrics, perf annotate `H`/TAB | tells which instructions to change without running N analyses (the cost column does, but slowly on large blocks) | uop table values, `criticalPath` edge latencies | S | low; port share uses the simulated assignment, not the allowed port set | **r1** |
| 3 | **What-if experiments**: one-click re-analyses of the whole block: unroll ×2/×4/×8 (per original iteration), ideal front end, no macro/micro-fusion, best alignment, other options; with Δ and speedup | Facile counterfactuals, CQA "if fully vectorized / if no dependencies", MAQAO UFS | the follow-up question after every result; wuica's speed makes it instant | the analyzer (new requests); `simpleFrontEnd`, fusion flags, alignment are options | M | low; unroll keeps the branch, copies the rest (dependencies kept, loop overhead removed) | **r1** |
| 4 | **Export**: copy the result as a Markdown table (issue/PR ready), CSV of the uop table, JSON of the response | CE "copy", llvm-mca `-json`, VTune report export | results go into reviews and issues; today only the text report can be copied | the response | S | low | **r1** |
| 5 | **API/MCP: derived analysis** (`bound`, `blame`, `unroll` what-if) in the HTTP API and the MCP `analyze` tool | — | agents get the same diagnosis as the page | the response | S–M | low; needs the module shared with packages/wuica | next |
| 6 | Code layout map: the block's bytes on 16 B (predecode) / 32 B (DSB) / 64 B lines, instruction boxes, JCC-erratum and line crossings marked, at the chosen alignment | Intel optimization manual, Agner's microarchitecture manual | explains front-end limits and alignment effects that numbers do not | opcode lengths, `alignmentOffset`, notes `J`, `DSBBlockSize`, `preDecodeBlockSize` | M | low | next |
| 7 | Front-end hazard badges: LCP prefixes, MS-microcoded instructions, 32 B DSB windows with too many uops, broken macro-fusion | Intel manual, Agner | names the cause of a front-end limit | bytes (LCP), MS column, notes | M | medium: must agree with uiCA's model, or it misleads | next |
| 8 | Exact top-down slot accounting from the trace (Retiring / FE-bound / BE-bound per issue slot, steady state) | VTune TMA, Apple CPU Bottlenecks, Arm top-down | VTune-identical vocabulary, per cycle | trace has issue cycles, IDQ in/out; **missing**: why issue stalled in a cycle (IDQ empty vs ROB/RS full vs uiCA's loop-boundary issue rule), and IDQ residency of LSD-issued uops; the simulator would have to emit a per-cycle issue-stall cause | M (with sim data) | high without the sim data (misattribution) | next (needs sim) |
| 9 | Wait-time table per instruction (in queue / ready-not-dispatched / executed-not-retired) | llvm-mca average wait times | separates port contention from latency | trace | S | low | other (trace wait breakdown) |
| 10 | Trace ↔ table linking, A–B trace alignment | Superluminal range filter, Konata overlay | | trace | | | other |
| 11 | Source-line mapping and per-source-line cost for Compiler Explorer imports | CE colour linking, VTune source view | C++ users think in source lines | CE API `asm[].source.line` | M | medium: depends on the asm import work | next (after asm-import lands) |
| 12 | Interactive dependency graph (SVG) of one iteration, chain highlighted, click → table/trace | OSACA `--export-graph`, uiCA `-depGraph` | shows parallelism and every chain, not only the critical one | trace `dependsOn` gives uop edges; **missing**: the static latency of each edge (only critical-path edges have it) and edges through flags/memory by name | M–L | medium | next (needs sim for latencies) |
| 13 | Instruction cards on hover: latency per operand, allowed ports (`1*p23+1*p015`), MITE/MS uops, fusion | uops.info, CE asm docs | saves the trip to uops.info | **missing**: allowed ports and latencies per instruction are in the tables but not in the response; would need a `wuica_instr_info` export or fields per row | S (with sim data) | low | next (needs sim) |
| 14 | Exact port-set bottleneck: the port combination behind the `Ports` limit and the uops that can only go there | Facile port model | "p23 is full" instead of "Port 2 and 3 are busy" | **missing**: Facile's maximizing port set; the response has only the limit value | S (with sim data) | low | next (needs sim) |
| 15 | Memory-carried dependencies (store→load through the same address) | staticdeps / CesASMe (cut uiCA's error from 29.6 % to 19.2 %) | accuracy on real code | needs simulator changes | L | high | not tonight |
| 16 | Region markers (LLVM-MCA-BEGIN/END, IACA, OSACA), auto-detect the loop in compiler output | llvm-mca, IACA, OSACA | paste a whole function | assembler output + labels | M | medium | next |
| 17 | Keyboard: jump to worst row, next/previous hot row, `?` shortcut list | perf annotate, Perfetto | large blocks | the DOM | S | low | partly r1 (blame: worst) |
| 18 | Short links (server-stored state) | CE `/z/`, Firefox Profiler uploads | long fragments of large blocks | needs storage on api.wuica | M | low | next |

Not applicable (wuica does not model them): cache misses and memory roofs, bad speculation and branch mispredictions,
false sharing (perf c2c), sampling confidence, call trees and flame graphs.

## Built in this round (see the commits on `features-r1`)

The page stays as lean as before: every new view is opt-in and computed only when opened.

1. **bound** (web/js/bound.js, web/css/bound.css): a details row under the limits; ideas 1 and 2.
2. **what if** (web/js/whatif.js): a details row; idea 3.
3. **export** (web/js/export.js): next to the text views; idea 4.

## Sources

- VTune TMA and µPipe: intel.com/content/www/us/en/docs/vtune-profiler/cookbook/2025-0/top-down-microarchitecture-analysis-method.html,
  …/user-guide/current/microarchitecture-pipe.html
- Advisor roofline: intel.com/content/www/us/en/docs/advisor/user-guide/2025-0/examine-bottlenecks-on-cpu-roofline-chart.html
- perf annotate: man7.org/linux/man-pages/man1/perf-annotate.1.html
- Apple CPU bottlenecks: developer.apple.com/documentation/xcode/addressing-cpu-bottlenecks
- Arm top-down: learn.arm.com/learning-paths/cross-platform/topdown-compare/1b-arm/
- Chrome DevTools, Perfetto, Konata: developer.chrome.com/docs/devtools/performance/reference, perfetto.dev/docs/visualization/perfetto-ui,
  github.com/shioyadan/Konata
- llvm-mca: llvm.org/docs/CommandGuide/llvm-mca.html
- uiCA: github.com/andreas-abel/uiCA, arxiv.org/abs/2107.14210; Facile: arxiv.org/abs/2310.13212
- OSACA: github.com/RRZE-HPC/OSACA; MAQAO CQA: maqao.liparad.uvsq.fr/documentation/MAQAO.Tutorial.CQA.pdf
- staticdeps / CesASMe: arxiv.org/html/2402.14567v1
- Compiler Explorer API: github.com/compiler-explorer/compiler-explorer/blob/main/docs/API.md
