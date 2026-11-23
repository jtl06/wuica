// Memory limits for the WebAssembly modules, applied inside a worker thread.
//
// The analyzer module declares no maximum for its memory, so one heavy input can grow an instance to 4 GB (a block of
// 5,000 instructions simulated for 1,000 iterations takes ~2 GB), and the memory of an instance never shrinks. A worker
// therefore (1) compiles the analyzer with a declared maximum: an input that needs more makes the module trap, which the
// library turns into {code: 3, trapped: true} and recovers from; and (2) tracks the instances' memories, so that a
// worker whose analyzer has grown is replaced after its job.
//
// Both hooks wrap globals of the worker's own isolate (WebAssembly.compile and WebAssembly.Instance) before the library
// is imported; the main thread is not affected.
//
// After a trap the library drops the analyzer instance and creates a new one, but the dropped instance's memory is only
// released when it is garbage-collected: a compare that traps on every microarchitecture would otherwise hold 15 capped
// memories at once. So a GC is forced before a new analyzer instance is created. (The memories are tracked with strong
// references to the current instance of each module, not with WeakRefs: a WeakRef keeps its target alive until the end
// of the current job, and a compare runs as one job.)

import v8 from 'node:v8';
import vm from 'node:vm';

const PAGE = 65536;

function readLeb(b, p) {
  let r = 0, s = 0, x;
  do { x = b[p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
  return [r, p];
}

function leb(n) {
  const out = [];
  do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 0x80; out.push(x); } while (n);
  return out;
}

// Returns the module bytes with every (32-bit, unshared) memory's maximum set to at most `maxPages`.
export function capMemory(bytes, maxPages) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let p = 8;
  while (p < b.length) {
    const start = p;
    const id = b[p++];
    let size;
    [size, p] = readLeb(b, p);
    const end = p + size;
    if (id === 5) {
      let q = p, n;
      [n, q] = readLeb(b, q);
      const body = [...leb(n)];
      for (let i = 0; i < n; i++) {
        const flags = b[q++];
        if (flags > 1) return b; // shared or 64-bit memory: left as it is
        let min, max = Infinity;
        [min, q] = readLeb(b, q);
        if (flags & 1) [max, q] = readLeb(b, q);
        body.push(1, ...leb(min), ...leb(Math.max(min, Math.min(max, maxPages))));
      }
      const section = [5, ...leb(body.length), ...body];
      const out = new Uint8Array(b.length - (end - start) + section.length);
      out.set(b.subarray(0, start), 0);
      out.set(section, start);
      out.set(b.subarray(end), start + section.length);
      return out;
    }
    p = end;
  }
  return b;
}

const current = new Map(); // module -> memory of its most recent instance (the one the library uses)
let analyzerModule = null;

let gc = null;
try {
  v8.setFlagsFromString('--expose-gc');
  gc = vm.runInNewContext('gc');
} catch { /* without it, dropped instances are collected whenever V8 decides */ }

// The unhooked constructor (for instances that should not be tracked, such as the instruction counter's).
export const RawInstance = WebAssembly.Instance;

// Installs the hooks. analyzerMaxBytes: the analyzer's memory limit.
export function installWasmLimits(analyzerMaxBytes) {
  const maxPages = Math.max(1, Math.floor(analyzerMaxBytes / PAGE));
  const compile = WebAssembly.compile;
  WebAssembly.compile = async function (source) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    const probe = await compile.call(WebAssembly, bytes);
    if (!WebAssembly.Module.exports(probe).some((e) => e.name === 'wuica_analyze')) return probe;
    analyzerModule = await compile.call(WebAssembly, capMemory(bytes, maxPages));
    return analyzerModule;
  };
  const Instance = WebAssembly.Instance;
  WebAssembly.Instance = new Proxy(Instance, {
    construct(target, args) {
      const module = args[0];
      if (module === analyzerModule && current.has(module)) {
        current.delete(module); // the previous instance trapped and was dropped by the library: release its memory
        gc?.();
      }
      const inst = new target(...args);
      if (inst.exports.memory instanceof WebAssembly.Memory) current.set(module, inst.exports.memory);
      return inst;
    },
  });
}

// The analyzer module as compiled (with the memory limit), for the instruction counter.
export const getAnalyzerModule = () => analyzerModule;

// Total size of the memories of the instances in use (the most recent instance of each module).
export function wasmMemoryBytes() {
  let total = 0;
  for (const m of current.values()) total += m.buffer.byteLength;
  return total;
}
