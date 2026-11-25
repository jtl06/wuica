// Fetching the files of the site (manifest, analyzer, data) with progress. Browser only.

// Resolves to the bytes of `url`. onProgress(received, total): `total` is `size` (the size build.sh recorded;
// Content-Length would be the compressed size) or 0 if unknown.
/** @param {string} url @param {{size?: number, onProgress?: ((received: number, total: number) => void) | null, signal?: AbortSignal}} [opts] */
export async function fetchBytes(url, { size = 0, onProgress = null, signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw Object.assign(new Error(`${url}: HTTP ${res.status}`), { status: res.status });
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

// manifest.json is written by build.sh (web/tools/manifest.mjs): { version, files: {path: size}, tables: [name],
// assembler: bool, mca: bool, engine: {name: {path, size, sha256}} } (and legacy, which the page does not read).
// Without it (the unbuilt source tree, or offline without the service worker) the version is 'dev'.
export async function fetchManifest() {
  try {
    const res = await fetch('manifest.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = await res.json();
    if (typeof m?.version !== 'string' || typeof m.files !== 'object') throw new Error('unexpected content');
    return { version: m.version, files: m.files, tables: Array.isArray(m.tables) ? m.tables : [], assembler: !!m.assembler, mca: !!m.mca,
      engine: m.engine && typeof m.engine === 'object' ? m.engine : null };
  } catch {
    return { version: 'dev', files: {}, tables: [], assembler: null, engine: null };
  }
}

// The engine files by their plain names (PATHS.wasm, PATHS.uarch, PATHS.table(name)); the other files have one name.
export const PATHS = Object.freeze({
  wasm: 'wuica_wasm.wasm',
  assembler: 'wuica_asm.wasm',
  mca: 'wuica_mca.wasm',
  uarch: 'data/uarch.json',
  // the binary form, gzip-compressed (web/build.sh): the host does not compress application/octet-stream; gunzip()
  table: (name) => `data/arch/${encodeURIComponent(name)}.bin.gz`,
});

// Where a page finds its engine files (the analyzer, uarch.json, the tables): a built page (build: the id stamped into
// its HTML) only in its own build's manifest, whose `engine` maps each plain name to {path, size, sha256} (the path
// holds a hash of the content: web/tools/manifest.mjs). Returns name -> that entry (null for a name the build does not
// have), or null when the manifest is not the page's build's: the plain names then hold another build's files (or the
// files of none), and a page that computed with them would show a number of neither build. The unbuilt source tree
// (no build) uses the plain names, unchecked.
export function engineFiles(manifest, build) {
  const engine = manifest?.engine;
  if (!build) return (name) => engine?.[name] ?? { path: name, size: 0, sha256: null };
  if (manifest?.version !== build || !engine) return null;
  return (name) => engine[name] ?? null;
}

// true if bytes are the file the manifest describes: its size, and its sha256 where the platform can compute it
// (crypto.subtle, in a secure context: https and localhost; it runs off the page's thread)
export async function checkBytes(bytes, file) {
  if (file.size && bytes.length !== file.size) return false;
  if (!file.sha256 || !globalThis.crypto?.subtle) return true;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex === file.sha256;
}

// An engine file the page cannot use: 'gone' (the site answers 404 for this build's file: a later deploy, or a
// rollback, replaced the build), 'mismatch' (what came is not this build's file: a cache or proxy on the way), 'foreign'
// (the manifest is another build's: the page cannot know where its own files are). A page shows the message instead of
// a number; 'gone' and 'foreign' also start the update (app.js).
export class EngineFileError extends Error {
  /** @param {'gone' | 'mismatch' | 'foreign'} kind @param {string} what */
  constructor(kind, what) {
    super(kind === 'mismatch' ? `The ${what} that was downloaded is not this version's (its checksum differs), so it is not used. Reload to try again.`
      : 'This version of the page is out of date: its files are no longer on the site. Reload for the current version.');
    this.name = 'EngineFileError';
    this.kind = kind;
  }
}

// The content of a gzip file (a table as the site ships it): the platform's DecompressionStream (Chrome 80, Firefox 113,
// Safari 16.4), else inflate.js (Safari 15 to 16.3, which run the page's module workers but have no DecompressionStream).
export async function gunzip(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return (await import('./inflate.js')).gunzip(bytes);
}

export function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

export function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => fn(), { timeout: 4000 });
  else setTimeout(fn, 300);
}
