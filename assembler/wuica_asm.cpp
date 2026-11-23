// wuica_asm: an x86-64 assembler for the browser, built from LLVM's MC layer.
//
// One exported function, wuica_assemble(), turns assembly text into machine code. It does what
// `llvm-mc -triple=x86_64-unknown-linux-gnu -filetype=obj` does (the code below follows
// llvm/tools/llvm-mc/llvm-mc.cpp of LLVM 22.1.2): the text is parsed by the X86 assembly parser and
// streamed into an ELF object writer, so jumps are relaxed and fixups are applied by the real
// assembler back end. The ELF object is written to memory and the contents of its `.text` section are
// returned, which is what `llvm-objcopy -O binary --only-section=.text` extracts.
//
// The module has no imports: the few WASI system calls that libc and LLVM's Support library refer to
// are defined at the end of this file and fail (or do nothing). There is therefore no way for
// `.incbin` or `.include` to reach a file, whatever the embedding page does.
//
// This file is part of wuica (AGPL-3.0). LLVM is licensed under Apache-2.0 WITH LLVM-exception.

#include "llvm/ADT/SmallVector.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/MC/MCAsmBackend.h"
#include "llvm/MC/MCAsmInfo.h"
#include "llvm/MC/MCCodeEmitter.h"
#include "llvm/MC/MCContext.h"
#include "llvm/MC/MCInstrInfo.h"
#include "llvm/MC/MCObjectFileInfo.h"
#include "llvm/MC/MCObjectWriter.h"
#include "llvm/MC/MCParser/MCAsmParser.h"
#include "llvm/MC/MCParser/MCTargetAsmParser.h"
#include "llvm/MC/MCRegisterInfo.h"
#include "llvm/MC/MCStreamer.h"
#include "llvm/MC/MCSubtargetInfo.h"
#include "llvm/MC/MCTargetOptions.h"
#include "llvm/MC/TargetRegistry.h"
#include "llvm/Support/ErrorHandling.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/VirtualFileSystem.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/TargetParser/Triple.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <string>

using namespace llvm;

extern "C" {
void LLVMInitializeX86TargetInfo();
void LLVMInitializeX86TargetMC();
void LLVMInitializeX86AsmParser();
}

#define WUICA_EXPORT(name) __attribute__((export_name(#name), visibility("default")))

enum {
   WUICA_ERR_ASSEMBLY = -1,  // the assembler reported errors; `err` has the diagnostics
   WUICA_ERR_OUT_CAP = -2,   // `out` is too small; `err` says how many bytes are needed
   WUICA_ERR_INTERNAL = -3,  // bad arguments or an internal error; `err` has a message
};

namespace {

const char TripleName[] = "x86_64-unknown-linux-gnu";
const char InputName[] = "<input>";

// A file system without files: `.include` and `.incbin` fail with the assembler's usual
// "Could not find ..." error.
class NoFileSystem : public vfs::FileSystem {
public:
   ErrorOr<vfs::Status> status(const Twine &) override { return std::make_error_code(std::errc::no_such_file_or_directory); }
   ErrorOr<std::unique_ptr<vfs::File>> openFileForRead(const Twine &) override {
      return std::make_error_code(std::errc::no_such_file_or_directory);
   }
   vfs::directory_iterator dir_begin(const Twine &, std::error_code &EC) override {
      EC = std::make_error_code(std::errc::no_such_file_or_directory);
      return vfs::directory_iterator();
   }
   std::error_code setCurrentWorkingDirectory(const Twine &) override { return std::make_error_code(std::errc::operation_not_permitted); }
   ErrorOr<std::string> getCurrentWorkingDirectory() const override { return std::string("/"); }
};

// The message of the last fatal LLVM error (report_fatal_error, out of memory). After such an error
// the module traps; the page can still read the message with wuica_fatal_message().
char FatalMessage[512];

[[noreturn]] void fatalErrorHandler(void *, const char *Reason, bool) {
   snprintf(FatalMessage, sizeof(FatalMessage), "%s", Reason ? Reason : "fatal error");
   __builtin_trap();
}

const Target *TheTarget = nullptr;

bool initialize(std::string &Error) {
   static bool Done = false;
   if (!Done) {
      Done = true;
      LLVMInitializeX86TargetInfo();
      LLVMInitializeX86TargetMC();
      LLVMInitializeX86AsmParser();
      install_fatal_error_handler(fatalErrorHandler);
      install_bad_alloc_error_handler(fatalErrorHandler);
      TheTarget = TargetRegistry::lookupTarget(Triple(TripleName), Error);
   }
   if (!TheTarget && Error.empty()) Error = "the X86 target is not available";
   return TheTarget != nullptr;
}

void copyMessage(const std::string &Message, char *Err, unsigned ErrCap) {
   if (!Err || ErrCap == 0) return;
   size_t N = Message.size() < ErrCap - 1 ? Message.size() : ErrCap - 1;
   memcpy(Err, Message.data(), N);
   Err[N] = 0;
}

uint16_t read16(const char *P) { uint16_t V; memcpy(&V, P, sizeof(V)); return V; }
uint32_t read32(const char *P) { uint32_t V; memcpy(&V, P, sizeof(V)); return V; }
uint64_t read64(const char *P) { uint64_t V; memcpy(&V, P, sizeof(V)); return V; }

// Finds the contents of the section called `.text` in a little-endian ELF64 relocatable object.
// (The host is wasm32, which is little-endian too.)
bool findTextSection(StringRef Obj, StringRef &Text) {
   const uint64_t Size = Obj.size();
   if (Size < 64 || memcmp(Obj.data(), "\x7f" "ELF\x02\x01", 6) != 0) return false;
   const uint64_t ShOff = read64(Obj.data() + 0x28);
   const uint64_t ShEntSize = read16(Obj.data() + 0x3A);
   const uint64_t ShNum = read16(Obj.data() + 0x3C);
   const uint64_t ShStrNdx = read16(Obj.data() + 0x3E);
   if (ShEntSize < 64 || ShStrNdx >= ShNum || ShOff > Size || ShNum * ShEntSize > Size - ShOff) return false;
   auto Header = [&](uint64_t I) { return Obj.data() + ShOff + I * ShEntSize; };
   const uint64_t StrOff = read64(Header(ShStrNdx) + 0x18), StrSize = read64(Header(ShStrNdx) + 0x20);
   if (StrOff > Size || StrSize > Size - StrOff) return false;
   const StringRef Names = Obj.substr(StrOff, StrSize);
   for (uint64_t I = 1; I < ShNum; I++) {
      const uint32_t NameOff = read32(Header(I));
      if (NameOff >= Names.size()) continue;
      if (Names.substr(NameOff).split('\0').first != ".text") continue;
      const uint32_t Type = read32(Header(I) + 0x04);
      const uint64_t Off = read64(Header(I) + 0x18), Sz = read64(Header(I) + 0x20);
      if (Type == 8 /* SHT_NOBITS */) { Text = StringRef(); return true; }
      if (Off > Size || Sz > Size - Off) return false;
      Text = Obj.substr(Off, Sz);
      return true;
   }
   return false;
}

void collectDiagnostic(const SMDiagnostic &Diag, void *Context) {
   raw_string_ostream OS(*static_cast<std::string *>(Context));
   Diag.print(nullptr, OS, /*ShowColors=*/false);
}

} // namespace

// libc++'s operator new aborts without a message when memory runs out (there are no exceptions).
// These replacements report it the way LLVM's own allocation functions do, so that the fatal error
// handler above records the message.
void *operator new(size_t Size) {
   void *P = malloc(Size ? Size : 1);
   if (!P) report_bad_alloc_error("Allocation failed");
   return P;
}
void *operator new[](size_t Size) { return operator new(Size); }
void operator delete(void *P) noexcept { free(P); }
void operator delete[](void *P) noexcept { free(P); }
void operator delete(void *P, size_t) noexcept { free(P); }
void operator delete[](void *P, size_t) noexcept { free(P); }

extern "C" {

// Assembles `text` (NUL-terminated) and writes the contents of the `.text` section to `out`.
//   syntax: 0 = Intel (as after `.intel_syntax noprefix`), 1 = AT&T. The text can still switch with
//           `.intel_syntax noprefix` / `.att_syntax`.
// Returns the number of code bytes, or a negative value (see the enum above). `err` always receives a
// NUL-terminated string (if err_cap > 0): the assembler's diagnostics in llvm-mc's format
// ("<input>:LINE:COL: error: MESSAGE", the source line, a caret); on success it is empty or holds
// warnings.
WUICA_EXPORT(wuica_assemble)
int wuica_assemble(const char *text, int syntax, unsigned char *out, unsigned out_cap, char *err, unsigned err_cap) {
   if (err && err_cap) err[0] = 0;
   std::string Diagnostics;
   if (!text || (syntax != 0 && syntax != 1) || (!out && out_cap)) {
      copyMessage("invalid arguments", err, err_cap);
      return WUICA_ERR_INTERNAL;
   }
   if (!initialize(Diagnostics)) {
      copyMessage(Diagnostics, err, err_cap);
      return WUICA_ERR_INTERNAL;
   }

   SmallVector<char, 0> Object;
   bool Failed;
   {
      const Triple TheTriple(TripleName);
      // llvm-mc's defaults (mc::InitMCTargetOptionsFromFlags() without flags).
      MCTargetOptions MCOptions;
      MCOptions.AsmVerbose = true;
      MCOptions.MCUseDwarfDirectory = MCTargetOptions::EnableDwarfDirectory;

      SourceMgr SrcMgr;
      SrcMgr.AddNewSourceBuffer(MemoryBuffer::getMemBuffer(StringRef(text), InputName), SMLoc());
      SrcMgr.setVirtualFileSystem(makeIntrusiveRefCnt<NoFileSystem>());
      SrcMgr.setDiagHandler(collectDiagnostic, &Diagnostics);

      std::unique_ptr<MCRegisterInfo> MRI(TheTarget->createMCRegInfo(TheTriple));
      std::unique_ptr<MCAsmInfo> MAI(TheTarget->createMCAsmInfo(*MRI, TheTriple, MCOptions));
      // No CPU and no features, like llvm-mc without -mcpu/-mattr. The X86 assembly parser accepts
      // every instruction set extension regardless (it only looks at the 16/32/64-bit mode).
      std::unique_ptr<MCSubtargetInfo> STI(TheTarget->createMCSubtargetInfo(TheTriple, "", ""));
      std::unique_ptr<MCInstrInfo> MCII(TheTarget->createMCInstrInfo());
      if (!MRI || !MAI || !STI || !MCII) {
         copyMessage("cannot create the target descriptions", err, err_cap);
         return WUICA_ERR_INTERNAL;
      }

      MCContext Ctx(TheTriple, MAI.get(), MRI.get(), STI.get(), &SrcMgr, &MCOptions);
      Ctx.setDiagnosticHandler([&](const SMDiagnostic &Diag, bool, const SourceMgr &, std::vector<const MDNode *> &) {
         collectDiagnostic(Diag, &Diagnostics);
      });
      std::unique_ptr<MCObjectFileInfo> MOFI(TheTarget->createMCObjectFileInfo(Ctx, /*PIC=*/false, /*LargeCodeModel=*/false));
      Ctx.setObjectFileInfo(MOFI.get());
      Ctx.setDwarfVersion(4);

      raw_svector_ostream OS(Object);
      MCCodeEmitter *CE = TheTarget->createMCCodeEmitter(*MCII, Ctx);
      MCAsmBackend *MAB = TheTarget->createMCAsmBackend(*STI, *MRI, MCOptions);
      std::unique_ptr<MCStreamer> Str(TheTarget->createMCObjectStreamer(
         TheTriple, Ctx, std::unique_ptr<MCAsmBackend>(MAB), MAB->createObjectWriter(OS), std::unique_ptr<MCCodeEmitter>(CE), *STI));
      Str->emitVersionForTarget(TheTriple, VersionTuple(), nullptr, VersionTuple());

      std::unique_ptr<MCAsmParser> Parser(createMCAsmParser(SrcMgr, Ctx, *Str, *MAI));
      std::unique_ptr<MCTargetAsmParser> TAP(TheTarget->createMCAsmParser(*STI, *Parser, *MCII, MCOptions));
      if (!TAP) {
         copyMessage("cannot create the assembly parser", err, err_cap);
         return WUICA_ERR_INTERNAL;
      }
      Parser->setTargetParser(*TAP);
      // The same as `.intel_syntax noprefix` / `.att_syntax` at the top of the text, without changing
      // the line numbers. (`llvm-mc --x86-asm-syntax=intel` sets the dialect in MCAsmInfo, which is
      // where the parser looks if this is not called; for parsing the two are equivalent.)
      Parser->setAssemblerDialect(syntax == 0 ? 1 : 0);

      Failed = Parser->Run(/*NoInitialTextSection=*/false) || Ctx.hadError();
   }

   if (Failed) {
      if (Diagnostics.empty()) Diagnostics = "assembly failed";
      copyMessage(Diagnostics, err, err_cap);
      return WUICA_ERR_ASSEMBLY;
   }
   StringRef Text;
   if (!findTextSection(StringRef(Object.data(), Object.size()), Text)) {
      copyMessage("no .text section in the assembled object", err, err_cap);
      return WUICA_ERR_INTERNAL;
   }
   if (Text.size() > out_cap) {
      copyMessage("output buffer too small: " + std::to_string(Text.size()) + " bytes needed", err, err_cap);
      return WUICA_ERR_OUT_CAP;
   }
   if (!Text.empty()) memcpy(out, Text.data(), Text.size());
   copyMessage(Diagnostics, err, err_cap); // warnings, if any
   return static_cast<int>(Text.size());
}

// The message of the fatal error that made the module trap, or "" if there was none.
WUICA_EXPORT(wuica_fatal_message)
const char *wuica_fatal_message(void) { return FatalMessage; }

// ---------------------------------------------------------------------------------------------------
// WASI preview 1 system calls, defined here instead of being imported (wasi-libc declares them as
// imports named __imported_wasi_snapshot_preview1_*; a definition in the module takes precedence).
// There are no files, no arguments, no environment and no clock; writes to stdout/stderr are dropped.
// build.sh fails if the linked module still has an import, so a call that is missing here is noticed.

#define WASI_STUB(name, ...) int32_t __imported_wasi_snapshot_preview1_##name(__VA_ARGS__)
enum { WASI_ESUCCESS = 0, WASI_EBADF = 8, WASI_ENOENT = 44 };

WASI_STUB(fd_write, int32_t fd, int32_t iovs, int32_t iovs_len, int32_t nwritten) {
   if (fd != 1 && fd != 2) return WASI_EBADF;
   uint32_t Total = 0; // pretend that everything was written
   for (int32_t I = 0; I < iovs_len; I++) Total += reinterpret_cast<const uint32_t *>(static_cast<uintptr_t>(iovs))[2 * I + 1];
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
// Not random: the assembler's output must not depend on it, and nothing here needs secrecy.
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
WASI_STUB(fd_filestat_get, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_pread, int32_t, int32_t, int32_t, int64_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_prestat_get, int32_t, int32_t) { return WASI_EBADF; } // no preopened directories
WASI_STUB(fd_prestat_dir_name, int32_t, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_read, int32_t, int32_t, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(fd_seek, int32_t, int64_t, int32_t, int32_t) { return WASI_EBADF; }
WASI_STUB(path_filestat_get, int32_t, int32_t, int32_t, int32_t, int32_t) { return WASI_ENOENT; }
WASI_STUB(path_open, int32_t, int32_t, int32_t, int32_t, int32_t, int64_t, int64_t, int32_t, int32_t) { return WASI_ENOENT; }
WASI_STUB(path_readlink, int32_t, int32_t, int32_t, int32_t, int32_t, int32_t) { return WASI_ENOENT; }

} // extern "C"
