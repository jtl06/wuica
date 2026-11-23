#!/usr/bin/env bash
# Assembles the deployable site in web/dist/: the page, the analyzer (wuica_wasm.wasm), the data (data/) and,
# if it has been built, the assembler (assembler/dist/wuica_asm.wasm). It only copies: build the analyzer with
# ./build-wasm.sh and generate data/ with tools/export_data.py first.
#
#   web/build.sh                  then serve web/dist/ with any static file server, e.g.
#   python3 -m http.server -d web/dist 8000
#
# Environment: WUICA_WASM (path of the analyzer), WUICA_ASM_WASM (path of the assembler).
# It writes manifest.json (version, files with sizes, tables) and stamps the version, a hash of all files,
# into sw.js: a deploy with any change gives the service worker a new cache.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
out="$here/dist"
wasm="${WUICA_WASM:-$root/target/wasm32-unknown-unknown/release/wuica_wasm.wasm}"
asm="${WUICA_ASM_WASM:-$root/assembler/dist/wuica_asm.wasm}"

die() { echo "web/build.sh: $*" >&2; exit 1; }
[ -f "$wasm" ] || die "the analyzer is missing: $wasm (run ./build-wasm.sh, or set WUICA_WASM)"
[ -f "$root/data/uarch.json" ] || die "data/uarch.json is missing (generate data/ with tools/export_data.py)"
ls "$root"/data/arch/*.json >/dev/null 2>&1 || die "data/arch/ has no instruction tables (generate data/ with tools/export_data.py)"
if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$@"; }
else die "neither sha256sum nor shasum found"; fi

rm -rf "$out"
mkdir -p "$out/js" "$out/css" "$out/fonts" "$out/data/arch"
cp "$here/index.html" "$here/404.html" "$here/favicon.svg" "$here/_headers" "$out/"
cp "$here"/js/*.js "$out/js/"
cp "$here"/css/*.css "$out/css/"
cp "$here"/fonts/*.woff2 "$here/fonts/OFL.txt" "$out/fonts/"
mkdir -p "$out/licenses"
cp "$root/LICENSE" "$out/licenses/AGPL-3.0.txt"
cp "$root/third_party/xed/LICENSE" "$out/licenses/XED-Apache-2.0.txt"
[ -f "$root/assembler/LICENSE-LLVM.txt" ] && cp "$root/assembler/LICENSE-LLVM.txt" "$out/licenses/LLVM.txt"
cp "$root/data/uarch.json" "$out/data/"
cp "$root"/data/arch/*.json "$out/data/arch/"
cp "$wasm" "$out/wuica_wasm.wasm"
assembler=false
if [ -f "$asm" ]; then cp "$asm" "$out/wuica_asm.wasm"; assembler=true; fi

cd "$out"
# What the page can request (not _headers and 404.html, which are for the host), in a stable order.
files="$(find . -type f ! -name _headers ! -name 404.html | sed 's|^\./||' | LC_ALL=C sort)"
version="$( { echo "$files" | while IFS= read -r f; do sha "$f"; done; sha "$here/sw.js"; } | sha | cut -c1-12)"

{
  printf '{\n  "version": "%s",\n  "assembler": %s,\n  "tables": [' "$version" "$assembler"
  sep=''
  for t in data/arch/*.json; do n="$(basename "$t" .json)"; printf '%s"%s"' "$sep" "$n"; sep=', '; done
  printf '],\n  "files": {\n'
  sep=''
  echo "$files" | while IFS= read -r f; do
    printf '%s    "%s": %s' "$sep" "$f" "$(wc -c < "$f" | tr -d ' ')"; sep=$',\n'
  done
  printf '\n  }\n}\n'
} > manifest.json

sed "s/__WUICA_VERSION__/$version/" "$here/sw.js" > sw.js
grep -q "'$version'" sw.js || die "could not stamp the version into sw.js"

total="$(find . -type f -exec cat {} + | wc -c | tr -d ' ')"
echo "web/dist: version $version, $(echo "$files" | wc -l | tr -d ' ') files, $((total / 1024)) KiB; assembler: $assembler"
