// GET /api/version: the versions of the server, the library, the analyzer's components and the instruction data.
// The deployed server has no repository docs, so the component versions are constants here; test/version.test.mjs
// checks them against the repository (docs/DESIGN.md, third_party/xed/README.md, the package README).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPONENTS = Object.freeze({
  // the Python uiCA that wuica reproduces and whose tables (data/) it uses: fork jtl06/uiCA, branch perf
  uiCA: { repository: 'https://github.com/jtl06/uiCA', commit: '8f24bd3' },
  // the assembler module (assembler/): LLVM's x86 assembler
  llvm: '22.1.2',
  // the decoder in the analyzer (third_party/xed): andreas-abel/XED-to-XML, the version uiCA pins
  xed: 'v10.0-1167-gc71679ee',
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function versionInfo() {
  const server = readJson(fileURLToPath(new URL('../package.json', import.meta.url)));
  const pkgFile = fileURLToPath(import.meta.resolve('wuica/package.json'));
  const pkg = readJson(pkgFile);
  let manifest = null;
  try { manifest = readJson(path.join(path.dirname(pkgFile), 'dist', 'manifest.json')); } catch { /* optional */ }
  const sha = (name) => manifest?.files?.[name]?.sha256 ?? null;
  return {
    wuica: pkg.version,
    server: server.version,
    node: process.versions.node,
    uiCA: COMPONENTS.uiCA,
    llvm: COMPONENTS.llvm,
    xed: COMPONENTS.xed,
    data: { source: 'https://www.uops.info (via uiCA)', uarchSha256: sha('data/uarch.json') },
    wasm: { analyzerSha256: sha('wuica_wasm.wasm'), assemblerSha256: sha('wuica_asm.wasm') },
  };
}
