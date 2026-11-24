// Fetching the files of the site (manifest, analyzer, data) with progress. Browser only.

// Resolves to the bytes of `url`. onProgress(received, total): `total` is `size` (the size build.sh recorded;
// Content-Length would be the compressed size) or 0 if unknown.
export async function fetchBytes(url, { size = 0, onProgress = null, signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!res.body || !onProgress) {
    const all = new Uint8Array(await res.arrayBuffer());
    onProgress?.(all.length, size || all.length);
    return all;
  }
  const reader = res.body.getReader();
  let buf = new Uint8Array(size || 1 << 20);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > buf.length) {
      const bigger = new Uint8Array(Math.max(buf.length * 2, n + value.length));
      bigger.set(buf.subarray(0, n));
      buf = bigger;
    }
    buf.set(value, n);
    n += value.length;
    onProgress(n, size);
  }
  return n === buf.length ? buf : buf.slice(0, n);
}

// manifest.json is written by build.sh: { version, files: {path: size}, tables: [name], assembler: bool }.
// Without it (the unbuilt source tree) the page still works, with unknown sizes.
export async function fetchManifest() {
  try {
    const res = await fetch('manifest.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = await res.json();
    if (typeof m?.version !== 'string' || typeof m.files !== 'object') throw new Error('unexpected content');
    return { version: m.version, files: m.files, tables: Array.isArray(m.tables) ? m.tables : [], assembler: !!m.assembler, mca: !!m.mca };
  } catch {
    return { version: 'dev', files: {}, tables: [], assembler: null };
  }
}

export const PATHS = Object.freeze({
  wasm: 'wuica_wasm.wasm',
  assembler: 'wuica_asm.wasm',
  mca: 'wuica_mca.wasm',
  uarch: 'data/uarch.json',
  table: (name) => `data/arch/${encodeURIComponent(name)}.bin`, // the binary form (tools/encode-tables.sh)
});

export function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

export function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => fn(), { timeout: 4000 });
  else setTimeout(fn, 300);
}
