# wuica

Throughput prediction for x86-64 basic blocks, running locally in Node. **wuica** (WebAssembly uiCA) is an independent
Rust/WebAssembly port of [uiCA](https://github.com/andreas-abel/uiCA), the uops.info Code Analyzer by Andreas Abel and
Jan Reineke. Its reports are bit-identical to the Python uiCA on the port's test corpus. The package contains:

- a **library**: `import { createWuica } from 'wuica'`
- a **command-line tool**: `npx wuica loop.s -arch SKL`
- a local **MCP server** (stdio) for AI agents: `npx wuica mcp`

This is **not the official uiCA** (that is [uiCA.uops.info](https://uiCA.uops.info) and the
[uiCA repository](https://github.com/andreas-abel/uiCA)). The instruction data (latencies, throughputs, port usage) comes
from [uops.info](https://www.uops.info). Besides uiCA's Intel models (Sandy Bridge to Rocket Lake), wuica includes the
experimental models of the fork [jtl06/uiCA](https://github.com/jtl06/uiCA): **AMD Zen 3 (ZEN3), Alder Lake P-core
(ADL-P) and Ice Lake server (ICX)**. They are marked `prototype` and are less validated than the Intel models.

Everything runs offline. The two WebAssembly modules (the analyzer, and LLVM's x86 assembler for assembly input) and the
instruction tables are shipped brotli-compressed. A table is loaded the first time its microarchitecture is used.
Requirements: Node.js 20 or later.

## What the numbers mean

`tp` is the predicted steady-state throughput in **core cycles per iteration** of the block (lower is faster). How the
block is simulated depends on how it ends:

- A block that ends with a branch is simulated as a loop body (`mode: "loop"`).
- Any other block is simulated as if it were unrolled, i.e. repeated back to back (`mode: "unroll"`).

The model assumes that all data is in the L1 cache, that no branches are mispredicted, and that nothing else is running
on the core. `bottlenecks` names what limits the throughput, such as Dependencies (a loop-carried chain), Ports, Issue,
Decoder or DSB. `limits` gives the throughput each component alone would allow. `text` is uiCA's complete report.

## Library

```js
import { createWuica } from 'wuica';

const w = await createWuica();
const r = await w.analyze('SKL', { source: 'loop:\n add rax, [rsi]\n add rsi, 8\n dec rcx\n jnz loop\n' });
if (r.code === 0) {
  console.log(r.tp, r.mode, r.bottlenecks);  // cycles per iteration, "loop", [...]
  console.log(r.text);                       // uiCA's report
  console.log(r.hex);                        // the assembled bytes
} else {
  console.error(r.error, r.stderr);          // e.g. assembler diagnostics with line/column
}

await w.analyze('ZEN3', { hex: '4801d84801c349ffcf75f5', options: { noMacroFusion: true } });
await w.analyze({ arch: 'ADL-P', source: 'addq %rbx, %rax', syntax: 'att' });  // single-object form
await w.compare({ source: 'imul rax, rbx' });            // every microarchitecture
w.archs();                                                // [{id, name, year, prototype, table, xedChip}, ...]
await w.assemble('vaddps zmm0, zmm1, zmm2');              // {code: 0, hex, length, bytes, stderr}
w.summarize(r);                                           // compact form (the MCP analyze result)
```

Methods never throw for bad input: they resolve to a failure `{code, error, stderr}` (see the contract below).
`createWuica({ dataDir })` reads the tables from another directory (`uarch.json` and `arch/<NAME>.json`, plain or
`.br`). TypeScript declarations are included (`index.d.ts`).

`compare` analyzes the microarchitectures in parallel on worker threads: by default one thread per two
microarchitectures (a thread's start costs about one analysis), at most `os.availableParallelism()`.
`createWuica({ threads: N })` or the environment variable `WUICA_THREADS=N` uses up to N threads, one per
microarchitecture; 1 runs them one after another on the calling thread. The response is the same either way. Each thread loads only the
tables of the microarchitectures it analyzes and keeps them for the next `compare`; idle threads do not keep the process
alive and stop after 30 s (`w.close()` stops them at once). A thread's WebAssembly memory has a lower limit (a quarter
of the RAM shared by the threads, 256 MB to 1 GB each); an analysis that exceeds it is done again on the calling thread.

Inputs on which the original uiCA fails can make the WebAssembly module trap. In that case the call resolves to
`{code: 3, error, trapped: true}`. The module is then re-instantiated and its tables are reloaded, so the next call works.

## Command line

```
npx wuica loop.s                     # assembly file (Intel syntax), uiCA's report for SKL
npx wuica loop.s -arch ICL -TPonly   # only the throughput
cat loop.s | npx wuica -arch ZEN3    # stdin (or "-")
npx wuica -att loop_att.s            # AT&T syntax
npx wuica 4801d84801c349ffcf75f5     # a hex argument (as in the Rust CLI)
npx wuica -hex code.txt              # hex from a file or stdin ("48 01 d8", "0x48,0x01" are fine)
npx wuica -raw code.bin              # raw machine code
npx wuica loop.s -arch all           # throughput table for every microarchitecture (in parallel)
npx wuica loop.s -arch SKL,ICL,ZEN3  # throughput table for these
npx wuica -list                      # the microarchitectures
npx wuica loop.s -json               # the JSON result (the contract's analyze response)
```

The simulation options are uiCA's: `-alignmentOffset N`, `-initPolicy diff|same|stack`, `-simpleFrontEnd`,
`-noMicroFusion`, `-noMacroFusion`, `-minIterations N`, `-minCycles N`, and `-trace` (with `-json`). With several
microarchitectures, `-threads N` analyzes them on at most N threads at a time (`-threads 1`: one after another).
Diagnostics go to stderr. The exit status is the result code: 0 ok, 1 bad request or usage, 2 assembler error, 3 analysis failed.
`npx wuica -h` lists everything.

## MCP server

`wuica mcp` (or the `wuica-mcp` binary) is a Model Context Protocol server on stdio. It has four tools:

| Tool | What it does |
|---|---|
| `analyze` | one block on one microarchitecture: `tp`, bottlenecks, limits, a compact per-instruction table (ports, uop sources, fusion notes) and uiCA's text report (`format`: `json`, `text`, `both`) |
| `compare_archs` | one block on several or all microarchitectures: `tp` and bottlenecks per microarchitecture |
| `list_archs` | ids, names, years, prototype flags |
| `assemble` | assembly → hex bytes, or diagnostics with line/column |

Add it to **Claude Code** from a local checkout (after `build.sh` and `npm install`) or an installed tarball:

```
claude mcp add wuica -- node /absolute/path/to/packages/wuica/bin/wuica.js mcp
```

Once the package is published on npm:

```
claude mcp add wuica -- npx -y wuica mcp
```

Other MCP clients (Claude Desktop, Cursor, VS Code, ...) use the same command in their JSON configuration:

```json
{
  "mcpServers": {
    "wuica": { "command": "npx", "args": ["-y", "wuica", "mcp"] }
  }
}
```

Example prompt: *"Use wuica to compare this loop on Skylake, Ice Lake and Zen 3 and explain the bottleneck."*

## API contract

The library, the MCP tools and the REST API (https://api.wuica.jacen.li, server/) share these shapes. They follow
[Compiler Explorer's API](https://github.com/compiler-explorer/compiler-explorer/blob/main/docs/API.md): a list
endpoint like `/api/compilers`, a call keyed by id like `/api/compiler/<id>/compile`, results as JSON or plain
text, and errors with structured stderr.

| REST | Library | MCP tool |
|---|---|---|
| `GET /api/archs[?fields=id,name]` | `w.archs(fields?)` | `list_archs {fields?}` |
| `POST /api/analyze/<arch>` | `w.analyze(arch, request)` | `analyze {arch, ...request, format?}` |
| `POST /api/compare` | `w.compare(request)` | `compare_archs {...request}` |
| `POST /api/assemble` | `w.assemble(source, syntax)` | `assemble {source, syntax?}` |

### Microarchitectures: `GET /api/archs`

```json
[{"id": "SKL", "name": "Skylake", "year": 2015, "prototype": false, "table": "SKL", "xedChip": "SKYLAKE"}, ...]
```

The list is in order of release. `prototype` is true for ZEN3, ADL-P and ICX. `fields` (comma-separated, or an
array in the library) selects fields; the default is all fields (`list_archs` defaults to `id,name,year,prototype`).
uiCA's ablation variants (ids containing `_`) are not listed, but `analyze` accepts them. Ids are matched exactly,
or failing that case-insensitively with `-` optional (`adlp` → `ADL-P`). The default arch is `SKL`.

### Analysis: `POST /api/analyze/<arch>`

Request:

```json
{
  "source": "loop: add rax, rbx\n dec rcx\n jnz loop",
  "hex": "4801d8...",
  "syntax": "intel",
  "options": {
    "alignmentOffset": 0, "initPolicy": "diff", "simpleFrontEnd": false, "noMicroFusion": false,
    "noMacroFusion": false, "minIterations": 10, "minCycles": 500, "includeTrace": false
  }
}
```

- Give exactly one of `source` (assembly; the library also accepts `asm`) and `hex` (machine code; spaces, commas and
  `0x` are allowed).
- `syntax` is `intel` (noprefix, the default) or `att`. The source may also switch syntax itself with
  `.intel_syntax noprefix` / `.att_syntax`.
- Every field of `options` is optional; the defaults are shown. Unknown options and unknown request fields are an
  error (code 1), not ignored. The library also accepts the options at the top level of the request
  (`{hex, arch, minIterations}`); `options` takes precedence. The MCP tools accept only the nested form.
- The source must be 64-bit code: `.code16`, `.code16gcc` and `.code32` are an error (code 1), since the analyzer
  only models 64-bit mode. `assemble` alone accepts them.

### Option ranges per interface

All interfaces run the same analyzer, but they accept different ranges for the numeric options. A value outside the
range is refused (code 1, REST 400; the MCP tools' schema rejects it as invalid arguments), except in the web page,
which clamps it into its range.

| Interface | `alignmentOffset` | `minIterations` | `minCycles` | Other limits |
|---|---|---|---|---|
| library, `wuica` CLI, native CLI (`crates/wuica-cli`) | any integer (negative values and values above 63 are simulated as given) | any integer | any integer | none; very large values run out of memory (library: code 3) |
| MCP tools of `wuica mcp` (stdio) | 0–63 | 1–100000 | 1–1000000 | |
| REST API (`server/`) | any integer | at most 1000 | at most 20000 | `source` at most 64 KB, `hex` at most 65536 characters, at most 10,000 instructions |
| remote MCP (`server/`, `/mcp`) | 0–63 | 1–1000 | 1–20000 | as REST |
| web page | 0–63 | 1–10000 | 1–100000 | at most 1 MiB of machine code (assembled or as hex) |

Microarchitecture ids are accepted the same way everywhere: exactly, or case-insensitively with `-` optional (`adlp`,
`adl-p` → `ADL-P`). Hex may contain spaces, commas and `0x` / `\x` prefixes everywhere.

Response (JSON), on success:

```json
{
  "code": 0,
  "arch": "SKL", "tp": 1.25, "mode": "loop", "decodeErrors": 0,
  "bottlenecks": ["Dependencies"],
  "limits": [{"name": "Issue", "tp": 0.75}, {"name": "Dependencies", "tp": 1.0}],
  "columns": ["MITE", "MS", "DSB", "LSD", "Issued", "Exec.", "Port 0", "..."],
  "rows": [{"kind": "instr", "label": "add rax, rbx", "opcode": "4801D8", "instrStr": "ADD (R64, R64)",
            "url": "https://www.uops.info/html-instr/ADD_01_R64_R64.html", "notes": "", "values": [0, 0, 1.0, "..."]}],
  "text": "Throughput (in cycles per iteration): 1.25\n...",
  "trace": null,
  "hex": "4801d8...",
  "stderr": []
}
```

The fields from `arch` to `trace` are the analysis response of the WebAssembly module (`docs/WASM-API.md` in the wuica
repository: `rows[].values[i]` belongs to `columns[i]`, and `notes` is `M` macro-fused, `J` JCC erratum or `X`
unsupported). `hex` is present when `source` was given and holds the assembled bytes. `stderr` holds the assembler's
warnings and the warning "N position(s) could not be decoded".

**Plain text** (CE's `Accept: text/plain`): the response is `text` (uiCA's report), or the `stderr` lines on failure.
In the library this is `r.text`; the MCP tool takes `format: "text"`.

**Compact form** (the MCP `analyze` JSON, `w.summarize(r)`): `{code, arch, name, year, prototype, tp, unit, mode,
bottlenecks, limits, decodeErrors, hex?, stderr, instructions, insights}`. Each entry of `instructions` is
`{instr, bytes, issued, executed, uopSource: {MITE|DSB|LSD|MS: n}, ports: {"Port 0": n, ...}, notes, uopsInfo}`
(zero values omitted, numbers rounded to 2 decimals). `insights` is a diagnosis derived from the analysis (as the web
page's "bound" view): `utilization` (each limit and port: cycles / tp), `binding`, `next` (`{limit, tp, maxSpeedup}`:
the next limit, and the speedup at most if the binding one went away), `unexplained` (cycles no single limit explains),
`chain` (the critical loop-carried chain: `{index, instr, operand, latency, carried}`) and `hot` (`{resource, ports?,
instructions: [{index, instr, share}]}`: the largest shares of the binding resource).

### Failures

Every call can fail like a compiler run in Compiler Explorer, with a non-zero `code` and stderr lines:

```json
{
  "code": 2,
  "error": "assembly failed: line 2: invalid instruction mnemonic 'frobnicate'",
  "stderr": [
    {"text": "<input>:2:1: error: invalid instruction mnemonic 'frobnicate'",
     "tag": {"line": 2, "column": 1, "severity": "error", "text": "invalid instruction mnemonic 'frobnicate'"}},
    {"text": "frobnicate rax"},
    {"text": "^~~~~~~~~~"}
  ]
}
```

| code | meaning | REST status |
|---|---|---|
| 0 | success | 200 |
| 1 | bad request: neither or both of source/hex, bad hex, unknown arch, unknown option, bad option value or syntax | 400 (unknown arch: 404) |
| 2 | assembler error (stderr as `llvm-mc` prints it; positioned lines carry `tag`) | 200, like a failed compile in CE |
| 3 | the analysis failed for this input (as the Python uiCA would); `trapped: true` if the module trapped | 200 |

### Compare: `POST /api/compare`

The request is the same as for analyze, plus an optional `archs` (ids; the default is all listed ones). The response:

```json
{
  "code": 0, "hex": "...", "stderr": [],
  "results": [
    {"arch": "SKL", "name": "Skylake", "year": 2015, "prototype": false, "code": 0, "tp": 2.0, "mode": "loop",
     "bottlenecks": ["Dependencies"], "decodeErrors": 0},
    {"arch": "K8", "name": "K8", "year": null, "prototype": false, "code": 1, "error": "unknown microarchitecture: K8 ..."}
  ]
}
```

The top-level `code` is non-zero only if the request or the assembly fails. A failure on one microarchitecture is
reported in its row.

### Assemble: `POST /api/assemble`

Request: `{"source": "...", "syntax": "intel"}`. Response: `{"code": 0, "hex": "4801d8", "length": 3, "stderr": []}`;
the library also returns `bytes` (a `Uint8Array`). On failure: `{code: 2, error, stderr}` as above. The assembler is
LLVM 22.1.2's (the same bytes as `llvm-mc`). Only `.text` is returned. `.include`/`.incbin` always fail. GNU as's
`{load}`/`{store}` hints, which LLVM rejects, are removed at the start of a line.

## Building from the repository

```
packages/wuica/build.sh          # copies and compresses the wasm modules and tables into dist/, copies the licenses
cd packages/wuica && npm install && npm test
npm pack                         # wuica-<version>.tgz
```

`build.sh` uses `target/wasm32-unknown-unknown/release/wuica_wasm.wasm` (it runs `./build-wasm.sh` if the file is
missing), `assembler/dist/wuica_asm.wasm` and `data/`. `dist/manifest.json` records the size and SHA-256 of each
uncompressed file.

## Licenses

- wuica is a derivative work of uiCA and, like uiCA, is licensed under the **GNU Affero General Public License v3.0
  only** (`LICENSE`).
- The analyzer contains a subset of [Intel XED](https://github.com/intelxed/xed) (Apache License 2.0,
  `licenses/LICENSE-XED.txt`).
- The assembler module is a modified build of [LLVM](https://llvm.org) 22.1.2 (Apache License 2.0 with LLVM
  Exceptions, `licenses/LICENSE-LLVM.txt`). The changes are in `assembler/llvm-22.1.2-wasi.patch` in the wuica
  repository. It also contains wasi-libc and libc++ from wasi-sdk (Apache-2.0 WITH LLVM-exception, MIT and other
  permissive licenses).
- The instruction data comes from [uops.info](https://www.uops.info) by Andreas Abel and Jan Reineke.
- The MCP server uses the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (MIT) and
  [zod](https://zod.dev) (MIT), installed as npm dependencies.

If you use uiCA's models in research, cite the uiCA paper: Andreas Abel and Jan Reineke, *uiCA: Accurate Throughput
Prediction of Basic Blocks on Recent Intel Microarchitectures*, ICS 2022.
