# wuica

Throughput prediction for x86-64 basic blocks, running locally in Node. **wuica** (WebAssembly uiCA) is an independent
Rust/WebAssembly port of [uiCA](https://github.com/andreas-abel/uiCA). Its reports are bit-identical to the Python uiCA on the
port's test corpus. The package contains:

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

## The CLI in five minutes

```
clang -O3 -march=haswell -S dot.c -o dot.s     # AT&T, as clang and gcc write it: detected, no flag needed
npx wuica dot.s                                # uiCA's report for SKL, of the loop wuica picked
npx wuica dot.s -arch SKL,ZEN3,ADL-P           # one table for several CPUs ("all": every one)
npx wuica dot.s -per 8                         # the loop does 8 elements per iteration: cycles per element too
npx wuica dot.s -loops                         # the loops in the file; -loop N or -loop .LBB0_12 picks one
npx wuica dot.s -whatif                        # unrolled, N accumulators, front end and fusion variants
objdump -d dot.o | npx wuica                   # objdump output: the loop's real alignment from its address
```

- **Syntax.** Intel (noprefix) or AT&T is detected from the text (`%rdx`, `$8`, `(%rdi,%rcx,4)` are AT&T);
  stderr says which (`analyzed: loop .LBB0_9 (lines 28-47, in dot), AT&T syntax (detected)`). `-att` or `-intel`
  force one.
- **Per iteration.** `tp` is cycles per iteration of the loop as the compiler wrote it. Compilers unroll and vectorize
  (×8, ×16, ×32 elements per iteration), so compare per element: `-per N` prints `Per element: … cycles` (JSON
  `perElement`); without it, stderr shows the loop's step when it can (`step: rcx += 8 per iteration`).
- **Which loop.** A whole function or file is analyzed at one loop: the deepest one (clang's
  `# =>This Inner Loop Header` notes count), among equals the first in the code. That can be a remainder loop: clang
  often emits it before the main loop, gcc after it. Stderr says what was picked and how many others there are;
  `-loops` lists them (index, label, function, lines, instructions, depth, auto), `-loop N` (0-based) or
  `-loop LABEL` picks one, `-func NAME` keeps one function's loops, `-loop whole` analyzes the whole text.
- **One input per run**: a file, `-` or nothing for stdin, a hex argument, `-hex` or `-raw FILE` (bare machine code:
  for an object file, `objdump -d file.o | wuica`).
- **Tables.** `-arch A,B,C` prints one row per CPU; `-` means unknown (uiCA names no single bottleneck; the notes
  give the nearest limit), `5.00*` that the CPU could not decode some instructions (they are left out), and the notes
  column the caveats (what the model does not simulate, such as store forwarding through an indexed address).
- **After the report** come what uiCA's text leaves out: the nearest limit when the bottleneck is unknown, the next
  limit, and `Not modelled:` lines.
- **Exit status**: 0 ok, 1 bad request or usage, 2 assembler error, 3 the analysis failed; with several CPUs, the
  largest of their codes, which is also the JSON's `code`. A reader that closes the pipe (`| head`) does not change it.
- **JSON** (`-json`): one CPU gives the analyze response (`tp`, `bottlenecks`, `limits`, `rows`, `criticalPath`,
  `insights`, `loop`, `syntax`, and `perElement` / `whatIf` when asked); several give `{code, hex, loop, stderr,
  results: [{arch, tp, bottlenecks, limits, decodeErrors, perElement?, caveats?}]}` and `whatIf: {ARCH: …}`.
- No colours and no links, on a terminal or not.

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
w.insights(r);                                            // the diagnosis alone (REST's insights)
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
npx wuica loop.s                     # assembly file (syntax detected), uiCA's report for SKL
npx wuica loop.s -arch ICL -TPonly   # only the throughput
cat loop.s | npx wuica -arch ZEN3    # stdin (or "-")
npx wuica -att loop_att.s            # AT&T syntax, forced (-intel forces Intel)
npx wuica 4801d84801c349ffcf75f5     # a hex argument (as in the Rust CLI)
npx wuica -hex code.txt              # hex from a file or stdin ("48 01 d8", "0x48,0x01" are fine)
npx wuica -raw code.bin              # raw machine code
npx wuica loop.s -arch all           # throughput table for every microarchitecture (in parallel)
npx wuica loop.s -arch SKL,ICL,ZEN3  # throughput table for these
npx wuica -list                      # the microarchitectures
npx wuica loop.s -json               # the JSON result (the contract's analyze response)
npx wuica psum.s -loop whole         # the whole text, not the loop found in it (-loop auto, the default, or -loop N)
npx wuica psum.s -loops              # list the loops; -loop .LBB0_12 or -func psum to choose
npx wuica psum.s -whatif -per 8      # what-if variants; cycles per element (8 elements per iteration)
npx wuica --version
```

The simulation options are uiCA's: `-alignmentOffset N`, `-initPolicy diff|same|stack`, `-simpleFrontEnd`,
`-noMicroFusion`, `-noMacroFusion`, `-minIterations N`, `-minCycles N`, and `-trace` (with `-json`). Every flag also
takes `--flag` and `--flag=value`, in any case (`--tponly`, `--arch=zen3`). With several
microarchitectures, `-threads N` analyzes them on at most N threads at a time (`-threads 1`: one after another).
Diagnostics go to stderr. The exit status is the result code: 0 ok, 1 bad request or usage, 2 assembler error, 3 analysis failed.
`npx wuica -h` lists everything.

## MCP server

`wuica mcp` (or the `wuica-mcp` binary) is a Model Context Protocol server on stdio. It has five tools:

| Tool | What it does |
|---|---|
| `analyze` | one block on one microarchitecture: `tp`, bottlenecks, limits, a compact per-instruction table (ports, uop sources, fusion notes) and uiCA's text report (`format`: `json`, `text`, `both`) |
| `what_if` | one block re-analyzed with one change each (the web page's "try" row): `unroll2`/`unroll4`/`unroll8` (per original iteration), `acc2`/`acc3`/`acc4`/`acc8` (N accumulators: unrolled ×N with the loop-carried register renamed in each copy; `renamed` lists the registers, `accumulators.best` is the best N, 1 = as it is), `simpleFrontEnd`, `noMacroFusion`, `noMicroFusion`, and `nochain` (an estimate without the loop-carried chain); per variant `tp`, `delta`, `speedup` |
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
| — | `whatIf((a, r) => w.analyze(a, r), arch, request, variants?, {assemble: (t) => w.assemble(t)})` | `what_if {arch, ...request, variants?}` |
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
    "noMacroFusion": false, "minIterations": 10, "minCycles": 500, "includeTrace": false, "details": false
  }
}
```

- Give exactly one of `source` (assembly; the library also accepts `asm`) and `hex` (machine code; spaces, commas and
  `0x` are allowed).
- `source` is read as the web page reads pasted assembly. `loop` (optional) says what of it is analyzed:
  - `"auto"` (the default): a whole function (`gcc -S`, `clang -S`, `objdump -d` lines with addresses, with or
    without the bytes, Intel or AT&T) is analyzed at its deepest loop (clang's `Inner Loop Header` notes count;
    among equals the first in the code, which may be a remainder loop: clang often emits it first). A span that holds a `ret` or another function's label is not a loop (a tail
    call jumping back). A compiler's function without a loop (it has a function label, directives or a
    prologue/epilogue, and ends in `ret`) is analyzed at its body, without prologue, epilogue and `ret`; a bare snippet
    such as `add rax, 1` / `ret` is analyzed as typed. A text that is one loop already, or has region markers, is
    analyzed as it is.
  - `"whole"`: the whole text, never a pick; a number: that loop (0-based: deepest first, then in code order); any
    other string: the loop with that label (`".LBB0_12"`, `"0x10"`). `func` (optional) keeps one function's loops.
- `syntax` is `"auto"` (the default: detected from the text), `"intel"` or `"att"`; the response's `syntax` says
  which was used.

  objdump text is recognised by a header line (`0000… <f>:`), a byte column or `<sym+off>` branch targets; without
  those, only when every line is address-prefixed, there are at least three, and the steps between the addresses fit
  the instructions (so `a: add rax, 1` / `b: dec rcx` / `jnz a` stays assembly). In objdump text a branch target is
  always an address (`jne 1b <psum+0x1b>`); GNU numeric labels (`1:` … `jnz 1b`) keep working in assembly. Code in
  `.text.*` sections (gcc's `main` in `.text.startup`, `-ffunction-sections`) is analyzed as `.text`. CRLF and lone CR
  line ends are line feeds (REST, MCP, the library, the CLI).

  Conditional branches to a symbol the text does not define (a loop's exits, `jae .Lout`, `.L` or not) are taken as
  not taken: the symbol is defined right after the analyzed code, so they assemble as short jumps; a note says so in
  `stderr`. An undefined target of a `jmp` gives a warning (it is encoded as a 32-bit jump to an external symbol).
  objdump lines with their bytes are assembled as those bytes. With addresses, the alignment offset is the analyzed
  code's address modulo 64, unless `options.alignmentOffset` is given. When something other than the whole text was
  analyzed, the response has `loop`: `{index, count, name, line, endLine, address?, alignmentOffset?}` (`name`:
  `"loop .L3"`, `"loop 0x10"`, `"body"`).
  Region markers (`# LLVM-MCA-BEGIN` … `# LLVM-MCA-END`, `# wuica-begin` … `# wuica-end`, IACA's byte markers) select
  the first marked region. A `;` that starts a line is a comment. After a statement, LLVM reads `;` as a separator. If
  what follows assembles, it is assembled, with a note in `stderr` naming it (`';' separates statements: 'call helper'
  was assembled (use # for a comment)`), unless the `;` follows the statement without a space, as GNU as code chains
  statements (`dec rcx; jnz 1b`). If it does not assemble, for any reason, it is a comment: nothing after a `;` makes a
  valid line an error; a note says so when it starts with a mnemonic (`add the next element`), and nothing when it does
  not (`sum += a[i]`). A line the assembler rejects inside the analyzed code is an error with its line number (objdump
  lines outside the picked loop that the assembler rejects, such as padding, are left out).
- `syntax` is `auto` (the default), `intel` (noprefix) or `att`. The source may also switch syntax itself with
  `.intel_syntax noprefix` / `.att_syntax`.
- Every field of `options` is optional; the defaults are shown. Unknown options and unknown request fields are an
  error (code 1), not ignored. The library also accepts the options at the top level of the request
  (`{hex, arch, minIterations}`); `options` takes precedence. The MCP tools accept only the nested form.
- The source must be 64-bit code: `.code16`, `.code16gcc` and `.code32` are an error (code 1), since the analyzer
  only models 64-bit mode. `assemble` alone accepts them.
- `loop` exists in the library, REST (`/api/analyze`, `/api/compare`), the MCP tools `analyze`, `what_if` and
  `compare_archs`, and the package's CLI (`wuica -loop auto|whole|N`). The native CLI (`crates/wuica-cli`) reads
  machine code only (hex or `-raw`), so it has no `-loop`.

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
  "stderr": [],
  "insights": {"utilization": {"Issue": 0.6, "Dependencies": 0.8, "Port 0": 0.25}, "binding": ["Dependencies"], "...": "..."}
}
```

The fields from `arch` to `trace` are the analysis response of the WebAssembly module (`docs/WASM-API.md` in the wuica
repository: `rows[].values[i]` belongs to `columns[i]`, and `notes` is `M` macro-fused, `J` JCC erratum or `X`
unsupported). `hex` is present when `source` was given and holds the assembled bytes. `stderr` holds the assembler's
warnings, the notes on exits taken as not taken, and the warning "N position(s) could not be decoded". `insights` (REST only; the library's `analyze()` result
does not have it, `w.insights(r)` computes it) is the diagnosis described under the compact form below, with `portSet`
and `issueSlots` when `options.details` is true.

**Plain text** (CE's `Accept: text/plain`): the response is `text` (uiCA's report), or the `stderr` lines on failure.
In the library this is `r.text`; the MCP tool takes `format: "text"`.

**Compact form** (the MCP `analyze` JSON, `w.summarize(r)`): `{code, arch, name, year, prototype, tp, unit, mode,
bottlenecks, limits, decodeErrors, hex?, loop?, stderr, instructions, insights}`. Each entry of `instructions` is
`{instr, bytes, issued, executed, uopSource: {MITE|DSB|LSD|MS: n}, ports: {"Port 0": n, ...}, notes, uopsInfo}`
(zero values omitted, numbers rounded to 2 decimals). `insights` is a diagnosis derived from the analysis (as the web
page's "bound" view): `utilization` (each limit and port: cycles / tp), `binding` (the bottlenecks uiCA names: always
the same as `bottlenecks`, `[]` when it names none), `largest` (only when `binding` is `[]`: the largest limit, the
nearest bound, which alone does not reach tp; the web page shows "unknown · nearest Ports"), `next` (`{limit, tp,
maxSpeedup}`: the next limit, and the speedup at most if the binding one went away), `unexplained` (cycles no single
limit explains),
`chain` (the critical loop-carried chain: `{index, instr, operand, latency, carried}`) and `hot` (`{resource, ports?,
instructions: [{index, instr, share}]}`: the largest shares of the binding resource, or of the largest limit), and
`caveats` (only if any: `[{id, text, title, instructions}]`, known blind spots of the model that the block meets:
`rmw-index` a read-modify-write to an indexed address, whose store forwarding between iterations depends on the data;
`exit` an exit before the loop's branch, whose mispredict is not modelled; `split` loads at an offset that is not a
multiple of their width, which may cross a cache line: on the CPUs whose model charges line crossings (ZEN3, ADL-P,
ICX: `splitLoadCycles` in uarch.json) only the loads whose address the model cannot follow (an address register written
other than by adding an immediate); the web page shows them in one line under the throughput). With `options.details` (MCP:
`details: true`), each instruction also has `allowedPorts` (`1*p0156+1*p23`), `uops`, `fusedUops`, `latencies`
(`"RAX->RAX:1"`) and `frontEnd` (`length`, `offset`, `crosses`, `lcp`, `microcoded`, fusion), and `insights` has `portSet`
(the ports behind the Ports limit, `cycles` = uops / ports, and the instructions that load them) and `issueSlots` (per
iteration: issued, and lost to the front end, a full ROB or RS, or other).

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

The request is the same as for analyze, plus an optional `archs` (ids; missing or empty: all listed ones; a repeated id counts once). The response:

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

Request: `{"source": "...", "syntax": "intel"}`. The whole text is assembled as it is (no loop finding, no region
markers; `;` comments as above). Response: `{"code": 0, "hex": "4801d8", "length": 3, "stderr": []}`;
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
