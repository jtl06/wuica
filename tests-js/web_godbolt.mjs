// Tests of the Compiler Explorer import (web/js/godbolt.js): link formats, the API client and the extraction of
// a block from the compiler's output. No network: the answers of godbolt.org were recorded with
// tests-js/record_godbolt.mjs into tests-js/fixtures/godbolt/.  Usage: node tests-js/web_godbolt.mjs
import fs from 'node:fs';
import {
  risonDecode, unrisonify, lzDecompressFromBase64, unminifyLayout, decodeFragment, parseCeLink, isCeLink, fromClientState,
  resolveShortLink, compilersOf, compilePane, compileRequest, outputModes, ceRequest, CeError, compilerMessages,
  parseListing, findLoops, defaultSelection, defaultLoopOf, bodyRange, extractRange, sourceAsAssembly, targetProblem, is32bit, CE_ORIGIN, gasToLlvmIntel,
} from '../web/js/godbolt.js';
import { WasmAssembler } from '../web/js/assembler.js';
import { withRegions } from '../web/js/asm-regions.js';
import { parseHexInput, toHex } from '../web/js/hex-input.js';
import { preparePaste, scan, leadingSemicolons, normalizeText } from '../web/js/loop-find.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
async function throws(f, re, what) {
  try { await f(); check(false, what, 'no error'); } catch (e) { check(re.test(e.message), what, e.message); }
}
const dir = new URL('./fixtures/godbolt/', import.meta.url);
const fx = (name) => JSON.parse(fs.readFileSync(new URL(name, dir), 'utf8'));
const links = fx('links.json');
const j = (x) => JSON.stringify(x);

// A fetch that answers from the recorded responses and records what was asked.
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, init });
    for (const [re, answer] of routes) {
      if (re.test(url)) {
        const a = typeof answer === 'function' ? answer(url, init) : answer;
        if (a instanceof Error) throw a;
        return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status ?? 200, headers: a.headers ?? { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
  f.calls = calls;
  return f;
}

// --- rison, lz-string, GoldenLayout ------------------------------------------------------------------------------------
{
  check(j(risonDecode("(a:1,b:!(x,'y z',!t,!f,!n),c:'it!'s!!',d:-1.5e2,e:(),f:!(),g:'')")) === j({ a: 1, b: ['x', 'y z', true, false, null], c: "it's!", d: -150, e: {}, f: [], g: '' }), 'rison: values');
  check(j(unrisonify("a:'b+c%2Bd',e:%27f%27")) === j({ a: 'b c+d', e: 'f' }), 'rison: the URI encoding of a fragment ("+" is a space)');
  for (const bad of ['(a:1', "(a:'x)", '(a:1)x', '(:1)', '!x']) {
    let ok = false; try { risonDecode(bad); } catch { ok = true; }
    check(ok, `rison: rejects ${bad}`);
  }
  check(lzDecompressFromBase64('') === '' && lzDecompressFromBase64('BYUwNmD2Q') !== null, 'lz-string: empty input');
  check(j(unminifyLayout({ g: [{ h: 'compiler', l: '5', n: '0', t: '1', i: { j: 1, pos: { ___x: 0 } } }], version: 4 }))
    === j({ content: [{ componentName: 'compiler', type: 'component', isClosable: true, reorderEnabled: false, componentState: { id: 1, pos: { x: 0 } } }], version: 4 }), 'GoldenLayout: unminified keys and values');
}

// --- full links ---------------------------------------------------------------------------------------------------------
{
  const r = parseCeLink(links.countSetBits);
  const st = r.state;
  check(r.kind === 'state' && st.editors.length === 1 && st.editors[0].id === 1 && st.editors[0].lang === 'c++', 'full link (#g:): the editor', j(st.editors));
  check(st.editors[0].source.startsWith('int countSetBits(unsigned a)\n{\n') && st.editors[0].source.includes('while (a != 0)') && st.editors[0].source.includes('a &= (a - 1);'), 'full link: the source (with "+", "!!" and %-escapes)', st.editors[0].source);
  const c = st.compilers;
  check(c.length === 1 && c[0].compiler === 'g82' && c[0].editorId === 1 && c[0].lang === 'c++' && c[0].options === '-O2 -march=haswell -Wall -Wextra -pedantic' && c[0].n === 1, 'full link: the compiler pane (the graph pane is not one)', j(c));
  check(c[0].filters.intel === true && c[0].filters.binary === false && c[0].title === 'x86-64 gcc 8.2 (Editor #1, Compiler #1) C++', 'full link: filters ("0" is true) and title', j(c[0]));

  const two = parseCeLink(links.rustAndCpp).state;
  check(two.editors.map((e) => `${e.id}:${e.lang}`).join() === '1:rust,2:c++' && two.compilers.map((p) => `${p.compiler}<-${p.editorId}:${p.lang}:${p.options}`).join() === 'r1330<-1:rust:-O,clang800<-2:c++:-O1', 'full link with two editors and two compilers', j(two.compilers));

  const z = parseCeLink(links.itoa).state;
  check(links.itoa.startsWith('https://godbolt.org/#z:') && z.compilers.length === 1 && z.compilers[0].compiler === 'gsnapshot' && z.compilers[0].options === '-std=c++20 -O3 -pthread', 'compressed link (#z:): the compiler pane', j(z.compilers));
  check(j(z.compilers[0].libs) === j([{ id: 'benchmark', version: '161' }, { id: 'fmt', version: '811' }]) && z.editors[0].source.includes('jeaiii_to_text.h'), 'compressed link: libraries and source', j(z.compilers[0].libs));

  // the same link from other hosts, without the scheme, from the embedded view, with a quoted "'"
  const base = links.countSetBits.slice('https://godbolt.org/'.length);
  for (const v of [`https://gcc.godbolt.org/${base}`, `https://compiler-explorer.com/${base}`, `godbolt.org/${base}`, `https://godbolt.org/e${base}`, links.countSetBits.replace(/'/g, '%27'), `https://godbolt.org/?readOnly=true${base}`]) {
    check(j(parseCeLink(v).state) === j(st), `full link variant ${v.slice(0, 40)}`);
  }
  // legacy (version 3) and JSON states
  const legacy = encodeURIComponent(JSON.stringify({ version: 3, compilers: [{ compiler: 'g82', source: 'int f(int x) { return x * 3; }', options: '-O2' }], filterAsm: { intel: true } }));
  const lg = parseCeLink(`https://godbolt.org/#${legacy}`).state;
  check(lg.compilers[0].compiler === 'g82' && lg.compilers[0].options === '-O2' && lg.editors[0].source.includes('x * 3') && lg.compilers[0].filters.intel === true, 'legacy state (version 3, JSON)', j(lg));
  // the client-state link format
  const cs = Buffer.from(JSON.stringify(fx('shortlinkinfo-G38YP7eW4.json'))).toString('base64');
  const csSt = parseCeLink(`https://godbolt.org/clientstate/${cs}`).state;
  check(csSt.compilers[0].compiler === 'g132' && csSt.compilers[0].options === '-fvisibility=hidden' && csSt.editors[0].source.includes('square'), '/clientstate/ link', j(csSt.compilers));

  await throws(() => parseCeLink('https://example.com/#g:!()'), /not a Compiler Explorer link/, 'another host is refused');
  await throws(() => parseCeLink('https://godbolt.org/'), /no code in it/, 'a link without a state');
  await throws(() => parseCeLink(links.itoa.slice(0, 200)), /corrupt|could not read/, 'a truncated compressed link');
  await throws(() => parseCeLink(''), /enter a Compiler Explorer link/, 'empty');
  await throws(() => parseCeLink('https://godbolt.org/#g:!((g:!((h:codeEditor'), /could not read the link/, 'a cut-off link');

  check([links.short, links.countSetBits, links.itoa, 'godbolt.org/z/abc', 'https://godbolt.org/z/G38YP7eW4/', `https://compiler-explorer.com/clientstate/${cs}`].every(isCeLink), 'isCeLink: links');
  check(![ '48 01 d8', 'https://godbolt.org/', 'https://example.com/z/abc', `see ${links.short}`, 'loop:\n  jmp loop', 'https://godbolt.org.evil.com/z/abc'].some(isCeLink), 'isCeLink: not links');
}

// --- short links and the API ------------------------------------------------------------------------------------------
{
  const r = parseCeLink(links.short);
  check(r.kind === 'short' && r.id === 'G38YP7eW4', 'short link: the id', j(r));
  const f = fakeFetch([[/\/api\/shortlinkinfo\/G38YP7eW4$/, { body: fx('shortlinkinfo-G38YP7eW4.json') }]]);
  const st = await resolveShortLink(r.id, { fetch: f });
  check(f.calls.length === 1 && f.calls[0].url === `${CE_ORIGIN}/api/shortlinkinfo/G38YP7eW4` && f.calls[0].init.credentials === 'omit' && f.calls[0].init.headers.Accept === 'application/json', 'short link: one GET to godbolt.org/api/shortlinkinfo, no credentials', j(f.calls[0].url));
  check(st.compilers.length === 1 && st.compilers[0].compiler === 'g132' && st.compilers[0].lang === 'c++' && st.editors[0].source.includes('int square(int num)'), 'short link: the state', j(st));
  check(j(fromClientState({ sessions: [{ id: 2, language: 'c', source: 'x', compilers: [{ id: 'cg132', options: '-O3', libs: [{ name: 'lib', ver: '1' }] }] }], trees: [{}] })) === j({ editors: [{ id: 2, lang: 'c', source: 'x' }], compilers: [{ compiler: 'cg132', editorId: 2, lang: 'c', options: '-O3', filters: {}, libs: [{ id: 'lib', version: '1' }], title: '', n: 1 }], notes: ['a multi-file project (CMake tree): not supported'] }), 'client state: sessions, libraries, trees');

  // errors
  const opt = (routes) => ({ fetch: fakeFetch(routes) });
  await throws(() => resolveShortLink('nope', opt([])), /not found on Compiler Explorer/, 'short link: 404');
  await throws(() => ceRequest('/api/x', opt([[/./, { status: 429, body: '{}', headers: { 'retry-after': '30' } }]])), /limiting the rate.*in 30 s/, 'rate limit (429) with Retry-After');
  await throws(() => ceRequest('/api/x', opt([[/./, { status: 429, body: '{}' }]])), /limiting the rate.*in a minute/, 'rate limit without Retry-After');
  await throws(() => ceRequest('/api/x', opt([[/./, new TypeError('Failed to fetch')]])), /could not reach godbolt.org/, 'network error / CORS');
  await throws(() => ceRequest('/api/x', opt([[/./, { status: 502, body: 'bad gateway' }]])), /HTTP 502/, 'server error');
  await throws(() => ceRequest('/api/x', opt([[/./, { body: '<html>', headers: { 'content-type': 'text/html' } }]])), /not JSON/, 'not JSON');
  try { await ceRequest('/api/x', opt([[/./, new TypeError('x')]])); } catch (e) { check(e instanceof CeError && e.network, 'a network error is marked'); }
  const ctrl = new AbortController();
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
  const p = ceRequest('/api/x', { fetch: hang, signal: ctrl.signal });
  ctrl.abort();
  await throws(() => p, /cancelled/, 'a request can be cancelled');
  await throws(() => ceRequest('/api/x', { fetch: hang, timeoutMs: 20 }), /did not answer in time/, 'a request times out');

  const infos = await compilersOf('c++', { fetch: fakeFetch([[/\/api\/compilers\/c%2B%2B\?fields=/, { body: fx('compilers-c++.json') }]]) });
  check(infos.get('g82')?.instructionSet === 'amd64' && infos.get('g82').supportsBinaryObject === true && infos.get('g82').name === 'x86-64 gcc 8.2', 'the compiler list', j(infos.get('g82')));
  const arm = [...infos.values()].find((c) => c.instructionSet === 'aarch64');
  check(!!arm && /aarch64 code; wuica analyzes x86-64 only/.test(targetProblem(arm)) && targetProblem(infos.get('g82')) === null && /produces aarch64/.test(targetProblem(null, null, { instructionSet: 'aarch64' })), 'other targets are refused with a reason');
  check(is32bit(infos.get('g82'), { options: '-O2 -m32' }) && is32bit(infos.get('cl19_2015_u3_32_exwine'), { options: '' }) && !is32bit(infos.get('g82'), { options: '-O2 -march=haswell' }), '32-bit code is recognized (-m32, "x86 msvc")');
  check(j(outputModes(infos.get('g82'))) === j(['binaryObject', 'binary', 'asm']) && j(outputModes({ supportsBinary: true })) === j(['binary', 'asm']) && j(outputModes(null)) === j(['binaryObject', 'binary', 'asm']), 'output modes');

  // compiling: the request is the one recorded against the real API
  const recorded = fx('requests.json');
  const st1 = parseCeLink(links.countSetBits).state;
  const fc = fakeFetch([[/\/api\/compiler\/g82\/compile$/, { body: fx('compile-g82-countSetBits.json') }]]);
  const res = await compilePane(st1.compilers[0], st1.editors[0].source, infos.get('g82'), { fetch: fc });
  check(fc.calls.length === 1 && fc.calls[0].method === 'POST' && j(fc.calls[0].body) === j(recorded[0].body) && recorded[0].status === 200, 'compile: the request (Intel syntax, object-file machine code, no execution, no storing of the code)', j(fc.calls[0].body));
  check(fc.calls[0].body.allowStoreCodeDebug === false && fc.calls[0].body.options.filters.intel === true && fc.calls[0].body.options.filters.binaryObject === true && fc.calls[0].body.options.filters.execute === false, 'compile: privacy and output filters');
  check(res.mode === 'binaryObject' && !res.failed, 'compile: machine code', j(res.mode));
  check(j(compileRequest({ options: '', libs: [{ id: 'fmt', version: '811' }], lang: 'c++' }, 's', 'asm').options.libraries) === j([{ id: 'fmt', version: '811' }]), 'compile: libraries are passed on');
  // a compiler of unknown capabilities whose first answer has no machine code: tried again as a linked binary
  const noBytes = { ...fx('compile-g82-countSetBits.json'), asm: fx('compile-g82-countSetBits.json').asm.map(({ opcodes, ...l }) => l) };
  let n = 0;
  const fb = fakeFetch([[/compile$/, () => ({ body: n++ === 0 ? noBytes : fx('compile-g82-countSetBits.json') })]]);
  const res2 = await compilePane(st1.compilers[0], st1.editors[0].source, null, { fetch: fb });
  check(fb.calls.length === 2 && fb.calls[1].body.options.filters.binary === true && res2.mode === 'binary', 'compile: falls back to the linked binary', j(fb.calls.map((c) => c.body.options.filters)));
  // a compiler that only links (no object file): code without main() fails to link, so the assembly text is used
  const linkErr = { code: 1, asm: [], stderr: [{ text: "ld: (.text+0x1b): undefined reference to `main'" }] };
  const asmText = fx('compile-clang1810-text.json').response;
  const fl = fakeFetch([[/compile$/, (url, init) => ({ body: JSON.parse(init.body).options.filters.binary ? linkErr : asmText })]]);
  const res4 = await compilePane({ compiler: 'gfortran', lang: 'fortran', options: '-O2', libs: [] }, 'x', { supportsBinary: true, supportsBinaryObject: false }, { fetch: fl });
  check(fl.calls.length === 2 && res4.mode === 'asm' && !res4.failed, 'compile: a failed link falls back to the assembly text', j(fl.calls.map((c) => c.body.options.filters.binary)));
  // a compilation error: not retried, messages without terminal colours
  const fe = fakeFetch([[/compile$/, { body: fx('compile-g142-error.json') }]]);
  const res3 = await compilePane({ compiler: 'g142', lang: 'c++', options: '-O2', libs: [] }, 'int f( {', infos.get('g142'), { fetch: fe });
  const msgs = compilerMessages(res3.response);
  check(res3.failed && fe.calls.length === 1 && /<source>:1:9: error: expected primary-expression/.test(msgs[0]) && !msgs.join('').includes('\x1b'), 'compile: an error is reported once, without colours', j(msgs.slice(0, 2)));
}

// --- the listing: functions, loops, the block ---------------------------------------------------------------------------------
{
  const bytesOf = (fn, s, e) => fn.items.slice(s, e + 1).filter((it) => it.kind === 'instr').map((it) => toHex(it.bytes)).join('');
  // gcc -O2 -march=haswell: one function, one loop (inc, blsr, jne)
  const L = parseListing(fx('compile-g82-countSetBits.json'));
  check(L.binary && L.functions.length === 1 && L.functions[0].name === 'countSetBits(unsigned int)', 'listing: functions', j(L.functions.map((f) => f.name)));
  const fn = L.functions[0];
  const loops = findLoops(fn);
  check(loops.length === 1 && loops[0].inner && fn.items[loops[0].start].text === 'inc eax' && fn.items[loops[0].end].text.startsWith('jne 10 <'), 'listing: the loop (a backward jump; targets are hex addresses)', j(loops));
  const je = fn.items.find((it) => it.mnemonic === 'je');
  check(je.target !== null && fn.items[je.target].address === 0x20, 'listing: a forward jump is resolved too');
  const d = defaultSelection(L);
  check(d.fn === 0 && d.start === loops[0].start && d.end === loops[0].end && d.loop, 'the innermost loop is preselected');
  // the loop preselected is the page's default (loop-find.js, defaultLoop): gcc's scale_add has a scalar peel loop, the
  // AVX2 loop and a scalar cleanup loop (the first, the peel loop, was preselected before)
  const sa = parseListing({ asm: fs.readFileSync(new URL('../tests-js/fixtures/loop-find/default/gcc-scale_add.O2.haswell.s', import.meta.url), 'utf8').split('\n').map((text) => ({ text })) });
  const saFn = sa.functions.find((f) => f.name === 'scale_add'), saLoops = findLoops(saFn), saDefault = defaultLoopOf(saFn);
  const saText = (l) => saFn.items.slice(l.start, l.end + 1).filter((it) => it.kind === 'instr').map((it) => it.mnemonic);
  check(saDefault.start === saLoops[1].start && saDefault.end === saLoops[1].end && saText(saDefault).includes('vfmadd213ps') && saText(saLoops[0]).includes('vfmadd213ss') && defaultSelection(sa).start === saDefault.start,
    'the preselected loop: the vector loop, not the peel loop first in the code', j(saLoops.map(saText)));
  // the import preselects what a paste of the same listing analyzes (loop-find.js): the function of the first deepest loop,
  // its default loop. The texts as Compiler Explorer's text output has them (no comments); several functions among them
  for (const f of ['dogfood/multi.s', 'profiles/clang23-sum.s', 'loop-find/default/clang-saxpy.O3.haswell.s', 'loop-find/default/gcc-scale_add.O2.haswell.s', 'cli/count_u8.hsw.s']) {
    const text = fs.readFileSync(new URL(`../tests-js/fixtures/${f}`, import.meta.url), 'utf8');
    const p = preparePaste(text);
    const s0 = scan(leadingSemicolons(normalizeText(text)));
    const paste = s0.instrs.filter((x) => x.line >= p.pick.begin && x.line <= p.pick.end).map((x) => x.mnemonic);
    const ce = parseListing({ asm: text.split('\n').map((t) => ({ text: t.replace(/\s*#.*$/, '') })) });
    const d = defaultSelection(ce);
    const picked = ce.functions[d.fn].items.slice(d.start, d.end + 1).filter((it) => it.kind === 'instr').map((it) => it.mnemonic);
    check(d.loop && j(picked) === j(paste) && ce.functions[d.fn].name === p.loops[p.choice].function, `the import and a paste agree: ${f}`, j([ce.functions[d.fn].name, picked.length, p.loops[p.choice].label, paste.length]));
  }
  // a nest in the second function: both take it (the deepest loop), not the first function's loop
  const nest = 'a:\n  mov ecx, 9\n.L1:\n  add rax, 1\n  dec rcx\n  jnz .L1\n  ret\nb:\n.L2:\n  mov ecx, 9\n.L3:\n  vaddps ymm0, ymm0, ymm1\n  dec rcx\n  jnz .L3\n  dec rdx\n  jnz .L2\n  ret\n';
  const nd = defaultSelection(parseListing({ asm: nest.split('\n').map((text) => ({ text })) }));
  const np = preparePaste(nest);
  check(nd.fn === 1 && np.loops[np.choice].label === '.L3' && np.loops[np.choice].function === 'b', 'the import and a paste: the function of the deepest loop', j([nd, np.loops[np.choice]]));
  const ext = extractRange(fn, d.start, d.end, L);
  const parsed = parseHexInput(ext.text);
  check(ext.mode === 'hex' && ext.instructions === 3 && ext.bytes === 9 && ext.endsInBranch && ext.startAddress === 16, 'the block: hex, 3 instructions, 9 bytes, at 0x10', j(ext));
  check(parsed.ok && parsed.format === 'listing' && parsed.hex === 'ffc0c4e240f3cf75f7' && parsed.hex === bytesOf(fn, d.start, d.end), 'the block reads back as exactly the compiler\'s bytes', ext.text);
  check(ext.text.split('\n')[0] === '  10:  ff c0             inc eax', 'the block is a readable listing', ext.text);

  // two functions with loops; the second one is preselected only if the first has none
  const L2 = parseListing(fx('compile-g142-loops.json').response);
  check(L2.functions.map((f) => f.name).join('|') === 'sum(int const*, int)|scale(float*, int, float)', 'listing: two functions', j(L2.functions.map((f) => f.name)));
  const d2 = defaultSelection(L2);
  const e2 = extractRange(L2.functions[d2.fn], d2.start, d2.end, L2);
  check(d2.fn === 0 && e2.instructions === 6 && /add rdi,0x4/.test(e2.text) && /jne/.test(e2.text.trim().split('\n').at(-1)) && parseHexInput(e2.text).hex === bytesOf(L2.functions[0], d2.start, d2.end), 'the loop of sum()', e2.text);
  const sc = findLoops(L2.functions[1]);
  check(sc.length >= 1 && sc[0].inner && L2.functions[1].items.slice(sc[0].start, sc[0].end + 1).some((it) => it.mnemonic === 'mulps'), 'the loop of scale()', j(sc));
  const whole = extractRange(L2.functions[1], 0, L2.functions[1].items.length - 1, L2);
  check(!whole.endsInBranch && whole.text.trim().split('\n').at(-1).endsWith('ret'), 'a whole function ends in ret: analyzed unrolled');

  // no loops: the first function's body (without its prologue and epilogue)
  const L3 = parseListing(fx('compile-g132-short.json'));
  const d3 = defaultSelection(L3);
  const f3 = L3.functions[0].items;
  check(L3.functions.map((f) => f.name).join('|') === 'square(int)|main' && !d3.loop && d3.fn === 0 && d3.end < f3.length - 1
    && f3.slice(d3.start, d3.end + 1).every((it) => !/^(push|pop|ret|leave)/.test(it.mnemonic)) && /^ret/.test(f3.at(-1).mnemonic), 'no loop: the first function\'s body', j([d3, f3.map((it) => it.text)]));
  const q = { items: ['endbr64', 'push rbp', 'mov rbp, rsp', 'movss DWORD PTR [rbp-20], xmm0', 'mulss xmm0, xmm1', 'pop rbp', 'ret'].map((t) => ({ kind: 'instr', text: t, mnemonic: t.split(' ')[0] })) };
  const qb = bodyRange(q);
  check(qb && qb.start === 3 && qb.end === 4, 'a body without the prologue (endbr64, push rbp, mov rbp, rsp) and the epilogue (pop, ret)', j(qb));

  // the assembly text of a compiler without machine code: labels, loops by label, the block as assembly
  const T = parseListing(fx('compile-clang1810-text.json').response);
  const tl = findLoops(T.functions[0]);
  check(!T.binary && T.functions.length === 2 && tl.length === 2 && tl.every((l) => l.inner), 'text listing: functions and loops (local labels do not start functions)', j(tl));
  const dt = defaultSelection(T);
  const et = extractRange(T.functions[dt.fn], dt.start, dt.end, T);
  const tlines = et.text.trim().split('\n');
  check(et.mode === 'asm' && et.syntax === 'intel' && /^\.LBB0_\d+:$/.test(tlines[0]) && tlines.at(-1) === `  jne ${tlines[0].slice(0, -1)}` && tlines.some((l) => /paddd/.test(l)), 'text listing: the first (vectorized main) loop, with its label, as assembly', et.text);

  // the assembly text goes through the page's assembler (LLVM): also a range with a jump out of it
  check(gasToLlvmIntel('mov eax, OFFSET FLAT:.LC0') === 'mov eax, offset .LC0' && gasToLlvmIntel('movsx rsi, esi') === 'movsxd rsi, esi' && gasToLlvmIntel('movsx eax, al') === 'movsx eax, al', 'GNU as Intel syntax for LLVM');
  const asmWasm = new URL('../assembler/dist/wuica_asm.wasm', import.meta.url);
  if (fs.existsSync(asmWasm)) {
    // as the page analyzes them: exits taken as not taken (loop-find.js)
    const wa = withRegions(await WasmAssembler.create(fs.readFileSync(asmWasm)));
    const a = { assemble: (t, s) => wa.assemble(t, s, { loop: 'auto' }) };
    const results = [];
    for (const f of T.functions) {
      const ranges = [[0, f.items.length - 1], ...findLoops(f).map((l) => [l.start, l.end])];
      const firstJump = f.items.findIndex((it) => it.kind === 'instr' && /^j/.test(it.mnemonic) && it.target > 0);
      if (firstJump > 0) ranges.push([0, firstJump]); // ends in a jump to a label outside the range
      for (const [s, e] of ranges) {
        const x = extractRange(f, s, e, T);
        const r = await a.assemble(x.text, 'intel');
        results.push(r.ok && r.bytes.length > 0 ? 'ok' : `${f.name} ${s}-${e}: ${j(r.diagnostics)} ${x.text}`);
      }
    }
    check(results.length >= 6 && results.every((x) => x === 'ok'), 'text output: whole functions, loops and ranges with exits assemble', results.filter((x) => x !== 'ok').join('\n'));
    const gas = await a.assemble(extractRange({ items: [{ kind: 'instr', text: 'mov eax, OFFSET FLAT:.LC0', mnemonic: 'mov' }, { kind: 'instr', text: 'movsx rsi, esi', mnemonic: 'movsx' }, { kind: 'instr', text: 'jne .L3', mnemonic: 'jne', target: null }] }, 0, 2, { binary: false }).text, 'intel');
    check(gas.ok, 'GCC\'s Intel syntax with outside labels assembles', j(gas.diagnostics));
  }

  // NASM, through the assembler pane: the loop label is local, so the target is the function
  const N = parseListing(fx('compile-nasm-loop.json').response);
  const dn = defaultSelection(N);
  const en = extractRange(N.functions[0], dn.start, dn.end, N);
  check(N.functions[0].name === 'f' && dn.loop && parseHexInput(en.text).hex === '4883c001c5f458c248ffc975f3', 'an assembler pane (NASM): its machine code', en.text);

  // assembly source without a compiler
  check(sourceAsAssembly({ source: 'loop:\n  addq $1, %rax\n  jnz loop' }).syntax === 'att' && sourceAsAssembly({ source: 'add rax, 1' }).syntax === 'intel' && sourceAsAssembly({ source: 'x' }).text === 'x\n', 'an assembly source: the syntax is guessed');
}

console.log(`${count} godbolt checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
