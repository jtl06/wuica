// Records Compiler Explorer's answers for the tests (tests-js/fixtures/godbolt/), through the page's own client
// (web/js/godbolt.js). This talks to https://godbolt.org: run it by hand, not in the automated tests.
//
//   node tests-js/record_godbolt.mjs
//
// It is also the manual check against the real API: it resolves the short link, decodes the full links,
// fetches the compiler list and compiles, and prints what it got.
import fs from 'node:fs';
import {
  parseCeLink, resolveShortLink, compilersOf, compilePane, parseListing, findLoops, ceRequest,
} from '../web/js/godbolt.js';

const dir = new URL('./fixtures/godbolt/', import.meta.url);
const links = JSON.parse(fs.readFileSync(new URL('links.json', dir), 'utf8'));
const save = (name, value) => { fs.writeFileSync(new URL(name, dir), JSON.stringify(value, null, 1) + '\n'); console.log('wrote', name); };

// what the page asked for, recorded with the answers (the tests check that the page asks the same)
const recorded = [];
const recFetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  recorded.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null, status: res.status });
  return new Response(text, { status: res.status, headers: res.headers });
};

// 1. the short link
const shortId = parseCeLink(links.short).id;
save(`shortlinkinfo-${shortId}.json`, await ceRequest(`/api/shortlinkinfo/${shortId}`));
const shortState = await resolveShortLink(shortId);
console.log('short link:', JSON.stringify(shortState.compilers));

// 2. the compiler list of C++ (cut down to the compilers the tests use, plus some others)
const all = await ceRequest('/api/compilers/c++?fields=id,name,lang,instructionSet,supportsBinary,supportsBinaryObject');
const keep = new Set(['g82', 'g132', 'g142', 'clang800', 'clang1810', 'gsnapshot', 'cl19_2015_u3_32_exwine', 'arm64g1320', 'armv8-clang1810']);
save('compilers-c++.json', all.filter((c) => keep.has(c.id)).concat(all.filter((c) => c.instructionSet === 'aarch64').slice(0, 1)));
const infos = await compilersOf('c++');

// 3. compilations, as the page makes them
const countSetBits = parseCeLink(links.countSetBits).state;
const pane = countSetBits.compilers[0];
const r1 = await compilePane(pane, countSetBits.editors[0].source, infos.get(pane.compiler), { fetch: recFetch });
save('compile-g82-countSetBits.json', r1.response);
console.log('countSetBits:', r1.mode, parseListing(r1.response).functions.map((f) => [f.name, findLoops(f)]));

const p2 = shortState.compilers[0];
const r2 = await compilePane(p2, shortState.editors[0].source, infos.get(p2.compiler), { fetch: recFetch });
save(`compile-${p2.compiler}-short.json`, r2.response);
console.log('short link:', r2.mode, parseListing(r2.response).functions.map((f) => f.name));

// two functions with loops (our own source), and the assembly text of a compiler (no machine code)
const loops = { compiler: 'g142', editorId: 1, lang: 'c++', options: '-O2', libs: [] };
const loopsSource = 'int sum(const int* a, int n) {\n  int s = 0;\n  for (int i = 0; i < n; i++) s += a[i] * 3;\n  return s;\n}\n\nvoid scale(float* x, int n, float k) {\n  for (int i = 0; i < n; i++)\n    for (int j = 0; j < 4; j++) x[i*4+j] *= k;\n}\n';
const r3 = await compilePane(loops, loopsSource, infos.get('g142'), { fetch: recFetch });
save('compile-g142-loops.json', { source: loopsSource, response: r3.response });
const r4 = await compilePane({ ...loops, compiler: 'clang1810' }, loopsSource, { supportsBinary: false, supportsBinaryObject: false }, { fetch: recFetch });
save('compile-clang1810-text.json', { source: loopsSource, response: r4.response });
console.log('text output:', r4.mode, parseListing(r4.response).functions.map((f) => [f.name, findLoops(f)]));

// an assembler pane (NASM): machine code of a linked object
const nasm = { compiler: 'nasm21601', editorId: 1, lang: 'assembly', options: '', libs: [] };
const nasmSource = 'section .text\nglobal f\nf:\n.loop:\n  add rax, 1\n  vaddps ymm0, ymm1, ymm2\n  dec rcx\n  jnz .loop\n  ret\n';
const r5 = await compilePane(nasm, nasmSource, { supportsBinary: true, supportsBinaryObject: false }, { fetch: recFetch });
save('compile-nasm-loop.json', { source: nasmSource, response: r5.response });

// a compilation that fails
const r6 = await compilePane({ ...loops, options: '-O2' }, 'int f( {', infos.get('g142'), { fetch: recFetch });
save('compile-g142-error.json', r6.response);

save('requests.json', recorded);
