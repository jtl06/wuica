# The WebAssembly interface

`crates/wuica-wasm` builds `wuica_wasm.wasm` (target `wasm32-unknown-unknown`: no imports, no WASI). Only integers cross the
boundary; strings and bytes are passed as (pointer, length) into the module's memory, and results are read from a buffer owned
by the module. All text is UTF-8; structured values are JSON.

## Exports

| Export | Meaning |
|---|---|
| `memory` | the module's memory |
| `wuica_alloc(len: u32) -> ptr` | allocates `len` bytes for an input |
| `wuica_free(ptr, len)` | frees a buffer from `wuica_alloc` |
| `wuica_result_ptr() -> ptr` | start of the result of the last call (valid until the next call) |
| `wuica_decode(code, code_len, chip, chip_len) -> len` | decodes machine code for an XED chip name; result: JSON array of decoded instructions, or `{"error": ...}` |
| `wuica_load_uarch(json, len) -> len` | loads `data/uarch.json` (once); result: `{"ok": true}` or `{"error": ...}` |
| `wuica_load_arch(name, name_len, json, len) -> len` | loads the instruction table `data/arch/<name>.json`; result as above |
| `wuica_analyze(request, len) -> len` | runs an analysis; result: a response object (below) |

Each function returns the length of its result; read it at `wuica_result_ptr()` *after* the call (the memory can have grown:
create typed-array views after the call, not before).

## Analysis request

```json
{
  "hex": "4801d84801c349ffcf75f5",
  "arch": "SKL",
  "alignmentOffset": 0,
  "initPolicy": "diff",
  "simpleFrontEnd": false,
  "noMicroFusion": false,
  "noMacroFusion": false,
  "minIterations": 10,
  "minCycles": 500,
  "includeTrace": false
}
```

Only `hex` and `arch` are required; the other values shown are the defaults. `arch` is a key of `configs` in `uarch.json`; a
configuration has the fields of uiCA's `MicroArchConfig`, among them `name` (the instruction table it needs), `XEDName` and
`experimental` (true for the models added by the fork: ZEN3, ADL-P, ICX; keys that contain `_` are uiCA's ablation variants). The
instruction table that the configuration needs (`configs[arch].name`) and `uarch.json` must have been loaded. `initPolicy` is
`"diff"`, `"same"` or `"stack"`.

## Failures and traps

wuica reproduces the fork of uiCA with its crash fixes (`docs/DEVIATIONS.md`): every input on which upstream uiCA raises an
exception either gets a result or an error that says what is wrong with the input (the same text as the fork's `InputError`, e.g.
"no iteration was completed (minIterations must be at least 1, or minCycles larger)"). No error says "the reference
implementation fails" for any known input; the checks that would give it remain in the simulator, each with the reason why no
input reaches it.

No known input makes the module panic: a fuzzer (`crates/wuica/examples/fuzz.rs`, and the suite `wuica:fuzz_short` of
`scripts/check.sh`) analyzes random blocks of real encodings with random options on all 15 CPUs and checks this.

A call can still **trap** (the module throws a `WebAssembly.RuntimeError`) when it runs out of memory: e.g. 200 × `div rcx` with
`minIterations` 10000 and `minCycles` 100000, or a 5,000-instruction block at the server's limits (about 2 GB). After a trap, the
instance must not be used again: create a new instance, call `wuica_load_uarch` and `wuica_load_arch` again, and continue. (The
web page keeps the bytes of the loaded tables for this.) `wbinvd` has about 10^6 uops in the tables: with it, a block is
rejected ("invalid input: too many operands", e.g. on IVB and ADL-P, where one of its uops has more than 65,535 input operands),
takes 40 s to several minutes (seen on SKL, SKX, KBL, CFL), or runs out of memory (seen on CLX); the reference takes hours.

## Analysis response

On failure: `{"error": "message"}` (unknown configuration, table not loaded, no instructions, unsupported configuration, ...).

On success:

```json
{
  "arch": "SKL",
  "tp": 1.25,
  "mode": "loop",
  "decodeErrors": 0,
  "bottlenecks": ["Dependencies"],
  "limits": [
    {"name": "Predecoder", "tp": 0.69},
    {"name": "Decoder", "tp": 0.75},
    {"name": "Issue", "tp": 0.75},
    {"name": "Ports", "tp": 0.75},
    {"name": "Dependencies", "tp": 1.0}
  ],
  "columns": ["MITE", "MS", "DSB", "LSD", "Issued", "Exec.", "Port 0", "Port 1", "Port 2", "Port 3", "Port 4", "Port 5", "Port 6", "Port 7", "Div"],
  "rows": [
    {
      "kind": "instr",
      "label": "add rax, rbx",
      "opcode": "4801D8",
      "instrStr": "ADD (R64, R64)",
      "url": "https://www.uops.info/html-instr/ADD_01_R64_R64.html",
      "notes": "",
      "values": [0, 0, 0, 1.0, 1.0, 1.0, 0.25, 0.25, 0, 0, 0, 0.25, 0.25, 0, 0]
    }
  ],
  "text": "Throughput (in cycles per iteration): 1.25\nBottleneck: Dependencies\n...",
  "trace": null
}
```

- `tp`: predicted throughput in cycles per iteration of the block.
- `mode`: `"loop"` if the block ends with a branch (it is analyzed as a loop), `"unroll"` otherwise (as if repeated back to back).
- `decodeErrors`: number of positions in the input that could not be decoded; the instructions that were decoded are analyzed.
- `bottlenecks`: names from uiCA's "Bottleneck(s)" line; can be empty.
- `limits`: uiCA's "throughputs that could be achieved if the given property were the only bottleneck", in its order; entries
  that do not apply are absent (e.g. `"LSD"` or `"DSB"` only for loops served from there).
- `columns` / `rows[].values`: the uop table. `values[i]` belongs to `columns[i]`; numbers are averages per iteration. The port
  columns are named as uiCA prints them (`"Port 0"`, or names such as `"ALU0"`, `"AGU1"`, `"FP2"` for Zen 3). `"Div"` is only
  present if a divider is used.
- `rows[].kind`: `"instr"` for an instruction; `"regMerge"` and `"stackSync"` for the extra uops that the renamer inserts before
  an instruction (label `"<Register Merge Uop>"` / `"<Stack Sync Uop>"`; no `opcode`, `instrStr`, `url`).
- `rows[].notes`: `"M"` (macro-fused with the previous instruction), `"J"` (cannot be in the DSB because of the JCC erratum),
  `"X"` (instruction not supported: no data), or `""`. `url` is `null` for unsupported instructions.
- `text`: the complete report as the command-line tool prints it (without terminal escape sequences).
- `trace`: with `"includeTrace": true`, the content of uiCA's `-json` output (`{parameters, instructions, cycles}`: the events of
  every cycle); otherwise `null`. It is large.
- `criticalPath` (optional; present only if the `"Dependencies"` limit is not 0): the loop-carried dependency cycle that gives
  that limit (`edgesOnMaxCycle` of uiCA's `computeMaximumLatencyForGraph`), in terms of the rows of the uop table:

  ```json
  "criticalPath": {
    "ratio": 2.0,
    "edges": [
      {"from": 0, "to": 1, "operand": "RAX", "latency": 1, "carried": false},
      {"from": 1, "to": 0, "operand": "RAX", "latency": 1, "carried": true}
    ]
  }
  ```

  (for `add rax, 1; add rax, 1; dec r15; jnz`). Each edge says that the instruction in row `from` (an index into `rows`) produces
  a value that the instruction in row `to` reads: `operand` is the register as written in the reading instruction (`"RAX"`,
  `"EAX"`, `"XMM1"`, ...), `"mem"` (a value passed through memory) or `"flags"`; `latency` is the number of cycles from the input
  of `from` on the cycle to that input of `to`; `carried` is true if `to` is in the next iteration. The edges are in the order of
  the cycle (`edges[k].to == edges[k+1].from`, and the last edge leads back to the first), starting after a carried edge.
  `ratio` = sum of the latencies / number of carried edges (the iterations the cycle spans) = the `"Dependencies"` limit before
  rounding.

## Details (`"details": true`)

Not in uiCA. With `"details": true` in the request, the response has one more field, `details`; every other field is the same
as without it, byte for byte (`crates/wuica/tests/details.rs` checks this on every case of the simulation fixtures, and
`WUICA_DETAILS=1 node tests-js/analyze_fixtures.mjs` on the module). Without the flag, nothing is computed or recorded.

```json
"details": {
  "rows": [
    {
      "index": 0,
      "portData": [{"ports": ["Port 0", "Port 1", "Port 5", "Port 6"], "uops": 1}, {"ports": ["Port 2", "Port 3"], "uops": 1}],
      "uopList": [
        {"ports": ["Port 2", "Port 3"], "inputs": ["[RSI]"], "outputs": [["pseudo", 5]], "divCycles": 0, "load": true, "storeAddress": false, "storeData": false},
        {"ports": ["Port 0", "Port 1", "Port 5", "Port 6"], "inputs": ["RAX", "pseudo"], "outputs": [["RAX", 1], ["flags (C)", 1], ["flags (SPAZO)", 1]], "divCycles": 0, "load": false, "storeAddress": false, "storeData": false}
      ],
      "latencies": [{"from": "RAX", "to": "RAX", "cycles": 1}, {"from": "mem", "to": "RAX", "cycles": 3}, {"from": "[RSI]", "to": "RAX", "cycles": 6}],
      "uops": 2, "retireSlots": 1, "uopsMITE": 1, "uopsMS": 0, "tpTable": null, "divCycles": 0,
      "length": 3, "offset": 0, "crosses": [], "lcp": false, "microcoded": false, "complexDecoder": false,
      "macroFusedWithPrev": false, "macroFusedWithNext": false, "mayBeEliminated": false, "branch": false, "serializing": false
    }
  ],
  "ports": {"ports": ["Port 6"], "uops": 1.0, "tp": 1.0, "rows": [0.0, 1.0, 0.0]},
  "issue": {
    "width": 4, "cycles": 242, "iterations": 242, "first": 246,
    "slots": {"issued": 2.0, "frontEnd": 2.0, "rob": 0, "rs": 0, "other": 0},
    "issued": [2, 2, 2], "cause": "FFF"
  }
}
```

(for `add rax, [rsi]; dec r15; jnz` on SKL; shortened).

- `rows`: one entry per row of the uop table (`null` for the register merge and stack sync rows): the instruction's data as the
  model uses it (uops.info's tables, after uiCA's adjustments). `portData`: the allowed ports and the number of uops for each set
  (uops.info writes `1*p0156+1*p23`); ports are named as the columns of the uop table. `uopList`: the unfused-domain uops, each
  with its allowed ports (`null`: no port), its inputs and its outputs with the latency to each. `latencies`: the instruction's
  latency for each (input, output) pair. `uops`: unfused-domain uops; `retireSlots`: fused-domain uops (issue slots). Operands are registers (`"RAX"`), address registers (`"[RSI]"`), `"flags (C)"` /
  `"flags (SPAZO)"`, `"mem"`, and `"pseudo"` (a value passed between the uops of one instruction). `tpTable`: the reciprocal
  throughput from the tables, if it limits the instruction. Front end: `length` in bytes, `offset` of the first byte from the
  64-byte boundary before the first iteration (the alignment offset plus the position in the block), `crosses` the 16-, 32- and
  64-byte boundaries it crosses there, `lcp` a length-changing prefix (a predecoder stall), `microcoded` uops from the microcode
  sequencer, `complexDecoder` needs the complex decoder, `macroFusedWithPrev` / `macroFusedWithNext`.
- `ports`: the set of ports behind the `"Ports"` limit (Facile's port model as uiCA computes it: of the unions of two allowed port
  sets, the one with the most uops per port; the first such union on a tie), the uops per iteration that can only use these
  ports, `tp` = uops / number of ports (the `"Ports"` limit before rounding), and per row its uops on the set. `null` if no uop
  needs a port.
- `issue`: the issue slots of the steady state (the cycles from the one that issued the end of the first relevant round to the
  one that issued the end of the last one; `iterations` rounds): per iteration, the issued fused-domain uops and the lost slots
  (issue width − issued, per cycle) by the cause the simulation had: `frontEnd` (the IDQ ran empty), `rob` (the reorder buffer
  was full), `rs` (the scheduler was full), `other` (the next uop did not fit into the cycle, a serializing instruction waited,
  or register merge uops were inserted). `issued` and `cause` list the cycles of the window one by one (at most 4096, from
  cycle `first`): `"."` for a cycle that issued the full width, else `F`, `R`, `S` or `O`. `null` if the simulation has no
  steady-state window (one round). Issue runs ahead of retirement until the reorder buffer or the scheduler is full, and the
  simulation of `minCycles` often ends before that (about a quarter of random blocks, e.g. `mov rax, [rax]; dec rcx; jnz` on
  ADL-P: 48 iterations issued in 16 cycles). Then, without `includeTrace`, the log is that of a longer simulation (8 or 64
  times `minCycles`, at most 250,000 instructions simulated, and only if longer than the simulation was; the rest of the response is still that of the simulation of
  `minCycles`): `cycles / iterations` is the throughput (within 3 % and two cycles) but in about 1 % of random blocks. With
  `includeTrace`, the log is that of the trace's cycles (`first` is a cycle of the trace), also when it is warm-up.
  With `simpleFrontEnd`, the front end delivers the unfused uops one by one (as uiCA's simple front end): `issued` counts
  them, and can be more than the uop table's `Issued` (fused uops).
- `portData` is the table's (uops.info); `uopList` the uops the model builds from it. They differ for a few instructions
  (cpuid, `ret imm16`, in/out/ins, enter, wrmsr): uiCA pairs store-address and store-data uops and drops the rest, so
  `uopList` (and the uop table) have fewer uops than `portData` (and the `Ports` limit, which uses `portData`).

Speed (`crates/wuica/examples/phases.rs` with `DETAILS=1`; `tests-js/analyze_fixtures.mjs` with `WUICA_DETAILS=1`): about 8 %
more time per analysis natively and 11 % in WebAssembly for small blocks, about 27 % for the 2,949-instruction SHA-256
example (18.5 → 23.5 ms natively: building the details, and their JSON); a request without the flag is as fast as before.
A block whose issue had not reached the steady state takes one or two longer simulations more (8 and 64 times `minCycles`,
limited to 250,000 instructions simulated: a few tens of ms natively; the page's examples: under 2 ms).

## Assembler

Assembly text is turned into machine code by a separate, lazily loaded module (`assembler/`, LLVM's x86 assembler); its interface
is described in `assembler/README.md`. The page passes the resulting bytes to `wuica_analyze` as `hex`.

### Marked regions and `.loc` lines (the page)

Before the assembler, the page looks for region markers in pasted assembly (`web/js/asm-regions.js`); without any, the text is
assembled as it is. With a marked region, only its bytes are analyzed (the first region, if there are several; a chip `▣ name 1/3`
under the input names it, its tooltip lists the markers, a click selects its BEGIN line). Markers:

| Convention | Start | End |
|---|---|---|
| llvm-mca | `# LLVM-MCA-BEGIN [name]` | `# LLVM-MCA-END [name]` |
| wuica | `# wuica-begin [name]` | `# wuica-end` |
| IACA / OSACA (bytes) | `mov ebx, 111` + `.byte 0x64, 0x67, 0x90` | `mov ebx, 222` + `.byte 0x64, 0x67, 0x90` |

Comment markers may start with `#`, `//` or `;`, in Intel or AT&T syntax (AT&T IACA: `movl $111, %ebx`); the IACA markers
themselves are not part of the region. An END without a name, or with the region's name, ends it; a region without an END runs
to the end of the code. The whole text is still assembled (labels, directives and branches outside the region keep their
meaning and their encodings): local labels at the region's ends and a trailer at the end of `.text` give the offsets, and are
cut off again. A region outside `.text`, or without instructions, is an error at its BEGIN line.

Compiler output with debug lines (`gcc -g -S`, `clang -g -S`: `.file N ["dir"] "name" [md5 …]`, `.loc N LINE …`) gives each
instruction the line of the `.loc` before it, the same way; the cost per source line (`src=1`, `web/js/srcmap.js`) then shows
`file:line` rows (the source text is not in the listing) for the main file, the one with the most lines in the analyzed code.
gcc's `view` operand of `.loc`, which LLVM rejects, is dropped.

### The loop of a whole function (the page, the library, REST, MCP, the package's CLI)

For an analysis, pasted assembly goes through `web/js/loop-find.js` before the regions above (the npm package has a copy
in `packages/wuica/lib/web`). The option is `loop`: `"auto"` (the default), `"whole"` (never a pick) or the index of a
loop (innermost first, in code order). The page shows the choice as a select under the input when it matters; the API
returns `loop: {index, count, name, line, endLine, address?, alignmentOffset?}` when something other than the whole text
was analyzed. In `"auto"`:

- **Loops**: backward branches to a label or an address; several branches back to one label are one loop. A span with a
  `ret` or another function's label (`.globl`, `.type @function`, or a call/jump target from outside) is not a loop.
  The first innermost loop is analyzed, unless the text is that loop already.
- **No loop**: a compiler's function (a function label, directives, a prologue/epilogue, or objdump) that ends in `ret`
  is analyzed without prologue, epilogue and `ret`; a bare snippet (`add rax, 1` / `ret`) as typed.
- **Exits**: a conditional branch to a symbol the text does not define is a short, not-taken jump to the end of the
  analyzed code (a note); an undefined `jmp` target is a warning.
- **objdump**: recognised by a header, a byte column or `<sym+off>` targets, else only if every line is address-prefixed
  (three or more, with steps that fit the instructions). Targets are addresses (`jne 1b <f+0x1b>` is 0x1b). Lines with
  bytes are assembled as those bytes; a line the assembler rejects is left out only outside the analyzed loop (padding),
  inside it is an error. The alignment offset is the analyzed code's address mod 64 unless one is given (the page: for
  each pick; an offset set by hand, in a link or by an import stays for that text).
- **Sections**: `.text.*` (gcc's `main` in `.text.startup`, `-ffunction-sections`) is analyzed as `.text`.
- **Line ends**: CRLF and a lone CR are line feeds.
- **`;`**: at the start of a line, a comment. After a statement, what assembles is assembled (a note names it, unless the
  `;` follows the statement without a space: `dec rcx; jnz 1b`); what does not is a comment (a note if it starts with a
  mnemonic). Nothing after a `;` makes a valid line an error.

Only the package's CLI takes `-loop`; the native CLI (`crates/wuica-cli`) reads machine code only.

### Derived fields (the npm package, REST, MCP)

Not in this module's response; the package computes them (`packages/wuica/README.md`, "Compact form"):
`insights.binding` (exactly `bottlenecks`, `Divider` included), `insights.largest` (when `bottlenecks` is empty: the
largest limit, the nearest bound), `insights.caveats` (known blind spots the block meets: `rmw-index`, `exit`, `split`;
`split` depends on the CPU's `splitLoadCycles`), and `what_if`'s `acc2`/`acc3`/`acc4`/`acc8` variants (N
accumulators: the chain's register renamed in each unrolled copy; refused, with a reason, for a chain through memory,
flags, an implicit operand, the induction variable, or a register also used off the chain) with `accumulators.best`.
