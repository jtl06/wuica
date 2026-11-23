// The worker of the llvm-mca view (mca.js): runs wuica_mca.wasm (mca/wuica_mca.cpp) off the page's thread.
//   {module: WebAssembly.Module}            once: instantiate it
//   {id, args: [string], text: string}     run llvm-mca with these arguments on this assembly text
//     -> {id, code, out, err, ms}           its exit code, stdout and stderr; or {id, error} if the module trapped
// A trap leaves the instance unusable, so the next run makes a new one.
let module = null, inst = null;
const enc = new TextEncoder(), dec = new TextDecoder();

function instance() {
  if (inst) return inst;
  inst = new WebAssembly.Instance(module, {}).exports;
  inst._initialize?.();
  return inst;
}

function put(x, bytes) {
  const p = x.malloc(Math.max(1, bytes.length));
  new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
  return p;
}

function read(x, which) {
  const p = x.wuica_mca_output(which), n = x.wuica_mca_output_len(which);
  return dec.decode(new Uint8Array(x.memory.buffer, p, n));
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.module) { module = m.module; inst = null; return; }
  const t0 = performance.now();
  try {
    const x = instance();
    const args = enc.encode(m.args.map((a) => a + '\0').join(''));
    const text = enc.encode(m.text);
    const pa = put(x, args), pt = put(x, text);
    const code = x.wuica_mca_run(pa, args.length, pt, text.length);
    const out = read(x, 0), err = read(x, 1);
    x.free(pa); x.free(pt);
    self.postMessage({ id: m.id, code, out, err, ms: performance.now() - t0 });
  } catch (error) {
    inst = null;
    self.postMessage({ id: m.id, error: String(error?.message ?? error) });
  }
};
