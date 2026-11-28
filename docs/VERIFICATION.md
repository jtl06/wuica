# How the port is verified

wuica is a port: it must compute exactly what the Python uiCA computes. This page describes how that is checked and the state
of each part. How close the models are to real CPUs is a separate question, answered in [ACCURACY.md](ACCURACY.md).

wuica turns machine code (or assembly) into uiCA's complete report in about 1 ms per analysis; the Python reference needs
40–55 ms plus startup. Natively and as WebAssembly, the report is identical to the Python reference on all 18,791 simulation
cases of both fixture sets (all options) and on 3,419 more in the optional set `more`. The counts are from the logs of
`scripts/check.sh full`: `target/check/wuica_end_to_end.log` and `target/check/analyze_fixtures_*.log`. See
[DESIGN.md](DESIGN.md) for the structure and the rules of the port.

## The method

The Python uiCA is the reference. `tools/` contains scripts that run it on a corpus of basic blocks and export what it computes at
each stage (decoded instructions, instruction objects, simulation results) as fixtures. The Rust code has to reproduce them
exactly. The reference commit is recorded in `docs/DESIGN.md`.

## The parts

| Part | Where | State |
|---|---|---|
| Decoding (Intel XED, the version uiCA pins) | `crates/wuica-xed` | identical to Python on 3948 file × chip cases |
| Instruction tables, configurations | `crates/wuica-core` (`data`, `config`) | loaded from `data/` (generated, see below) |
| Instruction builder (`instructions.py`) | `crates/wuica-core` (`instr_builder`) | identical on 8,056 + 3,990 cases (`target/check/wuica-core_instr_builder_fixtures.log`) |
| Pipeline simulator (`uiCA.py`) | `crates/wuica-core` (`sim`) | identical throughput, uop table and `-json` output |
| Bottleneck analysis (`facile.py`, `printBottlenecks`) | `crates/wuica-core` (`facile`) | identical report text |
| Analysis API | `crates/wuica` | the request/response of [WASM-API.md](WASM-API.md) |
| Reference/test binary (not a product: the CLI to install is the npm package's) | `crates/wuica-cli` | `wuica HEX -arch SKL` prints uiCA's report; the exactness checks use it as an independent interface |
| WebAssembly module | `crates/wuica-wasm` | 3.06 MB, 0.8 MB gzipped (binary tables only: no JSON table loader) |
| Assembler (LLVM 22.1.2 MC, x86 only) | `assembler/` | identical bytes to `llvm-mc` on 3000 files; 3.8 MB, 0.7 MB brotli |
| Web page | `web/` | static site, runs entirely in the browser |

## Building and running the checks

    scripts/check.sh                           # builds what changed, runs the tests in parallel (quick subset, ~1 min)
    scripts/check.sh full                      # all suites: Rust, WebAssembly, web page, npm package (see docs/PORTING.md)
    cargo test --release                       # all Rust tests (needs data/ and fixtures/generated/, see below)
    cargo run --release -p wuica-cli -- 4801d84801c349ffcf75f5 -arch SKL   # the reference/test binary
    ./build-wasm.sh                            # WebAssembly; needs clang with the wasm32 target (not Apple's clang)
    node tests-js/analyze_fixtures.mjs         # the WebAssembly module against the Python reference
    assembler/build.sh                         # the assembler (Linux; downloads LLVM and wasi-sdk), see assembler/README.md
    web/build.sh && python3 -m http.server -d web/dist 8000

`data/` (instruction tables, configurations) and `fixtures/generated/` are generated from a uiCA installation with
`tools/export_data.py` and `tools/export_fixtures.py`.

CI (GitHub Actions, `.github/workflows/ci.yml`) runs `scripts/check.sh full` on every push to main and every pull request.

[PORTING.md](PORTING.md) has more on working in the repository. The rules, architecture, measurements, rejected ideas and
known weaknesses are in [SPEC.md](SPEC.md).
