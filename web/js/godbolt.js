// Import from Compiler Explorer (godbolt.org): decoding its links, its API, and picking a block out of the
// compiler's output. No DOM; the network goes through a fetch function the caller passes in, so this runs under
// Node (tests-js/web_godbolt.mjs) with recorded responses.
//
// Links:
//   https://godbolt.org/z/<id>              a short link: resolved with GET /api/shortlinkinfo/<id>
//   https://godbolt.org/#g:!((g:!((...      the whole state in the fragment: rison (a URL-friendly JSON) of
//                                           GoldenLayout's minified layout configuration
//   https://godbolt.org/#z:OYLghAFBqd5...   the same, compressed with lz-string (base64)
//   https://godbolt.org/clientstate/<b64>   base64 JSON in CE's "client state" format (what short links resolve to)
//   also gcc.godbolt.org, compiler-explorer.com, the embedded view (/e#...), and legacy states (versions 1 to 3).
// Every request goes to https://godbolt.org (the only third-party origin the page's CSP allows), and only when
// the user imports something.

import { functionBody, defaultLoop, vectorWidth, isRemainder, JCC, JMP } from './loop-find.js';

export const CE_ORIGIN = 'https://godbolt.org';
const HOST = /^(?:[a-z0-9-]+\.)*(?:godbolt\.org|compiler-explorer\.com)$/i;
const MAX_LINK = 1 << 20;

// ---- rison ------------------------------------------------------------------------------------------------------
// https://github.com/Nanonid/rison: '(a:1,b:!(x,y))' is {a: 1, b: ['x', 'y']}; !t !f !n are true false null;
// strings are bare ids or '...' with !' and !! as escapes.

const NOT_IDCHAR = " '!:(),*@$";
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/y;

export function risonDecode(text) {
  const s = String(text);
  let i = 0;
  const fail = (what) => { throw new Error(`rison: ${what} at position ${i}`); };
  const quoted = () => {
    i++; // '
    let out = '';
    for (;;) {
      if (i >= s.length) fail('unterminated string');
      const c = s[i++];
      if (c === "'") return out;
      if (c === '!') {
        const d = s[i++];
        if (d === '!' || d === "'") out += d; else fail('bad escape in a string');
      } else out += c;
    }
  };
  const value = () => {
    if (i >= s.length) fail('unexpected end');
    const c = s[i];
    if (c === '!') {
      const d = s[i + 1];
      i += 2;
      if (d === 't') return true;
      if (d === 'f') return false;
      if (d === 'n') return null;
      if (d === '(') {
        const arr = [];
        if (s[i] === ')') { i++; return arr; }
        for (;;) {
          arr.push(value());
          if (s[i] === ',') { i++; continue; }
          if (s[i] === ')') { i++; return arr; }
          fail('expected , or ) in an array');
        }
      }
      fail('unknown ! value');
    }
    if (c === '(') {
      i++;
      const obj = {};
      if (s[i] === ')') { i++; return obj; }
      for (;;) {
        const k = value();
        if (typeof k !== 'string' && typeof k !== 'number') fail('bad key');
        if (s[i] !== ':') fail('expected :');
        i++;
        obj[String(k)] = value();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ')') { i++; return obj; }
        fail('expected , or ) in an object');
      }
    }
    if (c === "'") return quoted();
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(s);
      if (!m) fail('bad number');
      i += m[0].length;
      return Number(m[0]);
    }
    const start = i;
    while (i < s.length && !NOT_IDCHAR.includes(s[i])) i++;
    if (i === start) fail(`unexpected ${JSON.stringify(c)}`);
    return s.slice(start, i);
  };
  const v = value();
  if (i !== s.length) fail('trailing characters');
  return v;
}

// The fragment of a CE link: rison without the outer parentheses, URI-encoded with "+" for spaces.
export function unrisonify(text) {
  return risonDecode('(' + decodeURIComponent(String(text).replace(/\+/g, '%20')) + ')');
}

// ---- lz-string ----------------------------------------------------------------------------------------------------
// decompressFromBase64 of lz-string (https://github.com/pieroxy/lz-string, MIT), which CE uses for "#z:" links.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

export function lzDecompressFromBase64(input) {
  const text = String(input ?? '');
  if (text === '') return '';
  const val = (k) => {
    const v = B64.indexOf(text.charAt(k));
    if (v < 0) throw new Error('lz-string: not base64');
    return v;
  };
  const RESET = 32;
  let data = val(0), position = RESET, index = 1;
  const bits = (n) => {
    let out = 0;
    for (let power = 1, k = 0; k < n; k++, power <<= 1) {
      const b = data & position;
      position >>= 1;
      if (position === 0) {
        position = RESET;
        data = index < text.length ? val(index) : 0;
        index++;
      }
      if (b > 0) out |= power;
    }
    return out;
  };
  /** @type {(number | string)[]} */
  const dict = [0, 1, 2];
  let enlargeIn = 4, dictSize = 4, numBits = 3;
  let c;
  switch (bits(2)) {
    case 0: c = String.fromCharCode(bits(8)); break;
    case 1: c = String.fromCharCode(bits(16)); break;
    default: return '';
  }
  dict[3] = c;
  let w = c;
  const result = [c];
  for (;;) {
    if (index > text.length) return '';
    let code = bits(numBits);
    if (code === 0 || code === 1) {
      dict[dictSize++] = String.fromCharCode(bits(code === 0 ? 8 : 16));
      code = dictSize - 1;
      enlargeIn--;
    } else if (code === 2) {
      return result.join('');
    }
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
    let entry;
    if (dict[code] !== undefined) entry = dict[code];
    else if (code === dictSize) entry = w + w.charAt(0);
    else throw new Error('lz-string: corrupt data');
    result.push(entry);
    dict[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
  }
}

// ---- GoldenLayout's minified configuration -------------------------------------------------------------------------
// Keys and some values are replaced by their index (base 36) in these tables; other one-character strings get "___".

const GL_KEYS = ['settings', 'hasHeaders', 'constrainDragToContainer', 'selectionEnabled', 'dimensions', 'borderWidth',
  'minItemHeight', 'minItemWidth', 'headerHeight', 'dragProxyWidth', 'dragProxyHeight', 'labels', 'close', 'maximise',
  'minimise', 'popout', 'content', 'componentName', 'componentState', 'id', 'width', 'type', 'height', 'isClosable',
  'title', 'popoutWholeStack', 'openPopouts', 'parentId', 'activeItemIndex', 'reorderEnabled', 'borderGrabWidth'];
const GL_VALUES = [true, false, 'row', 'column', 'stack', 'component', 'close', 'maximise', 'minimise', 'open in new window'];

function glMax(v, table) {
  if (typeof v === 'string' && v.length === 1) return table[parseInt(v, 36)];
  if (typeof v === 'string' && v.startsWith('___')) return v[3];
  return v;
}

export function unminifyLayout(x) {
  if (Array.isArray(x)) return x.map((v) => (v !== null && typeof v === 'object' ? unminifyLayout(v) : glMax(v, GL_VALUES)));
  const out = {};
  for (const [k, v] of Object.entries(x)) out[glMax(k, GL_KEYS)] = v !== null && typeof v === 'object' ? unminifyLayout(v) : glMax(v, GL_VALUES);
  return out;
}

// ---- links -> a normalized state ------------------------------------------------------------------------------------
// A state, whatever the link format:
//   { editors:   [{id, lang, source}],
//     compilers: [{n, compiler, editorId, lang, options, filters, libs: [{id, version}], title}],
//     notes:     [strings: things in the state that cannot be imported] }

function libsOf(libs) {
  if (!Array.isArray(libs)) return [];
  return libs.map((l) => ({ id: String(l?.name ?? l?.id ?? ''), version: String(l?.ver ?? l?.version ?? '') })).filter((l) => l.id);
}

function fromLayout(config) {
  const editors = [], compilers = [], notes = [];
  const walk = (item) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'component' || item.componentName) {
      const st = item.componentState ?? {};
      if (item.componentName === 'codeEditor') {
        editors.push({ id: Number(st.id ?? editors.length + 1), lang: String(st.lang ?? ''), source: String(st.source ?? '') });
      } else if (item.componentName === 'compiler') {
        if (st.tree !== undefined && st.source === undefined) notes.push('a compiler pane of a multi-file project (CMake tree): not supported');
        else compilers.push({ compiler: String(st.compiler ?? ''), editorId: Number(st.source ?? 1), lang: String(st.lang ?? ''),
          options: String(st.options ?? ''), filters: st.filters ?? {}, libs: libsOf(st.libs), title: typeof item.title === 'string' ? item.title : '' });
      } else if (item.componentName === 'tree') {
        notes.push('a multi-file project (CMake tree): not supported');
      }
    }
    for (const c of Array.isArray(item.content) ? item.content : []) walk(c);
  };
  walk(config);
  return { editors, compilers, notes };
}

// CE's client state (what /api/shortlinkinfo returns): {sessions: [{id, language, source, compilers: [...]}], trees}
export function fromClientState(cs) {
  if (!cs || !Array.isArray(cs.sessions)) throw new Error('not a Compiler Explorer state (no sessions)');
  const editors = [], compilers = [], notes = [];
  for (const s of cs.sessions) {
    const id = Number(s.id ?? editors.length + 1);
    editors.push({ id, lang: String(s.language ?? ''), source: String(s.source ?? '') });
    for (const c of Array.isArray(s.compilers) ? s.compilers : []) {
      compilers.push({ compiler: String(c.id ?? c.compilerId ?? c.compiler ?? ''), editorId: id, lang: String(s.language ?? ''),
        options: String(c.options ?? ''), filters: c.filters ?? {}, libs: libsOf(c.libs), title: '' });
    }
  }
  if (Array.isArray(cs.trees) && cs.trees.length) notes.push('a multi-file project (CMake tree): not supported');
  return finish({ editors, compilers, notes });
}

function finish(st) {
  st.compilers = st.compilers.filter((c) => c.compiler).map((c, k) => ({ ...c, n: k + 1, lang: c.lang || st.editors.find((e) => e.id === c.editorId)?.lang || '' }));
  return st;
}

// CE's loadState: versions 1 to 3 were a flat object, version 4 is the GoldenLayout configuration.
function fromLoadedState(state) {
  if (!state || typeof state !== 'object') throw new Error('not a Compiler Explorer state');
  if (Array.isArray(state.sessions)) return fromClientState(state);
  const v = state.version;
  if (v === 1 || v === 2 || v === 3) {
    const sc = v === 3 ? state.compilers?.[0] : state;
    if (!sc) throw new Error('an old Compiler Explorer state without a compiler');
    const source = sc.sourcez ? lzDecompressFromBase64(sc.sourcez) : String(sc.source ?? '');
    const filters = { ...(v === 1 ? {} : state.filterAsm ?? {}) };
    return finish({ editors: [{ id: 1, lang: 'c++', source }],
      compilers: [{ compiler: String(sc.compiler ?? ''), editorId: 1, lang: 'c++', options: String(sc.options ?? ''), filters, libs: [], title: '' }], notes: [] });
  }
  if (v === 4) return finish(fromLayout(unminifyLayout(state)));
  throw new Error(`unknown Compiler Explorer state version ${JSON.stringify(v)}`);
}

// The state in the fragment of a full link (without "#"), as CE's deserialiseState reads it.
export function decodeFragment(fragment) {
  const text = String(fragment ?? '').replace(/^#/, '');
  if (text === '') throw new Error('the link has no state in it');
  let state = null, error = null;
  try {
    state = unrisonify(text);
    if (state && typeof state.z === 'string') {
      const data = lzDecompressFromBase64(state.z);
      if (data === '') throw new Error('the compressed state is corrupt (was the link cut off?)');
      state = unrisonify(data);
    }
  } catch (e) { error = e; state = null; }
  if (!state || (state.version === undefined && !Array.isArray(state.sessions))) {
    try { state = JSON.parse(decodeURIComponent(text)); error = null; } catch { /* report the rison error */ }
  }
  if (!state) throw new Error(`could not read the link's state: ${error?.message ?? 'unknown format'}`);
  return fromLoadedState(state);
}

function fromBase64Json(b64) {
  const bin = atob(decodeURIComponent(b64).replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

// True if the text is (only) a Compiler Explorer link.
export function isCeLink(text) {
  const t = String(text ?? '').trim();
  if (!t || /\s/.test(t) || t.length > MAX_LINK) return false;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t);
    return HOST.test(u.hostname) && (u.hash.length > 1 || /^\/(?:z|clientstate)\/[^/]+/.test(u.pathname));
  } catch { return false; }
}

// Reads a link: {kind: 'short', id} (needs the API) or {kind: 'state', state}. Throws with a message for the user.
export function parseCeLink(text) {
  const t = String(text ?? '').trim();
  if (t === '') throw new Error('enter a Compiler Explorer link');
  if (t.length > MAX_LINK) throw new Error('the link is too long');
  let u;
  try { u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t); } catch { throw new Error('not a link'); }
  if (!HOST.test(u.hostname)) throw new Error(`not a Compiler Explorer link (${u.hostname}); links of godbolt.org or compiler-explorer.com work`);
  let m;
  if ((m = /^\/z\/([A-Za-z0-9_-]{1,64})\/?$/.exec(u.pathname))) return { kind: 'short', id: m[1] };
  if ((m = /^\/clientstate\/([A-Za-z0-9+/=_%-]+)\/?$/.exec(u.pathname))) {
    try { return { kind: 'state', state: fromClientState(fromBase64Json(m[1])) }; } catch (e) { throw new Error(`could not read the link's state: ${e.message}`); }
  }
  if (u.hash.length > 1) return { kind: 'state', state: decodeFragment(u.hash) };
  throw new Error('this link has no code in it: use the link from Compiler Explorer\'s Share menu (short or full link)');
}

// ---- the API ---------------------------------------------------------------------------------------------------------

export class CeError extends Error {
  constructor(message, { status = 0, retryAfter = null, network = false } = {}) {
    super(message);
    this.name = 'CeError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.network = network;
  }
}

// fetch -> JSON with the errors explained. opts: {fetch, signal, timeoutMs}
export async function ceRequest(path, { method = 'GET', body = null, fetch: f = globalThis.fetch, signal = null, timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let res;
  try {
    res = await f(CE_ORIGIN + path, {
      method, signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: method === 'GET' ? 'default' : 'no-store',
      headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (signal?.aborted) throw new CeError('cancelled');
    if (ctrl.signal.aborted) throw new CeError('godbolt.org did not answer in time; try again', { network: true });
    throw new CeError('could not reach godbolt.org (offline, or the request was blocked, e.g. by an extension)', { network: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (res.status === 429) {
    const ra = Number(res.headers?.get?.('retry-after'));
    throw new CeError(`Compiler Explorer is limiting the rate of requests; try again ${Number.isFinite(ra) && ra > 0 ? `in ${Math.ceil(ra)} s` : 'in a minute'}`, { status: 429, retryAfter: Number.isFinite(ra) ? ra : null });
  }
  if (res.status === 404) throw new CeError('not found on Compiler Explorer (a mistyped or deleted short link?)', { status: 404 });
  if (!res.ok) throw new CeError(`Compiler Explorer answered HTTP ${res.status}`, { status: res.status });
  try {
    return await res.json();
  } catch {
    throw new CeError('Compiler Explorer sent an unexpected answer (not JSON)', { status: res.status });
  }
}

export async function resolveShortLink(id, opts) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new CeError('not a short link id');
  return fromClientState(await ceRequest(`/api/shortlinkinfo/${encodeURIComponent(id)}`, opts));
}

// The compilers of a language: Map id -> {id, name, instructionSet, supportsBinary, supportsBinaryObject}
export async function compilersOf(lang, opts) {
  const list = await ceRequest(`/api/compilers/${encodeURIComponent(lang)}?fields=id,name,lang,instructionSet,supportsBinary,supportsBinaryObject`, opts);
  if (!Array.isArray(list)) throw new CeError('Compiler Explorer sent an unexpected compiler list');
  return new Map(list.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
}

// How the output is requested: 'binaryObject' (assembled object file, disassembled: the exact bytes, no linking),
// 'binary' (linked executable), 'asm' (the compiler's assembly text, assembled again in the page).
export function outputModes(info) {
  if (!info) return ['binaryObject', 'binary', 'asm'];
  const modes = [];
  if (info.supportsBinaryObject) modes.push('binaryObject');
  if (info.supportsBinary) modes.push('binary');
  modes.push('asm');
  return modes;
}

export function compileRequest(pane, source, mode) {
  return {
    source,
    options: {
      userArguments: pane.options ?? '',
      compilerOptions: { skipAsm: false, executorRequest: false },
      filters: {
        binaryObject: mode === 'binaryObject', binary: mode === 'binary', execute: false,
        intel: true, demangle: true, labels: true, directives: true, commentOnly: true, libraryCode: true, trim: false, debugCalls: false,
      },
      tools: [],
      libraries: pane.libs ?? [],
    },
    lang: pane.lang,
    allowStoreCodeDebug: false,
  };
}

// Compiles a pane, trying the output modes in order: the first that gives a listing with machine code wins; if
// none does, the assembly text. Resolves to {response, mode, failed}. A failed compilation is not tried again in
// another mode when the compiler is known to support that mode (it is an error in the code or the options).
export async function compilePane(pane, source, info, opts = {}) {
  let last = null;
  for (const mode of outputModes(info)) {
    const response = await ceRequest(`/api/compiler/${encodeURIComponent(pane.compiler)}/compile`, { ...opts, method: 'POST', body: compileRequest(pane, source, mode) });
    const ok = !!response && response.code === 0 && Array.isArray(response.asm);
    last = { response, mode, failed: !ok };
    if (ok && (mode === 'asm' || response.asm.some((l) => Array.isArray(l.opcodes) && l.opcodes.length))) return last;
    // a linked binary also fails for code without main(): then the assembly text
    if (!ok && ((info && mode === 'binaryObject') || mode === 'asm')) return last;
  }
  return last;
}

// The messages of a response (stderr), without terminal colours.
export function compilerMessages(response) {
  const lines = [...(response?.stderr ?? []), ...(response?.buildResult?.stderr ?? [])];
  return lines.map((l) => String(l?.text ?? l ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).filter((t) => t.trim() !== '');
}

// x86-64 or not: CE says "amd64" for x86-64 (and for 32-bit MSVC: see is32bit), "x86" for 32-bit targets.
export function targetProblem(info, pane, response) {
  const set = response?.instructionSet ?? info?.instructionSet;
  if (set && set !== 'amd64') return `this compiler produces ${set} code; wuica analyzes x86-64 only`;
  return null;
}

export function is32bit(info, pane) {
  return /(^|\s)-m(32|x32|16)\b/.test(pane?.options ?? '') || /^x86 /i.test(info?.name ?? '') || /\b(i[3-6]86|x86_32)\b/i.test(info?.name ?? '');
}

// ---- the listing ---------------------------------------------------------------------------------------------------
// The compiler's output as functions of instructions:
//   {binary, functions: [{name, items: [{kind: 'label', name} | {kind: 'instr', text, mnemonic, address, bytes,
//                                       line, target}]}]}
// binary: the instructions have their machine code (opcodes). target: the index (in items) of the instruction a
// direct jump goes to, if it is in the same function.

const LOCAL_LABEL = /^(?:\.L|L[A-Z_]|\$|\.\$|LBB|\.LBB|@)/;

function splitInstr(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  const words = t.split(' ');
  let i = 0;
  while (i < words.length - 1 && /^(?:lock|rep|repe|repz|repne|repnz|bnd|notrack|data16|cs|ds|es|ss|fs|gs|addr32|rex(?:\.\w+)?)$/.test(words[i])) i++;
  return { text: t, mnemonic: (words[i] ?? '').toLowerCase(), operands: words.slice(i + 1).join(' ') };
}

const JUMP = /^(?:j[a-z]{1,4}|loop[a-z]{0,2}|jrcxz|jecxz)$/;

export function parseListing(response) {
  const lines = Array.isArray(response?.asm) ? response.asm : [];
  const binary = lines.some((l) => Array.isArray(l?.opcodes) && l.opcodes.length);
  const functions = [];
  let fn = null;
  const start = (name) => { fn = { name, items: [] }; functions.push(fn); };
  for (const l of lines) {
    const text = String(l?.text ?? '');
    const hasBytes = Array.isArray(l?.opcodes) && l.opcodes.length > 0;
    const label = /^\s*([^\s].*?):\s*$/.exec(text);
    if (!hasBytes && label && !/^\s/.test(text)) {
      const name = label[1];
      if (binary || !LOCAL_LABEL.test(name)) start(name);
      else { if (!fn) start('(start)'); fn.items.push({ kind: 'label', name }); }
      continue;
    }
    if (binary && !hasBytes) continue; // relocations and other notes of the disassembly
    if (!binary && (!/^\s/.test(text) || text.trim() === '' || /^\s*\./.test(text) || /^\s*#/.test(text))) continue; // directives, comments
    if (!fn) start('(start)');
    const { text: t, mnemonic, operands } = splitInstr(text);
    const bytes = hasBytes ? l.opcodes.map((b) => parseInt(b, 16)) : null;
    if (bytes && bytes.some((b) => !(b >= 0 && b <= 255))) continue;
    fn.items.push({ kind: 'instr', text: t, mnemonic, operands, address: typeof l.address === 'number' ? l.address : null,
      bytes, line: l?.source?.line ?? null, file: l?.source?.file ?? null, target: null });
  }
  // direct jumps: resolve the target within the function
  for (const f of functions) {
    const byAddr = new Map(), byLabel = new Map();
    f.items.forEach((it, k) => {
      if (it.kind === 'instr' && it.address !== null) byAddr.set(it.address, k);
      if (it.kind === 'label') byLabel.set(it.name, k);
    });
    f.items.forEach((it) => {
      if (it.kind !== 'instr' || !JUMP.test(it.mnemonic)) return;
      let k;
      const m = /^(?:0x)?([0-9a-f]+)(?:\s+<[^>]*>)?$/i.exec(it.operands);
      if (binary && m) k = byAddr.get(parseInt(m[1], 16));
      else if (!binary) k = byLabel.get(it.operands.trim());
      if (k === undefined) return;
      while (k < f.items.length && f.items[k].kind !== 'instr') k++; // a label: the instruction after it
      if (k < f.items.length) it.target = k;
    });
  }
  return { binary, functions: functions.filter((f) => f.items.some((it) => it.kind === 'instr')) };
}

// The source line of each instruction of a range, in the main source file (a line of another file, or none: null).
export function rangeLines(fn, start, end) {
  return fn.items.slice(start, end + 1).filter((it) => it.kind === 'instr').map((it) => (it.file === null || it.file === undefined) && it.line > 0 ? it.line : null);
}

// The loops of a function: backward jumps, [{start, end, inner}] (item indices; the jump is `end`; inner: no other
// loop inside it). Innermost loops first, in the order of the code (a compiler puts the main loop before its
// remainder loop), then the outer ones.
export function findLoops(fn) {
  const loops = [];
  fn.items.forEach((it, k) => {
    if (it.kind !== 'instr' || it.target === null || it.target > k) return;
    // several jumps back to one instruction are one loop, to the last of them
    const same = loops.find((l) => l.start === it.target);
    if (same) same.end = Math.max(same.end, k); else loops.push({ start: it.target, end: k });
  });
  for (const l of loops) l.inner = !loops.some((o) => o !== l && o.start >= l.start && o.end <= l.end);
  return loops.sort((a, b) => Number(b.inner) - Number(a.inner) || a.start - b.start || a.end - b.end);
}

// The body of a function without a loop: without its prologue and epilogue (loop-find.js), as item indices {start,
// end}, or null.
export function bodyRange(fn) {
  const instrs = fn.items.flatMap((it, k) => (it.kind === 'instr' ? [{ line: k, body: it.text, mnemonic: it.mnemonic, kind: /^(?:rep[z]? )?ret[q]?\b/i.test(it.text) ? 'ret' : 'other' }] : []));
  const b = functionBody({ instrs });
  return b ? { start: b.begin, end: b.end } : null;
}

// The loops of a function as loop-find.js ranks them: {loops, ranked: [{inner, depth, begin, instructions, vector}],
// order: indices of the loops loop-find.js counts (no span with a ret in it) in its list order (the innermost first, the
// deepest of them first, then the code's)}
function rankLoops(fn) {
  const loops = findLoops(fn);
  // a span with a ret inside it is not a loop for loop-find.js (a jump back over a function's exit)
  const hasRet = (l) => fn.items.slice(l.start + 1, l.end).some((it) => it.kind === 'instr' && /^ret[lqw]?$/.test(it.mnemonic));
  const ranked = loops.map((l) => {
    let width = 0, count = 0, instructions = 0;
    for (const it of fn.items.slice(l.start, l.end + 1)) {
      if (it.kind !== 'instr') continue;
      instructions++;
      const w = vectorWidth(it.mnemonic, it.operands.replace(/\s*#.*$/, '')); // (not a comment's registers: "# ymm3 = mem[0],...")
      if (w) { count++; width = Math.max(width, w); }
    }
    // (its depth: the loops around it; not a span with a ret, which is no loop: loop-find.js leaves those out)
    const depth = 1 + loops.filter((o) => o !== l && o.start <= l.start && o.end >= l.end && !hasRet(o)).length;
    return { inner: l.inner, depth, begin: l.start, end: l.end, instructions, vector: { width, count } };
  });
  // the remainder loops, as loop-find.js finds them (isRemainder), on the function's items (item indices as lines)
  const text = { instrs: fn.items.flatMap((it, k) => (it.kind === 'instr' ? [{ line: k, mnemonic: it.mnemonic, operands: it.operands.replace(/\s*#.*$/, ''), body: it.text,
    kind: JCC.test(it.mnemonic) ? 'jcc' : JMP.test(it.mnemonic) ? 'jmp' : /^call/i.test(it.mnemonic) ? 'call' : /^ret/i.test(it.mnemonic) ? 'ret' : 'other' }] : [])) };
  for (const r of ranked) r.remainderOf = ranked.filter((a) => a !== r && isRemainder(text, a, r)).map((a) => a.begin);
  const order = ranked.map((r, k) => k).filter((k) => !hasRet(loops[k]))
    .sort((a, b) => Number(ranked[b].inner) - Number(ranked[a].inner) || ranked[b].depth - ranked[a].depth || a - b);
  return { loops, ranked, order };
}

// The loop of a function to preselect, by the default of the page's loop finder (loop-find.js, defaultLoop: among the
// function's deepest innermost loops, the widest vector registers, then the most vector instructions, then the most
// instructions, then the first), or null.
export function defaultLoopOf(fn) {
  const { loops, ranked, order } = rankLoops(fn);
  const k = defaultLoop(order.map((i) => ranked[i]));
  return k < 0 ? null : loops[order[k]];
}

// What to preselect, as a paste of the whole listing would analyze it (loop-find.js): the function of the first loop of
// the list (the first function with an innermost loop at the greatest depth of all), and its default loop
// (defaultLoopOf); without loops, the first function's body without its prologue and epilogue, or the whole function.
// {fn, start, end, loop}
export function defaultSelection(listing) {
  let best = -1, key = null;
  listing.functions.forEach((f, k) => {
    const { ranked, order } = rankLoops(f);
    if (!order.length) return;
    const top = ranked[order[0]];
    if (key === null || Number(top.inner) > Number(key.inner) || (top.inner === key.inner && top.depth > key.depth)) { best = k; key = top; }
  });
  if (best >= 0) {
    const l = /** @type {any} */ (defaultLoopOf(listing.functions[best]));
    return { fn: best, start: l.start, end: l.end, loop: true };
  }
  const fn = listing.functions[0];
  if (!fn) return null;
  const body = bodyRange(fn);
  if (body) return { fn: 0, start: body.start, end: body.end, loop: false };
  const first = fn.items.findIndex((it) => it.kind === 'instr');
  return { fn: 0, start: first, end: fn.items.length - 1, loop: false };
}

const hex2 = (b) => (b < 16 ? '0' : '') + b.toString(16);

// The selected items (start..end of a function) as text for the page's input:
//   binary output: {mode: 'hex', text: an objdump-like listing}: the exact bytes the compiler produced
//   text output:   {mode: 'asm', syntax: 'intel', text: the assembly, with the labels in the range}
// plus {instructions, bytes, startAddress, endsInBranch}
export function extractRange(fn, start, end, { binary }) {
  const items = fn.items.slice(start, end + 1);
  const instrs = items.filter((it) => it.kind === 'instr');
  const last = instrs.at(-1);
  const info = { instructions: instrs.length, endsInBranch: !!last && JUMP.test(last.mnemonic) };
  if (binary) {
    const width = Math.max(0, ...instrs.map((it) => it.bytes.length * 3 - 1));
    const aw = Math.max(4, ...instrs.map((it) => (it.address ?? 0).toString(16).length));
    const text = instrs.map((it) => `${(it.address ?? 0).toString(16).padStart(aw)}:  ${it.bytes.map(hex2).join(' ').padEnd(width)}    ${it.text}`).join('\n') + '\n';
    return { ...info, mode: 'hex', text, bytes: instrs.reduce((n, it) => n + it.bytes.length, 0), startAddress: instrs[0]?.address ?? null };
  }
  // a label right before the range belongs to it (the loop's own label)
  let s = start;
  while (s > 0 && fn.items[s - 1].kind === 'label') s--;
  // Local labels (.L...) that the range uses but does not contain would be undefined temporary symbols, which the
  // assembler rejects: a constant's (.LC0) gets an ordinary name (an external symbol); a jump's (an exit of the loop)
  // stays: the analysis takes it as not taken, a short jump to the end of the code (loop-find.js).
  const defined = new Set(fn.items.slice(s, end + 1).filter((it) => it.kind === 'label').map((it) => it.name));
  const outside = (t) => t.replace(/(^|[^\w.$@])(\.L[\w.$@]*)/g, (m, pre, name) => (defined.has(name) ? m : `${pre}outside${name.slice(1)}`));
  const text = fn.items.slice(s, end + 1).map((it) => (it.kind === 'label' ? `${it.name}:` : `  ${JUMP.test(it.mnemonic) ? gasToLlvmIntel(it.text) : outside(gasToLlvmIntel(it.text))}`)).join('\n') + '\n';
  return { ...info, mode: 'asm', syntax: 'intel', text, bytes: null, startAddress: null };
}

// GNU as's Intel syntax (GCC's output) where LLVM's assembler reads it differently: "OFFSET FLAT:sym" and
// "movsx r64, r32" (LLVM: movsxd).
export function gasToLlvmIntel(text) {
  return text
    .replace(/\bOFFSET FLAT:/gi, 'offset ')
    .replace(/^movsx (r\w+), (e[a-z]{2}|r\d+d)$/i, 'movsxd $1, $2');
}

// An assembly editor without a compiler pane: its source as it is (assembly mode; AT&T if it uses %registers).
export function sourceAsAssembly(editor) {
  const text = String(editor?.source ?? '');
  return { mode: 'asm', syntax: /%[re]?[a-z]{1,2}x?\b|%xmm|%ymm|%zmm|%r\d/.test(text) ? 'att' : 'intel', text: text.endsWith('\n') ? text : text + '\n' };
}
