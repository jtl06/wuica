# wuica (WebAssembly uiCA)

[![CI](https://github.com/jtl06/wuica/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jtl06/wuica/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/wuica-cli)](https://www.npmjs.com/package/wuica-cli)

An independent Rust/WebAssembly port of [uiCA](https://github.com/andreas-abel/uiCA), which predicts the throughput of x86-64
basic blocks with a detailed pipeline simulation. The goal is uiCA in the browser: paste assembly or machine code, get the
prediction, with nothing sent to a server.

This is not the official uiCA and not its official web version (that is [uiCA.uops.info](https://uiCA.uops.info)).
wuica follows the fork [jtl06/uiCA](https://github.com/jtl06/uiCA), which adds experimental models for AMD Zen 3,
Alder Lake P-cores and Ice Lake server to the original Intel models.

## Use it

- **In the browser:** [wuica.jacen.li](https://wuica.jacen.li). Paste assembly or machine code; nothing leaves the page.
- **From Node or the command line:** `npx wuica-cli loop.s -arch SKL`. The npm package
  [`wuica-cli`](https://www.npmjs.com/package/wuica-cli) is a library, a command-line tool and a local MCP server; it runs
  offline and has no dependencies. See [packages/wuica/README.md](packages/wuica/README.md).
- **Over HTTP:** a hosted API at [api.wuica.jacen.li](https://api.wuica.jacen.li). Unlike the page, this sends your code to
  the server.

      curl -s -X POST https://api.wuica.jacen.li/api/analyze/SKL -d '{"hex":"4801d84801c349ffcf75f5"}'

  An MCP endpoint for agents is at `https://api.wuica.jacen.li/mcp`.
- **Source and issues:** [github.com/jtl06/wuica](https://github.com/jtl06/wuica). The models come from the fork
  [jtl06/uiCA](https://github.com/jtl06/uiCA) of [uiCA](https://github.com/andreas-abel/uiCA).
- **Measure your own CPU:** [wuica-calibrate](https://github.com/jtl06/wuica-calibrate) (pre-release) runs about 1,800 real
  loops on a Linux x86-64 machine and writes a result file you can send back to help model that CPU.

**Status: working preview.** From machine code (or assembly) to uiCA's complete report, identical to the Python reference on
all 18,791 simulation cases of both fixture sets (all options; 3,419 more in the optional set `more`), natively and as
WebAssembly (counts from the logs of `scripts/check.sh full`, `target/check/wuica_end_to_end.log` and
`target/check/analyze_fixtures_*.log`), at about 1 ms per analysis (the Python
reference needs 40–55 ms plus startup). See [docs/DESIGN.md](docs/DESIGN.md) for the structure and the rules of the port.

For reviewers: [docs/SPEC.md](docs/SPEC.md) states the rules, architecture, measurements, rejected ideas and known weaknesses.

| Part | Where | State |
|---|---|---|
| Decoding (Intel XED, the version uiCA pins) | `crates/wuica-xed` | identical to Python on 3948 file × chip cases |
| Instruction tables, configurations | `crates/wuica-core` (`data`, `config`) | loaded from `data/` (generated, see below) |
| Instruction builder (`instructions.py`) | `crates/wuica-core` (`instr_builder`) | identical on 8,056 + 3,990 cases (`target/check/wuica-core_instr_builder_fixtures.log`) |
| Pipeline simulator (`uiCA.py`) | `crates/wuica-core` (`sim`) | identical throughput, uop table and `-json` output |
| Bottleneck analysis (`facile.py`, `printBottlenecks`) | `crates/wuica-core` (`facile`) | identical report text |
| Analysis API | `crates/wuica` | the request/response of [docs/WASM-API.md](docs/WASM-API.md) |
| Reference/test binary (not a product: the CLI to install is the npm package's) | `crates/wuica-cli` | `wuica HEX -arch SKL` prints uiCA's report; the exactness checks use it as an independent interface |
| WebAssembly module | `crates/wuica-wasm` | 3.06 MB, 0.8 MB gzipped (binary tables only: no JSON table loader) |
| Assembler (LLVM 22.1.2 MC, x86 only) | `assembler/` | identical bytes to `llvm-mc` on 3000 files; 3.8 MB, 0.7 MB brotli |
| Web page | `web/` | static site, runs entirely in the browser |

## Building

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

uiCA is described in: Andreas Abel and Jan Reineke, *uiCA: Accurate Throughput Prediction of Basic Blocks on Recent Intel
Microarchitectures*, ICS 2022. The Intel models are uiCA's; the ZEN3, ADL-P and ICX models are prototypes of the fork
[jtl06/uiCA](https://github.com/jtl06/uiCA) and are not part of that work.
