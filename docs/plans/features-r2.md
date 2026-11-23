# Features, round 2: simulator details, instruction cards, drill-downs, source lines, API

Continues [features-r1.md](features-r1.md) (the ranked list and the research behind it). Branch `features-r2`, built on
`48fbd47`. Status as there: **r2** = built in this round; **next** = not started.

## Built in this round (branch `features-r2`)

| # | What | Where on the page | Module | Idea (r1) |
|---|---|---|---|---|
| 1 | **Simulator details on request**: `"details": true` adds per row the instruction's allowed ports (`portData`, per uop `uopList`), latency per (input, output) pair, uop counts, length, offset, boundaries crossed, LCP, microcode, fusion; the port set behind the `Ports` limit with each row's uops on it; the issue slots of the steady state per cause from an issue log of the simulation (front end / ROB full / RS full / other), per cycle and summed. The rest of the response is byte-identical (tested on 9,899 fixture cases); without the flag nothing is computed or recorded | — | crates/wuica-core/src/details.rs, sim/issue.rs | 8, 13, 14 |
| 2 | **Instruction card**: a click (or Enter, or focus) on a row of the uop table shows a card under the table: `1*p0156+1*p23`, throughput from its ports, uops (unfused · fused · MITE · MS, loads, stores), latency per operand pair, its edges on the critical chain, its share of the bottleneck, uops.info link, front end (`3 B @0`, `✂16/32/64`, `LCP`, `µcode`, `complex`, fusion). The details come from one more analysis, the first time a card is shown; sticky at the bottom for long tables; Esc closes | uop table | web/js/icard.js, details.js | 13 |
| 2 | **Front-end badges** in the Notes column (CSS, the cell text stays the note): `µ` microcoded (MS uops), `64` crosses a 64-byte line at the alignment offset. From the response only, no analysis | uop table | web/js/icard.js | 7 (part) |
| 3 | **Ports drill-down**: with "Ports" selected, the bound view names the port set (`set p23 2 uops / 2 = 1.00`), shades and lists the instructions by their uops on it, and marks the set's columns in the table | `bound` | web/js/portset.js | 14 |
| 3 | **Issue slots** (VTune's top-down level 1 from the simulation itself): one stacked bar, issued / front end / ROB / RS / other | `bound` | web/js/slots.js | 8 |
| 3 | **Issue strip in the trace**: per cycle of the steady state the uops issued and the cause of lost slots, with the share of slots used; hover for the cycle | `trace` | web/js/trace-issue.js | 8 |
| 4 | **Cost per source line** after a Compiler Explorer import: the source lines of the imported instructions (CE's `asm[].source.line`, main file only) with the share of the bottleneck their instructions have; a line jumps to its costliest row. Shown only while the analyzed bytes are the imported ones | `source` (opt-in, `src=1`) | web/js/srcmap.js | 11 |
| 5 | **REST insights**: `insights` in `POST /api/analyze/<arch>` (as in the MCP summary) | — | server/lib/app.js | 5 |
| 5 | **MCP `what_if`** (package and remote server): unroll ×2/×4/×8 per original iteration, simple front end, macro-/micro-fusion switched, no-chain estimate; `tp`, `delta`, `speedup` per variant; the remote server charges it like a compare | — | packages/wuica/lib/whatif.js | 5 |
| 5 | **MCP `analyze` with `details: true`** (library option `details`, CLIs `-details`): per instruction `allowedPorts`, `latencies`, `frontEnd`; `insights.portSet`, `insights.issueSlots` | — | packages/wuica/lib/details.js | 13, 14 |
| 6 | **Accuracy**: the word "accuracy" next to "limitations" (docs/ACCURACY.md on GitHub); the prototypes' share within 10 % (random loops · real code) in their tooltips | header, CPU boxes | web/js/archs.js | — |

Agreement tests: packages/wuica/lib/whatif.js against web/js/whatif.js (tests-js/web_whatif.mjs), lib/details.js against
the page's (tests-js/web_details.mjs), the accuracy numbers against the tables of docs/ACCURACY.md, the trace's issue log
against the fused uops the trace issues.

### Speed

Native (`crates/wuica/examples/phases.rs`, `total`, minimum of several runs on a quiet Mac; the four basic examples / the
SHA-256 showcase, 2,949 instructions): main 194 µs / 18.5 ms, this branch without details 195 µs / 18.4 ms (the same within
noise), with `DETAILS=1` 210 µs (+8 %) / 23.5 ms (+27 %; on a busy machine the measurements ranged up to +60 %). WebAssembly (`tests-js/analyze_fixtures.mjs 5`, 3,211 fixture cases, min of 4 runs): main 0.37 ms per
case, this branch 0.37 ms, with `WUICA_DETAILS=1` 0.41 ms. The page asks for details only when a card is shown, the bound view
is open (300 ms after a result), or a trace is loaded; SHA-256 with the bound view and a card: no long task (the browser
suite measures it).

## Data the simulator does not give yet

- Every dependency edge with its operand and static latency (not only the critical path), store→load edges: a dependency graph
  with latencies and per-instruction slack (r1 idea 12).
- Per-instruction issue attribution (which instruction's uops a lost slot waited for) and LSD residency.
- The issue log outside the steady-state window (the page shows the window only).

## Next ideas

1. Dependency arcs labelled with the observed latency (producer dispatch → consumer ready, from the trace) and the static one
   (details), slack per instruction.
2. Range selection in the trace that drives the bound view and the slots (steady state vs warm-up).
3. Region markers (LLVM-MCA-BEGIN/END) and loop detection in pasted compiler output; source lines for pasted `-g` assembly
   (`.loc` directives).
4. Keyboard: `?` for the shortcuts, `n`/`p` to the next/previous hot row of the selected resource.
5. LCP and other details-based badges in the Notes column once the details are there anyway (bound view or card open).
6. The issue strip and the slots in the A–B view (both sides), and per CPU in the compare table.
