// A worker thread of the pool: its own instance of the wuica library (analyzer and assembler WebAssembly instances,
// instruction tables), so that the CPU-bound analysis never runs on the event loop.
//
// Messages in:  {id, op: 'analyze' | 'compare' | 'assemble', args}
// Messages out: {type: 'ready', baseline} once, then {id, result, meta: {instructions, bytes}, recycle} per job.
// `recycle` asks the pool to replace this worker (its WebAssembly memory has grown; it never shrinks).

import { parentPort, workerData } from 'node:worker_threads';
import { installWasmLimits, getAnalyzerModule, RawInstance, wasmMemoryBytes } from './wasm-limits.js';

const cfg = workerData;
installWasmLimits(cfg.analyzerMemoryMb * 2 ** 20);
const { createWuica, normalizeHex } = await import('wuica');

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_INSTR_LEN = 15; // bytes

let w;
try {
  w = await createWuica(cfg.dataDir ? { dataDir: cfg.dataDir } : {});
  if (cfg.warm) {
    for (const a of w.archs()) {
      const r = await w.analyze(a.id, { hex: '90' });
      if (r.code !== 0) throw new Error(`warm-up on ${a.id} failed: ${r.error}`);
    }
    const a = await w.assemble('nop');
    if (a.code !== 0) throw new Error(`warm-up of the assembler failed: ${a.error}`);
  }
} catch (e) {
  parentPort.postMessage({ type: 'init-error', message: e?.stack ?? String(e) });
  process.exit(1);
}
const baseline = wasmMemoryBytes();
const archList = w.archs();
const defaultChip = archList.at(-1)?.xedChip ?? 'SKYLAKE';

function chipOf(arch) {
  const id = w.resolveArch(arch);
  if (!id) return defaultChip;
  return (archList.find((a) => a.id === id) ?? archList.find((a) => a.id === id.split('_')[0]))?.xedChip ?? defaultChip;
}

// Counts the instructions XED decodes in `bytes` (undecodable bytes are skipped), with an instance of the analyzer
// module of its own (not the library's). null if that is not possible.
let decoder = null;
function countInstructions(bytes, chip) {
  const module = getAnalyzerModule();
  if (!module) return null;
  try {
    decoder ??= new RawInstance(module, {}).exports;
    const x = decoder;
    const args = [];
    for (const b of [bytes, enc.encode(chip)]) {
      const p = x.wuica_alloc(b.length);
      new Uint8Array(x.memory.buffer, p, b.length).set(b);
      args.push([p, b.length]);
    }
    const len = x.wuica_decode(args[0][0], args[0][1], args[1][0], args[1][1]);
    const text = dec.decode(new Uint8Array(x.memory.buffer, x.wuica_result_ptr(), len));
    for (const [p, l] of args) x.wuica_free(p, l);
    if (!text.startsWith('[')) return null;
    let n = 0;
    for (let i = text.indexOf('"iclass":'); i >= 0; i = text.indexOf('"iclass":', i + 9)) n++;
    return n;
  } catch {
    decoder = null;
    return null;
  } finally {
    if (decoder && decoder.memory.buffer.byteLength > 64 * 2 ** 20) decoder = null; // decoding allocates ~600 B per byte
  }
}


// The machine code of a request, without analyzing it: {bytes} (to be counted), {small: true} (assembly text that
// cannot hold more than maxInstructions instructions), or null (malformed: the library reports it).
async function code(req) {
  if (req === null || typeof req !== 'object') return null;
  const source = req.source ?? req.asm;
  const hasSource = source !== undefined && source !== null, hasHex = req.hex !== undefined && req.hex !== null;
  if (hasSource === hasHex) return null;
  if (hasHex) {
    const hex = normalizeHex(req.hex);
    return hex === null ? null : { bytes: Buffer.from(hex, 'hex') };
  }
  if (typeof source !== 'string') return null;
  // every instruction takes at least 2 characters plus a separator, and only directives (which all contain a '.':
  // .rept, .fill, .p2align, .macro, ...) make code out of nothing; any '.' takes the slow path (assemble and count)
  if (source.length <= cfg.maxInstructions && !source.includes('.')) return { small: true };
  const a = await w.assemble(source, req.syntax ?? 'intel');
  return a.code === 0 ? { bytes: a.bytes } : null;
}

function tooMany(what) {
  const error = `too many instructions: ${what} (the limit of this server is ${cfg.maxInstructions})`;
  return { code: 1, error, stderr: [{ text: error }] };
}

// Checks the instruction limit. Returns {failure} or {instructions} (null if not counted).
async function checkSize(req, chip) {
  const c = await code(req);
  if (!c || c.small) return { instructions: null };
  const n = c.bytes.length;
  if (n > cfg.maxInstructions * MAX_INSTR_LEN) return { failure: tooMany(`${n} bytes of machine code`), bytes: n };
  if (n <= cfg.maxInstructions) return { instructions: null, bytes: n };
  const count = countInstructions(c.bytes, chip) ?? n;
  if (count > cfg.maxInstructions) return { failure: tooMany(count), instructions: count, bytes: n };
  return { instructions: count, bytes: n };
}

function hexCount(r, req, chip) {
  const hex = r.hex ?? (typeof req?.hex === 'string' ? normalizeHex(req.hex) : null);
  if (!hex || hex.length / 2 > cfg.maxInstructions * MAX_INSTR_LEN) return { instructions: null, bytes: hex ? hex.length / 2 : null };
  return { instructions: countInstructions(Buffer.from(hex, 'hex'), chip), bytes: hex.length / 2 };
}

const ops = {
  async analyze({ arch, req }) {
    const chip = chipOf(arch);
    const s = await checkSize(req, chip);
    if (s.failure) return { result: s.failure, meta: { instructions: s.instructions ?? null, bytes: s.bytes ?? null, limit: true } };
    const r = await w.analyze(arch, req);
    const instructions = r.code === 0 ? r.rows.filter((x) => x.kind === 'instr').length : s.instructions;
    const bytes = r.code === 0 ? (r.hex ?? normalizeHex(req.hex) ?? '').length / 2 : s.bytes ?? null;
    return { result: r, meta: { instructions, bytes } };
  },
  async compare({ req }) {
    const first = Array.isArray(req?.archs) && req.archs.length ? req.archs[0] : undefined;
    const chip = first === undefined ? defaultChip : chipOf(first);
    const s = await checkSize(req, chip);
    if (s.failure) return { result: s.failure, meta: { instructions: s.instructions ?? null, bytes: s.bytes ?? null, limit: true } };
    const r = await w.compare(req);
    const meta = r.code === 0 ? (s.instructions !== null ? { instructions: s.instructions, bytes: s.bytes } : hexCount(r, req, chip)) : { instructions: null, bytes: null };
    return { result: r, meta };
  },
  async assemble({ source, syntax }) {
    const { bytes, ...r } = await w.assemble(source, syntax);
    return { result: r, meta: r.code === 0 ? hexCount(r, null, defaultChip) : { instructions: null, bytes: null } };
  },
};

parentPort.on('message', async ({ id, op, args }) => {
  let out;
  try {
    out = await ops[op](args);
  } catch (e) {
    const error = `internal error: ${e?.message ?? e}`;
    out = { result: { code: 3, error, stderr: [{ text: error }] }, meta: {} };
  }
  const grown = wasmMemoryBytes() - baseline;
  parentPort.postMessage({ id, ...out, recycle: grown > cfg.recycleMemoryMb * 2 ** 20 });
});

parentPort.postMessage({ type: 'ready', baseline });
