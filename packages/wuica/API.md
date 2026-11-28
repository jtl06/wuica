# wuica-cli: API contract

This is the full contract of the requests and responses of the `wuica-cli` package; the [README](README.md) covers
installation, the CLI, the library and the MCP setup.

The library, the MCP tools and the REST API (https://api.wuica.jacen.li, server/) share these shapes. They follow
[Compiler Explorer's API](https://github.com/compiler-explorer/compiler-explorer/blob/main/docs/API.md): a list
endpoint like `/api/compilers`, a call keyed by id like `/api/compiler/<id>/compile`, results as JSON or plain
text, and errors with structured stderr.

| REST | Library | MCP tool |
|---|---|---|
| `GET /api/archs[?fields=id,name]` | `w.archs(fields?)` | `list_archs {fields?}` |
| — | `listLoops(source, {func?})` | `list_loops {source, func?}` |
| `POST /api/analyze/<arch>` | `w.analyze(arch, request)` | `analyze {arch, ...request, format?}` |
| `POST /api/compare` | `w.compare({...request, archs?, per?})` | `compare_archs {...request, archs?, per?}` |
| `POST /api/what-if/<arch>` | `w.whatIf(arch, {...request, variants?, per?})` | `what_if {arch, ...request, variants?, per?}` |
| `POST /api/diff/<arch>` | `w.diff(arch, {a, b, options?, per?})` | `diff_blocks {arch, a, b, options?, per?}` |
| `POST /api/assemble` | `w.assemble(source, syntax)` | `assemble {source, syntax?}` |

## Microarchitectures: `GET /api/archs`

```json
[{"id": "SKL", "name": "Skylake", "year": 2015, "prototype": false, "table": "SKL", "xedChip": "SKYLAKE"}, ...]
```

The list is in order of release. `prototype` is true for ZEN3, ADL-P and ICX. `fields` (comma-separated, or an
array in the library) selects fields; the default is all fields (`list_archs` defaults to `id,name,year,prototype`).
uiCA's ablation variants (ids containing `_`) are not listed, but `analyze` accepts them. Ids are matched exactly,
or failing that case-insensitively with `-` optional (`adlp` → `ADL-P`). The default arch is `SKL`.

## Analysis: `POST /api/analyze/<arch>`

Request:

```json
{
  "source": "loop: add rax, rbx\n dec rcx\n jnz loop",
  "syntax": "intel",
  "options": {
    "alignmentOffset": 0, "initPolicy": "diff", "simpleFrontEnd": false, "noMicroFusion": false,
    "noMacroFusion": false, "minIterations": 10, "minCycles": 500, "includeTrace": false, "details": false
  }
}
```

- Give exactly one of `source` (assembly; the library also accepts `asm`) and `hex` (machine code, `"4801d8..."`;
  spaces, commas and `0x` are allowed).
- `source` is read as the web page reads pasted assembly. `loop` (optional) selects the part of it that is analyzed:
  - `"auto"` (the default): a whole function (`gcc -S`, `clang -S`, `objdump -d` lines with addresses, with or
    without the bytes, Intel or AT&T) is analyzed at its default loop (see "Which loop" in
    [Command line](README.md#command-line)). A span that holds a
    `ret` or another function's label is not a loop (a tail call jumping back). A compiler's function
    without a loop (it has a function label, directives or a prologue/epilogue, and ends in `ret`) is analyzed at its
    body, without prologue, epilogue and `ret`; a bare snippet such as `add rax, 1` / `ret` is analyzed as typed. A
    text that is one loop already, or has region markers, is analyzed as it is.
  - `"whole"`: the whole text, with no loop picked. A number picks that loop (0-based, in the order `listLoops` and
    `-loops` list them: the deepest innermost first, then in code order; the default need not be 0). Any other string
    picks the loop with that label (`".LBB0_12"`, `"0x10"`). `func` (optional) keeps one function's loops.
- `syntax` is `"auto"` (the default: detected from the text), `"intel"` (noprefix) or `"att"`; the response's
  `syntax` says which was used. The source may also switch syntax itself with `.intel_syntax noprefix` /
  `.att_syntax`.

  objdump text is recognized by a header line (`0000… <f>:`), a byte column or `<sym+off>` branch targets. Without
  those, text is read as objdump output only when every line has an address prefix, there are at least three lines,
  and the steps between the addresses fit the instructions (so `a: add rax, 1` / `b: dec rcx` / `jnz a` stays
  assembly). In objdump text a branch target is always an address (`jne 1b <psum+0x1b>`); GNU numeric labels (`1:` …
  `jnz 1b`) keep working in assembly. Code in `.text.*` sections (gcc's `main` in `.text.startup`,
  `-ffunction-sections`) is analyzed as `.text`. CRLF and lone CR line ends are read as line feeds (REST, MCP, the
  library, the CLI).

  Conditional branches to a symbol the text does not define (a loop's exits, `jae .Lout`, `.L` or not) are treated as
  not taken: the symbol is defined right after the analyzed code, so they assemble as short jumps, and a note in
  `stderr` says so. An undefined target of a `jmp` gives a warning (it is encoded as a 32-bit jump to an external
  symbol).
  objdump lines with their bytes are assembled as those bytes. With addresses, the alignment offset is the analyzed
  code's address modulo 64, unless `options.alignmentOffset` is given. When something other than the whole text was
  analyzed, the response has `loop`: `{index, count, name, line, endLine, lines?, address?, alignmentOffset?}` (`name`:
  `"loop .L3"`, `"loop 0x10"`, `"body"`; `lines`: the source line of each instruction).
  Region markers (`# LLVM-MCA-BEGIN` … `# LLVM-MCA-END`, `# wuica-begin` … `# wuica-end`, IACA's byte markers) select
  the first marked region. A `;` that starts a line is a comment. After a statement, LLVM reads `;` as a separator. If
  what follows assembles, it is assembled, and a note in `stderr` names it (`';' separates statements: 'call helper'
  was assembled (use # for a comment)`), unless the `;` follows the statement without a space, as GNU as code chains
  statements (`dec rcx; jnz 1b`). If what follows does not assemble, for any reason, it is a comment, so nothing after
  a `;` makes a valid line an error. A note says so when the comment starts with a mnemonic (`add the next element`),
  and there is none when it does not (`sum += a[i]`). A line the assembler rejects inside the analyzed code is an error
  with its line number (objdump lines outside the picked loop that the assembler rejects, such as padding, are left
  out).
- Every field of `options` is optional; the defaults are shown. Unknown options and unknown request fields are an
  error (code 1), not ignored. The library also accepts the options at the top level of the request
  (`{hex, arch, minIterations}`); `options` takes precedence. The MCP tools accept only the nested form.
- The source must be 64-bit code: `.code16`, `.code16gcc` and `.code32` are an error (code 1), since the analyzer
  only models 64-bit mode. `assemble` alone accepts them.
- `loop` is accepted by the library, REST (`/api/analyze`, `/api/compare`, `/api/what-if`, each block of `/api/diff`),
  the MCP tools `analyze`, `what_if`, `compare_archs` and `diff_blocks` (per block), and the package's CLI (`wuica
  -loop auto|whole|N`, also for `wuica diff`). The reference/test binary (`crates/wuica-cli`) reads machine code only
  (hex or `-raw`), so it has no `-loop`. When the text has more than one loop, `otherLoops` lists the others (as
  `listLoops` and `-loops` give them, without `auto`) in the analyze, summary and compare results.
- Assembly input: each instruction row (and `instructions[]`, `insights.chain[]`, `insights.hot.instructions[]`) has
  `line`, its 1-based line in the text, and `loc` ("file.c:12") when the text has `.file`/`.loc` directives. Both come
  from what the loop finder and the assembler record, not from matching the text. Machine code has neither.
- Profiles are read without conversion. `objdump -dS` (or `-S`) output gives each instruction `source`, the
  interleaved source line in force. `perf annotate --stdio` output gives `samples` and `source`. `samples` is the
  instruction's percent of all the samples of the output: each symbol's percentages weighted by its sample count, or,
  if a header has no count, each symbol's own percentages, which a note says. When perf output has several loops, the
  one whose own instructions (not those of a loop nested in it) have the most samples is analyzed (`loop` can still
  pick another). `perf annotate --stdio2` output has no addresses: it is refused with a note to use `--stdio`. A text
  with `.rept`, `.irp`, `.irpc`, `.macro` or `.if` has no `line` (its lines are not its instructions one to one) and
  is analyzed whole, with a note. Code with a data directive (`.byte`, `.fill`, ...) among the analyzed instructions
  has no `line` either. A prefix alone on its line (`lock`, then `add [rdi], eax`) is part of the next instruction.

## Option ranges per interface

The numeric options have the same range in the library, the CLI, the MCP tools and the REST API: any integer up to
2^53 - 1 in magnitude. Any other value is refused (code 1, REST 400; the MCP tools' schema rejects it).
Negative values and values above 63 of `alignmentOffset` are read modulo 64; the reference binary `crates/wuica-cli`
refuses an `alignmentOffset` beyond ±2^62.
Everywhere, a block of more than 250,000 uops per iteration is refused (a work budget, code 3), and very large values run
out of memory (code 3). The differences:

| Interface | Limits |
|---|---|
| REST API and remote MCP (`server/`) | `minIterations` at most 1000, `minCycles` at most 20000; `source` at most 64 KB, `hex` at most 65536 characters, at most 10,000 instructions |
| MCP tools (stdio and remote) | `minIterations` 1–100000, `minCycles` 1–1000000 (an agent should not start a 3 GB simulation by accident) |
| API server, its rate limit | per client, a token bucket (`rateBurst`, `ratePerMinute`); a request costs in proportion to the analyses it can start, as many as a compare of every microarchitecture costing `compareCost` (3): analyze 1 token, what-if `ceil(3 × analyses / 15)` with the base and one analysis per variant (`nochain` none, `align` 64): 3 for the default variants, 13 for `align` alone, 15 for both; diff 1; a compare `compareCost` whatever it lists, and at least one token per job it can run at once (a compare split over idle workers); at least 1 per request, at most the burst; the same in REST and `/mcp`. What-if and diff run all their analyses within one job's time limit and start none once the client has gone: a what-if returns the variants that finished and marks the others `not run: deadline` (`notRun` on the result); a diff fails and says which block was analyzed |
| web page | clamps `alignmentOffset` to 0–63, `minIterations` to 1–10000, `minCycles` to 1–100000; at most 1 MiB of machine code |

Microarchitecture ids are matched the same way everywhere (see [Microarchitectures](#microarchitectures-get-apiarchs) above; `adlp`, `adl-p` → `ADL-P`).
Hex may contain spaces, commas and `0x` / `\x` prefixes everywhere.

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
warnings, the notes on exits treated as not taken, and the warning "N position(s) could not be decoded". `unsupported`
is present only when the CPU cannot run the code: its decoder skipped some positions (AVX-512 on SKL), or its decoder
accepts an instruction of an extension the CPU lacks (AVX-512 on ZEN3, detected by the instruction's encoding). It
holds the reason: `"needs AVX-512"` when the extension is known (from the instruction, or from the analyzed assembly
text without its comments), else `"12 undecodable"`. `tp` is then the reference's number, which leaves that code out,
and the text report, the Markdown and the web page do not present it as a result. `noData` is present only when the
CPU can run the code but some of the instructions are not in its tables (the note X: x87 tbyte loads, syscall, CLWB on
ICX). It holds their count; the result stands, without their cost. compare's rows can have both fields. `insights` is
in REST responses only (the library's `analyze()` result does not have it; `w.insights(r)` computes it). It is the
diagnosis described under the compact form below, with `portSet` and `issueSlots` when `options.details` is true.

**Plain text** (CE's `Accept: text/plain`): the response is `text` (uiCA's report), or the `stderr` lines on failure.
In the library this is `r.text`; the MCP tool takes `format: "text"`.

**Markdown** (`Accept: text/markdown`, analyze, compare, what-if and diff): what `wuica -md` prints
(`markdown.report`, `markdown.cpuTable`), with the same status codes.

**Compact form** (the MCP `analyze` JSON, `w.summarize(r)`): `{code, arch, name, year, prototype, tp, unit, mode,
bottlenecks, limits, decodeErrors, hex?, loop?, stderr, instructions, insights}`. Each entry of `instructions` is
`{instr, bytes, issued, executed, uopSource: {MITE|DSB|LSD|MS: n}, ports: {"Port 0": n, ...}, notes, uopsInfo}`
(zero values omitted, numbers rounded to 2 decimals). `insights` is a diagnosis derived from the analysis, like the web
page's "bound" view. It has `utilization` (each limit and port: cycles / tp), `binding` (the bottlenecks uiCA names:
always the same as `bottlenecks`, `[]` when it names none), `largest` (only when `binding` is `[]`: the largest limit,
the nearest bound, which alone does not reach tp; the web page shows "unknown · nearest Ports"), `next` (`{limit, tp,
maxSpeedup}`: the next limit, and the largest possible speedup if the binding limit went away), `unexplained` (cycles
no single limit explains), `chain` (the critical loop-carried chain: `{index, instr, operand, latency, carried}`) and
`hot` (`{resource, ports?, instructions: [{index, instr, share}]}`: the largest shares of the binding resource, or of
the largest limit). It also has `caveats`, only if any apply: `[{id, text, title, instructions}]`, the known blind
spots of the model that the block meets. The web page shows them in one line under the throughput. `rmw-index` marks a
read-modify-write to an indexed address, whose store forwarding between iterations depends on the data. `paths` marks a
conditional branch inside the block (an if/else, a second back edge), both of whose sides are simulated one after the
other while a real iteration takes one (named by its source line). `exit` marks an exit before the loop's branch, whose
mispredict is not modeled. `split` marks loads at an offset that is not a multiple of their width, which may cross a
cache line; on the CPUs whose model charges line crossings (ZEN3, ADL-P, ICX: `splitLoadCycles` in uarch.json), it
covers only the loads whose address the model cannot follow (an address register written other than by adding an
immediate). With `options.details` (MCP: `details: true`), each instruction also has `allowedPorts`
(`1*p0156+1*p23`), `uops`, `fusedUops`, `latencies` (`"RAX->RAX:1"`) and `frontEnd` (`length`, `offset`, `crosses`,
`lcp`, `microcoded`, fusion), and `insights` has `portSet` (the ports behind the Ports limit, `cycles` = uops / ports,
and the instructions that load them) and `issueSlots` (per iteration: issued, and lost to the front end, a full ROB or
RS, or other).

## Failures

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

## Compare: `POST /api/compare`

The request is the same as for analyze, plus an optional `archs` and `per`. `archs` lists ids; when it is missing or
empty, all listed microarchitectures are analyzed, and a repeated id counts once. `per` is the number of elements per
iteration; it adds `elementsPerIteration` and each row's `perElement`, as `wuica -arch A,B -per N` does. The response:

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

## What-if: `POST /api/what-if/<arch>`

The request is analyze's plus `variants` and `per`. `variants` lists variant ids; the default is all of `unroll2`,
`unroll4`, `unroll8`, `acc2`, `acc3`, `acc4`, `acc8`, `simpleFrontEnd`, `noMacroFusion`, `noMicroFusion` and `nochain`.
`align` runs only when asked for: it analyzes the block at each of the 64 alignment offsets (64 analyses), its `tp` is
the median, and it adds `alignment` {min, median, max, best, worst, spread, offset}. `per` (elements per iteration)
adds cycles per element. The response is the same as the MCP tool's and `wuica -whatif -json`'s (`WhatIfResult`): the
base `tp`; per variant, `tp` per original iteration, `delta` and `speedup`, or `error`; and `accumulators.best`.
`text/plain` gives the CLI's table, `text/markdown` the Markdown one. Each variant is one analysis (`nochain` none,
`align` 64), and the request costs tokens in proportion (see the rate limit in [Option ranges per interface](#option-ranges-per-interface) above).

## Diff: `POST /api/diff/<arch>`

The request is `{a: block, b: block, options?, per?}`. Each block is an analyze request; `options` applies to both;
`per` is the number of elements per iteration (N for both, or [A, B]). The response (`DiffResult` in index.d.ts;
`wuica diff -json`): `a` and `b` (`tp`, `bottlenecks`, `perElement`), `delta`, `speedup`, `verdict`, `perElement`,
`bottlenecks` (`gone`, `new`), `limits`, `ports` (uops per iteration before and after) and `instructions` (`counts`;
`changes`: `changed`, `modified`, `added`, `removed`, with the change of their uops). A failure of one block has an
`error` that starts with `A: ` or `B: `. `text/plain` gives the CLI's text, `text/markdown` the web page's A–B tables.

## Assemble: `POST /api/assemble`

Request: `{"source": "...", "syntax": "intel"}`. The whole text is assembled as it is (no loop finding, no region
markers; `;` comments as above). Response: `{"code": 0, "hex": "4801d8", "length": 3, "stderr": []}`;
the library also returns `bytes` (a `Uint8Array`). On failure: `{code: 2, error, stderr}` as above. The assembler is
LLVM 22.1.2's (the same bytes as `llvm-mc`). Only `.text` is returned. `.include`/`.incbin` always fail. GNU as's
`{load}`/`{store}` hints, which LLVM rejects, are removed at the start of a line, clang 23's `.prefalign` is read as
`.p2align`, and the line table (`.loc`, numbered `.file`) is not assembled (so gcc 11+ `-g` output assembles).
