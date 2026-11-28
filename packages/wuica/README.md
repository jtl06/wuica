# wuica

Throughput prediction for x86-64 basic blocks, running locally in Node. **wuica** (WebAssembly uiCA) is an independent
Rust/WebAssembly port of [uiCA](https://github.com/andreas-abel/uiCA). Its reports are bit-identical to the Python uiCA on the
port's test corpus. The package contains:

- a **library**: `import { createWuica } from 'wuica-cli'`
- a **command-line tool**: `npx wuica-cli loop.s -arch SKL`
- a local **MCP server** (stdio) for AI agents: `npx wuica-cli mcp`

In the browser: [wuica.jacen.li](https://wuica.jacen.li) · source and issues: [github.com/jtl06/wuica](https://github.com/jtl06/wuica) ·
hosted API: [api.wuica.jacen.li](https://api.wuica.jacen.li)

This is **not the official uiCA** (that is [uiCA.uops.info](https://uiCA.uops.info) and the
[uiCA repository](https://github.com/andreas-abel/uiCA)). The instruction data (latencies, throughputs, port usage) comes
from [uops.info](https://www.uops.info). Besides uiCA's Intel models (Sandy Bridge to Rocket Lake), wuica includes the
experimental models of the fork [jtl06/uiCA](https://github.com/jtl06/uiCA): **AMD Zen 3 (ZEN3), Alder Lake P-core
(ADL-P) and Ice Lake server (ICX)**. They are marked `prototype` and are less validated than the models from uiCA.

Everything runs offline. The two WebAssembly modules (the analyzer, and LLVM's x86 assembler for assembly input) and the
instruction tables are shipped brotli-compressed. A table is loaded the first time its microarchitecture is used.
Requirements: Node.js 20 or later. **No dependencies**: `npm install wuica-cli` (or `npx wuica-cli`) adds this one
package, 2.4 MB unpacked; the MCP server is part of it.

The commands are `wuica` and `wuica-mcp`. Install them with `npm install -g wuica-cli`, or run without installing
with `npx wuica-cli ...`. The examples below write `wuica`.

## The CLI in five minutes

```
wuica -example saxpy -arch SKL,ZEN3,ADL-P      # a built-in loop, no file needed (-examples lists them)
clang -O3 -march=haswell -S dot.c -o dot.s     # AT&T, as clang and gcc write it: detected, no flag needed
wuica dot.s                                    # uiCA's report for SKL, of the loop wuica picked
wuica dot.s -arch SKL,ZEN3,ADL-P               # one table for several CPUs ("all": every one)
wuica dot.s -per 8                             # the loop does 8 elements per iteration: cycles per element too
wuica dot.s -loops                             # the loops in the file; -loop N or -loop .LBB0_12 picks one
wuica dot.s -whatif                            # unrolled, N accumulators, front end and fusion variants
wuica dot.s -arch SKL,ZEN3 -md                 # Markdown to paste in an issue or a chat (any mode)
wuica diff dot.s dot4.s -per 8,32              # before and after: speed-up, bottlenecks, ports, instructions changed
clang -O3 -c dot.c && wuica dot.o -func dot    # an object file (ELF or Mach-O, x86-64): no objdump needed
wuica *.s -arch SKL,ZEN3                       # several files in one run: one table (-files LIST for long lists)
objdump -d dot.o | wuica                       # objdump output: the loop's real alignment from its address
perf annotate --stdio -s dot | wuica           # a profile: the hottest loop, samples and source lines per instruction
```

On an Arm Mac, add `--target=x86_64-linux-gnu` to the clang command: wuica analyzes x86-64 code, and Apple's clang does
not accept `-march=haswell` for arm64.

The first command prints one row per CPU:

```
Arch   Model              Year      TP  Bottlenecks          Notes
SKL    Skylake            2015    1.50  Issue, Ports
ZEN3   AMD Zen 3          2020    1.00  Dependencies, Ports  [prototype]
ADL-P  Alder Lake P-core  2021    1.00  Issue, Ports         [prototype]
```

`TP` is the predicted cycle count per iteration of the loop, and `Bottlenecks` names what limits it: one iteration takes
1.50 cycles on Skylake and 1.00 on the other two. This loop handles 8 floats per iteration, so `-per 8` adds a column of
cycles per element (0.19 and 0.13). With one CPU, wuica prints uiCA's report: the limits, and a table with a row per
instruction that shows its uops and the ports they run on.

## What the numbers mean

`tp` is the predicted steady-state throughput in **core cycles per iteration** of the block (lower is faster). How the
block is simulated depends on how it ends:

- A block that ends with a branch is simulated as a loop body (`mode: "loop"`).
- Any other block is simulated as if it were unrolled, i.e. repeated back to back (`mode: "unroll"`).

The model assumes that all data is in the L1 cache, that no branches are mispredicted, and that nothing else is running
on the core. `bottlenecks` names what limits the throughput, such as Dependencies (a loop-carried chain), Ports, Issue,
Decoder or DSB. `limits` gives the throughput each component alone would allow. `text` is uiCA's complete report.

## Command line

```
wuica loop.s                         # assembly file (syntax detected), uiCA's report for SKL
wuica loop.s -arch ICL -TPonly       # only the throughput
cat loop.s | wuica -arch ZEN3        # stdin (or "-")
wuica -att loop_att.s                # AT&T syntax, forced (-intel forces Intel)
wuica 4801d84801c349ffcf75f5         # a hex argument (as in the repository's reference binary)
wuica -hex code.txt                  # hex from a file or stdin ("48 01 d8", "0x48,0x01" are fine)
wuica -raw code.bin                  # raw machine code
wuica loop.s -arch all               # throughput table for every microarchitecture (in parallel)
wuica loop.s -arch SKL,ICL,ZEN3      # throughput table for these
wuica -list                          # the microarchitectures
wuica loop.s -json                   # the JSON result (the contract's analyze response)
wuica loop.s -arch SKL,ZEN3 -md      # Markdown (an issue, a review, a chat); with -whatif, -loops, several files
wuica psum.s -loop whole             # the whole text, not the loop found in it (-loop auto, the default, or -loop N)
wuica psum.s -loops                  # list the loops; -loop .LBB0_12 or -func psum to choose
wuica psum.s -whatif -per 8          # what-if variants; cycles per element (8 elements per iteration)
wuica psum.s -variants align,acc4    # these variants only; align: the 64 alignment offsets (min, median, max)
wuica dot.o -func dot                # an object file (ELF or Mach-O x86-64); -funcs lists its functions
wuica a.s b.s c.o -arch SKL,ZEN3     # several inputs: one table, a row per file and CPU
wuica -files list.txt -TPonly        # the names from a file (- for stdin): file<TAB>cycles lines
wuica *.s -json                      # {code, files: [{file, ...}]}, each entry as a single run's JSON
wuica -examples                      # the built-in examples (the web page's set)
wuica -example dot1 -whatif          # one of them, as if it were the input file (every option applies)
wuica -example dot1 -show > dot.s    # its assembly, to save and edit
wuica diff a.s b.s -per 8 [-md|-json]  # two blocks (files, - or hex): before and after
wuica --version
```

The simulation options are uiCA's: `-alignmentOffset N`, `-initPolicy diff|same|stack`, `-simpleFrontEnd`,
`-noMicroFusion`, `-noMacroFusion`, `-minIterations N`, `-minCycles N`, and `-trace` (with `-json`). Every flag can
also be written `--flag` or `--flag=value`, in any letter case (`--tponly`, `--arch=zen3`). With several
microarchitectures or files, the number of threads depends on the amount of work (see Library); `-threads N` uses at
most N threads (`-threads 1` runs the analyses one after another).
Diagnostics go to stderr.
`wuica -h` lists all options.

- **Syntax.** wuica detects Intel (noprefix) or AT&T syntax from the text (`%rdx`, `$8`, `(%rdi,%rcx,4)` are AT&T) and
  names it on stderr (`analyzed: loop .LBB0_9 (lines 28-47, in dot), AT&T syntax (detected)`). `-att` or `-intel`
  forces one.
- **Per iteration.** `tp` is the cycle count per iteration of the loop as the compiler wrote it. Compilers unroll and
  vectorize (×8, ×16, ×32 elements per iteration), so compare cycles per element. `-per N` prints `Per element: …
  cycles` (JSON `perElement`; values under 0.1 get 3 significant digits, `0.0625`). Without `-per`, stderr shows the
  loop's step when it can, in the register's units: `rcx += 8 per iteration (index; ×4 bytes in [rdi+rcx*4])` is 8
  elements of 4 bytes, `r13 += 64 per iteration (bytes; the base of [r13+0x20])` is 64 bytes (16 floats: `-per 16`),
  and `(register step)` marks a counter that no address uses.
- **Which loop.** For a whole function or file, wuica analyzes one loop. By default (`auto`) it takes an innermost loop
  at the greatest depth, and of those the one whose vector instructions use the widest registers. Stderr says which loop
  was picked and how many others there are. `-loops` lists them (index, label, function, lines, instructions, depth,
  auto). `-loop N` (0-based) or `-loop LABEL` picks one, `-func NAME` keeps one function's loops, and `-loop whole`
  analyzes the whole text.

  <details>
  <summary>How the default loop is picked, and when it picks wrong</summary>

  By default (`auto`) it picks:
  1. only the innermost loops at the greatest depth (clang's `# =>This Inner Loop Header` notes count), and of those
     only the ones in the function of the first of them. In a file with several functions, the default therefore stays
     in that function (`-func` picks another). A loop that is the remainder of another of these loops is left out: it
     continues the counter of an earlier loop toward the same bound register after that loop stopped (the earlier
     loop's only exit is that compare, and the counter comes from the register it compares), so it runs less than one
     of its steps. clang's scalar tail of an unrolled loop is such a remainder, and is left out even when it has more
     instructions;
  2. among those, the one whose vector instructions use the widest registers (zmm, then ymm, then xmm, then none), then
     the one with more vector instructions;
  3. then the one with more instructions, then the first in the text.

  A vector instruction is an SSE/AVX/AVX-512 instruction that names an xmm, ymm or zmm register and works on several
  elements. Scalar code uses xmm registers too, so these do not count: scalar floating point (a mnemonic, without its
  `v`, that does not start with `p` and ends in `ss`, `sd` or `sh`: `addss`, `vfmadd231sd`, `movsd`, `cvtsi2sd`, and
  `cvttsd2si`, but not the broadcasts), one element moved to or from a general-purpose register or memory (`movd`,
  `movq`, `pinsr*`, `pextr*`, `insertps`, `extractps`, `movlpd`, `movhpd`), zero idioms (`vxorps xmm0, xmm0, xmm0`),
  register-to-register copies (`movaps xmm1, xmm0`), and `andps`/`andnps`/`orps`/`xorps` (and `pd`) on xmm registers,
  which compilers use for `fabs`, negation and `copysign` of scalars. So a vectorized loop is picked over its scalar
  remainder or peel loop wherever the compiler put them, and a scalar float loop does not beat a larger integer loop only
  because it uses xmm registers. The rule can still pick the wrong loop. A vectorized loop with a fixed, small trip count
  (merging sub-histograms) beats the scalar main loop; a small constant trip count is not held against a loop, because
  in an 8x8 transform the 8-iteration loops are the work. A cleanup loop that the compiler vectorized and unrolled with
  a counter of its own can beat a hand-written intrinsics loop or a loop unrolled by hand. gcc's vectorized peel loop
  (`-O3`) can beat the main loop. clang's conversion of a `uint64_t` to `double` without AVX-512 (`vunpcklps`, `vsubpd`,
  `vshufpd` around a `vaddsd`) makes a scalar loop look like a 128-bit vector loop. Without clang's notes (objdump
  output), a loop with several back edges can be found as overlapping loops, so the loops found in the `-S` and objdump
  outputs of the same code may differ. A loop three or more deep in clang's notes keeps the place in the `-loops` list
  it had when only the notes' first two lines were read. A label that names loops in several functions (`1:` …
  `jnz 1b`) is an error that lists them; `-func` or the index picks one.

  </details>

- **Branches inside the loop.** uiCA runs the analyzed code straight through. In a loop with an if/else (or two back
  edges, as clang's remainder loops often have), it simulates both sides of the branch, one after the other, while a
  real iteration takes one. A `Not modelled: both paths: both sides of the branch at line N …` line (table note
  `both paths`; JSON caveat `paths`) reports this. To analyze one side, put `# wuica-begin` and `# wuica-end` around it.
- **Inputs**: a file (assembly, objdump output, or an object file), `-` or nothing for stdin, a hex argument, `-hex` or
  `-raw FILE` (bare machine code).
- **Object files.** wuica reads an ELF or Mach-O x86-64 object, executable or shared object directly. Give a large
  executable a `-func`: with it, a 2.6 MB static executable takes 0.2 s; without it, the whole file is read, which
  takes minutes and can fail. COFF is not supported yet; use `llvm-objdump -d f.obj | wuica`.

  <details>
  <summary>Functions and loops in object files, duplicate names, arm64 objects</summary>

  The analyzer decodes its code into the text `llvm-objdump -d` prints, so `wuica dot.o` and `objdump -d dot.o | wuica`
  pick the same loop and give the same numbers. `-func NAME` takes the symbol (without Mach-O's `_`) or a unique part
  of it, and analyzes that function alone: its loop, or its body if it has none. `-funcs` lists the functions, `-loops`
  gives the loops' addresses, and objects built with `-ffunction-sections` work. When the file gives one name to several
  functions (static functions of different source files, gcc's `.cold` parts: any static executable has them), each
  is listed with its address as `NAME.0xADDR`; `-func NAME` then lists them, and `-func NAME.0xADDR` picks one. For an
  arm64 object (what a Mac compiles by default), wuica says so and how to compile for x86-64 (`clang -arch x86_64 -c`,
  or `--target=x86_64-linux-gnu`).

  </details>

- **Several inputs** (`wuica a.s b.s c.o`, a glob, or `-files LIST` with one name per line, `-files -` from stdin):
  one process analyzes all of them, spread over the threads.

  <details>
  <summary>The table for several inputs, other output modes, failures</summary>

  With one CPU, the table has a row per file (file, loop, TP, bottlenecks, notes). With several, it has a row per file
  and CPU, grouped by file, with a CPU column, so any number of CPUs fits in 80 columns. `-TPonly` prints
  `file<TAB>[CPU<TAB>]cycles` lines. `-report` adds uiCA's report of each file and `-whatif` the what-if tables, each
  after a `==> FILE <==` line. A file that fails does not stop the others: its row says why, and the exit status is the
  largest of the files' statuses. One input prints exactly what it printed before.

  </details>

- **Tables.** `-arch A,B,C` prints one row per CPU. `-` means unknown (uiCA names no single bottleneck; the notes give
  the nearest limit), and `5.00*` means that the CPU could not decode some instructions, which are left out. The notes
  column gives the caveats (what the model does not simulate, such as store forwarding through an indexed address).
- **After the report**, wuica prints what uiCA's text leaves out: the nearest limit when the bottleneck is unknown, the
  next limit, and `Not modelled:` lines.
- **What if** (`-whatif`): a table per CPU, in cycles per original iteration, or per element with `-per N`.

  <details>
  <summary>What-if lines with -TPonly</summary>

  With `-TPonly`, it prints one `variant cycles` line per variant after the throughput (`acc2 16.00`; with `-per`,
  `acc2 16.00 2.00`; with several CPUs, each line starts with the CPU). In these lines, estimates (`>=` in the table)
  are plain numbers.

  </details>

- **Markdown** (`-md`): GitHub-flavored Markdown on stdout instead of the text report, for an issue, a review or a
  chat.

  <details>
  <summary>What the Markdown contains, and which flags it works with</summary>

  With one CPU it gives the headline (cycles per iteration, or per element with `-per N`; the CPU; the bottleneck or
  `unknown · nearest X`), the limits, the next limit, the `not modelled` caveats, the critical chain, the uop table
  (branch targets as the labels in the text) and the analyzed code. `-arch A,B,C` gives the CPU table, several files the
  files × CPUs table (with `-report`, each file's report too), and `-whatif` and `-loops` their tables. Columns are
  padded to line up in a monospace font. `-md` does not work with `-json` or `-TPonly`; diagnostics and the exit status
  are the same as without it.

  </details>

- **JSON** (`-json`): one CPU gives the analyze response (`tp`, `bottlenecks`, `limits`, `rows`, `criticalPath`,
  `insights`, `loop`, `syntax`, and `perElement` / `whatIf` when asked); several give `{code, hex, loop, stderr,
  results: [{arch, tp, bottlenecks, limits, decodeErrors, perElement?, caveats?}]}`.

  <details>
  <summary>The JSON shapes of what-if results, caveats, several inputs and the version</summary>

  Both use the same shapes for `whatIf`, which is keyed by CPU (`{SKL: {tp, variants: [{id, tp, …, perElement?}],
  perElement?}}`), and for a caveat, `{id, text, title, instructions}` (in `insights.caveats` with one CPU,
  `results[].caveats` with several). The types are `CliAnalyzeJson`, `CliCompareJson` and `CliWhatIf` in index.d.ts.
  Several inputs give `{code, files: [{file, ...}]}`, where each entry is what a single run prints for that file, plus
  its name (`CliBatchJson`). `--version -json` gives `{wuica, uiCA: {repository, commit, branch}, node}`, where `uiCA`
  names the uiCA commit whose data and model the package has.

  </details>

- **Syntax mistakes.** When the assembler fails, a `hint:` line names a line with the other syntax's operands (mixed
  AT&T and Intel lines, a `.intel_syntax` directive over AT&T code, `mov rdx, $8` in Intel code) and the flag to try.
- The output has no colors and no links, on a terminal or not (`-md` is plain text too).

## Exit status

0 ok, 1 bad request or usage, 2 assembler error, 3 the analysis failed; with several CPUs, the largest of their codes,
which is also the JSON's `code`. A reader that closes the pipe (`| head`) does not change it.

## Library

```js
import { createWuica, markdown } from 'wuica-cli';

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
markdown.report(r, { insights: w.insights(r) });          // Markdown, as wuica -md (also cpuTable, whatIf, loops, compare)
```

Methods never throw for bad input: they resolve to a failure `{code, error, stderr}` (see
[Failures](https://github.com/jtl06/wuica/blob/main/packages/wuica/API.md#failures) in the API contract).
`createWuica({ dataDir })` reads the tables from another directory: `uarch.json` and the binary `arch/<NAME>.bin`,
plain or `.br`. The analyzer that ships reads no JSON tables; the repository's `tools/encode-tables.sh IN_DIR OUT_DIR`
converts a uiCA export's `arch/<NAME>.json`. `w.disassemble(bytes)` turns an object file into the text `analyze` reads
(with `{func}`, the text of that function alone). TypeScript declarations are included (`index.d.ts`).

`compare`, `analyzeMany(arch, requests)` and `compareMany(requests, {archs})` use worker threads when the work is large
enough. `createWuica({ threads: N })` or the environment variable `WUICA_THREADS=N` uses up to N threads (at most one
per job); 1 runs everything on the calling thread. The response is the same either way. Idle threads do not keep the
process alive and stop after 30 s (`w.close()` stops them at once).

<details>
<summary>Number of threads, shared tables and the memory limit</summary>

By default the number of threads comes from the amount of work (the tables to load, the analyses and their
instructions). Work that would take less than about 0.3 s on one thread gets no threads, because a thread's start, its
table and its first, not yet optimized analysis cost more than they save (`-arch all` on a small block stays on one
thread). Larger work gets one thread per 0.15 s, from 2 to 8, and at most the number of cores minus one.
The threads share one compiled module and take jobs from one queue. Each thread loads the tables of the jobs it takes
and keeps them for the next call. A thread's WebAssembly memory has a lower limit than the calling thread's: a quarter
of the RAM, shared by the threads, from 256 MB to 1 GB each. An analysis that exceeds it is run again on the calling
thread.

</details>

Inputs on which the original uiCA fails can make the WebAssembly module trap. In that case the call resolves to
`{code: 3, error, trapped: true}`. The module is then re-instantiated and its tables are reloaded, so the next call works.

## MCP server

`wuica mcp` (or the `wuica-mcp` binary) is a Model Context Protocol server on stdio, written without an MCP library.
The tools:

| Tool | What it does |
|---|---|
| `analyze` | one block on one microarchitecture: `tp`, bottlenecks, limits, a compact per-instruction table (ports, uop sources, fusion notes) and uiCA's text report (`format`: `json`, `text`, `both`) |
| `what_if` | one block re-analyzed with one change each (the web page's "try" row): `unroll2`/`unroll4`/`unroll8` (per original iteration), `acc2`/`acc3`/`acc4`/`acc8` (N accumulators: unrolled ×N with the loop-carried register renamed in each copy; `renamed` lists the registers, `accumulators.best` is the best N, 1 = as it is), `simpleFrontEnd`, `noMacroFusion`, `noMicroFusion`, `nochain` (an estimate without the loop-carried chain), and `align` when asked for (the 64 alignment offsets); per variant `tp`, `delta`, `speedup` (and `approx: {limit, shown}` when the simulation came out up to 1% under the variant's Ports or Issue limit: the text shows that limit, ≈) |
| `diff_blocks` | two blocks, A (before) and B (after), on one microarchitecture: `tp` of each, `delta`, `speedup`, per element with `per`, bottlenecks and limits before and after, each port's uops, the instructions changed, added or removed |
| `compare_archs` | one block on several or all microarchitectures: `tp` and bottlenecks per microarchitecture |
| `list_loops` | the loops of assembly text (what `loop` can pick): index, label, function, lines, instructions, depth, the one picked by default |
| `list_archs` | ids, names, years, prototype flags |
| `assemble` | assembly → hex bytes, or diagnostics with line/column |

<details>
<summary>Protocol details: JSON-RPC methods, revisions, argument checking, the exported tool table</summary>

It speaks newline-delimited JSON-RPC 2.0 and handles `initialize`, `ping`, `tools/list` and `tools/call`. The
`initialize` handshake supports the protocol revisions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05: the server
uses the client's revision if it is one of these, else 2025-11-25, and accepts batches only under 2025-03-26.
Arguments are checked against the tools' JSON Schemas; a mismatch gives a tool error (`isError`) that says what is
wrong, and an unknown tool gives a JSON-RPC error. The server exits when its stdin closes, and writes only protocol
messages to stdout. `wuica mcp --help` prints the usage. The tool table itself (names, descriptions, JSON Schemas,
handlers) is exported as `mcpTools(w)` from `wuica-cli/mcp`, with `callTool` and `validate`; the remote server
(`server/`) serves the same table over HTTP.

</details>

### Set it up in your agent

The command is `npx -y wuica-cli mcp` (stdio) in every client. **Claude Code**, **OpenAI Codex CLI**, **opencode**
and **Amp** add it with one command:

```sh
claude mcp add wuica -- npx -y wuica-cli mcp
codex mcp add wuica -- npx -y wuica-cli mcp
opencode mcp add wuica -- npx -y wuica-cli mcp
amp mcp add wuica -- npx -y wuica-cli mcp
```

Most other clients read a JSON file with an `mcpServers` object: **Claude Desktop** (Settings → Developer → Edit Config:
`claude_desktop_config.json`), **Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project), **Gemini CLI**
(`~/.gemini/settings.json`, or `.gemini/settings.json` in a project), **Cline** (MCP Servers → Configure → Configure MCP
Servers: `cline_mcp_settings.json`) and **Continue** (a file in `.continue/mcpServers/`):

```json
{
  "mcpServers": {
    "wuica": { "command": "npx", "args": ["-y", "wuica-cli", "mcp"] }
  }
}
```

<details>
<summary>Configuration for Codex, opencode, VS Code, Zed, Amp and goose</summary>

Where the format differs:

- **Codex** (`~/.codex/config.toml`, or `.codex/config.toml` in a trusted project; what `codex mcp add` writes):

  ```toml
  [mcp_servers.wuica]
  command = "npx"
  args = ["-y", "wuica-cli", "mcp"]
  ```

- **opencode** 2.x (`opencode.jsonc` in the project, or the global configuration):

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": { "servers": { "wuica": { "type": "local", "command": ["npx", "-y", "wuica-cli", "mcp"] } } }
  }
  ```

- **VS Code** with GitHub Copilot (`~/.copilot/mcp-config.json`; `.mcp.json` at the workspace root is behind an
  experimental setting):

  ```json
  {
    "mcpServers": {
      "wuica": { "type": "stdio", "command": "npx", "args": ["-y", "wuica-cli", "mcp"], "tools": ["*"] }
    }
  }
  ```

- **Zed** (`settings.json`):

  ```json
  {
    "context_servers": {
      "wuica": { "command": "npx", "args": ["-y", "wuica-cli", "mcp"], "env": {} }
    }
  }
  ```

- **Amp** (`~/.config/amp/settings.json`, or `.amp/settings.json` in a project):

  ```json
  {
    "amp.mcpServers": {
      "wuica": { "command": "npx", "args": ["-y", "wuica-cli", "mcp"] }
    }
  }
  ```

- **goose** (`~/.config/goose/config.yaml`):

  ```yaml
  extensions:
    wuica:
      type: stdio
      name: wuica
      enabled: true
      cmd: npx
      args: ["-y", "wuica-cli", "mcp"]
      timeout: 300
  ```

</details>

The hosted server (`server/`, the REST API's host) speaks MCP over Streamable HTTP at
`https://api.wuica.jacen.li/mcp`, with nothing to install: `claude mcp add --transport http wuica
https://api.wuica.jacen.li/mcp`. Clients with a JSON or TOML file give the URL instead of the command: `"url"` in
Cursor and Zed, `"type": "http", "url"` in VS Code, `"httpUrl"` in Gemini CLI, `"type": "remote", "url"` in opencode,
`url = "…"` in Codex.

To develop wuica, point a client at a checkout instead (after `packages/wuica/build.sh` and `npm install`):
`claude mcp add wuica -- node /absolute/path/to/packages/wuica/bin/wuica.js mcp`.

Example prompt: *"Use wuica to compare this loop on Skylake, Ice Lake and Zen 3 and explain the bottleneck."*

**Without MCP.** An agent that can run shell commands can use the CLI directly: `npx -y wuica-cli FILE -arch SKL,ZEN3
-json` (one JSON object; the shapes are under "JSON" in [Command line](#command-line)), `-whatif`
for the variants, `-loops` and `-loop N` to choose the loop, and `-example saxpy` to try it without a file.

## API contract

The library, the MCP tools and the REST API (https://api.wuica.jacen.li) share one set of request and response shapes,
modeled on [Compiler Explorer's API](https://github.com/compiler-explorer/compiler-explorer/blob/main/docs/API.md):

| REST | Library | MCP tool |
|---|---|---|
| `GET /api/archs[?fields=id,name]` | `w.archs(fields?)` | `list_archs {fields?}` |
| — | `listLoops(source, {func?})` | `list_loops {source, func?}` |
| `POST /api/analyze/<arch>` | `w.analyze(arch, request)` | `analyze {arch, ...request, format?}` |
| `POST /api/compare` | `w.compare({...request, archs?, per?})` | `compare_archs {...request, archs?, per?}` |
| `POST /api/what-if/<arch>` | `w.whatIf(arch, {...request, variants?, per?})` | `what_if {arch, ...request, variants?, per?}` |
| `POST /api/diff/<arch>` | `w.diff(arch, {a, b, options?, per?})` | `diff_blocks {arch, a, b, options?, per?}` |
| `POST /api/assemble` | `w.assemble(source, syntax)` | `assemble {source, syntax?}` |

A failed call has a non-zero `code`, with the values of the CLI's exit status (see [Exit status](#exit-status)), and
stderr lines. The full contract (requests, responses, option ranges per interface, failures, and each call) is in
[API.md](https://github.com/jtl06/wuica/blob/main/packages/wuica/API.md).

## Building from the repository

```
packages/wuica/build.sh          # copies and compresses the wasm modules and tables into dist/, copies the licenses
cd packages/wuica && npm install && npm test
npm pack                         # wuica-cli-<version>.tgz
```

`build.sh` uses `target/wasm32-unknown-unknown/release/wuica_wasm.wasm` (it runs `./build-wasm.sh` if the file is
missing), `assembler/dist/wuica_asm.wasm` and `data/`. The instruction tables are shipped in a binary form
(`dist/data/arch/<NAME>.bin.br`, written from `data/arch/*.json` by `tools/encode-tables.sh`; 6.4 MB instead of
14.6 MB, and loaded about 40 % faster); the analyzer module is built without the JSON table loader (the Cargo feature
`json-tables` of `crates/wuica`, which the native tools and tests use). `dist/manifest.json` records the size and
SHA-256 of each uncompressed file.

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
- The package has no dependencies. Its tests use the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
  (MIT) and [zod](https://zod.dev) (MIT) as development dependencies; the remote server (`server/`) uses them at run time.

uiCA is described in: Andreas Abel and Jan Reineke, *uiCA: Accurate Throughput Prediction of Basic Blocks on Recent
Intel Microarchitectures*, ICS 2022. The Intel models are uiCA's; the ZEN3, ADL-P and ICX models are prototypes of the
fork [jtl06/uiCA](https://github.com/jtl06/uiCA) and are not part of that work.
