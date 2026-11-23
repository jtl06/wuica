# wuica (WebAssembly uiCA)

An independent Rust/WebAssembly port of [uiCA](https://github.com/andreas-abel/uiCA), the uops.info Code Analyzer by Andreas Abel
and Jan Reineke, which predicts the throughput of x86-64 basic blocks with a detailed pipeline simulation. The goal is uiCA in the
browser: paste machine code, get the prediction, with nothing sent to a server.

This is not the official uiCA and not its official web version (that is [uiCA.uops.info](https://uiCA.uops.info)).
wuica follows the fork [jtl06/uiCA](https://github.com/jtl06/uiCA), which adds experimental models for AMD Zen 3,
Alder Lake P-cores and Ice Lake server to the original Intel models.

**Status: early.** The decoder works natively and in WebAssembly and matches the Python reference exactly. The simulator is not
ported yet. See [docs/DESIGN.md](docs/DESIGN.md) for the plan and the rules of the port.

| Part | Crate | State |
|---|---|---|
| Decoding (Intel XED, the version uiCA pins) | `crates/wuica-xed` | done; identical to Python on 3948 files × chips (51,312 instructions), natively and as WebAssembly |
| Instruction data and microarchitecture configs | `crates/wuica-core` | not started |
| Instruction builder (`instructions.py`) | `crates/wuica-core` | not started |
| Pipeline simulator (`uiCA.py`) | `crates/wuica-core` | not started |
| WebAssembly interface | `crates/wuica-wasm` | decoding only |
| Web page | `web/` | not started |

## Building

    cargo test -p wuica-xed --release          # native; needs a C compiler
    ./build-wasm.sh                            # WebAssembly; needs clang with the wasm32 target (not Apple's clang)
    node tests-js/decode_fixtures.mjs          # the WebAssembly module against the Python reference

## How correctness is checked

The Python uiCA is the reference. `tools/` contains scripts that run it on a corpus of basic blocks and export what it computes at
each stage (decoded instructions, instruction objects, simulation results) as fixtures; the Rust code has to reproduce them exactly.
The reference commit is recorded in `docs/DESIGN.md`.

## Licenses

- wuica is a derivative work of uiCA and is licensed under the **GNU AGPL v3** (`LICENSE`), like uiCA.
- `third_party/xed` is a subset of [Intel XED](https://github.com/intelxed/xed) (Apache License 2.0, `third_party/xed/LICENSE`).
- The instruction data comes from [uops.info](https://www.uops.info). It is **not** part of this repository: uops.info does not
  state a license for its data, so the tables are generated locally from a uiCA installation (`tools/export_data.py`).
  Ask the uops.info authors before publishing a build that contains them.

If you use uiCA's models in research, cite the uiCA paper: Andreas Abel and Jan Reineke, *uiCA: Accurate Throughput Prediction of
Basic Blocks on Recent Intel Microarchitectures*, ICS 2022.
