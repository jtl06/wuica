// Tests of the page's engine module (web/js/engine.js). Usage: node tests-js/web_engine.mjs [WASM]
//  1. a fake module that implements the interface of docs/WASM-API.md and grows its memory in every export
//     (wuica_alloc included): the engine must create its views of the memory after each call; it can also trap:
//     the engine must then start a fresh instance and load the data again;
//  2. the real module, if it has been built: decoding, and analysis if the module has it.
import fs from 'node:fs';
import { WasmEngine, EngineError, makeRequest, REQUEST_DEFAULTS } from '../web/js/engine.js';
import { WorkerEngine, CancelledError, createHandler } from '../web/js/engine-rpc.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
async function throws(fn, what) { let ok = false; try { await fn(); } catch { ok = true; } check(ok, what); }
const enc = new TextEncoder(), dec = new TextDecoder();

// --- 1. the fake module -------------------------------------------------------------------------------------------
function fake({ analyze = true } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let top = 16, resultPtr = 0, live = 0, calls = 0;
  const state = { uarch: null, archs: new Map(), requests: [], freed: [] };
  const grow = () => { memory.grow(1); calls++; }; // detaches every ArrayBuffer handed out before
  const alloc = (len) => {
    const p = top; top += Math.max(len, 1);
    while (top > memory.buffer.byteLength) memory.grow(1);
    return p;
  };
  const read = (p, len) => dec.decode(new Uint8Array(memory.buffer, p, len));
  const result = (obj) => {
    const b = enc.encode(typeof obj === 'string' ? obj : JSON.stringify(obj));
    resultPtr = alloc(b.length);
    grow();
    new Uint8Array(memory.buffer, resultPtr, b.length).set(b);
    return b.length;
  };
  const x = {
    memory,
    wuica_alloc(len) { grow(); live++; return alloc(len); },
    wuica_free(ptr, len) { live--; state.freed.push([ptr, len]); },
    wuica_result_ptr() { grow(); return resultPtr; },
    wuica_decode(code, codeLen, chip, chipLen) {
      const bytes = Array.from(new Uint8Array(memory.buffer, code, codeLen));
      const name = read(chip, chipLen);
      if (name !== 'SKYLAKE') return result({ error: `unknown XED chip name: ${name}` });
      return result(bytes.map((b, i) => ({ addr: i, opcode: b.toString(16).toUpperCase().padStart(2, '0'), asm: 'nop' })));
    },
  };
  if (analyze) {
    x.wuica_load_uarch = (p, len) => {
      try { state.uarch = JSON.parse(read(p, len)); } catch { return result({ error: 'invalid JSON' }); }
      return result({ ok: true });
    };
    x.wuica_load_arch = (np, nlen, p, len) => {
      const name = read(np, nlen);
      if (len === 0) return result({ error: 'empty table' });
      state.archs.set(name, new Uint8Array(memory.buffer, p, len).slice());
      return result({ ok: true });
    };
    x.wuica_analyze = (p, len) => {
      const req = JSON.parse(read(p, len));
      state.requests.push(req);
      if (req.hex === 'ff') return result('not json');
      if (req.hex === 'cc') throw new WebAssembly.RuntimeError('unreachable');
      if (req.hex === 'cd') throw new RangeError('Maximum call stack size exceeded');
      const cfg = state.uarch?.configs?.[req.arch];
      if (!cfg) return result({ error: `unknown configuration: ${req.arch}` });
      if (!state.archs.has(cfg.name)) return result({ error: 'table not loaded' });
      return result({ arch: req.arch, tp: 1.25, mode: 'loop', decodeErrors: 0, bottlenecks: [], limits: [], columns: ['Issued'],
        rows: [{ kind: 'instr', label: 'größe → ok', opcode: req.hex.toUpperCase(), instrStr: '', url: null, notes: '', values: [1] }], text: '┌─┐', trace: null });
    };
  }
  return { x, state, live: () => live, growths: () => calls, pages: () => memory.buffer.byteLength / 65536 };
}

{
  const f = fake();
  const e = await WasmEngine.create(() => f.x);
  check(e.capabilities.decode && e.capabilities.analyze && e.capabilities.mock === false, 'fake: capabilities');
  check(!e.hasUarch() && !e.hasArch('SKL'), 'fake: nothing loaded at first');
  await e.loadUarch(JSON.stringify({ configs: { SKL: { name: 'SKL' }, KBL: { name: 'KBL' } } }));
  check(e.hasUarch(), 'fake: uarch loaded');
  const table = new Uint8Array(300000).fill(0x20); // larger than the initial memory page with what is already there
  table[0] = 0x7b; table[table.length - 1] = 0x7d;
  await e.loadArch('SKL', table);
  check(e.hasArch('SKL') && !e.hasArch('KBL'), 'fake: table loaded');
  const got = f.state.archs.get('SKL');
  check(got.length === table.length && got[0] === 0x7b && got[got.length - 1] === 0x7d && got[150000] === 0x20, 'fake: the table arrives intact (bytes input)');
  await e.loadArch('KBL', '{"a": 1}');
  check(dec.decode(f.state.archs.get('KBL')) === '{"a": 1}', 'fake: the table arrives intact (string input)');
  await throws(() => e.loadArch('X', ''), 'fake: loadArch rejects on {error}');
  check(!e.hasArch('X'), 'fake: a failed table is not marked as loaded');

  const r = await e.analyze(makeRequest('4801d8', 'SKL'));
  check(r.tp === 1.25 && r.rows[0].label === 'größe → ok' && r.rows[0].opcode === '4801D8' && r.text === '┌─┐', 'fake: analyze returns the response (UTF-8)', JSON.stringify(r));
  const sent = f.state.requests.at(-1);
  check(JSON.stringify(sent) === JSON.stringify({ hex: '4801d8', arch: 'SKL', ...REQUEST_DEFAULTS }), 'fake: the request has all fields with their defaults', JSON.stringify(sent));
  const r2 = await e.analyze(makeRequest('90', 'KBL', { alignmentOffset: 5, initPolicy: 'stack', noMacroFusion: true, minCycles: 100, bogus: 1 }));
  const sent2 = f.state.requests.at(-1);
  check(r2.arch === 'KBL' && sent2.alignmentOffset === 5 && sent2.initPolicy === 'stack' && sent2.noMacroFusion === true && sent2.minCycles === 100 && sent2.minIterations === 10 && !('bogus' in sent2), 'fake: options are passed, unknown ones dropped');
  const err = await e.analyze(makeRequest('90', 'NOPE'));
  check(err.error === 'unknown configuration: NOPE', 'fake: an error response is returned, not thrown');
  await throws(() => e.analyze(makeRequest('ff', 'SKL')), 'fake: invalid JSON from the module is an exception');

  const d = await e.decode('4801D8', 'SKYLAKE');
  check(Array.isArray(d) && d.length === 3 && d[2].opcode === 'D8', 'fake: decode (hex string)');
  const d2 = await e.decode(Uint8Array.of(0x90, 0xc3), 'SKYLAKE');
  check(d2.length === 2 && d2[1].opcode === 'C3', 'fake: decode (bytes)');
  check((await e.decode('', 'SKYLAKE')).length === 0, 'fake: decode of nothing');
  check((await e.decode('90', 'x')).error === 'unknown XED chip name: x', 'fake: decode error response');
  await throws(() => e.decode('9', 'SKYLAKE'), 'fake: odd hex is rejected before the call');
  await throws(() => e.decode('zz', 'SKYLAKE'), 'fake: non-hex is rejected before the call');
  check(f.live() === 0, 'fake: every input buffer was freed', `${f.live()} live`);
  check(f.state.freed.every(([p, len]) => p > 0 && len >= 0), 'fake: wuica_free gets the pointer and the length');
  check(f.growths() > 30 && f.pages() > 30, 'fake: the memory grew during the calls', `${f.growths()} growths`);
}
{
  const decodeOnly = fake({ analyze: false });
  const e = await WasmEngine.create(() => decodeOnly.x);
  check(e.capabilities.decode && !e.capabilities.analyze, 'decode-only fake: capabilities');
  await throws(() => e.analyze(makeRequest('90', 'SKL')), 'decode-only fake: analyze throws');
  await throws(() => e.loadUarch('{}'), 'decode-only fake: loadUarch throws');
  let msg = ''; try { await e.analyze({}); } catch (x) { msg = x instanceof EngineError ? x.message : ''; }
  check(/wuica_analyze/.test(msg), 'decode-only fake: the error names the missing export', msg);
}
await throws(() => WasmEngine.create(() => ({ memory: new WebAssembly.Memory({ initial: 1 }) })), 'create rejects a module without the interface');
{
  // A trap: the response is an error, and the next call runs in a fresh instance that has the same data.
  const made = [];
  const e = await WasmEngine.create(() => { const f = fake(); made.push(f); return f.x; });
  await e.loadUarch(JSON.stringify({ configs: { SKL: { name: 'SKL' }, HSW: { name: 'HSW' } } }));
  await e.loadArch('SKL', '{"skl": 1}');
  check((await e.analyze(makeRequest('90', 'SKL'))).tp === 1.25 && made.length === 1, 'trap: works before');
  const t = await e.analyze(makeRequest('cc', 'SKL'));
  check(t.error === 'the analysis failed for this input' && t.trapped === true && /unreachable/.test(t.detail), 'trap: a trap is an error response', JSON.stringify(t));
  check(made.length === 1, 'trap: the module is restarted lazily');
  check(e.hasUarch() && e.hasArch('SKL'), 'trap: what was loaded stays loaded for the caller');
  const again = await e.analyze(makeRequest('90', 'SKL'));
  check(again.tp === 1.25 && made.length === 2, 'trap: the next analysis runs in a fresh instance', JSON.stringify(again));
  check(made[1].state.uarch?.configs.HSW && dec.decode(made[1].state.archs.get('SKL')) === '{"skl": 1}' && made[1].state.requests.length === 1, 'trap: uarch.json and the tables were loaded into it again');
  const t2 = await e.analyze(makeRequest('cd', 'SKL'));
  check(t2.trapped === true && /call stack/.test(t2.detail), 'trap: other exceptions from the module count as well');
  await e.loadArch('HSW', '{"hsw": 1}'); // a load is also a call that needs a live instance
  check(made.length === 3 && [...made[2].state.archs.keys()].join() === 'SKL,HSW' && (await e.analyze(makeRequest('90', 'HSW'))).arch === 'HSW', 'trap: loading another table after a trap');
  await e.analyze(makeRequest('cc', 'SKL'));
  check((await e.decode('90', 'SKYLAKE')).length === 1 && made.length === 4, 'trap: decode after a trap');
  await throws(() => e.analyze(makeRequest('ff', 'SKL')), 'trap: invalid JSON is still an exception, not a trap');
  check(made.length === 4, 'trap: and does not restart the module');
}

// --- the engine in a worker (engine-rpc.js), with a worker that runs in this thread -------------------------------------
class FakeWorker {
  static made = [];
  #handle = createHandler(); #dead = false;
  posted = [];
  constructor() { FakeWorker.made.push(this); }
  postMessage(msg) { this.posted.push(msg.op); setTimeout(async () => { if (this.#dead) return; const a = await this.#handle(msg); setTimeout(() => { if (!this.#dead) this.onmessage?.({ data: a }); }, 0); }, 0); }
  terminate() { this.#dead = true; }
}
{
  const fakes = [];
  const source = () => { const f = fake(); fakes.push(f); return f.x; };
  const e = await WorkerEngine.create(source, () => new FakeWorker());
  check(e.capabilities.analyze && e.capabilities.decode && e.capabilities.cancel && !e.capabilities.mock, 'worker: capabilities');
  await e.loadUarch(JSON.stringify({ configs: { SKL: { name: 'SKL' }, HSW: { name: 'HSW' } } }));
  await e.loadArch('SKL', '{"skl": 1}');
  check(e.hasUarch() && e.hasArch('SKL') && !e.hasArch('HSW'), 'worker: what is loaded');
  const [a, b, d] = await Promise.all([e.analyze(makeRequest('90', 'SKL')), e.analyze(makeRequest('c3', 'SKL')), e.decode('90c3', 'SKYLAKE')]);
  check(a.rows[0].opcode === '90' && b.rows[0].opcode === 'C3' && d.length === 2, 'worker: concurrent calls get their own answers');
  check((await e.analyze(makeRequest('90', 'NOPE'))).error?.includes('NOPE'), 'worker: error responses pass through');
  await throws(() => e.analyze(makeRequest('ff', 'SKL')), 'worker: engine errors are exceptions');
  let kind = ''; try { await e.loadArch('X', ''); } catch (x) { kind = x instanceof EngineError ? 'engine' : 'other'; }
  check(kind === 'engine' && !e.hasArch('X'), 'worker: EngineError keeps its type');
  check((await e.analyze(makeRequest('cc', 'SKL'))).trapped === true && (await e.analyze(makeRequest('90', 'SKL'))).tp === 1.25 && FakeWorker.made.length === 1 && fakes.length === 2, 'worker: a trap is handled inside the worker');

  // cancel: pending calls reject, the next call gets a new worker with the data loaded again
  const p1 = e.analyze(makeRequest('90', 'SKL')), p2 = e.decode('90', 'SKYLAKE');
  e.cancel();
  const outcome = async (p) => { try { await p; return 'resolved'; } catch (x) { return x instanceof CancelledError ? 'cancelled' : 'error'; } };
  check(await outcome(p1) === 'cancelled' && await outcome(p2) === 'cancelled', 'worker: cancel rejects what is pending');
  e.cancel(); // twice is fine
  const again = await e.analyze(makeRequest('90', 'SKL'));
  check(again.tp === 1.25 && FakeWorker.made.length === 2, 'worker: the next call starts a new worker');
  check(FakeWorker.made[1].posted.slice(0, 3).join() === 'init,loadUarch,loadArch', 'worker: the new worker gets the module and the data first', FakeWorker.made[1].posted.join());
  const p3 = e.loadArch('HSW', '{"hsw": 1}'); e.cancel();
  check(await outcome(p3) === 'cancelled' && !e.hasArch('HSW'), 'worker: a cancelled load is not recorded');
  const [x, y] = await Promise.all([e.analyze(makeRequest('90', 'SKL')), e.analyze(makeRequest('c3', 'SKL'))]); // both wait for the same restart
  check(x.tp === 1.25 && y.tp === 1.25 && FakeWorker.made.length === 3, 'worker: concurrent calls share one restart');
  // a worker that cannot start
  await throws(() => WorkerEngine.create(source, () => { throw new Error('no workers'); }), 'worker: create rejects if the worker cannot be made');
  await throws(() => WorkerEngine.create(source, () => { const w = { postMessage() { setTimeout(() => w.onerror({ message: 'script error' }), 0); }, terminate() {} }; return w; }), 'worker: create rejects if the worker fails to load');
}

// --- 2. the real module -------------------------------------------------------------------------------------------
const wasmPath = process.argv[2] || new URL('../target/wasm32-unknown-unknown/release/wuica_wasm.wasm', import.meta.url);
if (!fs.existsSync(wasmPath)) {
  console.log(`(no real module at ${wasmPath}: skipped)`);
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasmPath));
  console.log('real module: capabilities', JSON.stringify(e.capabilities));
  const d = await e.decode('4801d84801c349ffcf75f5', 'SKYLAKE');
  check(Array.isArray(d) && d.map((i) => i.asm).join('; ') === 'add rax, rbx; add rbx, rax; dec r15; jnz 0xfffffffffffffff7', 'real: decode', JSON.stringify(d).slice(0, 200));
  check(d.map((i) => `${i.addr}:${i.opcode}`).join(' ') === '0:4801D8 3:4801C3 6:49FFCF 9:75F5', 'real: addresses and bytes');
  const big = await e.decode('4801d8'.repeat(20000), 'SKYLAKE'); // forces the memory to grow
  check(Array.isArray(big) && big.length === 20000 && big[19999].addr === 59997, 'real: a large input (the memory grows)');
  check((await e.decode('90', 'NO_SUCH_CHIP')).error?.includes('NO_SUCH_CHIP'), 'real: unknown chip is an error response');
  check((await e.decode('', 'SKYLAKE')).length === 0, 'real: empty input');
  const dataDir = new URL('../data/', import.meta.url);
  if (e.capabilities.analyze && fs.existsSync(new URL('uarch.json', dataDir))) {
    await e.loadUarch(fs.readFileSync(new URL('uarch.json', dataDir)));
    await e.loadArch('SKL', fs.readFileSync(new URL('arch/SKL.json', dataDir)));
    const r = await e.analyze(makeRequest('4883c0014883c00149ffcf75f3', 'SKL'));
    check(r.tp === 2 && r.mode === 'loop' && r.rows.length === 4 && r.rows.every((x) => x.values.length === r.columns.length), 'real: analyze (reference: 2.00 cycles)', JSON.stringify(r).slice(0, 300));
    const noTable = await e.analyze(makeRequest('90', 'HSW'));
    check(typeof noTable.error === 'string', 'real: analysis without the table is an error response', JSON.stringify(noTable));
    check(typeof (await e.analyze(makeRequest('', 'SKL'))).error === 'string' && typeof (await e.analyze(makeRequest('06', 'SKL'))).error === 'string' && typeof (await e.analyze(makeRequest('90', 'NOPE'))).error === 'string', 'real: no instructions and an unknown configuration are error responses');
    const opt = await e.analyze(makeRequest('4883c0014883c00149ffcf75f3', 'SKL', { noMacroFusion: true, alignmentOffset: 5, initPolicy: 'same', minCycles: 200 }));
    check(opt.tp === 2 && opt.rows.at(-1).notes === '' && r.rows.at(-1).notes === 'M', 'real: options reach the analysis (no macro-fusion)', JSON.stringify(opt.rows?.at(-1)));
    // An input on which the Python reference itself fails (fixture s2_0394.o on IVB): whatever the module does,
    // the engine answers with a response and keeps working.
    await e.loadArch('IVB', fs.readFileSync(new URL('arch/IVB.json', dataDir)));
    const hard = await e.analyze(makeRequest('C4E3F960E603488B9EC0020000440FB6D2492BD54E8D542D004D8BD849FFCF75DF', 'IVB'));
    console.log('real: the input on which the reference fails ->', JSON.stringify(hard).slice(0, 160));
    check(typeof hard.error === 'string' || typeof hard.tp === 'number', 'real: such an input gives a response');
    const after = await e.analyze(makeRequest('4883c0014883c00149ffcf75f3', 'SKL'));
    check(after.tp === 2 && after.text === r.text, 'real: the engine works afterwards (same result as before)');
  } else {
    console.log('(the real module has no wuica_analyze yet: analysis not tested)');
  }
}

console.log(`${count} engine checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
