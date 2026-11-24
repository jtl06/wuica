#!/usr/bin/env bash
# Downloads the CI data asset recorded in ci/data-asset.txt (the release `tag`, its `file`), checks its sha256 and the
# MANIFEST.txt inside, and puts the generated files where the build and the tests read them: data/, fixtures/generated/,
# assembler/dist/wuica_asm.wasm and (from ci-data-v6 on) mca/dist/wuica_mca.wasm. Used by .github/workflows/ci.yml.
# Needs gh (GH_TOKEN), sha256sum, xz. Usage (from the repository root): ci/fetch-data-asset.sh [--data-only]
#   --data-only   data/ and the assembler only (what packages/wuica/build.sh needs), not the fixtures or llvm-mca
set -euo pipefail
cd "$(dirname "$0")/.."
only=0
[ "${1:-}" = --data-only ] && only=1
get() { sed -n "s/^$1=//p" ci/data-asset.txt; }
tag="$(get tag)"; file="$(get file)"; sum="$(get sha256)"
dir="${RUNNER_TEMP:-$(mktemp -d)}/ci-data"
mkdir -p "$dir/unpacked"
gh release download "$tag" --repo "${GITHUB_REPOSITORY:-jtl06/wuica}" --pattern "$file" --dir "$dir"
echo "$sum  $dir/$file" | sha256sum -c -
tar -C "$dir/unpacked" -xJf "$dir/$file"
(cd "$dir/unpacked" && sha256sum -c --quiet MANIFEST.txt)
mkdir -p assembler/dist
mv "$dir/unpacked/data" data
mv "$dir/unpacked/assembler/dist/wuica_asm.wasm" assembler/dist/
if [ "$only" = 0 ]; then
  mkdir -p fixtures mca/dist
  mv "$dir/unpacked/fixtures/generated" fixtures/generated
  if [ -f "$dir/unpacked/mca/dist/wuica_mca.wasm" ]; then mv "$dir/unpacked/mca/dist/wuica_mca.wasm" mca/dist/; fi
fi
rm -rf "$dir"
echo "$tag: $(get files) files$([ "$only" = 1 ] && echo ' (data and the assembler only)')"
