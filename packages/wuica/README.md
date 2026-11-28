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

- **Syntax.** wuica detects Intel (noprefix) or AT&T syntax from the text (`%rdx`, `$8`, `(%rdi,%rcx,4)` are AT&T) and
  names it on stderr (`analyzed: loop .LBB0_9 (lines 28-47, in dot), AT&T syntax (detected)`). `-att` or `-intel`
  forces one.
- **Per iteration.** `tp` is the cycle count per iteration of the loop as the compiler wrote it. Compilers unroll and
  vectorize (×8, ×16, ×32 elements per iteration), so compare cycles per element. `-per N` prints `Per element: …
  cycles` (JSON `perElement`; values under 0.1 get 3 significant digits, `0.0625`). Without `-per`, stderr shows the
  loop's step when it can, in the register's units: `rcx += 8 per iteration (index; ×4 bytes in [rdi+rcx*4])` is 8
  elements of 4 bytes, `r13 += 64 per iteration (bytes; the base of [r13+0x20])` is 64 bytes (16 floats: `-per 16`),
  and `(register step)` marks a counter that no address uses.
- **Which loop.** For a whole function or file, wuica analyzes one loop. By default (`auto`) it picks:
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
  outputs of the same code may differ. Stderr says which loop was picked and how many others there are. `-loops` lists
  them (index, label, function, lines, instructions, depth, auto); a loop three or more deep in clang's notes keeps the
  place in that list it had when only the notes' first two lines were read. `-loop N` (0-based) or `-loop LABEL` picks
  one, `-func NAME` keeps one function's loops, and `-loop whole` analyzes the whole text. A label that names loops in
  several functions (`1:` … `jnz 1b`) is an error that lists them; `-func` or the index picks one.
- **Branches inside the loop.** uiCA runs the analyzed code straight through. In a loop with an if/else (or two back
  edges, as clang's remainder loops often have), it simulates both sides of the branch, one after the other, while a
  real iteration takes one. A `Not modelled: both paths: both sides of the branch at line N …` line (table note
  `both paths`; JSON caveat `paths`) reports this. To analyze one side, put `# wuica-begin` and `# wuica-end` around it.
- **Inputs**: a file (assembly, objdump output, or an object file), `-` or nothing for stdin, a hex argument, `-hex` or
  `-raw FILE` (bare machine code).
- **Object files.** wuica reads an ELF or Mach-O x86-64 object, executable or shared object directly. The analyzer
  decodes its code into the text `llvm-objdump -d` prints, so `wuica dot.o` and `objdump -d dot.o | wuica` pick the
  same loop and give the same numbers. `-func NAME` takes the symbol (without Mach-O's `_`) or a unique part of it, and
  analyzes that function alone: its loop, or its body if it has none. `-funcs` lists the functions, `-loops` gives the
  loops' addresses, and objects built with `-ffunction-sections` work. When the file gives one name to several
  functions (static functions of different source files, gcc's `.cold` parts: any static executable has them), each
  is listed with its address as `NAME.0xADDR`; `-func NAME` then lists them, and `-func NAME.0xADDR` picks one. Give a
  large executable a `-func`: with it, a 2.6 MB static executable takes 0.2 s; without it, the whole file is read, which
  takes minutes and can fail. For an arm64 object (what a Mac compiles by default), wuica says so and how to compile for
  x86-64 (`clang -arch x86_64 -c`, or `--target=x86_64-linux-gnu`). COFF is not supported yet; use
  `llvm-objdump -d f.obj | wuica`.
- **Several inputs** (`wuica a.s b.s c.o`, a glob, or `-files LIST` with one name per line, `-files -` from stdin):
  one process analyzes all of them, spread over the threads. With one CPU, the table has a row per file (file, loop,
  TP, bottlenecks, notes). With several, it has a row per file and CPU, grouped by file, with a CPU column, so any
  number of CPUs fits in 80 columns. `-TPonly` prints `file<TAB>[CPU<TAB>]cycles` lines. `-report` adds uiCA's report
  of each file and `-whatif` the what-if tables, each after a `==> FILE <==` line. A file that fails does not stop the
  others: its row says why, and the exit status is the largest of the files' statuses. One input prints exactly what
  it printed before.
- **Tables.** `-arch A,B,C` prints one row per CPU. `-` means unknown (uiCA names no single bottleneck; the notes give
  the nearest limit), and `5.00*` means that the CPU could not decode some instructions, which are left out. The notes
  column gives the caveats (what the model does not simulate, such as store forwarding through an indexed address).
- **After the report**, wuica prints what uiCA's text leaves out: the nearest limit when the bottleneck is unknown, the
  next limit, and `Not modelled:` lines.
- **Exit status**: 0 ok, 1 bad request or usage, 2 assembler error, 3 the analysis failed; with several CPUs, the
  largest of their codes, which is also the JSON's `code`. A reader that closes the pipe (`| head`) does not change it.
- **What if** (`-whatif`): a table per CPU, in cycles per original iteration, or per element with `-per N`. With
  `-TPonly`, it prints one `variant cycles` line per variant after the throughput (`acc2 16.00`; with `-per`, `acc2
  16.00 2.00`; with several CPUs, each line starts with the CPU). In these lines, estimates (`>=` in the table) are
  plain numbers.
- **Markdown** (`-md`): GitHub-flavored Markdown on stdout instead of the text report, for an issue, a review or a
  chat. With one CPU it gives the headline (cycles per iteration, or per element with `-per N`; the CPU; the bottleneck
  or `unknown · nearest X`), the limits, the next limit, the `not modelled` caveats, the critical chain, the uop table
  (branch targets as the labels in the text) and the analyzed code. `-arch A,B,C` gives the CPU table, several files the
  files × CPUs table (with `-report`, each file's report too), and `-whatif` and `-loops` their tables. Columns are
  padded to line up in a monospace font. `-md` does not work with `-json` or `-TPonly`; diagnostics and the exit status
  are the same as without it.
- **JSON** (`-json`): one CPU gives the analyze response (`tp`, `bottlenecks`, `limits`, `rows`, `criticalPath`,
  `insights`, `loop`, `syntax`, and `perElement` / `whatIf` when asked); several give `{code, hex, loop, stderr,
  results: [{arch, tp, bottlenecks, limits, decodeErrors, perElement?, caveats?}]}`. Both use the same shapes for
  `whatIf`, which is keyed by CPU (`{SKL: {tp, variants: [{id, tp, …, perElement?}], perElement?}}`), and for a caveat,
  `{id, text, title, instructions}` (in `insights.caveats` with one CPU, `results[].caveats` with several). The types
  are `CliAnalyzeJson`, `CliCompareJson` and `CliWhatIf` in index.d.ts. Several inputs give `{code, files: [{file,
  ...}]}`, where each entry is what a single run prints for that file, plus its name (`CliBatchJson`). `--version
  -json` gives `{wuica, uiCA: {repository, commit, branch}, node}`, where `uiCA` names the uiCA commit whose data and
  model the package has.
- **Syntax mistakes.** When the assembler fails, a `hint:` line names a line with the other syntax's operands (mixed
  AT&T and Intel lines, a `.intel_syntax` directive over AT&T code, `mov rdx, $8` in Intel code) and the flag to try.
- The output has no colors and no links, on a terminal or not (`-md` is plain text too).

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

Methods never throw for bad input: they resolve to a failure `{code, error, stderr}` (see the contract below).
`createWuica({ dataDir })` reads the tables from another directory: `uarch.json` and the binary `arch/<NAME>.bin`,
plain or `.br`. The analyzer that ships reads no JSON tables; the repository's `tools/encode-tables.sh IN_DIR OUT_DIR`
converts a uiCA export's `arch/<NAME>.json`. `w.disassemble(bytes)` turns an object file into the text `analyze` reads
(with `{func}`, the text of that function alone). TypeScript declarations are included (`index.d.ts`).

`compare`, `analyzeMany(arch, requests)` and `compareMany(requests, {archs})` use worker threads when the work is large
enough. By default the number of threads comes from the amount of work (the tables to load, the analyses and their
instructions). Work that would take less than about 0.3 s on one thread gets no threads, because a thread's start, its
table and its first, not yet optimized analysis cost more than they save (`-arch all` on a small block stays on one
thread). Larger work gets one thread per 0.15 s, from 2 to 8, and at most the number of cores minus one.
`createWuica({ threads: N })` or the environment variable `WUICA_THREADS=N` uses up to N threads (at most one per job);
1 runs everything on the calling thread. The response is the same either way. The threads share one compiled module
and take jobs from one queue. Each thread loads the tables of the jobs it takes and keeps them for the next call. Idle
threads do not keep the process alive and stop after 30 s (`w.close()` stops them at once). A thread's WebAssembly
memory has a lower limit than the calling thread's: a quarter of the RAM, shared by the threads, from 256 MB to 1 GB
each. An analysis that exceeds it is run again on the calling thread.

Inputs on which the original uiCA fails can make the WebAssembly module trap. In that case the call resolves to
`{code: 3, error, trapped: true}`. The module is then re-instantiated and its tables are reloaded, so the next call works.

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
Diagnostics go to stderr. The exit status is the result code (see Exit status above).
`wuica -h` lists all options.

## MCP server

`wuica mcp` (or the `wuica-mcp` binary) is a Model Context Protocol server on stdio, written without an MCP library.
It speaks newline-delimited JSON-RPC 2.0 and handles `initialize`, `ping`, `tools/list` and `tools/call`. The
`initialize` handshake supports the protocol revisions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05: the server
uses the client's revision if it is one of these, else 2025-11-25, and accepts batches only under 2025-03-26.
Arguments are checked against the tools' JSON Schemas; a mismatch gives a tool error (`isError`) that says what is
wrong, and an unknown tool gives a JSON-RPC error. The server exits when its stdin closes, and writes only protocol
messages to stdout. `wuica mcp --help` prints the usage. The tool table itself (names, descriptions, JSON Schemas,
handlers) is exported as `mcpTools(w)` from `wuica-cli/mcp`, with `callTool` and `validate`; the remote server
(`server/`) serves the same table over HTTP. The tools:

| Tool | What it does |
|---|---|
| `analyze` | one block on one microarchitecture: `tp`, bottlenecks, limits, a compact per-instruction table (ports, uop sources, fusion notes) and uiCA's text report (`format`: `json`, `text`, `both`) |
| `what_if` | one block re-analyzed with one change each (the web page's "try" row): `unroll2`/`unroll4`/`unroll8` (per original iteration), `acc2`/`acc3`/`acc4`/`acc8` (N accumulators: unrolled ×N with the loop-carried register renamed in each copy; `renamed` lists the registers, `accumulators.best` is the best N, 1 = as it is), `simpleFrontEnd`, `noMacroFusion`, `noMicroFusion`, `nochain` (an estimate without the loop-carried chain), and `align` when asked for (the 64 alignment offsets); per variant `tp`, `delta`, `speedup` (and `approx: {limit, shown}` when the simulation came out up to 1% under the variant's Ports or Issue limit: the text shows that limit, ≈) |
| `diff_blocks` | two blocks, A (before) and B (after), on one microarchitecture: `tp` of each, `delta`, `speedup`, per element with `per`, bottlenecks and limits before and after, each port's uops, the instructions changed, added or removed |
| `compare_archs` | one block on several or all microarchitectures: `tp` and bottlenecks per microarchitecture |
| `list_loops` | the loops of assembly text (what `loop` can pick): index, label, function, lines, instructions, depth, the one picked by default |
| `list_archs` | ids, names, years, prototype flags |
| `assemble` | assembly → hex bytes, or diagnostics with line/column |

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

The hosted server (`server/`, the REST API's host) speaks MCP over Streamable HTTP at
`https://api.wuica.jacen.li/mcp`, with nothing to install: `claude mcp add --transport http wuica
https://api.wuica.jacen.li/mcp`. Clients with a JSON or TOML file give the URL instead of the command: `"url"` in
Cursor and Zed, `"type": "http", "url"` in VS Code, `"httpUrl"` in Gemini CLI, `"type": "remote", "url"` in opencode,
`url = "…"` in Codex.

To develop wuica, point a client at a checkout instead (after `packages/wuica/build.sh` and `npm install`):
`claude mcp add wuica -- node /absolute/path/to/packages/wuica/bin/wuica.js mcp`.

Example prompt: *"Use wuica to compare this loop on Skylake, Ice Lake and Zen 3 and explain the bottleneck."*

**Without MCP.** An agent that can run shell commands can use the CLI directly: `npx -y wuica-cli FILE -arch SKL,ZEN3
-json` (one JSON object; the shapes are under "JSON" in [The CLI in five minutes](#the-cli-in-five-minutes)), `-whatif`
for the variants, `-loops` and `-loop N` to choose the loop, and `-example saxpy` to try it without a file.

## API contract

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
    without the bytes, Intel or AT&T) is analyzed at its default loop (see "Which loop" above). A span that holds a
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

### Option ranges per interface

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

Microarchitecture ids are matched the same way everywhere (see Microarchitectures above; `adlp`, `adl-p` → `ADL-P`).
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

### What-if: `POST /api/what-if/<arch>`

The request is analyze's plus `variants` and `per`. `variants` lists variant ids; the default is all of `unroll2`,
`unroll4`, `unroll8`, `acc2`, `acc3`, `acc4`, `acc8`, `simpleFrontEnd`, `noMacroFusion`, `noMicroFusion` and `nochain`.
`align` runs only when asked for: it analyzes the block at each of the 64 alignment offsets (64 analyses), its `tp` is
the median, and it adds `alignment` {min, median, max, best, worst, spread, offset}. `per` (elements per iteration)
adds cycles per element. The response is the same as the MCP tool's and `wuica -whatif -json`'s (`WhatIfResult`): the
base `tp`; per variant, `tp` per original iteration, `delta` and `speedup`, or `error`; and `accumulators.best`.
`text/plain` gives the CLI's table, `text/markdown` the Markdown one. Each variant is one analysis (`nochain` none,
`align` 64), and the request costs tokens in proportion (see the rate limit above).

### Diff: `POST /api/diff/<arch>`

The request is `{a: block, b: block, options?, per?}`. Each block is an analyze request; `options` applies to both;
`per` is the number of elements per iteration (N for both, or [A, B]). The response (`DiffResult` in index.d.ts;
`wuica diff -json`): `a` and `b` (`tp`, `bottlenecks`, `perElement`), `delta`, `speedup`, `verdict`, `perElement`,
`bottlenecks` (`gone`, `new`), `limits`, `ports` (uops per iteration before and after) and `instructions` (`counts`;
`changes`: `changed`, `modified`, `added`, `removed`, with the change of their uops). A failure of one block has an
`error` that starts with `A: ` or `B: `. `text/plain` gives the CLI's text, `text/markdown` the web page's A–B tables.

### Assemble: `POST /api/assemble`

Request: `{"source": "...", "syntax": "intel"}`. The whole text is assembled as it is (no loop finding, no region
markers; `;` comments as above). Response: `{"code": 0, "hex": "4801d8", "length": 3, "stderr": []}`;
the library also returns `bytes` (a `Uint8Array`). On failure: `{code: 2, error, stderr}` as above. The assembler is
LLVM 22.1.2's (the same bytes as `llvm-mc`). Only `.text` is returned. `.include`/`.incbin` always fail. GNU as's
`{load}`/`{store}` hints, which LLVM rejects, are removed at the start of a line, clang 23's `.prefalign` is read as
`.p2align`, and the line table (`.loc`, numbered `.file`) is not assembled (so gcc 11+ `-g` output assembles).

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
