# wuica: a specification for reviewers

Release 0.1.8, as of repository commit `67a384b` (2026-11-23). Written so that a reviewer with only this file, or this file
plus the source files it names, can judge the project without guessing. Every number names the file, test or command it
comes from. Paths are relative to the repository root.

## 1. What it is

wuica ("WebAssembly uiCA") is an unofficial Rust/WebAssembly port of the Python x86-64 throughput simulator uiCA, as modified
by the fork `jtl06/uiCA`. For a block of x86-64 code and one of 15 microarchitectures it predicts the steady-state throughput
in core cycles per iteration, with uiCA's complete report (bottlenecks, per-instruction port usage, optional cycle-by-cycle
trace), and must give results identical to the Python reference (section 3, rule 1). It ships as a static website
(`https://wuica.jacen.li`; everything runs in the browser), an npm package `wuica-cli` (CLI `wuica`, a library, a stdio MCP
server; no runtime dependencies) and a hosted REST + MCP server (`https://api.wuica.jacen.li`, code in `server/`). It is for
people tuning small hot loops by hand or with an agent. It is **not** the official uiCA (that is uiCA.uops.info and
`andreas-abel/uiCA`), not a general CPU emulator, and not a profiler. The model's own limits, as the page states them
(`web/index.html`, section "Limitations"; `packages/wuica/README.md`, "What the numbers mean"): all data in L1, no branch
mispredictions, nothing else on the core; a block that ends in a branch is a loop whose branch is taken, any other block is
simulated as if unrolled; the ZEN3, ADL-P and ICX models are the fork's prototypes and less validated.

## 2. Headline numbers

| | Value | Source |
|---|---|---|
| Fixture cases identical to the reference | 17,081 simulation cases (+3,419 in an optional set), 12,046 instruction-builder cases, 3,948 decoder cases | Last local `scripts/check.sh full` logs (section 7.6) |
| Time per analysis (WebAssembly, warm) | 0.52 ms (BHive block), 0.63 ms (random loop), 36 ms (2,949-instruction SHA-256 block) | Commit `623a117` message, measurement machine (Ryzen 7 7735U), Node 22; before model rounds 6–9 |
| Analyzer module | 4.31 MB raw, 630 kB brotli q11 (package), 867 kB as the live site serves it | Section 7.1 |
| First visit in assembly mode (analyzer, assembler, SKL table, page shell) | 2.19 MB as the live site serves it; the same files weigh 1.64 MB at brotli q11 (+34 % served) | Section 7.1 |
| Accuracy of the prototypes, held out, within 10 % | ZEN3 84.4 % / 87.7 %, ADL-P 90.9 % / 92.6 %, ICX 85.8 % / 89.7 % (random loops / BHive blocks) | `docs/ACCURACY.md`, "Round 9" |
| Python reference, same work | 40–55 ms per analysis plus interpreter start | `README.md`, "Status" |

## 3. Hard rules

A suggestion that breaks one of these will not be taken, whatever it gains. Each has a reason and a check.

| # | Rule | Reason | Where it is enforced |
|---|---|---|---|
| 1 | **Bit-identical to the Python reference** on the fixture corpus: same throughput, same report text, same uop table, same `-json` trace (numbers by value, key order ignored; terminal hyperlinks in the report are stripped before comparing, `tests-js/analyze_fixtures.mjs`) | The project's claim is "uiCA, exactly"; any drift makes every prediction suspect and hides model bugs behind port bugs | Fixtures at three boundaries (section 7.6); `docs/DESIGN.md`, "Fixtures: the three boundaries" |
| 2 | **The rules for an exact port** (`docs/DESIGN.md`, "Rules for an exact port"): keep Python's iteration order (never iterate a `HashMap`/`HashSet`; Python sets that are iterated get a defined order); `//` and `%` round toward −∞ (`div_euclid`/`rem_euclid`); `min`/`max` return the first of equals, `sorted` is stable; keep the order of float operations, `round(x, 2)` rounds half to even on the binary value; port substring tests on names literally; operands are compared by identity, not by register name; known quirks of the reference are ported as they are and fixed in the Python reference first | Each is a place where a direct translation gave different results | Rule 1's fixtures; `crates/wuica-core/src/fasthash.rs` documents that its maps are lookup-only |
| 3 | **Optimizations change no output**, including fields the fixture tests do not compare | Rule 1 | `crates/wuica/examples/golden.rs` writes every fixture response for a before/after diff (`docs/PORTING.md`, "Speed") |
| 4 | **Nothing the user types into the page leaves the browser** (the hosted REST/MCP server of course receives what is sent to it). The one exception: pasting a Compiler Explorer link imports it from `godbolt.org` (short links are resolved there, and the source inside the link is sent to its compile API: `web/js/godbolt.js`, `compilePane`) | The page's main promise; users paste proprietary code | CSP in `web/index.html` (`connect-src 'self' https://cloudflareinsights.com https://godbolt.org`); page state lives in the URL fragment, which is not sent to servers (`web/js/url-state.js`); `tests-js/web_browser.mjs` checks the CSP |
| 5 | **The npm package has zero runtime dependencies** | One package to audit; `npx wuica-cli` installs one package (2.4 MB) | `packages/wuica/package.json` (only `devDependencies`); the MCP stdio server is hand-written (`packages/wuica/lib/mcp.js`) |
| 6 | **AGPL-3.0-only, with attribution** to uiCA (paper citation), uops.info (data), Intel XED, LLVM | wuica is a derivative work of uiCA, which is AGPL-3.0; the bundled XED/LLVM licenses require it | `LICENSE`, `README.md` "Licenses", licenses shipped in `web/dist/licenses/` and `packages/wuica/licenses/` |
| 7 | **Nothing implies endorsement** by the uiCA or uops.info authors; "unofficial port" | It is not their work | Page footer, READMEs |
| 8 | **The ZEN3, ADL-P and ICX models are the fork's prototypes and are labelled so** everywhere (page marker `p`, API `prototype: true`, CLI `[prototype]`) | They are not uiCA's models and are less validated | `web/js/archs.js` (`PROTOTYPE`), `packages/wuica/lib/cli.js`, `server/lib/app.js` |
| 9 | **Minimal text on the page** | Owner's design decision | Review only (no test) |
| 10 | **Files shared between page and package stay identical**: `packages/wuica/lib/web/*.js` are copies of `web/js/*.js` | One implementation of loop finding, regions, what-if renaming, caveats | `tests-js/web_pkg_copies.mjs` |
| 11 | **The shared Rust contract changes minimally**: `crates/wuica-core/src/{model,config,decoded,x64,jsoncmp}.rs` | Other work depends on these types | `docs/PORTING.md`, "Shared code" |
| 12 | **No local paths in shipped modules** | Privacy of the build machine | `build-wasm.sh` remaps paths and fails if `$HOME` appears in the module |

## 4. Architecture

### 4.1 Pipeline

```
 text box / file / API "source"                                                                      (JavaScript)
   │  syntax detection (Intel vs AT&T)          web/js/loop-find.js  detectSyntax
   │  loop finding (whole function → one loop)  web/js/loop-find.js
   │  region markers, .loc lines, ';' handling  web/js/asm-regions.js
   ▼
 assembler: LLVM 22.1.2 MC as wasm32-wasi       assembler/wuica_asm.cpp → wuica_asm.wasm            (C++, compiled)
   │  bytes of .text only
   ▼  hex
 ┌──────────────────────── wuica_wasm.wasm (or the reference binary) ─────────────────────────────── (Rust + C) ─┐
 │ decode: Intel XED, the version uiCA pins     crates/wuica-xed (shim/wuica_xed.c, src/lib.rs)                  │
 │ instruction builder + uops.info tables       crates/wuica-core/src/instr_builder.rs, data.rs, config.rs       │
 │ pipeline simulation                          crates/wuica-core/src/sim/{frontend,renamer,scheduler,prep,…}.rs │
 │ bottleneck analysis (Facile limits, graph)   crates/wuica-core/src/facile.rs                                  │
 │ report text, uop table, -json trace, details crates/wuica-core/src/{analyze,details}.rs, sim/output.rs        │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
   ▼  response JSON (docs/WASM-API.md)
 derived views: insights, caveats, what-if       web/js/{bound,insight,caveats,whatif,accum}.js;                 (JavaScript)
                                                 packages/wuica/lib/{insights,whatif}.js
```

The Python file each Rust module mirrors: `instructions.py` → `instr_builder.rs`; `uiCA.py` → `sim/`; `facile.py` and
`printBottlenecks` → `facile.rs`; `microArchConfigs.py` → `config.rs` (original sources: `reference/uiCA/`).

### 4.2 What is Rust, what is JavaScript, and why

| Part | Language | Files | Why there |
|---|---|---|---|
| Decoder | C (XED subset, `third_party/xed`) + Rust wrapper | `crates/wuica-xed` | The pinned XED plus a shim produce "the same records as uiCA's Python `xed` module" (`docs/DESIGN.md`, "Architecture"), checked at the decoder boundary |
| Builder, simulator, analysis, report | Rust, no I/O, no C | `crates/wuica-core` | The exact port (rules 1–2); runs natively for tests and as wasm |
| Engine facade | Rust | `crates/wuica/src/lib.rs` (`Engine`: `load_uarch`, `load_arch_bin`, `load_arch` (JSON, feature `json-tables`: native tools and tests only), `analyze`, `analyze_json`) | One entry point for wasm and the reference binary |
| WebAssembly exports | Rust | `crates/wuica-wasm/src/{lib,alloc}.rs` | Plain C ABI, no wasm-bindgen; own small-block allocator |
| Reference/test binary | Rust | `crates/wuica-cli/src/main.rs` | Not a product: an independent interface for the exactness checks (`scripts/check.mjs`, `tests-js/interfaces.mjs`); **machine code only** (hex or `-raw`) |
| Assembler | C++ (LLVM MC) as wasm32-wasip1, no imports | `assembler/` | Instruction lengths must match a real assembler; identical bytes to `llvm-mc` (`assembler/README.md`) |
| llvm-mca view | C++ (LLVM 22.1.2 `llvm-mca`) as wasm | `mca/` | Side-by-side comparison in the page only |
| Syntax detection, loop finding, regions, `;` comments, objdump text | JavaScript | `web/js/loop-find.js`, `asm-regions.js`, `asm-text.js` (copies in `packages/wuica/lib/web/`) | Written for the page; reused by the package. The repository records no design reason for not doing this in Rust; the effect is that the reference binary has none of it (section 8.4) |
| Insights, what-if, N accumulators, caveats | JavaScript | `web/js/{bound,insight,whatif,accum,caveats}.js`; package: `lib/insights.js`, `lib/whatif.js` (own implementations, kept equal by `tests-js/web_bound.mjs`, `web_whatif.mjs`), `lib/web/{accum,caveats}.js` (copies) | Derived from the response; not in uiCA |
| UI, worker pool, service worker, Compiler Explorer import | JavaScript, no framework, no bundler | `web/js/*.js` (61 files, 14,037 lines), `web/css/`, `web/sw.js` | Static hosting, no build step but copying (`web/build.sh`) |
| CLI, library, stdio MCP | JavaScript (Node ≥ 20) | `packages/wuica/{bin,lib}`, `index.d.ts` | Same wasm modules as the page |
| REST + remote MCP | JavaScript (Node ≥ 22) on `node:http` + MCP SDK | `server/lib/` | Uses the npm package; the SDK and zod are dependencies here only |

Simulator data layout: flat arrays per entity kind with `u32` indices instead of Python's object graph; nothing is freed
during a simulation (`docs/DESIGN.md`, "Data layout in the simulator").

### 4.3 The three WebAssembly modules

| Module | Built by | Exports | Memory (from the module's memory section) | Loaded |
|---|---|---|---|---|
| `wuica_wasm.wasm` (analyzer) | `build-wasm.sh`: `cargo build -p wuica-wasm --target wasm32-unknown-unknown --release`, fat LTO, 1 codegen unit, opt-level 3 | `memory`, `wuica_alloc`, `wuica_free`, `wuica_result_ptr`, `wuica_decode`, `wuica_load_uarch`, `wuica_load_arch` (binary tables only; JSON with the Cargo feature `json-tables`), `wuica_load_arch_bin`, `wuica_analyze` | initial 34 pages (2.1 MiB), **no maximum** (up to 4 GiB) | Page: at start. Package: in `createWuica` |
| `wuica_asm.wasm` (assembler) | `assembler/build.sh` (x86-64 Linux; `-Oz`, full LTO, a size patch) | `_initialize`, `malloc`, `free`, `wuica_assemble`, `wuica_fatal_message` | max 256 MiB | Page: at start in assembly mode (the default), else on first use. Package: on first assembly |
| `wuica_mca.wasm` (llvm-mca) | `mca/build.sh` | `wuica_mca_run`, `wuica_mca_output`, … | max 1 GiB | Page only, when the `mca` tab is first opened |

None of the three has imports. A trap (in practice: out of memory) makes an instance unusable; every host drops it,
instantiates again and reloads the tables (`docs/WASM-API.md`, "Failures and traps"; `packages/wuica/lib/wasm.js`).

### 4.4 Data files

| File | Content | Origin |
|---|---|---|
| `data/uarch.json` (51 kB) | uiCA's `MicroArchConfig` per configuration, including the fork's fields (`splitLoadCycles`, `fpSchedulerSize`, …) and uiCA's ablation variants (keys with `_`) | `tools/export_data.py` run against a uiCA checkout |
| `data/arch/<TABLE>.json` (15 tables, 0.46–1.77 MB each) | Instruction data per table: per XED iform the variants, ports, latencies, throughputs | uops.info measurements as converted by the fork's `convertXML.py`, exported by `tools/export_data.py` |
| `fixtures/decode_fixtures*.jsonl.gz` (in git) and `fixtures/generated/*.jsonl.gz` (not in git; 1.4 GB uncompressed for the simulation set) | What the reference computes at each boundary | `tools/export_decode_fixtures.py`, `tools/export_fixtures.py`, `tools/export_all.sh` |

`data/` and `fixtures/generated/` are generated locally and not committed (`.gitignore`). CI downloads them, with the
assembler and llvm-mca modules, from a GitHub pre-release named in `ci/data-asset.txt` (`ci-data-v7`), checked by sha256. The
tables are derived from uops.info data via uiCA and generated locally; the repository does not state a license for them.
The reference commit whose model and data are shipped is recorded once, in `ci/data-asset.txt` (`uica_commit=640e40e
(improve-r9)`), and reported by `wuica --version -json` and `GET /api/version`.

### 4.5 Threads and workers

| Host | Model | Files |
|---|---|---|
| Page | One analyzer worker for the main result (`engine-worker.js`); a pool of `hardwareConcurrency − 1` workers, at most 6, started on demand, for the all-CPU table, the 64-offset alignment sweep and the per-instruction cost column; each table loaded into one worker where possible, at most `ceil(tables/size) + 2` tables per worker; a worker whose memory grew past 512 MB is replaced; batches are latest-wins and a job still running 500 ms after cancellation kills its worker. Large assembly is assembled in its own worker; llvm-mca in its own worker. The module is compiled once on the page (`WebAssembly.compile`) and the compiled `Module` is posted to the workers | `web/js/app.js`, `pool.js`, `engine-rpc.js`, `assembler-rpc.js`, `mca-worker.js` |
| Node package | One analyzer on the calling thread. `compare` (several CPUs) uses `worker_threads`: by default one thread per two microarchitectures, at most `os.availableParallelism()`; a thread loads only its tables and keeps them; idle threads stop after 30 s. The threads share **one** compiled module, compiled separately from the main thread's with a memory cap (a quarter of RAM divided by the threads, 256 MiB to 1 GiB); an analysis that traps in a thread is redone on the calling thread. A warm-up analysis (`WARM_HEX`, 482 instructions) runs while threads start | `packages/wuica/lib/{index,threads,thread-worker,wasm}.js` |
| Server | Fixed pool of `worker_threads` (default `availableParallelism()`, deployed with 2), bounded queue (64; then 503 + `Retry-After`), 10 s per job (the worker is terminated on timeout), analyzer memory capped at 2048 MB, a worker replaced after its memory grew by 256 MB; tables and assembler preloaded; a compare on an idle pool is split into parts of two microarchitectures over the workers; per-IP token bucket (burst 60, 120/min, compare costs 3) | `server/lib/{pool,worker,facade,config,ratelimit,wasm-limits}.js` |

### 4.6 Page shell: service worker and URL state

- `web/build.sh` copies files into `web/dist/`, writes `manifest.json` (file sizes, table list) and stamps a hash of all files
  into `sw.js`. The service worker precaches everything except the tables, the assembler, llvm-mca and the showcase's
  assembly, serves cache-first, and fetches and caches lazy files on use; a new deploy is a new cache. After the first result
  the page prefetches all tables and the assembler when idle, unless Save-Data is set (`web/js/app.js`, `prefetchTables`).
  `tests-js/web_host_browser.mjs` checks this against a host emulation (`tests-js/static-host.mjs`) that redirects like the
  real host (Cloudflare static assets).
- All page state (input text as base64url, mode, CPUs, options, open views, A–B side B) is in the URL fragment
  (`web/js/url-state.js`, at most 200,000 characters of text from a link). Links are shareable without a server.

## 5. Interfaces

Full contracts: `docs/WASM-API.md` (module), `packages/wuica/README.md` ("API contract", "Option ranges per interface").

| Interface | Input | Can | Cannot |
|---|---|---|---|
| Module `wuica_analyze(request JSON)` | `{hex, arch, alignmentOffset, initPolicy, simpleFrontEnd, noMicroFusion, noMacroFusion, minIterations, minCycles, includeTrace, details}` | Response: `tp`, `mode` (`loop`/`unroll`), `decodeErrors`, `bottlenecks`, `limits`, `columns`/`rows` (uop table), `text` (uiCA's report), `trace` (uiCA's `-json`), `criticalPath`, `details` (not in uiCA; adding it changes no other field) | Assembly; loop finding; insights; tables must be loaded first (`wuica_load_uarch`, `wuica_load_arch_bin`) |
| Reference/test binary `crates/wuica-cli` (not a product) | Hex argument or `-raw FILE`; `-data DIR` | uiCA's report, `-TPonly`, `-json`, `-trace`, `-details`, uiCA's options | Assembly, objdump text, loop finding, several CPUs per run, what-if, caveats, insights |
| npm CLI `wuica` | Assembly file (syntax detected), stdin, hex, `-raw`, objdump text, `-example NAME` | Loop finding (`-loops`, `-loop N\|LABEL\|whole`, `-func`), `-arch A,B,…\|all` (one table), `-per N`, `-whatif`, `-json`, caveats and nearest limit after the report, exit codes 0/1/2/3 | One input per run; object files (use `objdump -d`) |
| Library `createWuica()` | `analyze(arch, {source\|hex, syntax, loop, func, options})`, `compare`, `assemble`, `archs`, `summarize`, `insights`, `whatIf` | Never throws on bad input: resolves to `{code, error, stderr}`; recovers from traps (`trapped: true`) | — |
| Stdio MCP (`wuica mcp`, `wuica-mcp`) | JSON-RPC 2.0 over stdio, protocol revisions 2025-11-25 … 2024-11-05 | Tools `analyze`, `what_if`, `compare_archs`, `list_archs`, `assemble`; arguments checked against JSON Schemas | Resources, prompts; option ranges narrower than the library's |
| REST (`server/`) | `GET /api/archs`, `POST /api/analyze/<arch>`, `POST /api/compare`, `POST /api/assemble`, `GET /api/version`; `Accept: text/plain` gives the report | Compiler Explorer–style shapes; `insights` in the response | `what_if` (MCP only); source ≤ 64 KB, ≤ 10,000 instructions, `minIterations` ≤ 1000, `minCycles` ≤ 20,000 |
| Remote MCP (`/mcp`, Streamable HTTP, stateless) | Same tool table as stdio (`mcpTools` in `packages/wuica/lib/mcp.js`) via the SDK | Same five tools | As REST |

Result codes everywhere: 0 ok, 1 bad request, 2 assembler error, 3 analysis failed (`packages/wuica/README.md`, "Failures").

## 6. Accuracy (model, not port)

The port reproduces the reference exactly, so these numbers hold for both (`docs/ACCURACY.md`). They cover only the fork's
three models; uiCA's Intel models are unchanged by the fork's rounds and are not measured in this repository.

Round 9, held-out sets (generated and measured before any model change, scored once at the end); share of loops within 10 %
of measured cycles per iteration, and MAPE:

| Model (measured on) | Random loops `holdout7` | BHive blocks `bhive5` | llvm-mca, same sets | Nearest original uiCA model |
|---|---|---|---|---|
| ZEN3 (Ryzen 7 7735U, Zen 3+) | 1960 loops: 84.4 %, 4.2 % | 1941: 87.7 %, 3.9 % | `znver3`: 55.2 % / 71.8 % | — |
| ADL-P (Core i7-12650H, P-core) | 1933: 90.9 %, 2.8 % | 1896: 92.6 %, 3.2 % | `alderlake`: 32.3 % / 68.8 % | RKL: 47.1 % / 71.3 % |
| ICX (Xeon Gold 6314U) | 1879: 85.8 %, 3.9 % | 1928: 89.7 %, 3.0 % | `icelake-server`: 53.0 % / 69.5 % | ICL: 78.4 % / 85.6 % |

Method (`docs/ACCURACY.md`, "Method of round 9", "Method of round 6"): `perf stat` user-mode cycles, pinned to one core, best
of three runs, nothing else on the machine; loops whose two fastest runs differ by more than 2 % are dropped. Random loops
come from the fork's `microbench/fuzz/fuzz_gen.py`; real-code blocks from BHive, run as loop bodies. Development used other
sets (`dev13`, earlier hold-outs, hand-written loops) and 21 "dogfood" loops from real use (ZEN3 within 10 %: 47.6 % → 57.1 %
in round 9). Each model was measured on one machine.

## 7. Measurements

Unless stated otherwise, "measured here" means: on the development machine (Apple M3 Pro, 12 cores, 18 GB, macOS, Node
26.0.0) on 2026-11-23, with other work running (load average 7–11), so timings are indicative only. "Measurement machine"
means the dedicated Ryzen 7 7735U (8 cores, 16 threads, Linux, Node 22) used under an exclusive lease, as quoted from the docs.

### 7.1 Sizes of what ships (measured here)

Files of the release build (`web/dist/`, identical modules in `packages/wuica/dist/`). gzip and brotli computed with Node's
`zlib` (gzip level 9; brotli quality 11, window 24, as `packages/wuica/build.sh` does). "Served" is the byte count the live
site sent with `Accept-Encoding: br, gzip` (`curl -s -o /dev/null -w '%{size_download}'`); the host compresses on the fly.

| File | Raw | gzip -9 | brotli q11 (= package) | Served (br) |
|---|---:|---:|---:|---:|
| `wuica_wasm.wasm` (analyzer) | 4,307,652 | 924,637 | 629,775 | 866,526 |
| ├ code section | 1,898,829 | | 300,690 | |
| ├ data section | 1,125,476 | | 238,009 | |
| └ `name` custom section (function names) | 1,214,546 | | 61,818 | |
| `wuica_asm.wasm` (assembler) | 3,802,001 | 1,036,003 | 687,897 | 941,580 |
| `wuica_mca.wasm` (llvm-mca, page only) | 4,376,885 | 1,191,976 | 801,898 | 1,103,294 |
| 15 instruction tables (`data/arch/*.json`) | 14,585,603 | 1,094,488 | 680,863 | 1,280,826 |
| ├ smallest (SNB) / largest (ADL-P) | 460,620 / 1,771,348 | | 24,502 / 77,426 | |
| `data/uarch.json` | 51,318 | 2,485 | 1,830 | |
| JavaScript (61 files) | 815,706 | 273,106 | 238,693 | |
| CSS (17 files), fonts (2 woff2) | 69,939 + 31,324 | | | |
| HTML + `uarch.json` + all JS, CSS, fonts | | | | 340,482 |

- Of the analyzer's 1,876,261 bytes of function bodies, 1,021,456 are XED's C functions (`xed3_phash*` 707,472,
  `xed3_capture*` 254,593), by the function names in the name section. The content of the 1.13 MB data section is not
  attributed yet (an audit is in progress, section 9).
- First visit in assembly mode, before the first result: analyzer + assembler + SKL table + shell (HTML, `uarch.json`, all JS,
  CSS, fonts) = 2,190,673 bytes served (866,526 + 941,580 + 42,085 + 340,482); the same files at brotli q11 are 1,639,934
  bytes (629,775 + 687,897 + 28,369 + 293,893), so the host's compression costs 551 kB (+34 %). The other
  14 tables (about 1.24 MB served) are prefetched after it; llvm-mca (1.1 MB) only on use.
- Whole site: 111 files, 27.7 MB on disk (`du -sk web/dist`).
- npm package 0.1.8 (`npm pack` of `packages/wuica` after `build.sh`): tarball 2,105,320 bytes, unpacked 2,375,054 bytes, 47
  files. Installed from that local tarball into an empty project: 1 package, 48 files, 2.4 MB (`du -sk node_modules`), 0.28 s
  (no network). The registry's latest is 0.1.7 (unpacked 2,327,182 bytes, 44 files; `npm view wuica-cli`).

### 7.2 Time per analysis

| Measurement | Value | Source |
|---|---|---|
| WebAssembly, warm, Node 22, measurement machine | BHive block 0.517 ms, random loop 0.633 ms, 1000-instruction block 10.95 ms, 3000 instructions 38.6 ms, SHA-256 block (2,949 instructions) 36.05 ms | Commit messages `4c93a30`, `6cb0b9f`, `623a117` (best of 5 batches; perf round 3, before model rounds 6–9) |
| WebAssembly, the whole fixture corpus | 0.37 ms per case (quiet development machine, every 5th case); 1.07 ms per case (measured here, 4 shards in parallel with the full check) | `docs/plans/features-r2.md`, "Speed"; `target/check/analyze_fixtures_*.log` |
| Native (Rust), quiet development machine | 195 µs for "the four basic examples", 18.4 ms for SHA-256; with `details`: +8 % / +27 % | `docs/plans/features-r2.md`, "Speed" (`crates/wuica/examples/phases.rs`) |
| First analysis in a new instance (V8 compiles lazily) | 17.5 ms small block, 107 ms SHA-256 (later 1.9 / 40 ms); with a warm-up analysis and a pause: 54–61 ms | `docs/PORTING.md`, "Speed" (measurement machine) |
| Loading a table into a new instance | 2–15 ms; all 15: 80 ms; nearly all of it `serde_json` | `docs/PORTING.md`, "Speed"; commit `3e7719b` |
| npm `createWuica` | 45 ms, of which 14 ms brotli decompression of the module | `docs/PORTING.md`, "Speed" |
| `-arch all` on SHA-256 (npm) | 0.60 s with 4 or 8 threads, 0.67 s with 12, 0.71 s with 15, 1.04 s without threads; a thread start ≈ 80 ms | `docs/PORTING.md`, "Speed"; `packages/wuica/lib/threads.js` |
| Page, first result of a fresh visit | 163 ms cold (first paint 64 ms), 65 ms with the service worker (headless Chrome, 1440×900, median of 6; network conditions not stated) | `docs/plans/features-r3.md`, "Speed" |
| Assembler, 100-line input | 0.47–0.74 ms warm; 9.5–16 ms first call in a fresh instance | `assembler/README.md`, "Timings" |
| llvm-mca, SHA-256, 101 iterations | about 0.4 s | `mca/README.md` |

### 7.3 Whole CLI runs and peak memory (measured here)

`/usr/bin/time -l`, three to five runs each, typical value; `node -e 0` alone takes 0.05 s and 46 MB. npm package 0.1.8
installed from the local tarball.

| Command | Wall time | Peak RSS |
|---|---:|---:|
| `wuica --version` | 0.07 s | 51 MB |
| `wuica -example saxpy -arch SKL -TPonly` | 0.16 s | 115 MB |
| `wuica -example saxpy -arch all` (default threads) | 0.26 s | 343 MB |
| `wuica -example saxpy -arch all -threads 1` | 0.25 s | 200 MB |
| `wuica -example sha256 -arch SKL -TPonly` | 0.18 s | 165 MB |
| `wuica -example sha256 -arch all` (default threads) | 0.51 s | 670 MB |
| `wuica -example sha256 -arch all -threads 1` | 0.70 s | 310 MB |
| reference binary `wuica <saxpy hex> -arch SKL -TPonly` (`check-fast` profile, 50 runs in a loop) | 7 ms per run | 10 MB |

### 7.4 Memory inside the module

An analyzer instance holds 2.5 MB with no table, about 10 MB with one, 20 MB with five and 54 MB with all 15
(`web/js/pool.js`, header comment). WebAssembly memory never shrinks; heavy inputs grow it to gigabytes (a 5,000-instruction
block for 1,000 iterations: about 2 GB, `server/lib/wasm-limits.js`). Hosts cap or recycle: page 512 MB per worker, package
threads 256 MiB–1 GiB, server 2048 MB and recycle after +256 MB (section 4.5).

### 7.5 Throughput of the test corpus itself

Native simulation of the corpus: 1.04 ms per case on one thread (measured here, under load; `wuica-core:sim_fixtures` log).
The full check (`scripts/check.sh full --no-skip`) took 12 minutes on GitHub Actions for `67a384b` (run started 03:04,
finished 03:16 UTC, conclusion success; `gh run list`).

### 7.6 Tests and CI

Counts from the last local `scripts/check.sh full` run (development machine, 2026-11-23; `target/check/*.log`):

| Boundary or area | Suite(s) | Count |
|---|---|---|
| Decoder vs Python `xed` records | `wuica-xed:fixtures` (native), `tests-js/decode_fixtures.mjs` (wasm) | 3,948 file × chip cases (51,312 instructions), both |
| Instruction objects vs `getInstructions` + adjustments, every field | `wuica-core:instr_builder_fixtures`, `model_fixtures` | 8,056 + 3,990 cases (81,624 + 44,480 instructions) |
| Simulation: throughput, uop table, `-json` trace | `wuica-core:sim_fixtures` | 17,062 cases (19 without an instruction fixture skipped here, covered end to end); 1,919 traces; optional set `more`: 3,419 cases with traces |
| Bottleneck analysis | `wuica-core:facile_fixtures` | 7,182 + 9,880 compared |
| End to end, bytes → complete report text | `wuica:end_to_end` (native), `tests-js/analyze_fixtures.mjs 1` in 4 shards (wasm: `tp` and `text`) | 17,081 cases each |
| `details` changes no other field; critical path; dependency cycle | `wuica:details`, `critical_path`, `wuica-core:dependency_cycle` | 9,899; 9,899 (8,512 with a path); 36,138 |
| No panics | `wuica:fuzz_short`, `details_fuzz` (`crates/wuica/tests/fuzz/mod.rs`) | random real encodings, random options, all 15 CPUs |
| Same result through every interface but the page | `tests-js/interfaces.mjs` (library, wasm via `engine.js`, the reference binary, npm CLI, REST, both MCP servers; random requests) | 2,647 checks |
| npm package; server | `node --test` | 83; 63 tests |
| Page logic in Node (30 suites) | `tests-js/web_*.mjs` without a browser | 23,314 checks |
| Page in headless Chrome (19 suites) | `tests-js/web_*_browser.mjs`, `web_browser*.mjs` via `tests-js/cdp.mjs` | 1,276 checks |

Corpus: 329 files of random loops, BHive blocks, uiCA's microbenchmarks and blocks of 10/100/1000 instructions (main set,
9,899 simulation cases), plus 42 hand-written blocks for paths the main set misses (`fixtures/extra-src/x_*.s`: ZMM, stack,
high-8 registers, LCP, lock, rep, fences, microcode, x87, crash fixes; 7,182 cases), each over all configurations and option
variants (`docs/DESIGN.md`, `docs/PORTING.md`, "Fixtures"). The fixtures come from the reference with its crash fixes; the
inputs on which upstream uiCA raises an exception and what the fork does instead are listed in `docs/DEVIATIONS.md`.

CI (`.github/workflows/ci.yml`): every push to main and every pull request runs `scripts/check.sh full --no-skip` on
ubuntu-latest (Rust 1.100, Node 22, the runner's clang and Chrome, 1 Chrome suite at a time); a skipped suite fails. It does
not run the optional set `more` (not in the data asset, `ci/make-data-asset.sh`), does not build the assembler or llvm-mca
(downloaded), and does not check against real hardware.

## 8. Already done, and tried and rejected

Check this table before suggesting an optimization. "Identical results" means rule 3 held.

### 8.1 Done, with measured effect

| Change | Effect | Source |
|---|---|---|
| Own allocator in the module: segregated free lists for blocks ≤ 1 KB, dlmalloc for the rest (dlmalloc took ~15 % of the time) | ~15 % faster in the browser | `crates/wuica-wasm/src/alloc.rs`; commit `a5c1e19` |
| Release build with 1 codegen unit for the module | ~1.5 % faster, ~20 kB smaller gzipped | `build-wasm.sh` comment |
| Simulator: no per-cycle allocations, ring buffers and arena lists in the scheduler, flat front-end queues, uop templates, flat port/key arrays, Fx hashing for never-iterated maps | Simulation ~2× faster; allocations per small block 12,400 → 580 | Commit `2643986` |
| Scheduler/renamer: arena linked lists with reused nodes, skip idle resources, move-elimination rings | Allocations 669 → 434 per small block | Commit `397a4fe` |
| Compact static data per uop and instruction (attributes as bits); compact dynamic uops (120 → 56 bytes); internal state separate from the public result | ~5–10 % (round 2 together) | Commits `3da2dc9`, `4ac03a2`, merge `6dbd091` |
| Free internal arrays as soon as converted | Kernel page-fault time 812M → 197M cycles on a 3000-instruction block | Commit `a99e887` |
| Decoder writes compact binary records instead of JSON | Decode 27 → 15 µs | Commit `0ec09ad` |
| Non-simulator path (decode, builder, uop table, dependency limit, report) | 311 → 126 µs per small loop | Merge `4096fec`; builder `56b50c4` (22 → 18 µs) |
| Register lookup by bytes, plain byte search for substring tests, numeric keys in the latency graph, uop table text without formatting machinery | 1–4 % each on large blocks; perf round 3 total: wasm 6–7 % on large blocks | Commits `4c93a30`, `6cb0b9f`, `623a117`, merge `6a8a517` |
| Tables: FxHash for `IndexMap`s (order does not depend on the hasher), latencies read in place | Native load of 15 tables 44.1 → 39.9 ms; wasm SKL 8.8 → 7.6 ms, all 79.5 ms | Commit `3e7719b` |
| Page worker pool for all-CPU table, sweep, cost column | All CPUs 17 → 6 ms, sweep 71 → 17 ms, cost 12.6 → 4.0 ms (GEMM example, warm) | Commit `e0b0ac2` |
| npm threads share one compiled module and get a warm-up analysis while starting | First SHA-256 analysis in 8 new threads ~100 instead of ~230 ms | `packages/wuica/lib/threads.js`; commit `571373f` |
| Assembler size work: `-Oz`, full LTO, `LLVM_X86_MC_ASSEMBLER_ONLY` (printers etc. unregistered) | 4,514,176 → 3,802,001 bytes raw (−15.8 %) | `assembler/README.md`, "Size" |
| Brotli q11 precompression of modules and tables in the package | 22.7 MB → 2.0 MB (modules, tables, `uarch.json`) | `packages/wuica/build.sh` |

### 8.2 Measured and not kept

| Idea | Result | Source |
|---|---|---|
| `opt-level = 2` for the module | No gain | `build-wasm.sh` comment |
| `opt-level = "s"` (size) | 25 % slower | `build-wasm.sh` comment |
| `+simd128` | No gain; measured again in round 3: within 0.5 % | `build-wasm.sh` comment |
| `wasm-opt -O3`/`-O4` on the analyzer | No gain on the fixture run, a few % worse on real-code blocks; its size gain is only the dropped name section | `build-wasm.sh` comment |
| `wasm-opt -Oz` on the assembler | Raw −7.0 %, but gzip +1.5 % and brotli +3.1 %; files are served compressed | `assembler/README.md`, "Size" |
| More threads for `-arch all` | 12 or 15 threads slower than 4–8; on a small block 15 threads 12 % slower than none | `docs/PORTING.md`, "Speed" |
| A V8 code cache for the module in Node | Not available: `v8.serialize` of a module is empty in Node 22 and 26; in Chrome `compileStreaming`'s cache sped up compilation, not the first analysis | `docs/PORTING.md`, "Speed" |
| Early stop of the simulation once it is periodic | The owner reports it was measured and not kept; **no numbers are recorded in the repository** | — |
| Model changes (each round): e.g. ZEN3 fused CMP/TEST+Jcc on branch ports, ALU uops dispatched to any free ALU, steering to the producer's port, a `vpermd` throughput limit; others per round | Each fixed its target and made held-out or hand-written sets worse | `docs/ACCURACY.md`, "Not fixed", "Tried and not kept" (rounds 7 and 8) |

### 8.3 Measured, gain available, deliberately not taken

| Idea | Gain | Why not | Source |
|---|---|---|---|
| Strip the analyzer's `name` section (`llvm-objcopy --remove-section=name`) | 4.24 → 3.03 MB raw, 616 → 556 kB brotli (−60 kB), no change in compile time | Kept on purpose (`build-wasm.sh`: "the names are kept"); the profiling method of `docs/PORTING.md` reads function names from it | `build-wasm.sh` comment; `docs/PORTING.md`, "Speed" |

## 9. In progress for 0.1.9 (not released; on branches, may change)

- Several inputs per CLI run.
- Thread count chosen by the workload, and one compiled module shared across worker threads.
- The shipped JSON tables replaced by a build-time binary form (JSON stays the export format).
- Object files as CLI input.
- A redesigned trace view and a layout without pane scrolling.
- A model round on the two known ZEN3 errors (section 10.1).
- An audit of what the WebAssembly modules contain.

## 10. Known weaknesses and open questions

### 10.1 Model

- **Remaining ZEN3 errors** (`docs/ACCURACY.md`, round 9, "Not fixed"): the scalar prefix sum (`add edx, [rdi+rax*4]; mov
  [rsi+rax*4], edx; inc rax; cmp rcx, rax; jne`) is predicted 1.36 cycles per iteration against 1.00 measured (a sum
  reduction: 1.55 vs 1.07); in the model the index chain loses ALU ports to the older accumulator chain. Shuffle-heavy vector
  loops are 13–29 % optimistic (8 `vmulps` + 6 `vpalignr`: 4.67 predicted, 5.58 measured; `vpermd` costs 1.33 cycles when
  two or more are in a loop). The fixes tried are in section 8.2.
- **Not modelled**: cache misses, branch mispredictions, frequency changes; loads at constant addresses crossing a line; the
  extra latency of line-crossing loads (+1 cycle on the Ryzen, +6 to +7 on the Intel CPUs); store forwarding through an
  indexed read-modify-write whose address depends on data. A branch inside the loop body makes uiCA simulate both sides one
  after the other. The package and page flag these as caveats (`rmw-index`, `paths`, `exit`, `split`; `web/js/caveats.js`)
  rather than model them.
- Each prototype model was fitted to and measured on **one machine**; random loops are not typical code; BHive is one
  benchmark collection (`docs/ACCURACY.md`, "Limits"). uiCA's Intel models are not re-measured here.

### 10.2 Payload and start-up

- The page needs about 2.2 MB (served) before its first result in assembly mode, over 80 % of it the analyzer and the
  assembler. The live host compresses on the fly at a lower ratio than the package's precompressed brotli q11: 867 kB vs
  630 kB for the analyzer, 942 kB vs 688 kB for the assembler, 1.28 MB vs 0.68 MB for the tables (section 7.1).
- XED's decoder accounts for 54 % of the analyzer's code bytes; the 1.13 MB data section is unattributed.
- The JSON tables are parsed with `serde_json` on every load (2–15 ms each, 80 ms for all); the 0.1.9 binary form targets this.
- 61 unbundled JavaScript modules (no build step); their load order and request count have not been measured.

### 10.3 Memory

- The analyzer declares no memory maximum; memory never shrinks. Hosts work around it by capping and recycling (section 7.4).
- Several CPUs at once multiply memory: `-arch all` on SHA-256 peaks at 670 MB with default threads vs 310 MB on one thread,
  for a 27 % shorter run (section 7.3). Each thread holds its own instance, tables and V8 state.
- A `wbinvd` block (about 10^6 uops in the tables) is rejected, takes minutes, or runs out of memory depending on the CPU
  (`docs/WASM-API.md`, "Failures and traps").

### 10.4 Interfaces

- **The reference/test binary (Rust, not a product) takes machine code only**: syntax detection, loop finding, regions, what-if, caveats and insights
  exist only in JavaScript. A Rust user or a future native server gets less than `npx wuica-cli`.
- The package's `insights.js` and `whatif.js` re-implement the page's `bound.js` and `whatif.js`; agreement is tested on the
  built-in examples only (`tests-js/web_bound.mjs`, `web_whatif.mjs`).
- Option ranges differ per interface (library unlimited; stdio MCP 0–63, 1–100,000, 1–1,000,000; REST ≤ 1000, ≤ 20,000;
  page clamps; `packages/wuica/README.md`, "Option ranges per interface").
- `what_if` exists in MCP and the library, not in REST.

### 10.5 Tests

- No real-hardware check in CI: accuracy is re-measured by hand per model round on the three machines.
- CI does not run the optional `more` fixture set, and does not rebuild the assembler or llvm-mca.
- Browser suites contain wall-clock bounds (a trace draw within 16 ms locally, 48 ms on CI; long-task bound 200 ms;
  `tests-js/cdp.mjs` `FRAME_MS`, `TIMING_SLACK`); one failed once on a shared runner (commit `c5862d7`).
- `engines.node` is `>=20` but CI runs Node 22 only.
- No test of the deployed site in CI.
- The package copies in `packages/wuica/lib/web/` are refreshed by hand (`cp`); a test catches drift.

### 10.6 Process and project

- Single maintainer. The reference fork, the port and the measurements are done by the same person.
- Licensing of the instruction tables: they are derived from uops.info data via uiCA and generated locally; the repository
  does not state a license for them.
- Analytics: the live 0.1.8 page loads no analytics script (the served HTML has none, and at run time there are no external
  script elements and no requests to `cloudflareinsights.com`), so nothing is sent today. The CSP would still allow the
  host's beacon if the host injected it (`script-src https://static.cloudflareinsights.com`, `connect-src
  https://cloudflareinsights.com`; `web/index.html`), and what it would send, in particular whether it includes the URL
  fragment that holds the user's code, is not established. Open question: should the CSP allow it at all?
- The CSP is a `<meta>` tag, not a header (`web/_headers` sets no CSP).

### 10.7 Where the docs and the code disagree (the code wins)

| Doc | Says | Code / logs |
|---|---|---|
| `Cargo.toml` | Workspace version 0.1.0 (the crates are not published) | Package and server 0.1.8 |
| `packages/wuica/README.md` | Describes 0.1.8 (`-example`, …) | At the time of writing the registry's latest is 0.1.7, so `npx wuica-cli` does not have 0.1.8's features yet |

## 11. Feedback wanted

Answer any of these; cite the file and function.

1. **Exactness strategy.** Is three-boundary fixture testing on 17,081 cases, plus a fuzzer for panics, enough to trust
   exactness on inputs outside the corpus? Which reference paths are likely unexercised (e.g. options combined, ZMM code
   beyond the extra set, very long blocks)? Are there float-ordering or `round` risks in `crates/wuica-core/src/facile.rs`
   or `sim/` that the fixtures would not catch?
2. **Model design for the open ZEN3 errors** (section 10.1): what mechanism explains a prefix sum at 1.00 cycles with one
   load, one store and a 1-cycle add chain, given that "dispatch to any free ALU" fixed it but cost 1.4–2.4 points on random
   loops? What would explain `vpermd` at 1.33 cycles only when two or more are present?
3. **Payload and cold start**: given section 7.1, what would cut the first-visit 2.2 MB without breaking rules 1, 4 and 5 —
   e.g. serving the precompressed brotli files, splitting XED's decoder tables, loading the assembler later, the name
   section? Is the trade in section 8.3 right?
4. **API design for agents**: are the CLI's `-json` shapes, the MCP tools' schemas and the compact form
   (`packages/wuica/lib/{mcp,core,insights}.js`, `index.d.ts`) what an agent needs? What is missing (e.g. several inputs,
   a diff of two blocks, source-line mapping)?
5. **UI clarity**: is the default result readable without the docs, given rule 9? (Use the live page.)
6. **Test strategy**: which gap in section 10.5 matters most? How would you test accuracy continuously without a hardware
   lab in CI? Are the timing-bound browser checks worth their flakiness?

**Not wanted**: rewrites that break a hard rule (a different decoder, "approximately equal" results, server-side analysis for
the page, a runtime dependency in the package); suggestions already in section 8 without new evidence; style changes to the
docs' wording.

## 12. How to review

### 12.1 Files to ask for, per topic

| Topic | Files |
|---|---|
| Exactness rules and fixtures | `docs/DESIGN.md`, `docs/DEVIATIONS.md`, `crates/wuica-core/tests/sim_fixtures.rs`, `tests-js/analyze_fixtures.mjs`, `crates/wuica-core/src/jsoncmp.rs` |
| Simulator | `crates/wuica-core/src/sim/{mod,frontend,renamer,scheduler,prep,output}.rs`, `reference/uiCA/uiCA.py` |
| Instruction builder, tables | `crates/wuica-core/src/{instr_builder,data,config,model}.rs`, `reference/uiCA/instructions.py` |
| Bottlenecks, critical path | `crates/wuica-core/src/facile.rs`, `analyze.rs` |
| Module boundary, allocator | `crates/wuica-wasm/src/{lib,alloc}.rs`, `crates/wuica/src/lib.rs`, `docs/WASM-API.md`, `build-wasm.sh` |
| Decoder | `crates/wuica-xed/src/lib.rs`, `crates/wuica-xed/shim/wuica_xed.c` |
| Assembly input | `web/js/{loop-find,asm-regions,asm-text,assembler}.js`, `assembler/README.md` |
| Page | `web/index.html`, `web/js/{app,engine,engine-rpc,pool,url-state,godbolt}.js`, `web/sw.js`, `web/build.sh` |
| npm package | `packages/wuica/lib/{index,cli,mcp,threads,wasm,core,insights,whatif}.js`, `index.d.ts`, `README.md` |
| Server | `server/lib/{app,pool,facade,config,wasm-limits,ratelimit}.js`, `server/deploy/` (systemd unit, tunnel configuration) |
| Model accuracy | `docs/ACCURACY.md` (the measurement scripts and raw tables are in the fork, `microbench/`) |
| Tests and CI | `scripts/check.mjs`, `.github/workflows/ci.yml`, `ci/make-data-asset.sh`, `tests-js/interfaces.mjs` |

### 12.2 Build and check

Needs Rust 1.100 with `wasm32-unknown-unknown`, a clang with the wasm32 target (not Apple's), Node 22, Chrome for the
browser suites, and the generated `data/` and `fixtures/generated/` (from a uiCA checkout with `tools/export_all.sh`, or the
CI data asset named in `ci/data-asset.txt`). The assembler and llvm-mca modules come from the same asset.

    scripts/check.sh full          # builds what changed (module, site, package) and runs every suite in parallel
    scripts/check.sh               # quick subset, about a minute

Single pieces: `./build-wasm.sh`; `web/build.sh && python3 -m http.server -d web/dist 8000`; `packages/wuica/build.sh`;
`cargo run --release -p wuica-cli -- 4801d84801c349ffcf75f5 -arch SKL`.

### 12.3 Reproducing a number

| Number | Command |
|---|---|
| Module and table sizes | `wc -c web/dist/*.wasm web/dist/data/arch/*.json`; `gzip -9 -c F \| wc -c`; `brotli -q 11 -w 24 -c F \| wc -c` |
| Section sizes (name, code, data) | `wasm-objdump -h web/dist/wuica_wasm.wasm` (wabt) |
| Served sizes | `curl -s -o /dev/null -w '%{size_download}\n' -H 'Accept-Encoding: br, gzip' https://wuica.jacen.li/wuica_wasm.wasm` |
| Package size | `cd packages/wuica && npm pack --dry-run` |
| CLI time and memory | after `packages/wuica/build.sh`: `/usr/bin/time -l node packages/wuica/bin/wuica.js -example sha256 -arch all` (macOS; `-v` on Linux); the registry's 0.1.7 has no `-example` |
| Per-phase time and allocations (native) | `cargo run --release -p wuica --example phases -- ARCH N HEXFILE...` |
| Table load times | `cargo run --release -p wuica --example load -- [N] [TABLE...]` |
| WebAssembly per-case time | `node tests-js/analyze_fixtures.mjs 5` (prints ms per case) |
| Exactness | `cargo test --release -p wuica --test end_to_end`; `node tests-js/analyze_fixtures.mjs 1` |
| Outputs unchanged by a change | `cargo run --release -p wuica --example golden -- before.jsonl`, again after the change, then `diff` |
