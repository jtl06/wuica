# Working on the port

Read `docs/DESIGN.md` first: the architecture, the fixtures and, above all, the "Rules for an exact port".

## Setup

- Rust: `export PATH=$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH` (cargo is not on the default PATH on the
  development Mac).
- When several people or agents build at the same time, use your own target directory, e.g.
  `export CARGO_TARGET_DIR=$PWD/target-<name>` (`target*/` is ignored by git).
- `data/` (instruction tables, configurations) and `fixtures/generated/` are generated and not in git; they are present on the
  development Mac. `tools/export_data.py` and `tools/export_fixtures.py` regenerate them from a uiCA installation.

## The reference

- Read: `reference/uiCA/*.py` (the exact commit the fixtures come from). The decoder's C code that produces the decoded records
  is mirrored in `crates/wuica-xed/shim/wuica_xed.c`.
- Run: on the host `aethia` (`ssh aethia`), the reference is installed in `~/uica-zen/uiCA-perf` (never modify it), with the Python
  interpreter `~/uica-zen/venv/bin/python`. To add debug output, copy the directory (e.g. to `~/uicaspeed/<name>/uiCA`, 60 MB) and
  edit the copy. Example: `cd ~/uica-zen/uiCA-perf && ~/uica-zen/venv/bin/python -c "import xed, uiCA; ..."`; the functions take
  the list returned by `xed.disasHex(hexString, chip=config.XEDName)`.
- aethia is also a measurement machine. A single short Python run is fine. Anything CPU-heavy (more than a few seconds, or
  parallel) must hold a lease, taken from the Mac: `~/perfq/perfq ssh aethia --est 5m --mode shared -- 'COMMAND'` (it blocks while
  queued; a lease ends after 10 minutes). No sudo, no installing anything outside your own directory.

## Fixtures

One JSON object per line, gzip. A case with an `error` field is one where the reference raised an exception: skip it.

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
`fixtures/generated/extra_sim_fixtures.jsonl.gz`; sources in `fixtures/extra-src/x_*.s`): 32 hand-written blocks for paths that
the main corpus does not reach (ZMM registers, stack operations, high-8 registers, LCP, lock, rep, fences, microcode, x87, ...),
each with all option variants and the `-json` output. Every case was run in a new process (`FRESH=1`), like a run of the
command-line tool: the reference modifies its instruction tables in place for code that uses ZMM registers, so within one
process earlier cases can change later ones (the main set has no ZMM code). 108 of its 5472 simulation cases are reference
crashes (`error`), which are skipped.

The decoded records of a case are found in the decode fixtures by `file` and the chip `configs[arch].XEDName`.
Compare JSON with `wuica_core::jsoncmp::diff` (numbers by value, object key order ignored).

## Shared code

`crates/wuica-core/src/{model,config,decoded,x64,jsoncmp}.rs` are the contract between the parts. If one of them needs a change,
make the smallest possible change and say so clearly, because other work depends on them.
