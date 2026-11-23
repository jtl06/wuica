# QA round 2 (branch qa-r2)

What was tested of the features of rounds 1 and 2 (features-r1.md, features-r2.md) and of the API work that landed with
them, how, and the result. Base: origin/main 12c0c3a. Fixes are separate commits on this branch, each with a test that fails
before it. Legend as in [qa-r1.md](qa-r1.md): **ok**, **fixed** (commit), **open** (see "Open findings"), **note**.

## Suites added or extended (picked up by `scripts/check.sh full`)

| Suite | What |
|---|---|
| `wuica:details_fuzz` (crates/wuica/tests/details_fuzz.rs, new) | `"details": true` against the rest of the response: 3,000 random blocks of the fuzzer (all 15 CPUs, random options, 3 % with a trace; `WUICA_DETAILS_FUZZ_SEED`, `_BLOCKS`) and 10 odd inputs × 15 CPUs (empty, undecodable, one instruction, `minIterations` 0 and 1 with `minCycles` 0, `jmp $`, a divide, pointer chasing with a trace, 9,000 bytes, the SHA-256 showcase). Invariants: the response without `details` is byte-identical; one detail row per row, `null` exactly for merge/sync rows; offsets are the alignment offset plus the lengths before; the port set is the one an independent computation from the rows' `portData` finds (Facile's unions of two sets), `uops / ports = tp` = the `Ports` limit, its per-row uops sum to its uops and equal each row's `portData` uops inside the set; a row's uops in the uop table run only on the allowed ports of its `uopList` (with the macro-fused branch's), `Exec.` = its uops (fewer only for eliminated moves), `Div` = its uops' `divCycles`; the issue slots add up to width × cycles, the per-cycle lists agree with the slots and with `"."`, the issued uops per iteration are the table's `Issued`, and the window's cycles per iteration are the throughput (at most 1 % of blocks without a trace may miss, see D1); plus the pointer-chasing test of D1 |
| `interfaces` (tests-js/interfaces.mjs, extended) | every 5th random case also with `details: true` through the library, the module (web/js/engine.js), the native CLI and the npm CLI (`-details`), REST (with `insights` against the library's `insights()` + `detailInsights()`) and both MCP servers (`details: true`, against `summarize()`); `compare` with arch lists and all CPUs through the library with 1 and 4 threads, the npm CLI (`-arch A,B`, `-threads 1`, `-threads 3`, `WUICA_THREADS=2`), REST with the split compare and with `WUICA_SPLIT_COMPARE=0` (a second server), and both MCP servers, every row equal to the single analysis; `what_if` through the library and both MCP servers |
| `web_qa2_browser` (tests-js/web_qa2_browser.mjs, new; 55 checks; passes with three copies at once) | the trace's issue strip against the module's log of the trace's cycles (pointer chasing on ADL-P, chain on SKL); the URL state with each view open (bound, try, bytes, deps, trace, a selected row and its card) and all at once on SKL, ADL-P, ZEN3, ICX: after a reload and in a new tab (the copied link) the same result, views, selection, card and texts; an old link (`cmpcpu=1`) with two views; the bound view's slots against the module in Node; A–B mode with every view open, and back; keyboard only (Enter/Space on each view's summary, ArrowDown + Enter on the uop table for the card, Escape); both themes × 9 widths 320–2560 with every view and a card open; SHA-256 with every view, the trace and a card: no long task ≥ 100 ms; the links (only the site, GitHub repositories of the project and of uiCA, uops.info; the accuracy page) and the page text (no personal website, nothing about a permission); a Compiler Explorer import from the recorded responses: cost per source line, `src=1` in the link, asm → hex → asm keeps text and lines, the link reopened in a new tab |

## Counts

- Details invariants (native): 220,000 random blocks (seed 7: 20,000; seeds 8–11: 50,000 each), 0 failures, before and
  after the fix of D1 (after it: 0.7 % of blocks without a trace not steady with seed 7, 0.7 % with seed 8; no details
  analysis took more than 0.5 s and 4 times the plain one); 150 odd
  inputs (105 with a result, the rest the same error with and without details). Before the fix of D1, 27 % of the blocks
  (5,419 of 20,000 with seed 7; 53,593 of 200,000 with seeds 8–11) had a window whose cycles per iteration missed the
  throughput by more than two cycles over the window, 14 % by more than 10 %; after it 0.7 % without a trace (142 of 20,000,
  seed 7, by the 3 % criterion).
- The page's examples (14) × 15 CPUs with details: 63 of 210 off by more than 10 % before D1's fix, 0 after.
- Interfaces: 600 cases (seed 20261124), on the final tree: 5,194 checks, 0 differences, of them 122 with details through 7
  interfaces, 27 compares through 9 paths, 23 what-ifs through 3. `check.sh full` runs 150 cases (seed 1): 2,649 checks.
- SHA-256 compare (2,949 instructions, all 15 CPUs): library with 1 and 6 threads, a second compare on warm threads,
  REST split (3 workers) and unsplit: identical; 483 / 221 / 239 / 369 ms.
- Page: 55 checks in `web_qa2_browser`, 0 failed; the existing browser suites pass unchanged.
- `scripts/check.sh full --chrome-jobs 2` on the final tree: 61 suites passed (the 59 of main, plus `wuica:details_fuzz`
  and `web_qa2_browser`), 2 min 23 s.

## Inventory

| Feature | How tested | Result |
|---|---|---|
| `details: true` (wasm, native, npm library/CLI `-details`, REST `options.details`, MCP `details: true`) | details_fuzz; interfaces | ok; **fixed** D1 (f088a19); note D2, D3 |
| issue log (top-down slots) | details_fuzz (per-cycle lists, slots sum, table's `Issued`, window vs throughput) | **fixed** D1 |
| port set behind `Ports` | details_fuzz: recomputed from `portData` on 220,000 blocks | ok |
| per-uop ports vs uop table | details_fuzz | ok; note D3 (`portData` vs `uopList`) |
| instruction card, Notes badges | web_qa2_browser (keyboard, URL `sel`, reload, merge/sync and `X` rows by hand: no card for merge uops, a card from the response for `X`) | ok |
| bound view: port set, slots bar | web_qa2_browser (slots vs Node; ptrchase on ADL-P: 100 % issued before D1's fix) | ok after D1 |
| trace issue strip | details_fuzz (with a trace, the log is within the trace's cycles); web_qa2_browser (the page's strip is the module's log); web_details (the log against the fused uops the trace issues) | ok; by design it can disagree with the bound view's slots (D1) |
| cost per source line (`src=1`) | web_qa2_browser with the recorded Compiler Explorer responses | ok; N5 (no change needed) |
| asm ↔ hex of an import | web_qa2_browser | ok |
| REST `insights` | interfaces (122 cases with details) | ok |
| MCP `what_if` (package, remote) | interfaces; by hand: SHA-256, empty and repeated variants, bad arch, undecodable | ok; **fixed** N2 (0dfa684) |
| accuracy link and tooltips | web_qa2_browser (href), by hand (ZEN3 83 % / 89 %, ICX 87 % / 88 %, ADL-P 92 % / 92 % = docs/ACCURACY.md round 7, rounded) | ok |
| `-arch SKL,ICL`, `all`, `-threads`, `WUICA_THREADS`, parallel compare, `WUICA_SPLIT_COMPARE` | interfaces; by hand: lower case, spaces, duplicates, empty items, unknown, `all,SKL`, `-threads 0/-1/abc/1.5/99999/''`, `WUICA_THREADS=0/-1/abc/''` | ok; **fixed** N3 (fea4047) |
| warm-up (library threads, server) | SHA-256 compare above (a block ≥ 2 KB of hex warms idle threads) | ok |
| assembler worker, 512 MB worker recycle | existing suites (web_assembler_rpc, web_pool*, web_robust_browser) | ok |
| 1 MiB hex limit, `.code16`/`.code32` | page by hand: 1,100,000 bytes → "Too much machine code: 1,100,000 bytes (at most 1,048,576)"; `.code16` → "line 1:1: .code16: only 64-bit code can be analyzed"; interfaces (`.code32` everywhere) | ok; note N1 |
| features-r1 views (bound, try, bytes, deps), copy md/csv/json | existing web_views_browser (43 checks) and web_export; web_qa2_browser (URL, A–B, widths, keyboard) | ok |
| service worker update path | existing web_browser (second deploy) and web_host_browser | ok |

## Findings

### Fixed

**D1. The issue slots were not of the steady state** (f088a19; test `issue_slots_are_of_the_steady_state` and the 1 % bound
in `details_agree_with_the_response_on_random_blocks`). The window of the issue log was the cycles that issued the relevant
rounds. Issue runs ahead of retirement until the reorder buffer or the scheduler is full, and the simulation of 500 cycles
often ends before that: 27 % of random blocks (14 % by more than 10 %), 63 of the 210 example × CPU pairs. Reproduction (before the fix): the
"pointer chasing" example on ADL-P, bound view: "slots issued 100 %" for a loop bound by its 5-cycle load chain (48
iterations issued in 16 cycles); on SKL "issued 46 %, front end 40 %, RS 14 %" instead of RS-bound; `wuica -json -details
-arch ADL-P 488b0048ffc975f8` gave `cycles 16, iterations 48`; with `-minCycles 5000` the window is 5 cycles per
iteration and 28 of 30 slots per iteration are lost (RS full). The same numbers reached the MCP/REST `insights.issueSlots`.
Two candidate fixes were tried: (1) the retirement cycles of the same rounds as the window: the cycles per iteration then
equal the throughput, but the issued uops per iteration are too many (the issue is still in warm-up inside the window;
1,706 of 20,000 blocks off): rejected. (2) Kept: with details and without a trace, if the window is not steady (its cycles
per iteration are not within 3 % and two cycles of the throughput), the issue log comes from a longer simulation (8, then
64 times `minCycles`, bounded at 250,000 instructions simulated, and skipped when `minIterations` already ran that long); the response's other fields are those of the normal
simulation, byte for byte (tested). With `includeTrace` the log stays that of the trace's cycles (the trace's issue strip
needs them), so a trace's strip can show warm-up while the bound view shows the steady state. Cost: only for those blocks,
one or two more simulations (the page's examples: under 2 ms; a few tens of ms natively at most). Shared code touched:
`crates/wuica-core/src/analyze.rs` (3 lines after the simulation), `details.rs` (two functions); a854a21 bounds its cost
(counts `minIterations`, skips a rerun that would be the same simulation, 250,000 instructions; the first result stays in
memory during the rerun). The test fails without the fix (checked by disabling the `if`: SKL pointer chasing 65 cycles / 60
iterations for a throughput of 4; 587 of 3,000 random blocks not steady).

A judgment call, for the owner to confirm: it changes `details.issue` values (never the default analysis, which is
byte-identical with and without details) and touches `analyze.rs` in model-r8's crate. To revert: drop the `if
request.details && !request.include_trace { ... }` after the simulation in `analyze.rs` (the functions in details.rs are
then unused), and the 1 % assertion and `issue_slots_are_of_the_steady_state` in details_fuzz.rs.

### Open findings and notes

- **D2 (note, documented in WASM-API.md).** With `simpleFrontEnd`, `details.issue.slots.issued` counts unfused uops (the
  simple front end delivers them one by one, as uiCA), so it can exceed the uop table's `Issued` (fused): in 199 of 3,000
  random blocks. WASM-API.md said "fused-domain uops"; it now says so. The page's slot shares are right; only the absolute
  "issued per iteration" is in a different unit than the table's. Reproduction: `wuica -json -details -simpleFrontEnd 4C0397B0010000C5A059E9488B9F9800000049C7C599000000`:
  issued 5.0, table 4.
- **D3 (note, documented).** For cpuid, `ret imm16`, in/out/ins, enter and wrmsr, `portData` (the table's, shown on the card
  as `1*p..` and used by the `Ports` limit, as in uiCA) lists uops that `uopList` and the simulation do not have: uiCA's
  `computeUopProperties` pairs store-address and store-data uops and drops the unpaired ones (crates/wuica-core/src/instr_builder.rs,
  the port of it). 412 rows in 20,000 random blocks. Not changed (it is the reference's model); the card could show the
  simulated uops instead.
- **N1 (open, minor).** The 1 MiB limit of hex input admits blocks the analyzer cannot do: 1,000,000 bytes of `90` (one
  million `nop`) end in "Analyzer crashed on this input (unreachable: out of memory, 3.7 GB in use; try a smaller block ...)"
  after about 1 s. The message is clear and the page stays usable; a limit on the instruction count (about 400,000) would
  say it before the run.
- **N2 (fixed, 0dfa684; tests: server/test/mcp.test.mjs "an unrolled variant over the server's limits", the label
  assertion in packages/wuica/test/mcp.test.mjs).** An unrolled variant that cannot be analyzed now says so itself:
  "the block unrolled ×4 (N bytes) could not be analyzed: <the reason>", and every variant row, error or not, has its
  `label` (packages/wuica/lib/whatif.js, shared by the stdio and the remote server). Was: The remote MCP `what_if` on a large block: the unrolled variants go through the server's request limits,
  so for SHA-256 `unroll4`/`unroll8` give "`hex` is longer than 65536 characters, the limit of this server" (the user sent
  no such hex; the stdio server analyzes them). Error rows of variants have no `label` (`{"id":"unroll2","error":"not a
  loop"}`), the others have one.
- **N3 (fixed, fea4047; tests: the arch-name assertions of packages/wuica/test/library.test.mjs and cli.test.mjs,
  server/test/compare-split.test.mjs (split and not), `arch_names_like_the_other_interfaces` of wuica-cli).**
  Whitespace around a name is ignored in the library (so REST and both MCP servers) and both CLIs (`"skl "` is SKL; a
  blank name follows each interface's rule for `""`: SKL in the library, unknown in the native CLI); a repeated name in a
  compare list counts once, in the order of its first appearance (library; the server de-duplicates before it splits a
  compare into parts, after its limit of 15 names, which counts the list as given); `-details` without `-json` (and in the
  npm CLI with several CPUs) prints one line on stderr, "-details: shown only with -json ...; ignored" (`-trace`
  unchanged); README: `archs` missing or empty means all. `"S-K-L"` is still SKL. Was: Arch names: the library and the npm CLI take `""` as SKL (the default), but `" "` and `"skl "` are unknown;
  the npm CLI trims list items (`-arch "SKL, ICL"` works); `"S-K-L"` is SKL (every `-` is dropped); duplicates in a list give
  duplicate rows (CLI, REST, MCP); REST `archs: []` means all; the native CLI has no lists (`unknown microarchitecture:
  SKL,ICL`). `-details` (both CLIs) is ignored without `-json` and with several CPUs, like `-trace`.
- **N4 (note).** In A–B mode the instruction card and the views are hidden by design; the A–B trace has no issue strip
  (features-r2 "next ideas").
- **N5 (no change needed).** The source row is not built without the line table (srcmap.js `paint()`), so the
  reopened link has no source row, not an empty one; web_qa2_browser now asserts exactly that (it accepted either before).
  Was: A link with `src=1` reopened in a new tab has the imported assembly but not Compiler Explorer's line
  table, so the "source" view is not offered until the link is imported again (tested: no error, the same result).
- **Speed note.** After D1's fix a details request on random blocks costs about twice as much on average (the random-block
  test: 20,000 blocks × 2 analyses in 3.3 s before, about 7 s after, 8 threads), because a quarter of them run the longer
  simulation; the page asks for details once per result, 300 ms after it, in its worker.

## Could not test

- Other browsers and real phones (headless Chrome only, widths emulated).
- The live site and API: no automated traffic by rule; everything ran against local builds and servers on 127.0.0.1.
- Compiler Explorer beyond the recorded responses (by rule).

## Files touched

Shared with other work tonight: `crates/wuica-core/src/analyze.rs` (one `if` after the simulation, for model-r8 to merge),
`crates/wuica-core/src/details.rs`, `docs/WASM-API.md` (the Details section). Added: `crates/wuica/tests/details_fuzz.rs`,
`tests-js/web_qa2_browser.mjs`, this file; extended: `tests-js/interfaces.mjs` (a section before its summary). Not touched:
web/js (no page change was needed), app.js, views.js, url-state.js, scripts/check.mjs.

Fixes of N2 and N3 (branch qa-r2-fixes): packages/wuica/lib/whatif.js, index.js, cli.js, index.d.ts (`label` always
present), README.md; server/lib/facade.js; crates/wuica-cli/src/main.rs; tests in packages/wuica/test (mcp, library, cli,
threads: a repeated arch now gives one row), server/test (mcp, compare-split), tests-js/web_qa2_browser.mjs (N5 assertion).
No analysis result changes.
