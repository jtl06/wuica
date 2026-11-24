// Runs the WebAssembly module end to end on simulation fixtures of the Python reference: for a sample of the cases, the
// response's `tp` and `text` must equal the reference's throughput and text output (without terminal hyperlinks). The fixtures
// come from the fixed reference (docs/DEVIATIONS.md): a case with an `error` fails, unless it is an input error
// (`InputError: ...`), which the module must report with the same text.
// Usage: node tests-js/analyze_fixtures.mjs [EVERY_NTH=7] [WASM]
// WUICA_DETAILS=1: the requests ask for `details` (docs/WASM-API.md); the rest of the response must be the same.
import fs from 'node:fs'; import zlib from 'node:zlib'; import readline from 'node:readline';
const every = Number(process.argv[2] || 7);
// WUICA_SHARD=k/n (scripts/check.sh runs shards in parallel): only the k-th of every n sampled cases
const [shard, shards] = (process.env.WUICA_SHARD || '0/1').split('/').map(Number);
const details = process.env.WUICA_DETAILS === '1' ? { details: true } : {};
const wasmPath = process.argv[3] || 'target/wasm32-unknown-unknown/release/wuica_wasm.wasm';
const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
const e = instance.exports, enc = new TextEncoder(), dec = new TextDecoder();
function call(fn, ...strings) {
  const bufs = strings.map(s => { const b = typeof s === 'string' ? enc.encode(s) : s; const p = e.wuica_alloc(b.length); new Uint8Array(e.memory.buffer, p, b.length).set(b); return [p, b.length]; });
  const n = e[fn](...bufs.flat());
  const out = dec.decode(new Uint8Array(e.memory.buffer, e.wuica_result_ptr(), n));
  for (const [p, l] of bufs) e.wuica_free(p, l);
  return JSON.parse(out);
}
const t0 = performance.now();
const uarch = fs.readFileSync('data/uarch.json', 'utf8');
if (!call('wuica_load_uarch', uarch).ok) throw new Error('load_uarch');
// the instruction tables as the site and the npm package ship them: the binary form (web/dist/data/arch/<NAME>.bin.gz, written
// by web/build.sh from data/arch/*.json); the JSON with WUICA_TABLES=json
const TABLES = process.env.WUICA_TABLES === 'json' ? { dir: 'data/arch', ext: '.json', fn: 'wuica_load_arch' } : { dir: 'web/dist/data/arch', ext: '.bin.gz', fn: 'wuica_load_arch_bin', gz: true };
if (!fs.existsSync(TABLES.dir)) throw new Error(`${TABLES.dir} is missing: run web/build.sh (or WUICA_TABLES=json)`);
for (const f of fs.readdirSync(TABLES.dir).filter((f) => f.endsWith(TABLES.ext))) { const r = call(TABLES.fn, f.slice(0, -TABLES.ext.length), (TABLES.gz ? zlib.gunzipSync(fs.readFileSync(`${TABLES.dir}/${f}`)) : fs.readFileSync(`${TABLES.dir}/${f}`))); if (!r.ok) throw new Error(JSON.stringify(r)); }
const tLoad = performance.now() - t0;
const strip = s => s.replace(/\x1b\]8;;.*?\x07/g, '');
let n = 0, bad = 0, refErr = 0, i = 0, tAnalyze = 0;
for (const set of ['sim_fixtures', 'extra_sim_fixtures']) {
  const rl = readline.createInterface({ input: fs.createReadStream(`fixtures/generated/${set}.jsonl.gz`).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (i++ % every || ((i - 1) / every) % shards !== shard) continue;
    // the large `json` field (the trace) is not needed: cut it off before parsing
    const cut = line.indexOf(', "json": ');
    const c = JSON.parse(cut < 0 ? line : line.slice(0, cut) + '}');
    const t = performance.now();
    let r;
    try { r = call('wuica_analyze', JSON.stringify({ hex: c.hex, arch: c.arch, ...c.options, ...details })); }
    catch (err) { r = { error: 'trap: ' + err.message }; }
    tAnalyze += performance.now() - t;
    if (c.error) {
      refErr++;
      const expected = c.error.startsWith('InputError: ') ? c.error.slice('InputError: '.length) : null;
      if (expected === null || r.error !== expected) { bad++; if (bad <= 5) console.log('differs:', c.file, c.arch, JSON.stringify(c.options), 'reference:', c.error, 'wuica:', r.error || r.tp); }
      continue;
    }
    n++;
    if (r.error || r.tp !== c.TP || r.text !== strip(c.stdout)) { bad++; if (bad <= 5) console.log('differs:', c.file, c.arch, JSON.stringify(c.options), r.error || r.tp); }
  }
}
console.log(`${n} cases compared (every ${every}th), ${bad} differ; ${refErr} input errors of the reference checked`);
console.log(`loading all tables (${TABLES.ext}): ${tLoad.toFixed(0)} ms; analysis: ${(tAnalyze / (n + refErr)).toFixed(2)} ms per case`);
process.exit(bad ? 1 : 0);
