// wuica_mca: LLVM's machine code analyzer (llvm-mca of LLVM 22.1.2) for the browser.
//
// build.sh compiles the llvm-mca tool's own sources (tools/llvm-mca) with three edits: its main() becomes
// mca_main(), InitLLVM is left out, and the input comes from wuica_mca_input() instead of a file or stdin.
// One exported function, wuica_mca_run(), runs it with the given arguments on the given assembly text; what
// llvm-mca prints to stdout and stderr is collected in memory and read with wuica_mca_output().
//
// The module has no imports: the WASI system calls that libc and LLVM's Support library refer to are defined
// at the end of this file. Writes to stdout (1) and stderr (2) go to the two buffers; there are no files.
//
// This file is part of wuica (AGPL-3.0). LLVM is licensed under Apache-2.0 WITH LLVM-exception.

#include "llvm/Support/CommandLine.h"
#include "llvm/Support/ErrorOr.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/raw_ostream.h"

#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

using namespace llvm;

#define WUICA_EXPORT(name) __attribute__((export_name(#name), visibility("default")))

int mca_main(int argc, char **argv); // tools/llvm-mca/llvm-mca.cpp, renamed by build.sh

namespace {
std::string Input;
std::string Output[2]; // stdout, stderr
} // namespace

// llvm-mca.cpp calls this where it read the input file
ErrorOr<std::unique_ptr<MemoryBuffer>> wuica_mca_input() {
   return MemoryBuffer::getMemBufferCopy(Input, "<input>");
}

extern "C" {

// Runs llvm-mca. `args`: the arguments without the program name, each ended by a NUL, `args_len` bytes in
// all; `input`: the assembly text. Returns llvm-mca's exit code (0: success); its output is then in
// wuica_mca_output(0) (stdout) and wuica_mca_output(1) (stderr), wuica_mca_output_len() bytes each.
WUICA_EXPORT(wuica_mca_run)
int wuica_mca_run(const char *args, size_t args_len, const char *input, size_t input_len) {
   Input.assign(input, input_len);
   Output[0].clear();
   Output[1].clear();
   // the options are global: back to their defaults before each run
   cl::ResetAllOptionOccurrences();
   std::vector<std::string> Args{"llvm-mca"};
   for (size_t I = 0; I < args_len;) {
      size_t N = strnlen(args + I, args_len - I);
      Args.emplace_back(args + I, N);
      I += N + 1;
   }
   std::vector<char *> Argv;
   for (std::string &A : Args) Argv.push_back(A.data());
   Argv.push_back(nullptr);
   int Code = mca_main(static_cast<int>(Args.size()), Argv.data());
   outs().flush();
   errs().flush();
   return Code;
}

WUICA_EXPORT(wuica_mca_output)
const char *wuica_mca_output(int which) { return Output[which ? 1 : 0].data(); }

WUICA_EXPORT(wuica_mca_output_len)
size_t wuica_mca_output_len(int which) { return Output[which ? 1 : 0].size(); }

// ---------------------------------------------------------------------------------------------------
// WASI preview 1 system calls, defined here instead of being imported (as in assembler/wuica_asm.cpp).
// stdout and stderr are collected; there are no files, no arguments, no environment and no clock.

#define WASI_STUB(name, ...) int32_t __imported_wasi_snapshot_preview1_##name(__VA_ARGS__)
enum { WASI_ESUCCESS = 0, WASI_EBADF = 8, WASI_ENOENT = 44 };

WASI_STUB(fd_write, int32_t fd, int32_t iovs, int32_t iovs_len, int32_t nwritten) {
   if (fd != 1 && fd != 2) return WASI_EBADF;
   const uint32_t *V = reinterpret_cast<const uint32_t *>(static_cast<uintptr_t>(iovs));
   uint32_t Total = 0;
   for (int32_t I = 0; I < iovs_len; I++) {
      Output[fd - 1].append(reinterpret_cast<const char *>(static_cast<uintptr_t>(V[2 * I])), V[2 * I + 1]);
      Total += V[2 * I + 1];
   }
   *reinterpret_cast<uint32_t *>(static_cast<uintptr_t>(nwritten)) = Total;
   return WASI_ESUCCESS;
}
[[noreturn]] void __imported_wasi_snapshot_preview1_proc_exit(int32_t) { __builtin_trap(); }
WASI_STUB(environ_sizes_get, int32_t count, int32_t buf_size) {
   *reinterpret_cast<uint32_t *>(static_cast<uintptr_t>(count)) = 0;
   *reinterpret_cast<uint32_t *>(static_cast<uintptr_t>(buf_size)) = 0;
   return WASI_ESUCCESS;
}
WASI_STUB(environ_get, int32_t, int32_t) { return WASI_ESUCCESS; }
WASI_STUB(clock_time_get, int32_t, int64_t, int32_t time) {
   *reinterpret_cast<uint64_t *>(static_cast<uintptr_t>(time)) = 0;
   return WASI_ESUCCESS;
}
WASI_STUB(random_get, int32_t buf, int32_t buf_len) {
   static uint32_t State = 0x9E3779B9u;
   uint8_t *P = reinterpret_cast<uint8_t *>(static_cast<uintptr_t>(buf));
   for (int32_t I = 0; I < buf_len; I++) {
      State ^= State << 13; State ^= State >> 17; State ^= State << 5;
      P[I] = static_cast<uint8_t>(State);
   }
   return WASI_ESUCCESS;
}
WASI_STUB(fd_close, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_fdstat_get, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_fdstat_set_flags, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_filestat_get, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_pread, int32_t, int32_t, int32_t, int64_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_prestat_get, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_prestat_dir_name, int32_t, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_read, int32_t, int32_t, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_readdir, int32_t, int32_t, int32_t, int64_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_seek, int32_t, int64_t, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(path_filestat_get, int32_t, int32_t, int32_t, int32_t, int32_t) { return WASI_ENOENT; }
WASI_STUB(path_open, int32_t, int32_t, int32_t, int32_t, int32_t, int64_t, int64_t, int32_t, int32_t) { return WASI_ENOENT; }
WASI_STUB(path_readlink, int32_t, int32_t, int32_t, int32_t, int32_t, int32_t) { return WASI_ENOENT; }

} // extern "C"
