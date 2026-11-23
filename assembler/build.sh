#!/usr/bin/env bash
# Builds dist/wuica_asm.wasm: LLVM's X86 assembler (MC layer) as a WebAssembly module with a C ABI
# (see wuica_asm.cpp and README.md).
#
#    ./build.sh
#
# Host: x86_64 Linux with cmake (3.20 or later), ninja, curl, tar, xz, patch, sha256sum and python3 (LLVM's
# build needs it). Nothing is installed; everything goes into the work directory (about 3 GB).
#
# Environment:
#    WUICA_ASM_WORK   work directory (default: ./work next to this script)
#    WUICA_ASM_DL     where the downloads are kept (default: $WUICA_ASM_WORK/dl); files that are already
#                     there are used if their checksum is right
#    LLVM_TABLEGEN    a native llvm-tblgen of exactly LLVM 22.1.2 (default: /usr/lib/llvm-22/bin/llvm-tblgen,
#                     Ubuntu's llvm-22). If it is not that version, one is built from the sources first.
#    JOBS             parallel build jobs (default: all cores)
#    WASM_OPT=1       also run binaryen's `wasm-opt -Oz` on the result (see "Size" below; off by default)
#
# The script can be interrupted and run again: downloads, extraction and the ninja build continue where
# they stopped.
#
# Size. What matters, in the order of effect (sizes are in README.md):
#   - Only the X86 target and only the MC libraries are built (no code generator, no tools).
#   - LLVM_X86_MC_ASSEMBLER_ONLY (added by llvm-22.1.2-wasi.patch): LLVMInitializeX86TargetMC() does not
#     register the instruction printers, so they are not linked in. About -10 %.
#   - -Oz instead of CMake's MinSizeRel default -Os, and full LTO (LLVM_ENABLE_LTO=Full, -flto=full).
#     Together about -6 %. LTO needs the bitcode variants of libc/libc++ that wasi-sdk ships.
#   - -ffunction-sections -fdata-sections with --gc-sections (wasm-ld's default), --strip-all.
#   - No assertions, no exceptions, no RTTI (LLVM's defaults), no threads, no zlib/zstd/libxml2.
#   - wasm-opt -Oz makes the file about 7 % smaller but the gzip/brotli-compressed file 1-3 % larger,
#     so it is not run unless WASM_OPT=1.
# About three quarters of the module are tables (instruction descriptions, the two matcher tables, the
# instruction names and the CPU scheduling models); the last two are not used for assembling but cannot
# be left out without changing generated code.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=${WUICA_ASM_WORK:-$HERE/work}
DL=${WUICA_ASM_DL:-$WORK/dl}
JOBS=${JOBS:-$(nproc)}
WASM_OPT=${WASM_OPT:-0}

# --- pinned downloads (official release pages only) ---------------------------------------------------
LLVM_VERSION=22.1.2
LLVM_TARBALL=llvm-project-$LLVM_VERSION.src.tar.xz
LLVM_URL=https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_VERSION/$LLVM_TARBALL
LLVM_SHA256=62f2f13ff25b1bb28ea507888e858212d19aafb65e8e72b4a65ee0629ec4ae0c

WASI_SDK_VERSION=34.0   # clang 23.1.0, wasi-libc 2e6fb9d8ee0c
WASI_SDK_DIR=wasi-sdk-$WASI_SDK_VERSION-x86_64-linux
WASI_SDK_TARBALL=$WASI_SDK_DIR.tar.gz
WASI_SDK_URL=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/$WASI_SDK_TARBALL
WASI_SDK_SHA256=b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4

BINARYEN_VERSION=version_133   # only with WASM_OPT=1
BINARYEN_TARBALL=binaryen-$BINARYEN_VERSION-x86_64-linux.tar.gz
BINARYEN_URL=https://github.com/WebAssembly/binaryen/releases/download/$BINARYEN_VERSION/$BINARYEN_TARBALL
BINARYEN_SHA256=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489

say() { printf '\n== %s\n' "$*"; }
die() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || die "the pinned wasi-sdk is the x86_64 Linux build; run this on x86_64 Linux"
for tool in cmake ninja curl tar xz patch sha256sum python3; do
   command -v "$tool" >/dev/null || die "$tool is missing"
done
mkdir -p "$WORK" "$DL"

# download URL FILE SHA256: fetches into $DL unless the file is already there with the right checksum.
download() {
   local url=$1 file=$DL/$2 sha=$3
   if [ -f "$file" ] && echo "$sha  $file" | sha256sum --check --status; then return; fi
   say "downloading $url"
   curl --fail --location --retry 3 --silent --show-error --output "$file.part" "$url"
   echo "$sha  $file.part" | sha256sum --check --status || die "checksum mismatch for $url"
   mv "$file.part" "$file"
}

# unpack STAMP DIR COMMAND...: runs COMMAND once; an interrupted extraction is started again.
unpack() {
   local stamp=$WORK/.stamp-$1 dir=$WORK/$2
   shift 2
   [ -f "$stamp" ] && return
   say "unpacking $(basename "$dir")"
   rm -rf "$dir"
   "$@"
   touch "$stamp"
}

download "$LLVM_URL" "$LLVM_TARBALL" "$LLVM_SHA256"
download "$WASI_SDK_URL" "$WASI_SDK_TARBALL" "$WASI_SDK_SHA256"

SRC=$WORK/llvm-project-$LLVM_VERSION.src
WASI_SDK=$WORK/$WASI_SDK_DIR
# Only the llvm, cmake and third-party subtrees of the LLVM tarball are needed.
unpack llvm "llvm-project-$LLVM_VERSION.src" tar -C "$WORK" -xf "$DL/$LLVM_TARBALL" \
   "llvm-project-$LLVM_VERSION.src/llvm" "llvm-project-$LLVM_VERSION.src/cmake" "llvm-project-$LLVM_VERSION.src/third-party"
unpack wasi-sdk "$WASI_SDK_DIR" tar -C "$WORK" -xf "$DL/$WASI_SDK_TARBALL"

# LLVM 22 does not support WASI. The patch (a) makes lib/Support compile for wasm32-wasip1: no signals,
# no processes, no setjmp, no users, no sockets; (b) adds LLVM_X86_MC_ASSEMBLER_ONLY (see "Size" above).
if [ ! -f "$WORK/.stamp-patch" ]; then
   say "patching LLVM"
   patch --directory "$SRC" --strip 1 --forward --input "$HERE/llvm-22.1.2-wasi.patch"
   touch "$WORK/.stamp-patch"
fi

# --- a native llvm-tblgen of the same version ---------------------------------------------------------
TBLGEN=${LLVM_TABLEGEN:-/usr/lib/llvm-22/bin/llvm-tblgen}
if ! "$TBLGEN" --version 2>/dev/null | grep -q "LLVM version $LLVM_VERSION\$"; then
   say "no llvm-tblgen $LLVM_VERSION at $TBLGEN: building one"
   cmake -G Ninja -S "$SRC/llvm" -B "$WORK/build-native" -DCMAKE_BUILD_TYPE=Release -DLLVM_TARGETS_TO_BUILD=X86 \
      -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_DOCS=OFF \
      -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_LIBEDIT=OFF >"$WORK/cmake-native.log" 2>&1 \
      || { tail -30 "$WORK/cmake-native.log"; die "cmake (native) failed"; }
   ninja -C "$WORK/build-native" -j "$JOBS" llvm-tblgen
   TBLGEN=$WORK/build-native/bin/llvm-tblgen
fi
say "llvm-tblgen: $TBLGEN ($("$TBLGEN" --version | grep 'LLVM version'))"

# --- LLVM for wasm32-wasip1 ---------------------------------------------------------------------------
BUILD=$WORK/build-wasm
# wasi-libc only declares signal(), mmap(), clock()/getrusage() and getpid() with these macros. Of the
# emulation libraries, only -lwasi-emulated-mman is actually linked into the result (unused code).
WASI_DEFINES="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID"
COMMON_FLAGS="$WASI_DEFINES -DLLVM_X86_MC_ASSEMBLER_ONLY -ffunction-sections -fdata-sections"

say "configuring LLVM $LLVM_VERSION for wasm32-wasip1"
cmake -G Ninja -S "$SRC/llvm" -B "$BUILD" \
   -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK/share/cmake/wasi-sdk-p1.cmake" \
   -DUNIX=1 \
   -DCMAKE_BUILD_TYPE=MinSizeRel \
   -DCMAKE_C_FLAGS="$COMMON_FLAGS" -DCMAKE_CXX_FLAGS="$COMMON_FLAGS" \
   -DCMAKE_C_FLAGS_MINSIZEREL="-Oz -DNDEBUG" -DCMAKE_CXX_FLAGS_MINSIZEREL="-Oz -DNDEBUG" \
   -DLLVM_ENABLE_LTO=Full \
   -DLLVM_TARGETS_TO_BUILD=X86 \
   -DLLVM_TABLEGEN="$TBLGEN" \
   -DLLVM_HOST_TRIPLE=wasm32-wasip1 -DLLVM_DEFAULT_TARGET_TRIPLE=x86_64-unknown-linux-gnu \
   -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_PIC=OFF -DBUILD_SHARED_LIBS=OFF \
   -DLLVM_ENABLE_ASSERTIONS=OFF -DLLVM_ENABLE_EH=OFF -DLLVM_ENABLE_RTTI=OFF -DLLVM_ENABLE_DUMP=OFF -DLLVM_ENABLE_WARNINGS=OFF \
   -DLLVM_ENABLE_BACKTRACES=OFF -DLLVM_ENABLE_CRASH_OVERRIDES=OFF -DLLVM_ENABLE_PLUGINS=OFF -DLLVM_ENABLE_UNWIND_TABLES=OFF \
   -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF \
   -DLLVM_ENABLE_CURL=OFF -DLLVM_ENABLE_HTTPLIB=OFF -DLLVM_ENABLE_Z3_SOLVER=OFF -DLLVM_ENABLE_FFI=OFF -DLLVM_ENABLE_BINDINGS=OFF \
   -DLLVM_INCLUDE_TOOLS=OFF -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_UTILS=OFF -DLLVM_BUILD_UTILS=OFF -DLLVM_INCLUDE_TESTS=OFF \
   -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_DOCS=OFF -DLLVM_INCLUDE_RUNTIMES=OFF \
   >"$WORK/cmake-wasm.log" 2>&1 || { tail -30 "$WORK/cmake-wasm.log"; die "cmake failed (log: $WORK/cmake-wasm.log)"; }
# Notes on the options:
#   UNIX=1                the WASI platform file of wasi-sdk does not set it; LLVM then uses lib/Support/Unix
#   LLVM_TABLEGEN         cross build: the generators must run on the host
#   LLVM_ENABLE_PIC=OFF   position-independent wasm objects cannot be linked into a normal module
#   LLVM_INCLUDE_TOOLS/UTILS=OFF   no llvm-mc etc.; only the libraries named below are built

say "building the LLVM libraries"
# The three X86 libraries pull in what they need: MCParser, MC, MCDisassembler, CodeGenTypes,
# DebugInfoDWARFLowLevel, BinaryFormat, TargetParser, Support, Demangle.
ninja -C "$BUILD" -j "$JOBS" LLVMX86AsmParser LLVMX86Desc LLVMX86Info

# --- the module ---------------------------------------------------------------------------------------
say "compiling and linking wuica_asm.wasm"
OUT=$WORK/out
mkdir -p "$OUT" "$HERE/dist"
CXX="$WASI_SDK/bin/clang++ --target=wasm32-wasip1"
$CXX -std=c++17 -Oz -flto=full -fno-exceptions -fno-rtti -fvisibility=hidden -ffunction-sections -fdata-sections \
   -DNDEBUG $WASI_DEFINES -I"$BUILD/include" -I"$SRC/llvm/include" \
   -c "$HERE/wuica_asm.cpp" -o "$OUT/wuica_asm.o"
# -mexec-model=reactor   a library without main(); exports _initialize, which runs the static constructors
# --export=malloc,free   for the caller's buffers (wuica_assemble and wuica_fatal_message are exported by
#                        attributes in the source)
# stack-size, --stack-first   1 MiB of stack below the data, so that an overflow traps instead of
#                        overwriting data
# --max-memory           256 MiB: an input like `.fill 4000000000` fails (traps) quickly
$CXX -mexec-model=reactor -Oz -flto=full "$OUT/wuica_asm.o" -L"$BUILD/lib" \
   -lLLVMX86AsmParser -lLLVMX86Desc -lLLVMX86Info -lLLVMMCParser -lLLVMMC -lLLVMMCDisassembler -lLLVMCodeGenTypes \
   -lLLVMDebugInfoDWARFLowLevel -lLLVMBinaryFormat -lLLVMTargetParser -lLLVMSupport -lLLVMDemangle \
   -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid \
   -Wl,--gc-sections -Wl,--strip-all -Wl,--export=malloc,--export=free \
   -Wl,-z,stack-size=1048576 -Wl,--stack-first -Wl,--max-memory=268435456 \
   -o "$OUT/wuica_asm.wasm"

# The module must be self-contained: wuica_asm.cpp defines the WASI calls that libc refers to. If a new
# one appears (other versions of LLVM or wasi-sdk), add it there.
if "$WASI_SDK/bin/llvm-objdump" -h "$OUT/wuica_asm.wasm" | grep -qw IMPORT; then
   "$WASI_SDK/bin/llvm-objdump" -x "$OUT/wuica_asm.wasm" | grep -A40 -i '^Import' | head -60 >&2 || true
   die "the module has imports; define them in wuica_asm.cpp"
fi

RESULT=$OUT/wuica_asm.wasm
if [ "$WASM_OPT" = 1 ]; then
   download "$BINARYEN_URL" "$BINARYEN_TARBALL" "$BINARYEN_SHA256"
   unpack binaryen "binaryen-$BINARYEN_VERSION" tar -C "$WORK" -xf "$DL/$BINARYEN_TARBALL"
   say "wasm-opt -Oz"
   # The features that clang 23 uses by default for wasm32 (all supported by current browsers and Node 22).
   "$WORK/binaryen-$BINARYEN_VERSION/bin/wasm-opt" -Oz --strip-debug --strip-producers \
      --enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
      --enable-multivalue --enable-reference-types --enable-call-indirect-overlong \
      "$OUT/wuica_asm.wasm" -o "$OUT/wuica_asm.opt.wasm"
   RESULT=$OUT/wuica_asm.opt.wasm
fi
cp "$RESULT" "$HERE/dist/wuica_asm.wasm"

say "done: $HERE/dist/wuica_asm.wasm"
printf 'sha256   %s\n' "$(sha256sum "$HERE/dist/wuica_asm.wasm" | cut -d' ' -f1)"
printf 'raw      %s bytes\n' "$(wc -c <"$HERE/dist/wuica_asm.wasm")"
printf 'gzip -9  %s bytes\n' "$(gzip -9 -c "$HERE/dist/wuica_asm.wasm" | wc -c)"
if command -v brotli >/dev/null; then printf 'brotli   %s bytes\n' "$(brotli -q 11 -c "$HERE/dist/wuica_asm.wasm" | wc -c)"; fi
echo "test:    node $HERE/test.mjs   (also prints the brotli size)"
