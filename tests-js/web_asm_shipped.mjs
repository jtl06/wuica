// The built-in examples answered from their machine code before the assembler has loaded (web/js/asm-shipped.js): for
// every example and both syntaxes, the result the page takes from the shipped bytes is the result of assembling the
// text (the same bytes, loop, notes, everything assembleMarked returns), and the analysis of the two is the same
// response. Also: other text, another loop picked, an unknown syntax: no answer (the assembler is needed).
//
//   node tests-js/web_asm_shipped.mjs
import fs from 'node:fs';
import { createShipped, NOT_AS_ASSEMBLED } from '../web/js/asm-shipped.js';
import { withRegions } from '../web/js/asm-regions.js';
import { WasmAssembler } from '../web/js/assembler.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES, SHOWCASE_EXAMPLES } from '../web/js/examples.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + String(detail).slice(0, 2000) : ''}`); } }
const root = new URL('../', import.meta.url);

// the showcase's assembly is a module of its own (loaded when the example is picked)
for (const ex of SHOWCASE_EXAMPLES) if (ex.asm && ex.text.intel == null) ex.text.intel = await ex.asm();
const examples = [...EXAMPLES, ...CLASSIC_EXAMPLES, ...SHOWCASE_EXAMPLES];
const shipped = createShipped(examples);

// no answer for what is not an example's text as it is
{
  const t = EXAMPLES[0].text.intel;
  check(await shipped(t + ' ', 'intel') === null && await shipped('  add rax, 1\n', 'intel') === null, 'other text: no answer');
  check(await shipped(t, 'intel', 'whole') === null && await shipped(t, 'intel', 0) === null, 'another loop picked: no answer');
  check(await shipped(t, 'att') === null && await shipped(EXAMPLES[0].text.att, 'att') !== null, 'the text in the other syntax: no answer; in its own: an answer');
  const a = await shipped(t, 'intel'), b = await shipped(t, 'intel');
  a.bytes[0] ^= 0xff;
  check(b.bytes[0] !== a.bytes[0], 'each answer is a copy (a caller may change its bytes)');
}

const asmPath = new URL('assembler/dist/wuica_asm.wasm', root);
const wasmPath = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(asmPath) || !fs.existsSync(wasmPath)) {
  console.log('(the assembler or the analyzer is missing: only the cases without them)');
} else {
  const A = withRegions(await WasmAssembler.create(fs.readFileSync(asmPath)));
  const e = await WasmEngine.create(fs.readFileSync(wasmPath));
  await e.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
  const uarch = JSON.parse(fs.readFileSync(new URL('data/uarch.json', root)));
  const loaded = new Set();
  const plain = (r) => JSON.stringify(r, (k, v) => (v instanceof Uint8Array ? [...v] : v));
  let answered = 0, both = 0;
  for (const ex of examples) {
    const arch = ex.arch ?? 'SKL';
    const table = uarch.configs[arch].name;
    if (!loaded.has(table)) { await e.loadArch(table, fs.readFileSync(new URL(`data/arch/${table}.json`, root))); loaded.add(table); }
    for (const syntax of ['intel', 'att']) {
      const text = ex.text[syntax];
      if (typeof text !== 'string') continue;
      both++;
      const real = await A.assemble(text, syntax, { loop: 'auto' });
      const fromCode = await shipped(text, syntax, 'auto');
      if (NOT_AS_ASSEMBLED.has(ex.id)) {
        check(fromCode === null && real.ok && Buffer.from(real.bytes).toString('hex') !== ex.hex, `${ex.id} (${syntax}): its machine code is not what its text assembles to, so it is not answered`);
        continue;
      }
      check(fromCode !== null, `${ex.id} (${syntax}): answered from its machine code`);
      if (!fromCode) continue;
      answered++;
      check(plain(fromCode) === plain(real), `${ex.id} (${syntax}): the same result as assembling its text`, `${plain(fromCode).slice(0, 300)}\n${plain(real).slice(0, 300)}`);
      const hexOf = (b) => Buffer.from(b).toString('hex');
      const [ra, rb] = [await e.analyze(makeRequest(hexOf(real.bytes), arch)), await e.analyze(makeRequest(hexOf(fromCode.bytes), arch))];
      check(!ra.error && JSON.stringify(ra) === JSON.stringify(rb), `${ex.id} (${syntax}) on ${arch}: the same analysis`, ra.error ?? '');
    }
  }
  console.log(`${answered} of ${both} example texts answered from their machine code`);
}
console.log(`${count} shipped-code checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
