# wuica_asm: an x86-64 assembler for the browser

`dist/wuica_asm.wasm` is LLVM's x86 assembler (the MC layer of LLVM 22.1.2) compiled to WebAssembly. It turns
assembly text into machine code in the browser. It produces exactly the bytes that

```
llvm-mc -triple=x86_64-unknown-linux-gnu -filetype=obj in.s -o in.o
llvm-objcopy -O binary --only-section=.text in.o in.bin
```

produce. The text goes through LLVM's own X86 assembly parser and ELF object writer (`MCAssembler`) into an object file
in memory, and the module returns the contents of `.text`. Branches to labels are relaxed (short or near), fixups are
applied, and alignment padding and `.nops` are emitted, all exactly as in native `llvm-mc`. Instruction lengths therefore
match the native assembler, which matters for the throughput analysis.

| file | what it is |
|---|---|
| `wuica_asm.cpp` | the wrapper: the C ABI, an ELF `.text` extractor, a file system without files, WASI stubs |
| `llvm-22.1.2-wasi.patch` | makes LLVM's Support library compile for WASI, and adds the size option `LLVM_X86_MC_ASSEMBLER_ONLY` |
| `build.sh` | downloads (pinned, checksummed), patches, configures, builds and links |
| `test.mjs` | Node test: byte-for-byte comparison with native `llvm-mc-22`, plus sizes and timings |
| `dist/wuica_asm.wasm` | the module (git-ignored by the repository's `*.wasm` rule) |

## Versions and downloads

| | version | URL | sha256 |
|---|---|---|---|
| LLVM sources | 22.1.2 | https://github.com/llvm/llvm-project/releases/download/llvmorg-22.1.2/llvm-project-22.1.2.src.tar.xz | `62f2f13ff25b1bb28ea507888e858212d19aafb65e8e72b4a65ee0629ec4ae0c` |
| wasi-sdk (clang 23.1.0, wasi-libc) | 34.0, x86_64 Linux | https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz | `b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4` |
| binaryen (only with `WASM_OPT=1`) | version_133 | https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-x86_64-linux.tar.gz | `2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489` |

The build also needs a native `llvm-tblgen` of exactly 22.1.2. It uses Ubuntu's `/usr/lib/llvm-22/bin/llvm-tblgen`
if that is version 22.1.2, and otherwise builds one from the same sources first.

The module in `dist/` was built on aethia (Ubuntu, cmake 4.2.3, ninja 1.13.2) with `WUICA_ASM_WORK=~/wuica-asm/clean`.
Its sha256 is `ee66811d0671cdea73176a3670f82816dcbb3cbb1fed13cd7dc2acbb69cb627d`. Relinking from the same build tree
gave a byte-identical file.

## Building

```
./build.sh                 # on x86_64 Linux; needs cmake >= 3.20, ninja, curl, tar, xz, patch, sha256sum, python3
WASM_OPT=1 ./build.sh      # also run wasm-opt -Oz (not recommended, see Size)
```

Everything goes into `work/` next to the script (about 3 GB). `WUICA_ASM_WORK` sets another work directory,
`WUICA_ASM_DL` sets another download directory, and `JOBS` sets the job count. If the script is interrupted, run it again:
downloads, extraction and the ninja build resume where they stopped. Only the X86 MC libraries are built (no code
generator, no tools). A clean build with the downloads already present took about 2 minutes on 16 cores. The script fails
if the linked module has any imports.

What `build.sh` does:

1. It downloads and checks the tarballs, and extracts the `llvm`, `cmake` and `third-party` trees of LLVM, plus wasi-sdk.
2. It applies `llvm-22.1.2-wasi.patch`.
3. It configures LLVM for `wasm32-wasip1` with wasi-sdk's CMake toolchain. The settings are `MinSizeRel` with
   `-Oz`, `LLVM_ENABLE_LTO=Full`, `-ffunction-sections -fdata-sections`, `-DLLVM_X86_MC_ASSEMBLER_ONLY`, only the
   X86 target, threads off, no PIC, no assertions/EH/RTTI, and no zlib/zstd/libxml2/plugins/tools.
4. It builds `LLVMX86AsmParser LLVMX86Desc LLVMX86Info` and their dependencies (MCParser, MC, MCDisassembler,
   CodeGenTypes, DebugInfoDWARFLowLevel, BinaryFormat, TargetParser, Support, Demangle).
5. It compiles `wuica_asm.cpp` and links with `-mexec-model=reactor` (no `main`; exports `_initialize`). The link
   flags are `--gc-sections`, `--strip-all`, `--export=malloc,free`, a 1 MiB stack placed first (an overflow traps
   instead of corrupting data), and `--max-memory=256 MiB`.

### The patch

LLVM 22 does not support WASI as a host, so its Support library does not compile for `wasm32-wasip1`. The patch
changes only what is needed for that, plus one size option. All changes are guarded by `__wasi__` or by the new
macro, so it does not change a native build.

* `ADT/bit.h`: use `<endian.h>` on WASI.
* `Support/CrashRecoveryContext.cpp`: no `setjmp`/`longjmp` (they need the wasm exception-handling proposal) and
  no signal handlers. A crash inside a recovery context aborts.
* `Support/Signals.cpp` and `Support/Program.cpp` include the new `WASI/Signals.inc` and `WASI/Program.inc`. In these
  files, no signal handlers are installed, no stack traces are printed, and starting or waiting for programs fails.
* `Support/Unix/Path.inc`: no `<pwd.h>` (`~user` and `$HOME`-less home directories are not expanded), no executable
  path, a fixed `umask` of 022, no `madvise`, no `fchown`, and no remote-file-system check.
* `Support/Unix/Process.inc`, `Unix.h`, `Watchdog.inc`, `ProgramStack.cpp`, `LockFileManager.cpp`: no rlimits, no
  `sigprocmask`, no terminal-width `ioctl`, no `<sys/wait.h>`, no `alarm`, no `getrlimit`, no process-alive check.
* `Support/raw_socket_stream.cpp`: compiled out (WASI preview 1 has no `AF_UNIX` sockets).
* `Target/X86/MCTargetDesc/X86MCTargetDesc.cpp`: with `-DLLVM_X86_MC_ASSEMBLER_ONLY`,
  `LLVMInitializeX86TargetMC()` does not register the instruction printers, the asm (text) target streamer, the
  COFF streamer, the instruction analysis or the relocation info. Assembling to an ELF object needs none of them,
  and leaving them unregistered lets the linker drop them: about 450 KB, or 10.5 % (see Size).

None of these code paths are reached when assembling. The few WASI system calls that libc still refers to (fd_write,
clock_time_get, random_get, path_open, ...) are defined in `wuica_asm.cpp` as stubs that fail or do nothing. That
leaves the module with **no imports at all**.

## Interface

Exports: `memory`, `_initialize`, `malloc`, `free`, `wuica_assemble`, `wuica_fatal_message`. No imports.

```c
// Assembles `text` (UTF-8, NUL-terminated) for x86_64-unknown-linux-gnu and writes the .text bytes to `out`.
//   syntax   0 = Intel (as after `.intel_syntax noprefix`), 1 = AT&T. The text may switch with
//            `.intel_syntax noprefix` / `.att_syntax` itself.
//   returns  >= 0  number of code bytes written to `out`
//            -1    the assembler reported errors; `err` has the diagnostics
//            -2    `out_cap` is too small; `err` says how many bytes are needed
//            -3    invalid arguments (syntax not 0/1, text NULL, ...) or an internal error
// `err` always receives a NUL-terminated string (if err_cap > 0), truncated to err_cap - 1 bytes. It holds
// diagnostics in llvm-mc's format, one or more of:
//     <input>:LINE:COL: error: MESSAGE
//     <source line>
//     <caret>
// On success it is empty or holds warnings (e.g. from `.warning`).
int wuica_assemble(const char *text, int syntax, unsigned char *out, unsigned out_cap, char *err, unsigned err_cap);

// After a trap: the message of the fatal LLVM error that caused it ("Allocation failed", ...), or "".
const char *wuica_fatal_message(void);
```

Behavior:

* The module assembles for the default CPU with no `-mattr`, as plain `llvm-mc -triple=x86_64` does. The parser
  accepts every ISA extension, including AVX-512 and APX.
* Intel mode (`syntax = 0`) behaves like `llvm-mc` on a file that starts with `.intel_syntax noprefix`, but the line
  numbers are not shifted by that extra line. A text that already starts with that directive gives the same result in
  either mode.
* `.include` and `.incbin` always fail with the assembler's usual error
  (`<input>:1:9: error: Could not find incbin file '/etc/passwd'`). The source manager has a file system with no
  files, and the module cannot reach any file anyway, since it has no imports.
* Only `.text` is returned. Data in other sections (`.data`, ...) is assembled but dropped. References to undefined
  symbols leave zero bytes where the relocation would go, as with `llvm-mc` + `objcopy`.
* Calls are independent: no state carries over from one call to the next, and memory does not grow across calls
  (checked over 3000 files).

### Calling it from JavaScript (browser)

No WASI shim is needed. The import object is `{}`.

```js
// Load once (e.g. at page start or in a Worker). The server must send the file as application/wasm for
// instantiateStreaming; otherwise use: WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), {}).
const { instance } = await WebAssembly.instantiateStreaming(fetch('wuica_asm.wasm'), {});
const assemble = wuicaAssembler(instance);

const r = assemble('top:\nadd rax, rbx\nvaddps zmm0 {k1}{z}, zmm1, zmm2\njnz top\n');
// r.bytes = Uint8Array 48 01 d8 62 f1 74 c9 58 c2 75 f5, r.message = ''
assemble('nop\nfrobnicate rax\n');
// { status: -1, message: "<input>:2:1: error: invalid instruction mnemonic 'frobnicate'\nfrobnicate rax\n^~~~~~~~~~\n" }
assemble('addq %rbx, %rax\n', 1).bytes;   // AT&T: 48 01 d8

function wuicaAssembler(instance) {
  const e = instance.exports;
  e._initialize();                                   // once, before any other call
  const enc = new TextEncoder(), dec = new TextDecoder();
  return function assemble(text, syntax = 0 /* 0 = Intel, 1 = AT&T */) {
    const src = enc.encode(text + '\0');
    const OUT_CAP = 1 << 20, ERR_CAP = 1 << 16;
    const textPtr = e.malloc(src.length), outPtr = e.malloc(OUT_CAP), errPtr = e.malloc(ERR_CAP);
    try {
      new Uint8Array(e.memory.buffer).set(src, textPtr);
      const n = e.wuica_assemble(textPtr, syntax, outPtr, OUT_CAP, errPtr, ERR_CAP);
      const mem = new Uint8Array(e.memory.buffer);   // re-create the view: memory may have grown
      const message = dec.decode(mem.subarray(errPtr, mem.indexOf(0, errPtr)));
      return n >= 0 ? { bytes: mem.slice(outPtr, outPtr + n), message } : { status: n, message };
    } finally {
      e.free(textPtr); e.free(outPtr); e.free(errPtr);
    }
  };
}
```

(This snippet, with the instance from `WebAssembly.instantiate(bytes, {})`, was run in Node 22 against the module
and printed the results shown in the comments.)

Rules:

* Call `_initialize()` exactly once after instantiating and before anything else. It runs the C++ static
  constructors. The X86 target itself is registered lazily on the first `wuica_assemble` call.
* Pointers are offsets into `instance.exports.memory`. Create typed-array views *after* each call, because the
  memory may grow during the call and that detaches older views.
* A **trap** (`WebAssembly.RuntimeError`) means a fatal LLVM error. In practice the only one is running out of
  memory: the module's memory is capped at 256 MiB, and an input like `.fill 400000000, 1, 0` triggers it. After a
  trap, you can read `wuica_fatal_message()`; then **throw the instance away** and instantiate the (cached) module
  again. Ordinary assembly errors never trap.
* The module is single-threaded and the call is synchronous. A 100-line input takes under 1 ms, so the main thread
  is fine for typical inputs. Use a Worker if users can paste very large files.
* The module uses clang 23's default wasm32 feature set (bulk memory, nontrapping float-to-int, sign extension,
  mutable globals, multi-value, reference types). Current browsers support all of these; minimum browser versions
  were not tested. Node 22 runs it.

## Size

`dist/wuica_asm.wasm`, sha256 `ee66811d…cb627d`:

| | bytes |
|---|---|
| raw | 3,802,001 (3.6 MiB) |
| gzip -9 | 1,024,828 |
| brotli -q 11 (Node zlib, window 24) | 687,897 |
| after `wasm-opt -Oz` (binaryen 133): raw | 3,536,354 (−7.0 %) |
| after `wasm-opt -Oz`: gzip -9 / brotli -q 11 | 1,040,645 (+1.5 %) / 708,948 (+3.1 %) |

`wasm-opt -Oz` makes the raw file smaller but the compressed file larger. The file will be served compressed, so the
build runs `wasm-opt` only when `WASM_OPT=1` is set.

What each size option does, measured by linking the current wrapper against each build tree:

| build | raw | gzip -9 |
|---|---|---|
| MinSizeRel (`-Os`), no LTO, printers registered | 4,514,176 | 1,202,736 |
| `-Oz`, no LTO, printers registered | 4,433,614 (−1.8 %) | 1,179,139 |
| `-Oz`, full LTO, printers registered | 4,249,694 (−4.1 %) | 1,132,698 |
| `-Oz`, full LTO, `LLVM_X86_MC_ASSEMBLER_ONLY` (final) | 3,802,001 (−10.5 %) | 1,024,828 |

In the final module, the code section is 0.97 MB and the data section is 2.83 MB. The data section is mostly
TableGen tables: instruction descriptions, the AT&T and Intel matcher tables, register and instruction names, and
the CPU scheduling models. The scheduling models and the instruction names are not used for assembling, but they
cannot be removed without changing the generated code.

## Timings

These are Node 22.22.1 timings on aethia (AMD Ryzen 7 7735U), under a perfq lease. Browsers with similar wasm
engines (V8 in Chrome) should be in the same range.

| | time |
|---|---|
| compile + instantiate (`WebAssembly.instantiate(bytes)`), fresh process | 5.6–8.7 ms (V8 compiles lazily) |
| `_initialize()` | 0.7–1.0 ms |
| first `wuica_assemble` of a 100-line input on a fresh instance (includes lazy compilation of the functions it uses) | 9.5–16 ms |
| later calls, same 100-line input (489 code bytes) | 0.47–0.74 ms (median of 300 calls, per process) |
| instantiate + `_initialize` of an already compiled module | 1.4 ms |

Linear memory after the whole test suite is 3.9 MiB.

## Tests

`node test.mjs` checks every input byte for byte against the native assembler. On aethia it runs as
`TMPDIR=~/wuica-asm/tmp /usr/bin/node test.mjs`, with `llvm-mc-22` and `llvm-objcopy-22` 22.1.2 as the reference.
`TMPDIR` is needed there because the test otherwise writes its scratch files to the system temp directory. Last full
run, on the shipped module (`ee66811d…`):

```
corpus     3000 files from ~/uica-zen/uiCA/zenbench/out_fuzz/holdout2, 146.3 s
           as they are: 93 assemble (bytes compared), 2907 are rejected by llvm-mc (mostly {load}/{store} hints; diagnostics compared)
           hints removed: 2980 assemble (bytes compared, 157789 code bytes), 20 are rejected by llvm-mc (GNU-only mnemonics; diagnostics compared)
           files with a mismatch: 0
cases      26 hand-written cases compared, 0 mismatches; 14 error cases
PASS: 33186 checks, 0 failures
```

Each corpus file is checked in several variants, and in each one the module must behave exactly like `llvm-mc`. The file
is used as it is with `syntax` = Intel and with `syntax` = AT&T, and again with its `.intel_syntax noprefix` line removed
and `syntax` = Intel. The same runs are then repeated with the GNU `{load}`/`{store}` hints stripped. Where `llvm-mc`
fails, the module must return −1 with identical diagnostics; only the file name differs (`<input>`).

The 26 hand-written cases cover:
* forward and backward branches, both short and relaxed to near, including the exact ±127/128 limits and a
  relaxation cascade;
* `loop`, `jrcxz`, `call`;
* RIP-relative addressing, both to local labels and to undefined symbols;
* addressing modes and immediate sizes, and the `{vex3}`/`{evex}`/`{disp32}` pseudo-prefixes;
* AVX/AVX2/FMA/BMI;
* AVX-512 with masks, zeroing, broadcast, rounding, k-registers, VNNI/GFNI/FP16;
* APX;
* x87/SSE/string instructions;
* alignment and `.nops`, data directives and expressions, macros and `.rept`/`.if`;
* other sections, syntax switching inside the text, and empty or comment-only input;
* AT&T: basic instructions, a near branch, and numeric local labels.

The 14 error cases cover:
* an unknown mnemonic (`<input>:2:1: error: invalid instruction mnemonic 'frobnicate'`), invalid operands, and two
  errors reported together;
* the wrong syntax mode in either direction, and a `{load}` hint;
* `.intel_syntax prefix`;
* `.incbin "/etc/passwd"`, a relative `.incbin`, and `.include` with an absolute and a relative path;
* an undefined symbol in `.if`, a layout-time error, and `.error`.

After each error case, the next call must succeed. The suite also checks warnings, a too-small output buffer (−2), a
truncated long diagnostic, an invalid `syntax` (−3), and an out-of-memory trap with its fatal message.

Options: `--limit N`, `--corpus DIR`, `--wasm FILE`, `--min-corpus N`. Environment: `LLVM_MC`, `LLVM_OBJCOPY`.

## Known limitations

* **The corpus's `{load}`/`{store}` hints are rejected.** The corpus was written for GNU as, and LLVM 22's
  assembler does not know these hints (`error: unknown prefix`). So 2907 of the 3000 corpus files fail as they are,
  natively and in the module alike. If the page is to accept such text, it has to strip `{load} `/`{store} ` at
  the start of a line before calling the module. With the hints removed, all 2980 files that assemble match
  `llvm-mc` byte for byte, but they do **not** always match what GNU as produces *with* the hints. Compared with
  `as` (binutils on aethia), 94 files are identical, 2857 have the same length but different bytes, and
  **29 differ in length**, by a few bytes each. The hints pick the opcode direction of a register-to-register
  instruction. For VEX moves this can force the 3-byte VEX prefix: GNU as encodes `{load} vmovaps xmm1, xmm8` as
  `c4 c1 78 28 c8` (5 bytes), while LLVM encodes the unhinted line as `c5 78 29 c1` (4 bytes). Where the
  analysis depends on instruction lengths, these inputs give LLVM's lengths, not GNU as's.
* 20 corpus files use mnemonics that only GNU as accepts (`pcmpestriq`, `vpcmpestrmq`, ...). They fail in the module
  as they do in `llvm-mc`.
* Output is `.text` only. There is no symbol table, no relocations and no listing.
* A trap (out of memory) leaves the instance unusable, so it has to be re-instantiated (see Rules).
* The build script runs only on x86_64 Linux, because the pinned wasi-sdk is the x86_64 Linux build.
* Two code paths of `build.sh` have not been run: `WASM_OPT=1`, and building `llvm-tblgen` when no 22.1.2 one is
  installed. The `wasm-opt` output was only measured for size; it was not run through `test.mjs`.
  A full rebuild in a fresh directory has not been compared for bit-identical output; only a relink was.
* The extra export `wuica_fatal_message` is not in the original interface sketch.

## License

The module contains LLVM, which is licensed under the Apache License 2.0 with LLVM Exceptions
(https://llvm.org/LICENSE.txt). It also contains wasi-libc and libc++ from wasi-sdk, under Apache-2.0 WITH
LLVM-exception, MIT and other permissive licenses (see the wasi-sdk release). The patch's two new files carry LLVM's
license header. `wuica_asm.cpp`, `build.sh` and `test.mjs` are part of wuica (AGPL-3.0); Apache-2.0 code can be
combined with AGPL-3.0 code.

The module is a compiled form of LLVM itself, so the LLVM exception, which covers LLVM runtime code embedded in
*your* compiled program, should not be relied on. When the page distributes `wuica_asm.wasm`, it should include or
link to LLVM's license text (`llvm/LICENSE.TXT` in the source tarball) and state that the module is built from a
modified LLVM 22.1.2 (the patch here).
