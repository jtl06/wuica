#!/usr/bin/env bash
# Builds dist/wuica_mca.wasm: llvm-mca of LLVM 22.1.2 for the browser (see wuica_mca.cpp).
#
#   mca/build.sh      on x86_64 Linux, after assembler/build.sh has downloaded, extracted and patched LLVM and
#                     wasi-sdk into its work directory (WUICA_ASM_WORK, default assembler/work)
#
# It configures a second LLVM build for wasm32-wasip1 with the same settings as the assembler's, but without
# LLVM_X86_MC_ASSEMBLER_ONLY (llvm-mca needs the instruction printer and the scheduling models), builds the
# MCA libraries, compiles the llvm-mca tool's own sources with three edits (see below) and links them with
# wuica_mca.cpp. Environment: WUICA_ASM_WORK (the assembler's work directory), WUICA_MCA_BUILD (the build
# directory, default $WUICA_ASM_WORK/build-wasm-mca), JOBS. Needs node (for the check of the module's imports).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
LLVM_VERSION=22.1.2
WORK=${WUICA_ASM_WORK:-$ROOT/assembler/work}
BUILD=${WUICA_MCA_BUILD:-$WORK/build-wasm-mca}
JOBS=${JOBS:-$(nproc)}
SRC=$WORK/llvm-project-$LLVM_VERSION.src
WASI_SDK=$WORK/wasi-sdk-34.0-x86_64-linux

say() { printf '\n== %s\n' "$*"; }
die() { printf 'mca/build.sh: %s\n' "$*" >&2; exit 1; }
[ -f "$WORK/.stamp-patch" ] || die "run assembler/build.sh first (no patched LLVM in $WORK)"
[ -d "$WASI_SDK" ] || die "no wasi-sdk in $WORK"
TBLGEN=${LLVM_TABLEGEN:-/usr/lib/llvm-22/bin/llvm-tblgen}
[ -x "$TBLGEN" ] || TBLGEN=$WORK/build-native/bin/llvm-tblgen
"$TBLGEN" --version 2>/dev/null | grep -q "LLVM version $LLVM_VERSION\$" || die "no llvm-tblgen $LLVM_VERSION"

WASI_DEFINES="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID"
COMMON_FLAGS="$WASI_DEFINES -ffunction-sections -fdata-sections"

if [ ! -f "$BUILD/build.ninja" ]; then
   say "configuring LLVM $LLVM_VERSION for wasm32-wasip1 (llvm-mca)"
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
      >"$BUILD.cmake.log" 2>&1 || { tail -30 "$BUILD.cmake.log"; die "cmake failed (log: $BUILD.cmake.log)"; }
fi

say "building the LLVM libraries"
LIBS="LLVMX86TargetMCA LLVMMCA LLVMX86AsmParser LLVMX86Desc LLVMX86Info LLVMX86Disassembler"
# shellcheck disable=SC2086
ninja -C "$BUILD" -j "$JOBS" $LIBS

# --- the tool's sources, with three edits -----------------------------------------------------------------
#   main()              -> mca_main(): wuica_mca_run() calls it
#   InitLLVM X(...)     left out: no signal handlers or argument rewriting in a library
#   getFileOrSTDIN(...) -> wuica_mca_input(): the text passed to wuica_mca_run()
say "compiling llvm-mca and wuica_mca.cpp"
OUT=$BUILD/out-mca
mkdir -p "$OUT" "$HERE/dist"
TOOL=$SRC/llvm/tools/llvm-mca
sed -e 's/^int main(int argc, char \*\*argv) {/int mca_main(int argc, char **argv) {/' \
    -e 's/^  InitLLVM X(argc, argv);$//' \
    -e 's/MemoryBuffer::getFileOrSTDIN(InputFilename)/wuica_mca_input()/' \
    -e 's/^using namespace llvm;$/using namespace llvm;\nErrorOr<std::unique_ptr<MemoryBuffer>> wuica_mca_input();/' \
    "$TOOL/llvm-mca.cpp" >"$OUT/llvm-mca.cpp"
for edit in 'int mca_main(' 'wuica_mca_input()'; do grep -qF "$edit" "$OUT/llvm-mca.cpp" || die "llvm-mca.cpp: the edit '$edit' did not apply"; done
grep -q 'InitLLVM X(' "$OUT/llvm-mca.cpp" && die "llvm-mca.cpp: InitLLVM is still there"

CXX="$WASI_SDK/bin/clang++ --target=wasm32-wasip1"
CXXFLAGS="-std=c++17 -Oz -flto=full -fno-exceptions -fno-rtti -fvisibility=hidden -ffunction-sections -fdata-sections -DNDEBUG $WASI_DEFINES"
INCS="-I$BUILD/include -I$SRC/llvm/include -I$TOOL"
OBJS=()
for f in "$OUT/llvm-mca.cpp" "$TOOL/CodeRegion.cpp" "$TOOL/CodeRegionGenerator.cpp" "$TOOL/PipelinePrinter.cpp" \
         "$TOOL"/Views/*.cpp "$HERE/wuica_mca.cpp"; do
   o=$OUT/$(basename "$f" .cpp).o
   # shellcheck disable=SC2086
   $CXX $CXXFLAGS $INCS -c "$f" -o "$o"
   OBJS+=("$o")
done

say "linking wuica_mca.wasm"
# as assembler/build.sh; 1 GiB of memory at most (llvm-mca keeps every simulated instruction of a region)
$CXX -mexec-model=reactor -Oz -flto=full "${OBJS[@]}" -L"$BUILD/lib" \
   -lLLVMX86TargetMCA -lLLVMMCA -lLLVMX86AsmParser -lLLVMX86Disassembler -lLLVMX86Desc -lLLVMX86Info -lLLVMMCParser -lLLVMMC \
   -lLLVMMCDisassembler -lLLVMCodeGenTypes -lLLVMDebugInfoDWARFLowLevel -lLLVMBinaryFormat -lLLVMTargetParser -lLLVMSupport -lLLVMDemangle \
   -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid \
   -Wl,--gc-sections -Wl,--strip-all -Wl,--export=malloc,--export=free \
   -Wl,-z,stack-size=2097152 -Wl,--stack-first -Wl,--max-memory=1073741824 \
   -o "$OUT/wuica_mca.wasm"

# (with Node: this wasi-sdk's llvm-objdump cannot read the linked module)
imports=$(node -e 'const m = new WebAssembly.Module(require("fs").readFileSync(process.argv[1])); console.log(WebAssembly.Module.imports(m).map((i) => i.module + "." + i.name).join(" "))' "$OUT/wuica_mca.wasm") \
   || die "node could not read the module"
[ -z "$imports" ] || die "the module has imports ($imports); define them in wuica_mca.cpp"
cp "$OUT/wuica_mca.wasm" "$HERE/dist/wuica_mca.wasm"
say "done: $HERE/dist/wuica_mca.wasm"
printf 'sha256   %s\n' "$(sha256sum "$HERE/dist/wuica_mca.wasm" | cut -d' ' -f1)"
printf 'raw      %s bytes\n' "$(wc -c <"$HERE/dist/wuica_mca.wasm")"
printf 'gzip -9  %s bytes\n' "$(gzip -9 -c "$HERE/dist/wuica_mca.wasm" | wc -c)"
