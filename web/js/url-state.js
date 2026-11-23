// The state of the page in the URL fragment: input, mode and options. The fragment, never the query string:
// a fragment is not sent to the server. No DOM; btoa/atob exist in browsers and in Node.

export const DEFAULT_STATE = Object.freeze({
  mode: 'hex',            // 'hex' | 'asm'
  syntax: 'intel',        // 'intel' | 'att'
  arch: 'SKL',
  text: '',
  alignmentOffset: 0,     // 0..63
  initPolicy: 'diff',     // 'diff' | 'same' | 'stack'
  simpleFrontEnd: false,
  noMicroFusion: false,
  noMacroFusion: false,
  minIterations: 10,
  minCycles: 500,
  // A–B comparison (ab.js): the fields above are side A and the shared options; these are side B
  ab: false,              // true: A–B mode
  bMode: 'hex',           // 'hex' | 'asm'
  bSyntax: 'intel',       // 'intel' | 'att'
  bArch: '',              // '' = the same microarchitecture as A
  bText: '',
  bScale: 1,              // 1..64: one iteration of B does the work of this many iterations of A (e.g. B is unrolled)
});

export const LIMITS = Object.freeze({
  alignmentOffset: [0, 63],
  minIterations: [1, 10000],
  minCycles: [1, 100000],
  bScale: [1, 64],
});
const MAX_TEXT = 200000; // characters accepted from a link

const INTS = { al: 'alignmentOffset', mi: 'minIterations', mc: 'minCycles' };
const FLAGS = { sfe: 'simpleFrontEnd', nmi: 'noMicroFusion', nma: 'noMacroFusion' };

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function clampInt(value, [lo, hi], fallback) {
  const n = typeof value === 'number' ? value : /^\d+$/.test(String(value).trim()) ? Number(value) : NaN;
  if (!Number.isInteger(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

// The fragment (without "#") for a state; values equal to the defaults are left out. An empty state gives "".
export function encodeState(state) {
  const s = { ...DEFAULT_STATE, ...state };
  const p = [];
  if (s.mode !== DEFAULT_STATE.mode) p.push(`m=${s.mode}`);
  if (s.mode === 'asm' && s.syntax !== DEFAULT_STATE.syntax) p.push(`s=${s.syntax}`);
  if (s.arch !== DEFAULT_STATE.arch) p.push(`a=${encodeURIComponent(s.arch)}`);
  for (const [k, name] of Object.entries(INTS)) if (s[name] !== DEFAULT_STATE[name]) p.push(`${k}=${s[name]}`);
  if (s.initPolicy !== DEFAULT_STATE.initPolicy) p.push(`ip=${s.initPolicy}`);
  for (const [k, name] of Object.entries(FLAGS)) if (s[name]) p.push(`${k}=1`);
  if (s.text !== '') p.push(`c=${toBase64Url(s.text)}`);
  if (s.ab) { // side B, only in A–B mode: a single-mode link stays as it was
    p.push('ab=1');
    if (s.bMode === 'asm') p.push('bm=asm');
    if (s.bMode === 'asm' && s.bSyntax === 'att') p.push('bs=att');
    if (s.bArch) p.push(`ba=${encodeURIComponent(s.bArch)}`);
    if (s.bScale !== DEFAULT_STATE.bScale) p.push(`bk=${s.bScale}`);
    if (s.bText !== '') p.push(`bc=${toBase64Url(s.bText)}`);
  }
  return p.length ? 'v=1&' + p.join('&') : '';
}

// The state in a fragment (with or without "#"); null if there is none. Everything is validated: a link is
// untrusted input. Unknown keys are ignored, bad values fall back to the defaults.
export function decodeState(fragment) {
  const f = String(fragment ?? '').replace(/^#/, '');
  if (f === '') return null;
  const q = new Map();
  for (const part of f.split('&')) {
    const i = part.indexOf('=');
    if (i > 0) q.set(part.slice(0, i), part.slice(i + 1));
  }
  if (q.get('v') !== '1') return null;
  const s = { ...DEFAULT_STATE };
  if (q.get('m') === 'asm') s.mode = 'asm';
  if (q.get('s') === 'att') s.syntax = 'att';
  if (q.has('a')) {
    try {
      const a = decodeURIComponent(q.get('a'));
      if (/^[A-Za-z0-9_-]{1,32}$/.test(a)) s.arch = a;
    } catch { /* keep the default */ }
  }
  for (const [k, name] of Object.entries(INTS)) if (q.has(k)) s[name] = clampInt(q.get(k), LIMITS[name], DEFAULT_STATE[name]);
  if (['same', 'stack'].includes(q.get('ip'))) s.initPolicy = q.get('ip');
  for (const [k, name] of Object.entries(FLAGS)) if (q.get(k) === '1') s[name] = true;
  const text = (k) => {
    try {
      const t = fromBase64Url(q.get(k));
      return t.length <= MAX_TEXT ? t : '';
    } catch { return ''; } // not base64 or not UTF-8: no text
  };
  if (q.has('c')) s.text = text('c');
  if (q.get('ab') === '1') {
    s.ab = true;
    if (q.get('bm') === 'asm') s.bMode = 'asm';
    if (q.get('bs') === 'att') s.bSyntax = 'att';
    if (q.has('ba')) {
      try {
        const a = decodeURIComponent(q.get('ba'));
        if (/^[A-Za-z0-9_-]{1,32}$/.test(a)) s.bArch = a;
      } catch { /* the same as A */ }
    }
    if (q.has('bk')) s.bScale = clampInt(q.get('bk'), LIMITS.bScale, DEFAULT_STATE.bScale);
    if (q.has('bc')) s.bText = text('bc');
  }
  return s;
}
