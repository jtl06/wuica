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

wuica reproduces the reference, including the inputs for which the Python uiCA fails. Such an input either gives
`{"error": ...}` or makes the call **trap** (the module throws a `WebAssembly.RuntimeError`, e.g. `unreachable`): a Rust panic
cannot be caught inside a `wasm32-unknown-unknown` module. After a trap, the instance must not be used again: create a new
instance, call `wuica_load_uarch` and `wuica_load_arch` again, and continue. (The web page keeps the bytes of the loaded
tables for this.) Making these cases return errors instead is planned.

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

## Assembler

Assembly text is turned into machine code by a separate, lazily loaded module (`assembler/`, LLVM's x86 assembler); its interface
is described in `assembler/README.md`. The page passes the resulting bytes to `wuica_analyze` as `hex`.
