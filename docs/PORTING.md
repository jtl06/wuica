# Working on the port

Read `docs/DESIGN.md` first: the architecture, the fixtures and, above all, the "Rules for an exact port".

## Setup

- Rust: `export PATH=$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH` (cargo is not on the default PATH on the
  development Mac).
- When several people or agents build at the same time, use your own target directory, e.g.
  `export CARGO_TARGET_DIR=$PWD/target-<name>` (`target*/` is ignored by git).
- `data/` (instruction tables, configurations) and `fixtures/generated/` are generated and not in git; they are present on the
  development Mac. `tools/export_data.py` and `tools/export_fixtures.py` regenerate them from a uiCA installation.

## Checks

`scripts/check.sh` builds what is out of date and runs every test suite in parallel (up to one job per CPU, at most 2 headless
Chrome suites at a time), each into `target/check/<suite>.log`, and prints one table: suite, result, time, the suite's count line.
On failure it prints the tail of the failed logs and exits with 1. `--list` shows the suites, `--only PATTERN` (a regular
expression) runs some of them and the builds they need.

- `scripts/check.sh` (= `quick`, about a minute): the simulation fixtures only for SKL and ZEN3, `analyze_fixtures.mjs 7`,
  `web_trace.mjs 16`, browser suites only if their last run took at most 10 s; no npm package, no doc tests. While working.
- `scripts/check.sh full`: everything (`analyze_fixtures.mjs 1` in 4 shards). The gate before a commit to main or a deploy.
- `typecheck` (in `full`): `scripts/typecheck.mjs`, `tsc --noEmit --checkJs` with the root `tsconfig.json` (strict, without
  `noImplicitAny`) over `packages/wuica/lib` and `bin`, `server/lib`, the page modules `packages/wuica/web-modules.json` lists,
  and `packages/wuica/typecheck/api.ts`, which uses the public API as the README does through `index.d.ts` and checks that
  `lib/index.js` has every declared export and method, accepting the declared arguments. TypeScript and `@types/node` (20, the
  package's oldest Node) are development dependencies of `packages/wuica`; nothing of them is shipped. The page's UI modules
  are not checked yet.
- `scripts/check.sh full --remote aethia`: the same on aethia, under a perfq lease (shared) taken from the Mac. The tree is
  copied to `~/wuica-check/` with rsync (`data/` and `fixtures/generated/` are linked to `~/wuica/`), with the WebAssembly
  module built on the Mac (aethia has no wasm32 target). aethia has no Chrome: the browser suites are skipped there.

The browser suites serve `web/dist` with `tests-js/static-host.mjs`, which behaves like the host (Cloudflare): `/index.html`
redirects to `/` and `/404.html` to `/404` (307), `/404` and missing files get `404.html` with status 404, `_headers` is
applied. `web_host_browser.mjs` checks the service worker against it (fresh profile, reloads, `/index.html`, offline). A new
browser suite should use `hostHandler` too, and is recognized as one (at most 2 at a time) if it starts Chrome with
`--headless` or `--remote-debugging-port`.

What makes it fast:
- Rust tests use the profile `check-fast` (`Cargo.toml`: release without LTO, 16 codegen units, incremental). The
  WebAssembly module and everything deployed keep `release` (fat LTO).
- The WebAssembly module, `web/dist` and `packages/wuica/dist` are rebuilt only when their inputs change (content hashes in
  `target/check/stamps/`). The test binaries are run directly, without cargo.
- `sccache` is used as `RUSTC_WRAPPER` when it is installed (`brew install sccache`; `WUICA_SCCACHE=0` turns it off). It
  helps a clean rebuild at the same path (12 s -> about 10 s: XED's C files and the registry crates are cached). In another
  worktree only the registry crates hit (paths differ, so XED's C files miss) and a clean build is about 2 s slower than
  without it; the workspace crates are incremental, which sccache does not cache.
- The Rust fixture tests read the fixtures through `wuica-testkit` (a dev-dependency): the smaller gzipped files are
  decompressed once into `target/fixture-cache/`, and tests that do not use the `json` field of the simulation fixtures
  (1.3 of their 1.4 GB) read a copy without it (`lines_without_json`). Copies are remade when a fixture's size or
  modification time changes; `WUICA_FIXTURE_CACHE=off` reads the gzipped files directly, `WUICA_FIXTURE_CACHE=DIR` puts the
  cache elsewhere (e.g. one for several worktrees). New fixture tests should read files with `wuica_testkit::lines`.

## CI

`.github/workflows/ci.yml` runs `scripts/check.sh full --no-skip` (a skipped suite fails) on GitHub Actions (ubuntu-latest,
Rust 1.100, Node 22, the runner's clang and Chrome) for pushes to main and pull requests; the table goes to the job summary,
the logs of a failed run are uploaded as the artifact `check-logs`. The generated files are not in git: the workflow
downloads them from the pre-release named in `ci/data-asset.txt` (`data/`, the four fixture files the suites read, the accuracy
table, and `assembler/dist/wuica_asm.wasm` and `mca/dist/wuica_mca.wasm`, whose LLVM builds are too heavy for CI) and checks their
sha256.

A second job, `node20`, runs the package on the oldest Node its `engines` field allows (`>=20`): it builds the analyzer and the
package from the asset's data (`ci/fetch-data-asset.sh --data-only`), runs `npm test` in `packages/wuica`, and installs the
packed tarball into an empty directory (`packages/wuica/test/smoke.sh`: the CLI with one and several CPUs, a batch of files,
`-md`, `-whatif`, and `wuica-mcp` over stdio). The server is not run there: its `engines` field says `>=22`.

The accuracy table `fixtures/generated/accuracy.jsonl.gz` (read by `crates/wuica/tests/accuracy_gate.rs`; see `docs/ACCURACY.md`,
"Policy and the accuracy gate") is made in the fork's tree on the reference machine from the measurement files of the sets and their
prediction caches (`microbench/measurements/fuzz/`, the caches are not in git) and the dogfood loops:

    cd microbench && ~/uica-zen/venv/bin/python accuracy_export.py OUT/accuracy.jsonl.gz \
      holdout7:<improve-r9 tree>/microbench/measurements/fuzz bhive5:<improve-r9 tree>/microbench/measurements/fuzz \
      holdout8 bhive6 dogfood -reference=OUT/accuracy_reference.json

(`-reference` also writes the numbers the gate must reproduce, computed with the Python reference). Its first line is a header (format,
analysis options, per set the rounding of the prediction), then one line per loop: set, name, machine code, analysis mode, measured
cycles per CPU where the loop counts. When the model changes on purpose, accept the gate's new numbers with
`WUICA_ACCURACY_ACCEPT=1 cargo test --release -p wuica --test accuracy_gate` (rewrites `crates/wuica/tests/accuracy_expected.json`).

When the data, the fixtures or the assembler change, publish a new asset (the old release stays for older commits):

    ci/make-data-asset.sh ci-data-v2 [SRC]   # SRC: a checkout with the files (default: this one); updates ci/data-asset.txt
    gh release create ci-data-v2 target/ci-data/wuica-ci-data.tar.xz --prerelease \
      --title "CI data (generated test fixtures and tables)" \
      --notes $'Generated from uiCA with tools/export_*.py;\nused by the CI workflow.'

then commit `ci/data-asset.txt` with the change that needs it. A new fixture file that a default suite reads also has to be
added to the list in `ci/make-data-asset.sh`.

## Releases

The version is written in 15 places: the page (`web/js/app.js` `VERSION`), `packages/wuica` and `server/` (their
`package.json` and lock files), and the Rust workspace (`Cargo.toml`'s `[workspace.package]` version and the workspace crates in
`Cargo.lock`). `node scripts/check-version.mjs [VERSION]` lists them and fails unless all are equal (and equal to `VERSION` if
given); the suite `web_version` runs it in every check. Bump them together.

After a deploy, `scripts/smoke-live.sh VERSION` checks what is live, reading only: the site in headless Chrome (the footer's
version, the service worker's cache named after the stamp in `/sw.js`, one analysis, and the bytes on the wire of the first
visit and of the 15 tables against `tests-js/budgets.mjs`, which `web_host_browser` checks for the build: the check that would
have caught the uncompressed tables of 0.1.9; also that the analyzer, the assembler and the tables arrive compressed) and the API
(`/healthz`, `/api/version` for the package and the server, one analyze, one compare, MCP `tools/list` and one `what_if`).
`--site URL` and `--api URL` point it elsewhere (a staging host, a local server), `--no-site`/`--no-api` skip a part.

Before a release, on the reference machine: `tools/fuzz/run.sh --cases 100000 --seed <new seed>` (under a shared lease; see
"Differential fuzzer"); every case must be `same`, or its finding explained.

## Speed

- `cargo run --release -p wuica --example phases -- ARCH N HEXFILE...`: the time and the allocations of each phase (native).
- `cargo run --release -p wuica --example load -- [N] [TABLE...]`: the time of `load_uarch` and of `load_arch` for each table.
- The WebAssembly module: `node --cpu-prof` on a script that calls `wuica_analyze` in a loop, with
  `target/wasm32-unknown-unknown/release/wuica_wasm.debug.wasm`: the profile names the module's functions from its name section,
  which the shipped `wuica_wasm.wasm` does not have (`build-wasm.sh`; the same code, so a `wasm-function[N]` frame of the shipped
  module is function N of the named one). A function that is inlined into its caller does not appear on its own.
- Report numbers from aethia under an exclusive perfq lease; the Mac varies by a factor of two when other work runs there.
- Before optimizing, check that every response stays the same, including the trace and the fields that
  `analyze_fixtures.mjs` does not compare: `examples/golden.rs` writes every fixture response; compare its output before and
  after the change.
- Known costs (aethia, node 22, round 3): V8 compiles a function when it is first called, with its baseline compiler first. The
  first analysis in a new instance therefore takes 17.5 ms for a small block, where later analyses take 1.9 ms, and 107 ms for
  the SHA-256 showcase, where later ones take 40 ms. Node has no code cache for WebAssembly modules (`v8.serialize` of a
  module gives an empty result in node 22 and 26). In headless Chrome (Mac) the first analysis of the showcase takes 60-66 ms
  and later ones 25 ms, also on a second visit and with `WebAssembly.compileStreaming` (whose code cache made the compilation
  faster, not the first analysis). Loading a table takes 2 to 15 ms in a new instance (80 ms for all 15 tables), nearly all of
  it `serde_json`; the first table also compiles the parser (8 to 11 ms for SKL). The npm package (aethia): `createWuica` 45 ms
  (14 ms of it the brotli decompression of the module), the first analysis of a 1-byte block with the SKL table 51 ms, the
  first showcase analysis after it 92 ms, the next 47 ms. The scheduler re-checks no uop: every uop in `nonReadyUops` and
  `pendingUops` is visited once (counted on the blocks of the benchmark), so its work per cycle is proportional to the uops in
  flight, not to the size of the block.
- Threads and warm-up (aethia, node 22, round 4). The first analysis is slow because V8 compiles each function at its first
  call with its baseline compiler and optimizes the hot ones in the background later; the compiled code belongs to the
  `WebAssembly.Module`, so it is shared by the instances in worker threads that were given the same module. One analysis of
  a 482-instruction block (`WARM_HEX`, ~10 ms) followed by a pause gets most of it optimized: the first showcase analysis
  then takes 54-61 ms instead of 78-83 (later ones 47-50) in Node, and 58 instead of 66 ms in headless Chrome (Mac; later
  ones 29 ms); without the pause (the optimizing compiler still running) it gains nothing. Several cold analyses at once are
  slower than one: in 8 new threads the first showcase analysis takes 210-256 ms (one thread: 112-160; warmed module:
  85-142), and even warm ones take ~85 instead of ~45 ms with 8 threads busy (shared cores and clock). Starting a thread
  takes ~80 ms, and stopping threads at exit ~3 ms per thread plus their memory (8 threads after the showcase: 45-60 ms,
  15: 73 ms). So `-arch all` on the showcase takes 0.60 s with 4 or 8 threads, 0.67 s with 12 and 0.71 s with 15 (1.04 s
  without), and on a small block 8 threads are as fast as none and 15 are 12% slower; the default is one thread per two
  microarchitectures. `-arch all` minus `-arch SKL` is the cost of the other 14: 0.73 s before, 0.30 s on threads.
- Threads by work (round 0.1.9; the measurement machine, node 22, 5 runs, medians; the Mac in parentheses). The default
  is no longer one thread per two CPUs but comes from the work of a call (threads.js, `WORK`): each table loaded once
  (8 ms), each analysis 1.2 ms plus 0.009 ms per instruction (SKL: saxpy 1.1 ms, the SHA-256 block 26 ms, Mac). Below
  300 ms of estimated work no threads; above, one per 150 ms, from 2 to 8, at most the cores but one. A thread costs
  about 50-60 MB (its isolate, its tables, its memory) and saves nothing on short work. `-arch all` on saxpy: 0.37 s
  with no thread, 0.38-0.42 s with 2-8 (197 MB against 240-347 MB): none. The SHA-256 block on all 15 CPUs: 1.01 s with
  none, 0.75 / 0.60 / 0.62 s with 2 / 4 / 8 (236 / 296 / 405 / 597 MB): the default picks 4 (0.61 s, 400 MB). 20
  SHA-256 blocks on SKL: 1.18 / 0.94 / 0.79 / 0.78 s with 1 / 2 / 4 / 8: 4 (0.79 s). 50 small blocks on 3 CPUs:
  0.44 s with none, 0.48-0.55 s with threads: none. The SHA-256 block on 3 CPUs (105 ms of estimated work): none, 0.42 s
  against 0.39-0.42 s with threads, at 195 instead of 277-311 MB.
- Batches (wuica a.s b.s ...): 50 small files in one process instead of 50: 0.39 s instead of 14.4 s on SKL, 0.43 s
  instead of 18.2 s on 3 CPUs; 20 SHA-256 blocks: 0.79 s instead of 6.5 s (Mac: 0.21 / 0.24 / 0.41 s instead of 7.6 /
  7.9 / 3.5 s).
- Memory (0.1.8 -> 0.1.9, peak RSS, the measurement machine; Mac in parentheses): saxpy on 3 CPUs 233 -> 159 MB (186 ->
  124), `-arch all` 396 -> 193 MB (347 -> 157), the SHA-256 block on all CPUs 676 -> 445 MB (673 -> 470), `-whatif` on 3
  CPUs 252 -> 183 MB (214 -> 155): fewer threads, binary tables (SKL: 4 instead of 6 MB of WebAssembly memory), no copy
  of decompressed bytes, table bytes not kept (read again after a trap). A small run on one CPU is 133-139 MB (100-111
  on the Mac) against node's 56 (46): no single cause. On the Mac: the analyzer's module decompressed and compiled
  +24 MB, the code V8 compiles for loading a table +8 MB and for the first analysis +15 MB, the assembler (assembly
  input only) +17 MB with its decompression. Freeing the assembler before the analysis lowers the peak by 5 MB only
  with a forced garbage collection: not done.
- Binary tables: 14.6 MB of JSON -> 6.4 MB (brotli 681 -> 614 kB for the 15); loading a table (decompress and load,
  warm) SKL 2.2 -> 1.4 ms, ADL-P 6.1 -> 3.7 ms, all 15 55 -> 33 ms (Mac); the analyzer module grows by 21 kB.

## Size of the modules

Measured on 0.1.8 (sizes in bytes; brotli with the command-line tool, window 24 unless said otherwise).

- The analyzer, `wuica_wasm.wasm`: 4,307,652 with the name section, 3,093,000 without (shipped so after 0.1.8, `build-wasm.sh`):
  code 1,898,829, data 1,125,476, function table (element section) 46,422, the rest under 22 kB. Brotli -q 11: 629,775 ->
  569,418; -q 4: 841,200 -> 747,612; gzip -9: 924,647 -> 816,848. Code: Rust 814,584 (`wuica-core` ~455 k, `serde_json` ~173 k,
  formatting and float parsing of `core`), XED 1,084,242 (the decoder's 19,719 small `xed3_phash_find_*` functions 727 k in
  `xed3-phash-lu-vv*.c`, `xed3-dynamic-decode.c` 256 k, the shim's `decode` with the record writer 36 k, the Intel disassembler
  `xed-disas.c` 12 k). Data: XED ~1.07 MB (the phash lookup tables 477 k, `xed_inst_table` 91 k, the decoder's function-pointer
  tables 61 k, `xed_iform_db` 55 k, the iform names 222 k of strings plus 55 k of pointers, the iclass names 15 k + 14 k), Rust
  ~60 kB plus its strings. Everything of XED that is linked is reached: the linker keeps only what is called (`wasm-ld`
  collects unused functions and data, and clang puts each in its own section for wasm by default:
  `-ffunction-sections -fdata-sections` gives the same bytes), and the shim uses the iclass, iform, category, extension,
  isa-set, operand, register and operand-action names, `str2xed_chip_enum_t` and `xed_format_generic` (the `asm` field); the
  enums it does not print (e.g. `xed-iformfl-enum.c`) are not in the module. Identical data symbols: 5 kB.
- `panic = "abort"` is already the target's default for wasm32-unknown-unknown (setting it changes only the order of a few
  functions and strings: 64 bytes). Brotli -q 11 moves by up to 6 kB with such reorderings (563,389 for that build), so
  differences of a few kB at -q 11 are noise; -q 4 moved by 76 bytes.
- `wasm-opt -Oz` (binaryen 123) on the stripped module: 2,714,295 raw but 578,742 with brotli -q 11, 771,552 with -q 4 and
  818,200 with gzip: larger compressed than the module it started from. Not used.
- The LLVM modules have no custom sections at all (no name section to strip): the assembler 3,802,001 (code 967,243, data
  2,827,957; brotli -q 11 687,897), llvm-mca 4,376,885 (code 1,134,742, data 3,233,333; -q 11 801,898). Their data is 44% zero
  bytes but in short runs (runs of 64 or more: 21 kB and 55 kB), so splitting the data segments would not help either.
- One module for the assembler and llvm-mca: the two compressed in one brotli stream (-q 11) are 921,005 instead of 1,489,795
  apart, so they share ~570 kB of compressed content (the x86 tables and MC); llvm-mca adds only ~233 kB to the assembler.
  A merged module would therefore be ~233 kB (~34%) larger for a visitor who never opens the llvm-mca tab, and save ~570 kB
  for one who does; it would also lose the assembler-only patch. Not done: the assembler is on the common path.
- What the site sends: the host compresses on the fly at a low brotli level. Measured on the live site (0.1.8): the analyzer
  866,526 (brotli -q 11: 629,775), the assembler 941,580 (687,897), llvm-mca 1,103,294 (801,898), the 15 tables 1,280,826
  (680,863). The host has no setting for the level (Compression Rules choose only the algorithm), and its documentation of static
  assets says nothing about precompressed files (a `Content-Encoding` set in `_headers` is reported not to work; not tried
  here). A Worker in front of the `.wasm` paths (`run_worker_first`) can return a
  precompressed `.br` file with `Content-Encoding: br` and `encodeBody: "manual"`, which the browser decodes itself.
  Measured with the local host (`tests-js/static-host.mjs` serving brotli: -q 2 for everything, close to the site's sizes,
  or the two modules precompressed at -q 11), time to the first result of a fresh visit in headless Chrome (median of 3):
  unthrottled 232 / 217 / 224 ms (with names / stripped / stripped at -q 11), 10 Mbit/s with 40 ms latency 2,582 / 2,499 /
  2,084 ms, 4 Mbit/s with 80 ms 5,690 / 5,567 / 4,548 ms; the two modules on the wire 1,848,252 / 1,757,297 / 1,257,315.
  Decompressing in the page instead needs a brotli decoder in JavaScript or WebAssembly in Chrome: `DecompressionStream`
  has no `brotli` in Chrome 157 (Node has it); `gzip` it has everywhere, but gzip -9 of the stripped analyzer (816,848) is
  larger than the host's brotli of it. A proposal for the Worker: `docs/plans/precompressed-modules.md`.
- XED's iform names in the analyzer: 219,323 bytes of strings and 54,944 of pointers; the module with them zeroed is 41 kB
  smaller with brotli -q 11 and 60 kB with -q 4 (the iclass names: 12,566 + 13,968 bytes, 0.5 / 12 kB). Who reads them: the
  shim writes the iform and iclass of every instruction into the decoded records, as uiCA's `xed` module does; `wuica-core`
  looks the instruction up in the table by iform name (`instrData`), takes the iclass from the iform's first word (MOV
  elimination, ADD/SUB/INC/DEC/LEA rules, `memRenamingExcluded`) and matches the serializing and fence iforms by name;
  `wuica_decode` returns both names (docs/WASM-API.md; the server counts the instructions of its output by the `"iclass"` keys). The text output and the page do not show them. Dropping the strings
  needs tables keyed by the numeric iform of this XED version, the iclass rules on numbers, and the names of
  `wuica_decode` from elsewhere (or that export changed).
- The page's modules: `js/app.js` imports 51 modules statically, in four levels, and the analyzer's download starts only
  when app.js runs, after all of them. `web/build.sh` adds a `<link rel="modulepreload">` for each (found from the imports
  at build time). First result of a fresh visit (everything at brotli -q 2, median of 10, the local host, which speaks
  HTTP/1.1, so Chrome fetches six modules at a time either way; the site's HTTP/2 should gain about the three round trips
  saved): 10 Mbit/s, 40 ms: 2,505 -> 2,444 ms; 4 Mbit/s, 80 ms: 5,561 -> 5,474 ms. A `<link rel="preload" as="fetch">` for
  the two modules as well: 2,330 ms at 10 Mbit/s (median of 3; not done: the mock page and visits that never need the assembler would
  download a module they do not use, and Chrome warns about an unused preload).
- The default example without the assembler (a visit with the same example as machine code, the proxy for shipping the
  example's bytes): 1,171,367 instead of 2,153,091 bytes before the first result, 10 Mbit/s: 2,553 -> 1,728 ms, 4 Mbit/s:
  5,503 -> 3,685 ms.

## The reference

The reference is [jtl06/uiCA](https://github.com/jtl06/uiCA), branch `improve-r10` (model at commit `7301b04`; not pushed yet,
worktree `/data/projects/uica-r10` on the reference machine): the model change of round 10 (see `docs/ACCURACY.md`) on top of
`improve-r9` (model and data at `640e40e`, pushed; branch tip `5a07a40`) on top of `improve-r8` (model `c899be7`: the changes of
round 8) on top of `improve-r7` (model `f4a7868`: the changes of round 7) on top of `improve-r6`
(`21b0b17`: the model changes of round 6, `9bed908`, merged with branch
`crash-fixes`, `f85fcbd`: branch `perf` (`adf62ae`, whose output is identical to that of `8f24bd3`) plus the fixes of the inputs on
which uiCA raised an exception, `docs/DEVIATIONS.md`). All fixtures in `fixtures/generated` are exported from it
(`tools/export_all.sh`, and the set `more` with `REPLAY=`).

- Read: `reference/uiCA/*.py` is still `8f24bd3`; the fixed code differs from it by the commits listed in `docs/DEVIATIONS.md`
  (`git diff adf62ae f85fcbd -- uiCA.py` in the fork). The decoder's C code that produces the decoded records is mirrored in
  `crates/wuica-xed/shim/wuica_xed.c`.
- Run: on the host `aethia` (`ssh aethia`), the fixed reference is installed in `~/uica-zen/uiCA-crashfix` (branch `crash-fixes`;
  the unfixed one in `~/uica-zen/uiCA-perf`; `improve-r6` in `~/uica-zen/uiCA-r6`; `improve-r7` in `~/uica-zen/uiCA-r7`;
  `improve-r8` in `~/uica-zen/uiCA-r8`; `improve-r9` in `/data/projects/uica-r9`; the reference of this branch, `improve-r10`, in
  `/data/projects/uica-r10`; never modify any of them), with the Python interpreter `~/uica-zen/venv/bin/python`. To add debug output, copy the directory (e.g. to `~/uicaspeed/<name>/uiCA`, 60 MB) and
  edit the copy. Example: `cd ~/uica-zen/uiCA-perf && ~/uica-zen/venv/bin/python -c "import xed, uiCA; ..."`; the functions take
  the list returned by `xed.disasHex(hexString, chip=config.XEDName)`.
- aethia is also a measurement machine. A single short Python run is fine. Anything CPU-heavy (more than a few seconds, or
  parallel) must hold a lease, taken from the Mac: `~/perfq/perfq ssh aethia --est 5m --mode shared -- 'COMMAND'` (it blocks while
  queued; a lease ends after 10 minutes). No sudo, no installing anything outside your own directory.

## Fixtures

One JSON object per line, gzip. A case with an `error` field is one where the reference raised an exception. The fixed reference
raises none on the fixtures; the only exception it raises on purpose is `InputError` (an input that cannot be analyzed), and a case
with `"error": "InputError: <message>"` must give an error with the text `<message>` (the tests check this, and treat any other
`error` as a failure). The sets were exported with `tools/export_fixtures.py` (the extra set with `FRESH=1`; the set `more` with
`REPLAY=`); with the fixed reference, every case that did not fail before is byte-identical to the export from `adf62ae`.

- `fixtures/decode_fixtures.jsonl.gz`: `{file, chip, hex, instrs}`: decoder output (`instrs` deserializes into
  `wuica_core::decoded::DecodedInstr`; the extra `ast` field is ignored) for each file and each XED chip name.
- `fixtures/generated/instr_fixtures.jsonl.gz`: `{file, arch, options, hex, operands, instrs}`: `{operands, instrs}` is the JSON
  form of `wuica_core::model::InstrList` for the configuration `arch` (a key of `configs` in `data/uarch.json`). `options` is `{}`
  or one of `{"alignmentOffset": n}`, `{"noMicroFusion": true}`, `{"noMacroFusion": true}`.
- `fixtures/generated/sim_fixtures.jsonl.gz`: `{file, arch, options, hex, TP, stdout[, json]}`: the result of
  `runSimulation(..., printDetails=True)`: the throughput, the text it prints, and for some cases the content of the `-json`
  file. `options` can also contain `initPolicy`, `simpleFrontEnd`, `minIterations`, `minCycles` (defaults: alignmentOffset 0,
  initPolicy "diff", simpleFrontEnd false, minIterations 10, minCycles 500). Blocks of more than 2000 bytes have simulation cases
  but no instruction-object cases.

**Extra set** (same formats; files `fixtures/decode_fixtures_extra.jsonl.gz`, `fixtures/generated/extra_instr_fixtures.jsonl.gz`,
`fixtures/generated/extra_sim_fixtures.jsonl.gz`; sources in `fixtures/extra-src/x_*.s`): 36 hand-written blocks (and since round 9
six more, `x_r9_*.s`, and since round 10 four more, `x_r10_*.s`) for paths that
the main corpus does not reach (ZMM registers, stack operations, high-8 registers, LCP, lock, rep, fences, microcode, x87, ...,
and four blocks for the crash fixes: `x_dsb_fused_mid*.s`, `x_push_mem_pair.s`, `x_stack_init.s`), each with all option variants
and, for some cases, the `-json` output (7182 simulation cases, 798 of them with the `-json` output; 3990 instruction-object
cases). Every case was run in a new process (`FRESH=1`),
like a run of the command-line tool: the reference modifies its instruction tables in place for code that uses ZMM registers, so
within one process earlier cases can change later ones (the main set has no ZMM code).

**Set `more`** (`fixtures/generated/more_sim_fixtures.jsonl.gz`, optional): 3419 simulation cases of main and extra blocks with
options, each with the `-json` output; made with `REPLAY=<the previous file> tools/export_fixtures.py UICA_DIR OUT_FILE`. The
simulation fixture test reads it with `WUICA_SET=more WUICA_MORE_SIM_FIXTURES=<path>`; `scripts/check.sh full` runs it if the file
is present.

Current sets: exported from the fork's `improve-r10` (`7301b04`) on the reference machine with `/data/projects/wuica-r10/export_r10.sh`
into `/data/projects/wuica-r10/r10` (`data/`, `fix/`; a copy on the development Mac in `~/Documents/blackedge/wuica-r10-exports/r10`,
`data/` and `fixtures-generated/`), with the sources of the extra blocks from `~/uicaspeed/wuica-fix-crash/extra-src`, the six blocks of
round 9 (`fixtures/extra-src/x_r9_*.s`) and four of round 10 (`x_r10_*.s`: chains across vector domains, `vperm2i128` + `vpaddd`,
an FP mix, the dogfood loop `fir8_s`; the extra set now has 46 blocks), and the cases of the set `more` replayed from
`~/uicaspeed/wuica-fix-crash/final`. Compared with the export of `improve-r9`: simulation fixtures 5 cases of ZEN3 differ; extra
simulation fixtures 26 of ZEN3, plus the cases of the new blocks (20 instruction and 36 simulation cases per configuration); set
`more`: 5 of ZEN3; instruction fixtures unchanged. `fixtures/decode_fixtures_extra.jsonl.gz` gained the decoder cases of the new
blocks; of the tables only `uarch.json` changed (the new field `domainBypassDelay`). CI needs these files as the data asset
`ci-data-v8` (with the accuracy table); `ci/data-asset.txt` names it. Earlier sets: `crash-fixes` (`f85fcbd`) in
`~/uicaspeed/wuica-fix-crash/final`; `improve-r6` in `~/projects/wuica-r6/r6m`; `improve-r7` in `~/projects/wuica-r7/t1`;
`improve-r8` in `~/projects/wuica-r8/r8`; `improve-r9` in `/data/projects/wuica-r9/r9`.

The decoded records of a case are found in the decode fixtures by `file` and the chip `configs[arch].XEDName`.
Compare JSON with `wuica_core::jsoncmp::diff` (numbers by value, object key order ignored).

## Differential fuzzer

`tools/fuzz/run.sh --cases N --seed S [--arch X] [--jobs J] [--out DIR]` runs random blocks through the Python reference and through
the native binary and compares throughput, report text and `-json` output field by field (as the fixture tests do). It runs on
the reference machine (`UICA_DIR`, default `/data/projects/wuica-fuzz/uica`: a worktree of the fork at the reference commit with
`instrData/` and the `xed` module copied from the reference tree; `PYTHON`); on aethia under `perfq ssh aethia --mode shared
--resumable`. A rerun with the same arguments skips the chunks already done.

- Pool (`fuzz.py pool`, once per output directory): the encodings of the decode fixtures, random changes of their register
  fields, REX/VEX bits and immediates, and the instances of `tools/fuzz/templates.py` assembled with GNU `as`; each checked with
  the reference's decoder and tables for each CPU (forms it decodes, with and without data), without branches, system
  instructions and forms of more than 200 uops.
- Blocks (`fuzz.py gen`): 1 to 64 instructions of the forms the CPU supports (2 % without data), drawn uniformly or with a bias to
  a few themes (shuffles, lane-crossing ymm, MUL, rotates, narrow stores, SSE/AVX, high-8 registers, rip-relative operands, LCP,
  zero idioms, eliminable moves, stack instructions, microcode); 80 % end in a branch to the start (macro-fusible pair, jcc, jmp,
  rel8 or rel32). Case `i` of seed `S` depends only on `(S, i)`, the pool and `--arch`.
- Options: a quarter of the cases with the defaults, the others from a pairwise covering array (960 rows) of CPU ×
  `alignmentOffset` 0..63 × `initPolicy` × `simpleFrontEnd` × `noMicroFusion` × `noMacroFusion` × 11 `minIterations`/`minCycles`
  pairs (0 and negative values among them).
- Reference: worker processes (as the exporter), an alarm per case (120 s), a fork per case with ZMM registers (the reference
  changes its tables in place for them). `fuzz.py calibrate UICA_DIR FIXTURES N` checks that the runner reproduces fixture lines
  byte for byte. A `-json` output above 16 MB is not compared (counted as such; throughput and text still are).
- wuica: `wuica -compare FILE|-` (crates/wuica-cli/src/compare.rs) reads the reference's lines and prints one verdict per case:
  `same`, `differs` (TP, stdout, json or the input error), `wuica-error`, `wuica-panic`, `ref-crash`, `ref-timeout`.
- Each kind of difference: run again with the reference in a new process, minimized (ddmin over the instructions, then the
  options and the end of the block), classified (port divergence, reference crash or hang, or a deviation of
  `docs/DEVIATIONS.md`) and written to `DIR/findings/<class>-<CPU>-<hash>.json`; `DIR/summary.json` has the verdicts per CPU.
  `fuzz.py replay FINDING.json` runs a finding again.

## Shared code

`crates/wuica-core/src/{model,config,decoded,x64,jsoncmp}.rs` are the contract between the parts. If one of them needs a change,
make the smallest possible change and say so clearly, because other work depends on them.
