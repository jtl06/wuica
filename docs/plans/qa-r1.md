# QA round 1 (branch qa-r1)

What was tested on every part of wuica, how, and the result. Base: origin/main 9e3904e (site 0.1.3, built from fa10c8e
plus the API server). Fixes are separate commits on this branch, each with a test that fails before it.

Legend: **ok** works; **fixed** was broken, fixed here (commit); **open** a problem left for a decision (see "Open
problems"); **note** works as designed but worth knowing.

## Suites added (picked up by `scripts/check.sh`)

| Suite | Mode | What |
|---|---|---|
| `tests-js/web_qa.mjs` | quick | every example: Intel and AT&T text assemble to its machine code (or an equivalent encoding with the same report), and it gives a result on all 15 CPUs; url-state fuzz (500 random states round trip, 3000 random fragments never throw); hex parser fuzz (5000 random texts, 500 random byte strings in five styles) |
| `tests-js/web_qa_browser.mjs` | full (browser) | the page's features in headless Chrome against the analyzer run in Node: 78 example runs (all examples × Intel/AT&T/hex on SKL, the others on ZEN3, ADL-P, SNB), the CPU table with undecodable positions, the alignment sweep point by point, A–B (demo, swap, B's CPU, scale), keyboard, back/forward, copy link into a new tab, both themes × 11 widths 320–2560, errors |
| `tests-js/web_interfaces_browser.mjs` | full (browser; quick with 60/8 cases if fast) | differential: 300 random requests through the module in Chrome, 30 through the page's controls (CPU, options, hex), against Node |
| `tests-js/interfaces.mjs` | full | differential: 300 random requests through the npm library, the module via `web/js/engine.js`, the native CLI (`-json`), the npm CLI, the server's REST and MCP (Streamable HTTP, its own process) and the stdio MCP server; bad requests give the same code everywhere |
| `npm:server` | full | the API server's own tests (`server/test`), which `check.sh` did not run before |
| shared | – | `tests-js/cdp.mjs` (Chrome over the DevTools protocol, a served copy of `web/dist`), `tests-js/fuzz-cases.mjs` (seeded random requests from the decoder fixtures) |

`interfaces.mjs` takes a count and `--seed`; a run of 4000 cases (seed 20261123) found no difference.

## Inventory

### Input

| Feature | How tested | Result |
|---|---|---|
| asm input (LLVM MC in WebAssembly) | every example in both syntaxes (Node and page); 30 page runs from random hex; odd inputs (below) | ok |
| hex input (plain, spaced, `0x`, `\x`, objdump/llvm-mc listings, comments) | hex parser fuzz; page runs of each style; examples' listings | ok |
| Intel / AT&T switch | every example in both; an untouched example follows the switch | ok |
| AT&T text in Intel mode, Intel in AT&T | page, npm CLI | ok: clear assembler message with line:column |
| empty, whitespace, comment only, labels only | page, npm CLI, REST | ok: "No code" / "No machine code" / "the source contains no instructions" |
| unknown mnemonic, unterminated operand, unicode in comments, a Cyrillic letter in a register | page, npm CLI | ok |
| `;` used as a comment | page | **fixed** (cbadad0): LLVM (like GNU as) reads `;` as a statement separator; the error now says so |
| UTF-8 byte order mark at the start | npm CLI (a file from a Windows editor), REST, page | **fixed** (ac191fa package, cbadad0 page): was "invalid character in input" |
| non-UTF-8 bytes in a `.s` file | npm CLI | ok: "invalid character in input" with the line |
| CRLF and CR line ends | npm CLI | ok |
| NUL characters | page | ok (replaced by spaces) |
| `.code16` / `.code32` | page | note: assembled in that mode, analyzed as 64-bit code without a warning |
| huge blocks: `.rept 100000 nop`, 70,000 instructions as hex | page | ok (about 1 s; the page stays responsive except for the assembly itself) |
| `.rept 1000000` and larger | page | **fixed** (de1676d, c0b28f2): the analyzer runs out of memory (wasm32, about 3.7 GB) and said only "crashed (unreachable)"; it now says out of memory. The page assembled up to 64 MiB in a second run on its own thread (7 s frozen for 10 MB); it now stops at 1 MiB (as the npm package) with "Too much machine code" |
| `.zero 1000000000`, `.p2align 30`, `.skip 1e8` | page, npm | ok: "the assembler failed: Allocation failed", the assembler restarts |
| bad hex (`zz`, odd digits, `0x` alone, unicode) | page | ok: message with the line |
| bytes that do not decode (`ff ff ff ff`, `48`) | page, all interfaces | ok: "no instructions found" |
| examples menu: every example | Node and page on all 15 CPUs (web_qa), in the page on 4 CPUs × 3 formats (web_qa_browser) | ok; note: on SNB/IVB the AVX2/FMA/BMI2 examples (avx, saxpy, dot1, dot4, gemm, sha256) lose those instructions (decode errors, as in uiCA) and the result says so; note: the "avx" example's Intel/AT&T text assembles `add r10, rcx` to 49 01 ca, its listing (from the reference corpus) has 4c 03 d1: same report |
| SHA-256 showcase (2,949 instructions) | page | ok: 744.25 on SKL, first 200 rows then "show all" |

### Options

| Feature | How tested | Result |
|---|---|---|
| alignment offset, init policy, simple front end, micro/macro fusion, min iterations/cycles | 30 random page runs set through the controls, compared with Node; 4000 random requests across the other interfaces | ok |
| "N changed" summary, reset | page (existing web_browser suite) | ok |
| out-of-range values in the page | url-state fuzz; clamped (0–63, 1–10000, 1–100000) | ok |
| extreme values in the library/CLI/REST (negative, 2^62, 2^31 iterations) | npm library, native CLI, REST | ok: no hang; huge iteration counts end in an out-of-memory trap (now named as such) after 2–4 s; REST caps minIterations 1000, minCycles 20000 |
| wrong option types / unknown initPolicy | library, REST, npm CLI | **fixed** (e229cf7): were code 3 ("invalid request: invalid type...", REST 200), now code 1 (REST 400) as the contract's table says for bad requests |
| loop / unroll mode | every result shows the tag; differential tests compare `mode` | ok |

### CPUs and results

| Feature | How tested | Result |
|---|---|---|
| CPU checkboxes, focus | page | **fixed** (73c36cb): a checked CPU becomes the focused one (details and status line follow, also in live mode); unchecking the focused CPU returns to the one focused before; "all"/"clear" keep the focus; the table still picks |
| status line with several CPUs | page | **fixed** (73c36cb): "2.00 cycles/iteration · HSW · 4 CPUs · 3.1 ms" |
| multi-CPU table | page: values equal single analyses; sorting, keyboard (existing suites) | ok |
| a CPU that cannot decode part of the block in the table | page (saxpy on SNB + SKL) | **fixed** (c926f0a): the row was silently faster (instructions skipped) and could be marked fastest; now "N undecodable skipped" and not the fastest |
| detailed result: limits, bottleneck, uop table, port pressure, notes | page vs Node: throughput, bottlenecks, limits, report text on 30 random cases | ok |
| dependency chain | page (existing insight suites) | ok |
| cost column | showcase (2,949 instructions): waits for a click ("compute (2948 analyses)", estimate 29–40 s), then 2,948 analyses in about 20 s on the worker pool (12 threads) | ok |
| objdump and uiCA report views | page: report text equals the module's `text` on 30 random cases | ok |
| trace (cycle by cycle) | showcase: asks first ("would be very large · load it anyway"), then draws in about 2.5 s with at most 1.2 s without a frame | ok (the trace view is being reworked on another branch) |
| alignment sweep | page: all 64 points equal single analyses at each offset | ok |
| A–B comparison | page: demo pair, swap, B on its own CPU, scale ×4 | ok |

### Page state and shell

| Feature | How tested | Result |
|---|---|---|
| URL fragment state, old links | url-state fuzz; page | **fixed** (b447bc1): SKL focused with an earlier CPU checked (e.g. HSW, SKL) was written without `a=`, so the link reopened with HSW focused |
| copy link | page: the copied URL opened in a new tab gives the same state and result | ok |
| back / forward | page: two links, back and forward restore input, CPU, options and result | ok |
| light / dark theme | page: toggle, colors change, stored, survives a reload | ok |
| widths 320–2560 | page: 11 widths × both themes with a result, the CPU table and the text views open: no horizontal scrolling | ok |
| keyboard | page: Ctrl/⌘+Enter, space on a CPU box (focus moves, keyboard focus stays), Escape closes the options | ok |
| errors leave the page usable | page: bad hex, bad asm, empty, undecodable, huge | ok |
| Compiler Explorer import | mocked: existing `web_godbolt.mjs`, `web_browser_ab.mjs` (recorded responses); one real import on the local build (a full-state link, gcc 8.2: 3 requests to godbolt.org; plus one short-link paste that showed the function picker) | ok |
| service worker: first visit, reloads, `/index.html`, offline, a new deploy | existing `web_host_browser.mjs`, `web_browser.mjs` | ok; **fixed** a race in `web_host_browser.mjs` (6288a0c) that failed `check.sh full` under load: the test clicked Analyze while the run restored from the fragment was going, which cancels it (reproduced with CPU throttling ×15) |
| worker pool | existing `web_pool*.mjs`; the cost column and the CPU table above | ok |

### npm package, CLIs, server

| Feature | How tested | Result |
|---|---|---|
| library, npm CLI, stdio MCP, REST, remote MCP, native CLI | `interfaces.mjs` (4000 random requests, seed 20261123; 300 in `check.sh full`) | ok: identical results |
| npm CLI odd inputs: empty/blank/comment/label files, non-UTF-8, BOM, CRLF, `-raw` empty/missing, two inputs, bad numbers | by hand | ok, except: BOM **fixed** (ac191fa); empty machine code said "expected an even number of hex digits", **fixed** (6f1fcdf) |
| native CLI odd inputs: no input, empty, `zz`, odd digits, `0x`, unknown arch/option, missing value, missing data dir, overflowing numbers | by hand | ok: one clear line on stderr, exit 1 |
| server odd requests: invalid JSON, non-object bodies, wrong content type, 300 KB body, 64 KB hex, 20,000 instructions, `.rept 1000000`, unknown paths and methods, OPTIONS, text/plain errors, compare with bad/too many archs, MCP schema errors, unknown tool, 40-message batch | local server, about 60 requests | ok: no 500, no hang; limits answered with 400/413 |
| server's own tests | `npm:server` (46 tests) | ok; they were not part of `check.sh` before |
| live API (api.wuica.jacen.li) | about 20 requests, one at a time: health, version, archs, 8 random analyses, asm, text/plain, compare, assemble, MCP list and analyze | ok: identical to the local library; the live server still has the two behaviors fixed here (bad option value: code 3; BOM: assembler error) |
| live site (wuica.jacen.li) | 3 page loads: version 0.1.3, build 794c0e17030d, analysis, service worker controls the page after a reload, "works offline", no console errors; reproduced the reported focus problem (checking ZEN3 keeps SKL in details and status line) | ok |

## Interface differences (by design or minor)

All interfaces gave identical results (tp, mode, limits, uop table, report text, critical path, failure kind) on 4000
random requests. Differences in what they accept:

- Option ranges: the page clamps alignment 0–63, minIterations 1–10000, minCycles 1–100000; the MCP schema allows
  0–63, 1–100000, 1–1000000; the REST server caps minIterations 1000 and minCycles 20000; the library and both CLIs
  take any integer (negative values and offsets above 63 are accepted and simulated).
- Architecture names: the npm library/CLI/REST/MCP accept `adlp`, `skl` (case-insensitive, `-` optional); the native
  CLI only exact keys. The native `-arch list` prints uarch.json's keys in file order, ablation variants included; the
  npm `-list` the 15 public ones in release order.
- Hex: the native CLI takes one argument of hex digits (spaces inside the argument are fine, `0x` is not); the npm
  CLI, library and REST also accept `0x`, `\x`, commas.
- Size limits: page 1 MiB of assembled code (after c0b28f2), npm assembler 1 MiB, REST 64 KB source / 10,000
  instructions. Hex input in the page has no limit; a block that large runs the analyzer out of memory (now said so).
- `GET /api/archs?fields=bogus` gives a list of empty objects (not an error). `POST /mcp` with invalid JSON gives the
  REST error object, not a JSON-RPC parse error (-32700).

## Open problems (not fixed here: larger changes or decisions)

1. **The assembler runs on the page's thread.** A large `.rept` freezes the page while it assembles: `.rept 1000000` /
   `nop` / `.endr` about 0.7 s, `.rept 10000000` about 3.5 s (one run now; it was two runs and 7 s, then a 10 MB block
   for the analyzer). In live mode this happens on each edit that changes the count. Moving `WasmAssembler` into a
   worker (as the analyzer is) would remove it. Reproduction: asm mode, paste `.rept 10000000\nnop\n.endr`.
2. **The analyzer's memory is never given back in the page.** WebAssembly memory only grows. The analyzer needs about
   7.6 KB per instruction (natively: 300,000 nops → 2.3 GB RSS) and more for long-latency loops (20,000 `div rcx` →
   2.6 GB of wasm memory; 50,000 → out of memory at about 3.7 GB). After such a block the page's analyzer worker keeps
   that memory until the page is reloaded (the server replaces a worker that grew by more than 256 MB; the page and
   the pool do not). Suggestion: after an analysis, if `engine.memory()` is above, say, 512 MB, restart the worker
   (`engine.cancel()` does that; the data is reloaded lazily). Reproduction: hex mode, `48f7f1` repeated 20,000 times,
   Analyze, then look at the tab's memory.
3. **No size limit for hex input in the page.** The page parses the text on its thread (210 KB of hex: 0.7 s) and
   sends any number of bytes to the analyzer; above roughly 450,000 instructions (fewer for slow instructions) the
   analyzer runs out of memory (now reported as such). A limit like the assembler's 1 MiB would make both inputs
   behave alike; the A–B side B input (ab.js, being changed on another branch) would need the same.
4. **`.code16` / `.code32` blocks are analyzed as 64-bit code** without a warning (`.code16` + `add ax, 1` gives
   `83 c0 01`, analyzed as `add eax, 1`). A note in the result when the source switches mode would avoid a silent
   wrong answer.
5. **Different option ranges per interface** (listed below). Not wrong, but a request that works in one place is
   refused or clamped in another; a single documented range (0–63, 1–10000, 1–100000, the page's) would be simpler.
6. **Deploy:** the live site and API run the code before these fixes (checked: the focus problem, a bad option value
   giving code 3, a BOM failing); they change only with the next deploy.
