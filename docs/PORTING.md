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
downloads them from the pre-release named in `ci/data-asset.txt` (`data/`, the four fixture files the suites read, and
`assembler/dist/wuica_asm.wasm`, whose LLVM build is too heavy for CI) and checks their sha256.

When the data, the fixtures or the assembler change, publish a new asset (the old release stays for older commits):

    ci/make-data-asset.sh ci-data-v2 [SRC]   # SRC: a checkout with the files (default: this one); updates ci/data-asset.txt
    gh release create ci-data-v2 target/ci-data/wuica-ci-data.tar.xz --prerelease \
      --title "CI data (generated test fixtures and tables)" \
      --notes $'Generated from uiCA with tools/export_*.py;\nused by the CI workflow.'

then commit `ci/data-asset.txt` with the change that needs it. A new fixture file that a default suite reads also has to be
added to the list in `ci/make-data-asset.sh`.

## Speed

- `cargo run --release -p wuica --example phases -- ARCH N HEXFILE...`: the time and the allocations of each phase (native).
- `cargo run --release -p wuica --example load -- [N] [TABLE...]`: the time of `load_uarch` and of `load_arch` for each table.
- The WebAssembly module: `node --cpu-prof` on a script that calls `wuica_analyze` in a loop; the profile names the module's
  functions (from its name section). A function that is inlined into its caller does not appear on its own.
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

## The reference

The reference is [jtl06/uiCA](https://github.com/jtl06/uiCA), branch `improve-r9` (model and data at commit `640e40e`, pushed;
the branch tip is `5a07a40`; worktree aethia `/data/projects/uica-r9`): the model changes of round 9 (see `docs/ACCURACY.md`)
on top of `improve-r8` (model `c899be7`: the changes of round 8) on top of `improve-r7` (model `f4a7868`: the changes of round 7) on top of `improve-r6`
(`21b0b17`: the model changes of round 6, `9bed908`, merged with branch
`crash-fixes`, `f85fcbd`: branch `perf` (`adf62ae`, whose output is identical to that of `8f24bd3`) plus the fixes of the inputs on
which uiCA raised an exception, `docs/DEVIATIONS.md`). All fixtures in `fixtures/generated` are exported from it
(`tools/export_all.sh`, and the set `more` with `REPLAY=`).

- Read: `reference/uiCA/*.py` is still `8f24bd3`; the fixed code differs from it by the commits listed in `docs/DEVIATIONS.md`
  (`git diff adf62ae f85fcbd -- uiCA.py` in the fork). The decoder's C code that produces the decoded records is mirrored in
  `crates/wuica-xed/shim/wuica_xed.c`.
- Run: on the host `aethia` (`ssh aethia`), the fixed reference is installed in `~/uica-zen/uiCA-crashfix` (branch `crash-fixes`;
  the unfixed one in `~/uica-zen/uiCA-perf`; `improve-r6` in `~/uica-zen/uiCA-r6`; `improve-r7` in `~/uica-zen/uiCA-r7`;
  `improve-r8` in `~/uica-zen/uiCA-r8`; the reference of this branch, `improve-r9`, in `/data/projects/uica-r9`; never modify any
  of them), with the Python interpreter `~/uica-zen/venv/bin/python`. To add debug output, copy the directory (e.g. to `~/uicaspeed/<name>/uiCA`, 60 MB) and
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
six more, `x_r9_*.s`) for paths that
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

Current sets: exported from the fork's `improve-r9` (`640e40e`) on aethia with `/data/projects/wuica-r9/export_r9.sh` into
`/data/projects/wuica-r9/r9` (`data/`, `fix/`; a copy on the development Mac in `~/Documents/blackedge/wuica-r9-exports/r9`, `data/`
and `fixtures-generated/`), with the sources of the extra blocks from `~/uicaspeed/wuica-fix-crash/extra-src` plus the six blocks of
round 9 (`fixtures/extra-src/x_r9_*.s`: dogfood loops and loop benchmarks that reach the new rules: crossing loads, the store-line
rule with rewritten registers, long FP chains; the extra set now has 42 blocks) and the cases of the set `more` replayed from
`~/uicaspeed/wuica-fix-crash/final`. Compared with the export of `improve-r8`: instruction fixtures 1 case of ZEN3 differs; simulation
fixtures 4 of ZEN3 and 1 of ADL-P; extra fixtures 5 instruction and 10 simulation cases of ZEN3, plus the cases of the new blocks
(30 instruction and 54 simulation cases per configuration); set `more`: 5 of ZEN3. `fixtures/decode_fixtures_extra.jsonl.gz` gained
the decoder cases of the new blocks (the others are unchanged); of the tables only `uarch.json` changed (new configuration fields).
CI reads these files from the data asset `ci-data-v7` (`ci/data-asset.txt`; `ci-data-v6` has round 8's). Earlier sets: `crash-fixes`
(`f85fcbd`) in `~/uicaspeed/wuica-fix-crash/final`; `improve-r6` in `~/projects/wuica-r6/r6m`; `improve-r7` in
`~/projects/wuica-r7/t1`; `improve-r8` in `~/projects/wuica-r8/r8`.

The decoded records of a case are found in the decode fixtures by `file` and the chip `configs[arch].XEDName`.
Compare JSON with `wuica_core::jsoncmp::diff` (numbers by value, object key order ignored).

## Shared code

`crates/wuica-core/src/{model,config,decoded,x64,jsoncmp}.rs` are the contract between the parts. If one of them needs a change,
make the smallest possible change and say so clearly, because other work depends on them.
