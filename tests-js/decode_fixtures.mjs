// Runs the WebAssembly module (Rust + XED) on the decoder fixtures of the Python reference. Usage: node tests-js/decode_fixtures.mjs [WASM]
import fs from 'node:fs'; import zlib from 'node:zlib';
const wasmPath = process.argv[2] || 'target/wasm32-unknown-unknown/release/wuica_wasm.wasm';
const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
const e = instance.exports, enc = new TextEncoder(), dec = new TextDecoder();
function decode(hex, chip) {
  const code = Uint8Array.from(hex.match(/../g) || [], b => parseInt(b, 16)), chipB = enc.encode(chip);
  const p = e.wuica_alloc(code.length), q = e.wuica_alloc(chipB.length);
  new Uint8Array(e.memory.buffer, p, code.length).set(code);
  new Uint8Array(e.memory.buffer, q, chipB.length).set(chipB);
  const n = e.wuica_decode(p, code.length, q, chipB.length);
  const out = dec.decode(new Uint8Array(e.memory.buffer, e.wuica_result_ptr(), n));
  e.wuica_free(p, code.length); e.wuica_free(q, chipB.length);
  return JSON.parse(out);
}
const lines = zlib.gunzipSync(fs.readFileSync('fixtures/decode_fixtures.jsonl.gz')).toString().trim().split('\n');
let bad = 0; const t0 = performance.now();
for (const line of lines) {
  const c = JSON.parse(line);
  for (const i of c.instrs) delete i.ast;
  if (JSON.stringify(decode(c.hex, c.chip)) !== JSON.stringify(c.instrs)) { bad++; if (bad <= 3) console.log('differs:', c.file, c.chip); }
}
console.log(`${lines.length} cases, ${bad} differ from the Python reference (${(performance.now() - t0).toFixed(0)} ms)`);
console.log('unknown chip ->', JSON.stringify(decode('90', 'NO_SUCH_CHIP')));
process.exit(bad ? 1 : 0);
