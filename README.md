# wuica (WebAssembly uiCA)

An independent Rust/WebAssembly port of [uiCA](https://github.com/andreas-abel/uiCA), the uops.info Code Analyzer by Andreas Abel
and Jan Reineke, which predicts the throughput of x86-64 basic blocks with a detailed pipeline simulation. The goal is uiCA in the
browser: paste assembly or machine code, get the prediction, with nothing sent to a server.

This is not the official uiCA and not its official web version (that is [uiCA.uops.info](https://uiCA.uops.info)).
wuica follows the fork [jtl06/uiCA](https://github.com/jtl06/uiCA), which adds experimental models for AMD Zen 3,
Alder Lake P-cores and Ice Lake server to the original Intel models.

**Status: working preview.** From machine code (or assembly) to uiCA's complete report, identical to the Python reference on
all 15,259 test cases (both fixture sets, all options), natively and as WebAssembly, at about 1 ms per analysis (the Python
reference needs 40–55 ms plus startup). See [docs/DESIGN.md](docs/DESIGN.md) for the structure and the rules of the port.

| Part | Where | State |
|---|---|---|
| Decoding (Intel XED, the version uiCA pins) | `crates/wuica-xed` | identical to Python on 3948 file × chip cases |
| Instruction tables, configurations | `crates/wuica-core` (`data`, `config`) | loaded from `data/` (generated, see below) |
| Instruction builder (`instructions.py`) | `crates/wuica-core` (`instr_builder`) | identical on 11,096 + 3135 cases |
| Pipeline simulator (`uiCA.py`) | `crates/wuica-core` (`sim`) | identical throughput, uop table and `-json` output |
| Bottleneck analysis (`facile.py`, `printBottlenecks`) | `crates/wuica-core` (`facile`) | identical report text |
| Analysis API | `crates/wuica` | the request/response of [docs/WASM-API.md](docs/WASM-API.md) |
| Command-line tool | `crates/wuica-cli` | `wuica HEX -arch SKL` prints uiCA's report |
| WebAssembly module | `crates/wuica-wasm` | 4.3 MB, 0.9 MB gzipped |
| Assembler (LLVM 22.1.2 MC, x86 only) | `assembler/` | identical bytes to `llvm-mc` on 3000 files; 3.8 MB, 0.7 MB brotli |
| Web page | `web/` | static site, runs entirely in the browser |

## Building

    cargo test --release                       # all Rust tests (needs data/ and fixtures/generated/, see below)
    cargo run --release -p wuica-cli -- 4801d84801c349ffcf75f5 -arch SKL
    ./build-wasm.sh                            # WebAssembly; needs clang with the wasm32 target (not Apple's clang)
    node tests-js/analyze_fixtures.mjs         # the WebAssembly module against the Python reference
    assembler/build.sh                         # the assembler (Linux; downloads LLVM and wasi-sdk), see assembler/README.md
    web/build.sh && python3 -m http.server -d web/dist 8000

`data/` (instruction tables, configurations) and `fixtures/generated/` are generated from a uiCA installation with
`tools/export_data.py` and `tools/export_fixtures.py`.

## How correctness is checked

The Python uiCA is the reference. `tools/` contains scripts that run it on a corpus of basic blocks and export what it computes at
each stage (decoded instructions, instruction objects, simulation results) as fixtures; the Rust code has to reproduce them exactly.
The reference commit is recorded in `docs/DESIGN.md`.

## Licenses

- wuica is a derivative work of uiCA and is licensed under the **GNU AGPL v3** (`LICENSE`), like uiCA.
- `third_party/xed` is a subset of [Intel XED](https://github.com/intelxed/xed) (Apache License 2.0, `third_party/xed/LICENSE`).
- The assembler is a modified build of [LLVM](https://llvm.org) 22.1.2 (Apache License 2.0 with LLVM Exceptions,
  `assembler/LICENSE-LLVM.txt`; the changes are in `assembler/llvm-22.1.2-wasi.patch`).
- The web page uses IBM Plex Mono (SIL Open Font License 1.1, `web/fonts/OFL.txt`).
- The instruction data (latencies, throughputs and port usage) comes from [uops.info](https://www.uops.info) by Andreas Abel and
  Jan Reineke. It is not part of this repository: the tables are generated locally from a uiCA installation with
  `tools/export_data.py`.

If you use uiCA's models in research, cite the uiCA paper: Andreas Abel and Jan Reineke, *uiCA: Accurate Throughput Prediction of
Basic Blocks on Recent Intel Microarchitectures*, ICS 2022.
