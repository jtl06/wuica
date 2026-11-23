// Tests of the page's other DOM-free modules: mock engine and its data, examples, microarchitecture menu,
// URL state, assembler adapter. Usage: node tests-js/web_modules.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { MockEngine, recordedCases, SYNTHETIC_HEX, MOCK_ERROR_HEX } from '../web/js/engine-mock.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, MOCK_EXAMPLES } from '../web/js/examples.js';
import { parseHexInput } from '../web/js/hex-input.js';
import { archGroups, INTEL_ORDER, ARCH_INFO } from '../web/js/archs.js';
import { DEFAULT_STATE, encodeState, decodeState, clampInt } from '../web/js/url-state.js';
import { WasmAssembler, parseDiagnostics, isWasm, stripHints } from '../web/js/assembler.js';
import { MockAssembler } from '../web/js/assembler-mock.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const exists = (p) => fs.existsSync(new URL(p, root));

// --- mock engine ----------------------------------------------------------------------------------------------------
const UARCH = { configs: { SKL: { name: 'SKL', XEDName: 'SKYLAKE' }, KBL: { name: 'KBL', XEDName: 'SKYLAKE' }, ZEN3: { name: 'ZEN3', XEDName: 'ALL' }, 'ADL-P': { name: 'ADL-P', XEDName: 'ALDER_LAKE' }, CLX_noLSD: { name: 'CLX' } } };
function checkShape(r, what) {
  const kinds = ['instr', 'regMerge', 'stackSync'];
  check(typeof r.arch === 'string' && typeof r.tp === 'number' && ['loop', 'unroll'].includes(r.mode) && Number.isInteger(r.decodeErrors), `${what}: head`);
  check(Array.isArray(r.bottlenecks) && r.bottlenecks.every((b) => typeof b === 'string'), `${what}: bottlenecks`);
  check(Array.isArray(r.limits) && r.limits.length > 0 && r.limits.every((l) => typeof l.name === 'string' && typeof l.tp === 'number'), `${what}: limits`);
  check(r.bottlenecks.every((b) => r.limits.some((l) => l.name === b)), `${what}: bottlenecks are limits`);
  check(Array.isArray(r.columns) && new Set(r.columns).size === r.columns.length && r.columns.slice(0, 6).join() === 'MITE,MS,DSB,LSD,Issued,Exec.', `${what}: columns`);
  for (const x of r.rows) {
    check(kinds.includes(x.kind) && typeof x.label === 'string' && ['', 'M', 'J', 'X'].includes(x.notes), `${what}: row ${x.label}`);
    check(Array.isArray(x.values) && x.values.length === r.columns.length && x.values.every((v) => typeof v === 'number' && v >= 0), `${what}: values of ${x.label}`);
    if (x.kind === 'instr') check(/^([0-9A-F]{2})+$/.test(x.opcode) && typeof x.instrStr === 'string' && (x.url === null || x.url.startsWith('https://www.uops.info/html-instr/')), `${what}: instr fields of ${x.label}`);
    else check(!('opcode' in x) && !('url' in x) && /^<.* Uop>$/.test(x.label), `${what}: extra row ${x.label}`);
    if (x.notes === 'X') check(x.url === null, `${what}: unsupported instruction has no url`);
  }
  check(typeof r.text === 'string' && r.text.length > 0 && !r.text.includes('\x1b') && !r.text.includes('~') && r.trace === null, `${what}: text`);
  check(r.rows.filter((x) => x.kind === 'instr').map((x) => x.opcode).join('').length <= r.mock.hex.length, `${what}: opcodes`);
}
{
  const m = new MockEngine();
  check(m.capabilities.analyze && m.capabilities.mock && !m.capabilities.decode, 'mock: capabilities');
  check((await m.analyze(makeRequest('90', 'SKL'))).error?.includes('uarch.json'), 'mock: needs uarch.json');
  await m.loadUarch(JSON.stringify(UARCH));
  check((await m.analyze(makeRequest('90', 'SKL'))).error?.includes('table SKL'), 'mock: needs the table');
  for (const t of ['SKL', 'KBL', 'ZEN3', 'ADL-P']) await m.loadArch(t, '{}');
  check(m.hasArch('SKL') && !m.hasArch('HSW'), 'mock: hasArch');
  check((await m.analyze(makeRequest('90', 'NOPE'))).error?.includes('unknown configuration'), 'mock: unknown configuration');
  check((await m.analyze(makeRequest('', 'SKL'))).error === 'no instructions', 'mock: no instructions');
  check(typeof (await m.analyze(makeRequest(MOCK_ERROR_HEX, 'SKL'))).error === 'string', 'mock: the error input');
  check((await m.decode('90', 'SKYLAKE')).error !== undefined, 'mock: no decoder without the real module');

  const cases = recordedCases();
  check(cases.length >= 4 && cases.some((c) => c.arch === 'SKL') && cases.some((c) => c.arch === 'ZEN3') && cases.some((c) => c.arch === 'ADL-P'), 'mock: recorded cases for SKL, ZEN3 and ADL-P');
  for (const c of cases) {
    const r = await m.analyze(makeRequest(c.hex.toUpperCase(), c.arch));
    check(r.mock.exact && r.mock.hex === c.hex && r.mock.source === c.source && r.mock.synthetic === (c.source === 'synthetic'), `mock: exact match ${c.source}/${c.arch}`);
    checkShape(r, `mock ${c.source}/${c.arch}`);
    if (c.source !== 'synthetic') {
      check(r.rows.filter((x) => x.kind === 'instr').map((x) => x.opcode).join('').toLowerCase() === c.hex, `mock ${c.source}: the rows are the instructions of the code`);
      check(r.text.startsWith(`Throughput (in cycles per iteration): ${r.tp.toFixed(2)}\n`) && r.text.includes('│ Total'), `mock ${c.source}: text report`);
      check(r.rows.at(-1).notes === 'M' && r.mode === 'loop', `mock ${c.source}: ends in a macro-fused branch`);
    }
  }
  const other = await m.analyze(makeRequest('90', 'KBL'));
  check(!other.mock.exact && !other.mock.synthetic && other.mock.hex !== '90', 'mock: unknown input gets a labelled sample');
  const sameCode = await m.analyze(makeRequest(cases[0].hex, 'KBL'));
  check(!sameCode.mock.exact && sameCode.mock.hex === cases[0].hex && sameCode.mock.arch === 'SKL', 'mock: known code on another microarchitecture');
  check((await m.analyze(makeRequest('90', 'ZEN3'))).mock.arch === 'ZEN3', 'mock: the sample follows the microarchitecture where it can');
  const syn = await m.analyze(makeRequest(SYNTHETIC_HEX, 'SKL'));
  const kinds = new Set(syn.rows.map((x) => x.kind)), notes = new Set(syn.rows.map((x) => x.notes));
  check(syn.mock.synthetic && syn.mode === 'unroll' && syn.decodeErrors === 1 && syn.columns.includes('Div') && kinds.has('regMerge') && kinds.has('stackSync') && notes.has('J') && notes.has('X') && notes.has('M'), 'mock: the synthetic case covers what the recorded ones lack');
  const a = await m.analyze(makeRequest(cases[0].hex, 'SKL')); a.rows.length = 0;
  check((await m.analyze(makeRequest(cases[0].hex, 'SKL'))).rows.length > 0, 'mock: responses are copies');

  // The text reports are the reference's, if the fixtures are here.
  if (exists('fixtures/generated/sim_fixtures.jsonl.gz')) {
    const want = new Map(cases.filter((c) => c.source !== 'synthetic').map((c) => [`${c.source}/${c.arch}`, c]));
    let compared = 0;
    // The file is far too large to read into one string (it has the cycle-by-cycle traces): read it line by line.
    const lines = readline.createInterface({ input: fs.createReadStream(new URL('fixtures/generated/sim_fixtures.jsonl.gz', root)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      const head = /^\{"file": "([^"]+)", "arch": "([^"]+)", "options": \{\}/.exec(line);
      if (!head || !want.has(`${head[1]}/${head[2]}`)) continue;
      const f = JSON.parse(line);
      const r = await m.analyze(makeRequest(f.hex, f.arch));
      const text = f.stdout.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
      check(r.text === text && r.tp === f.TP, `mock ${head[1]}/${head[2]}: identical to the fixture (text, TP)`);
      compared++;
    }
    check(compared === want.size, 'mock: every recorded case was found in the fixtures', `${compared}/${want.size}`);
  } else console.log('(no sim fixtures: the recorded cases were not compared with them)');
}
// the examples, through the real decoder
if (exists('target/wasm32-unknown-unknown/release/wuica_wasm.wasm')) {
  const real = await WasmEngine.create(fs.readFileSync(new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root)));
  for (const ex of [...EXAMPLES, ...MOCK_EXAMPLES]) {
    const d = await real.decode(ex.hex, 'SKYLAKE');
    const lines = ex.text.hex.trim().split('\n');
    const listed = lines.length - (ex.id === 'synthetic' ? 1 : 0); // the synthetic one has an undecodable byte
    check(Array.isArray(d) && d.length === listed, `example ${ex.id}: decodes into its ${listed} instructions`, JSON.stringify(d).slice(0, 120));
    if (ex.id !== 'synthetic') check(d.every((i, k) => k === d.length - 1 || lines[k].endsWith('    ' + i.asm)), `example ${ex.id}: the listing shows what the decoder reads`, d.map((i) => i.asm).join('; '));
  }
} else console.log('(no real module: examples not decoded)');

// --- examples -------------------------------------------------------------------------------------------------------
{
  const cases = recordedCases();
  check(EXAMPLES.length >= 3 && new Set([...EXAMPLES, ...MOCK_EXAMPLES].map((e) => e.id)).size === EXAMPLES.length + MOCK_EXAMPLES.length, 'examples: at least three, unique ids');
  for (const ex of [...EXAMPLES, ...MOCK_EXAMPLES]) {
    const p = parseHexInput(ex.text.hex);
    check(p.ok && p.hex === ex.hex && p.format === 'listing', `example ${ex.id}: the hex text parses to its machine code`, JSON.stringify(p));
    check(ex.text.intel.trim() !== '' && ex.text.att.trim() !== '' && ex.text.intel.split('\n').length === ex.text.att.split('\n').length, `example ${ex.id}: both syntaxes`);
  }
  for (const ex of EXAMPLES) check(cases.some((c) => c.hex === ex.hex && c.arch === ex.arch), `example ${ex.id}: the mock has the reference's result for ${ex.arch}`);
  check(MOCK_EXAMPLES.some((e) => e.hex === SYNTHETIC_HEX) && MOCK_EXAMPLES.some((e) => e.hex === MOCK_ERROR_HEX), 'examples: the mock-only ones reach the synthetic and the error case');
  const asm = new MockAssembler();
  const ok = await asm.assemble(EXAMPLES[0].text.att + '\n  # comment\n', 'att');
  check(ok.ok && Buffer.from(ok.bytes).toString('hex') === EXAMPLES[0].hex, 'mock assembler: knows the examples');
  const bad = await asm.assemble('loop:\n  frobnicate rax\n  dec r15\n   bogus\n', 'intel');
  check(!bad.ok && bad.diagnostics.map((d) => d.line).join() === '2,4' && bad.diagnostics[1].column === 4, 'mock assembler: diagnostics with lines', JSON.stringify(bad));
}

// --- microarchitecture menu ----------------------------------------------------------------------------------------
{
  const g = archGroups({ configs: {
    SKL: { name: 'SKL', XEDName: 'SKYLAKE', experimental: false }, SNB: { name: 'SNB', XEDName: 'SANDYBRIDGE', experimental: false },
    RKL: { name: 'RKL', XEDName: 'ICE_LAKE', experimental: false }, CLX: { name: 'CLX', XEDName: 'CASCADE_LAKE', experimental: false },
    CLX_noLSD: { name: 'CLX', XEDName: 'CASCADE_LAKE', experimental: false }, CLX_SimplePorts_noMoveElim: { name: 'CLX', XEDName: 'CASCADE_LAKE', experimental: false },
    ICX: { name: 'ICX', XEDName: 'ICE_LAKE_SERVER', experimental: true }, ZEN3: { name: 'ZEN3', XEDName: 'ALL', experimental: true },
    'ADL-P': { name: 'ADL-P', XEDName: 'ALDER_LAKE', experimental: true }, NEW: { name: 'NEWT', XEDName: 'FUTURE', experimental: false }, ZEN4: { name: 'ZEN4', XEDName: 'ALL', experimental: true },
  } });
  check(g.length === 2 && g[0].label === 'Intel' && g[1].label === 'Experimental (this fork)', 'archs: two groups');
  check(g[0].items.map((i) => i.key).join() === 'RKL,CLX,SKL,SNB,NEW', 'archs: stock models newest first, unknown ones last', g[0].items.map((i) => i.key).join());
  check(g[1].items.map((i) => i.key).join() === 'ZEN3,ADL-P,ICX,ZEN4', 'archs: experimental group', g[1].items.map((i) => i.key).join());
  check(![...g[0].items, ...g[1].items].some((i) => i.key.includes('_')), 'archs: configurations with "_" are hidden');
  check(g[0].items[0].title === 'RKL · Rocket Lake (2021)' && g[1].items[0].title === 'ZEN3 · AMD Zen 3' && g[0].items[4].title === 'NEW', 'archs: titles');
  check(g[0].items[4].table === 'NEWT' && g[0].items[4].chip === 'FUTURE', 'archs: table and chip come from the configuration');
  const years = INTEL_ORDER.map((k) => ARCH_INFO[k].year);
  check(INTEL_ORDER.length === 12 && years.every((y, i) => i === 0 || y <= years[i - 1]), 'archs: the order is newest to oldest', years.join());
  check(archGroups(null).length === 0, 'archs: no data');
  if (exists('data/uarch.json')) {
    const real = archGroups(JSON.parse(fs.readFileSync(new URL('data/uarch.json', root))));
    check(real[0].items.map((i) => i.key).join() === INTEL_ORDER.join() && real[1].items.map((i) => i.key).join() === 'ZEN3,ADL-P,ICX', 'archs: the real uarch.json', JSON.stringify(real.map((x) => x.items.map((i) => i.key))));
    check([...real[0].items, ...real[1].items].every((i) => exists(`data/arch/${i.table}.json`)), 'archs: every listed model has its table in data/arch');
  }
}

// --- URL state ------------------------------------------------------------------------------------------------------
{
  check(encodeState(DEFAULT_STATE) === '' && decodeState('') === null && decodeState('#about') === null && decodeState('#v=2&m=asm') === null, 'url: defaults give no fragment; foreign fragments are ignored');
  const s = { mode: 'asm', syntax: 'att', arch: 'ADL-P', text: 'loop:\n\taddq $1, %rax   # ünï → ✓ & = #\n\tjnz loop\n', alignmentOffset: 31, initPolicy: 'stack', simpleFrontEnd: true, noMicroFusion: true, noMacroFusion: true, minIterations: 7, minCycles: 1234 };
  const f = encodeState(s);
  check(/^[A-Za-z0-9=&_-]+$/.test(f), 'url: the fragment needs no escaping', f);
  check(JSON.stringify(decodeState('#' + f)) === JSON.stringify({ ...DEFAULT_STATE, ...s }) && JSON.stringify(decodeState(f)) === JSON.stringify({ ...DEFAULT_STATE, ...s }), 'url: round trip of every field');
  const h = { ...DEFAULT_STATE, text: '48 01 d8\n   0:\t49 ff cf\tdec r15\n', arch: 'ZEN3' };
  check(JSON.stringify(decodeState(encodeState(h))) === JSON.stringify(h) && !encodeState(h).includes('m=') && !encodeState(h).includes('ip='), 'url: defaults are left out');
  check(decodeState(encodeState({ ...DEFAULT_STATE, mode: 'hex', syntax: 'att', text: 'x' })).syntax === 'intel', 'url: the syntax is only kept for assembly');
  const evil = decodeState('v=1&m=evil&s=x&a=%3Cscript%3E&al=99&mi=-5&mc=1e9&ip=nope&sfe=yes&c=!!!&zzz=1');
  check(JSON.stringify(evil) === JSON.stringify({ ...DEFAULT_STATE, alignmentOffset: 63 }), 'url: bad values fall back to the defaults', JSON.stringify(evil));
  check(decodeState('v=1&a=%E0%A4%A').arch === 'SKL' && decodeState('v=1&c=_w').text === '', 'url: malformed escapes and invalid UTF-8');
  check(decodeState('v=1&mi=0&mc=99999999').minIterations === 1 && decodeState('v=1&mi=0&mc=99999999').minCycles === 100000, 'url: numbers are clamped');
  check(clampInt('12', [0, 63], 0) === 12 && clampInt('', [0, 63], 7) === 7 && clampInt('1.5', [0, 63], 7) === 7 && clampInt(64, [0, 63], 0) === 63, 'url: clampInt');
  const big = 'x'.repeat(100000);
  check(decodeState(encodeState({ ...DEFAULT_STATE, text: big })).text === big, 'url: a large text');
}

// --- assembler adapter -----------------------------------------------------------------------------------------------
{
  const msg = "<input>:2:1: error: invalid instruction mnemonic 'frobnicate'\nfrobnicate rax, rbx\n^\n<input>:5:9: warning: careful\n  nop\n        ^\n";
  const d = parseDiagnostics(msg);
  check(d.length === 2 && d[0].line === 2 && d[0].column === 1 && d[0].severity === 'error' && d[0].message === "invalid instruction mnemonic 'frobnicate'" && d[1].severity === 'warning' && d[1].line === 5, 'assembler: llvm-mc diagnostics', JSON.stringify(d));
  check(parseDiagnostics('').length === 0 && parseDiagnostics('output buffer too small: 70000 bytes needed')[0].line === null, 'assembler: messages without a position');
  check(stripHints('{load} mov rax, rbx\n  {store} add rax, rcx\nmov rdx, {load}\n') === 'mov rax, rbx\n  add rax, rcx\nmov rdx, {load}\n', 'assembler: {load}/{store} hints are removed at the start of a line only');
  check(isWasm(Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0)) && !isWasm(new TextEncoder().encode('<!doctype html><html>')) && !isWasm(new Uint8Array(0)), 'assembler: isWasm');

  // A fake module with the interface of assembler/wuica_asm.cpp; its memory grows in malloc and in the call.
  const enc = new TextEncoder();
  let instances = 0, live = 0;
  const make = () => {
    instances++;
    const memory = new WebAssembly.Memory({ initial: 1 });
    let top = 8, initialized = false, fatal = 0;
    const malloc = (n) => { const p = top; top += Math.max(n, 1); while (top > memory.buffer.byteLength) memory.grow(1); memory.grow(1); live++; return p; };
    const put = (p, cap, s) => { const b = enc.encode(s).subarray(0, cap - 1); const m = new Uint8Array(memory.buffer); m.set(b, p); m[p + b.length] = 0; };
    return {
      memory, malloc, free() { live--; }, _initialize() { initialized = true; },
      wuica_fatal_message() { return fatal; },
      wuica_assemble(text, syntax, out, outCap, err, errCap) {
        if (!initialized) throw new Error('not initialized');
        memory.grow(1);
        const m = new Uint8Array(memory.buffer);
        const src = new TextDecoder().decode(m.subarray(text, m.indexOf(0, text)));
        put(err, errCap, '');
        if (src.includes('trap')) { fatal = malloc(64); live--; put(fatal, 64, 'LLVM ERROR: boom'); throw new WebAssembly.RuntimeError('unreachable'); }
        if (src.includes('bogus')) { put(err, errCap, `<input>:${src.split('\n').findIndex((l) => l.includes('bogus')) + 1}:3: error: invalid instruction mnemonic 'bogus'\n  bogus\n  ^\n`); return -1; }
        const n = src.includes('huge') ? 70000 : 3;
        if (n > outCap) { put(err, errCap, `output buffer too small: ${n} bytes needed`); return -2; }
        new Uint8Array(memory.buffer).fill(syntax === 1 ? 0xa7 : 0x17, out, out + n);
        if (src.includes('warn')) put(err, errCap, '<input>:1:1: warning: careful\n');
        return n;
      },
    };
  };
  const a = await WasmAssembler.create(make);
  const ok = await a.assemble('add rax, rbx\n', 'intel');
  check(ok.ok && ok.bytes.length === 3 && ok.bytes[0] === 0x17 && ok.diagnostics.length === 0, 'assembler: bytes (Intel)', JSON.stringify(ok));
  check((await a.assemble('addq %rbx, %rax\n', 'att')).bytes[2] === 0xa7, 'assembler: the syntax is passed');
  const w = await a.assemble('warn\n');
  check(w.ok && w.diagnostics[0].severity === 'warning', 'assembler: warnings come with the code');
  const e = await a.assemble('nop\nnop\n  bogus\n');
  check(!e.ok && e.diagnostics.length === 1 && e.diagnostics[0].line === 3 && e.diagnostics[0].column === 3, 'assembler: errors with line and column', JSON.stringify(e));
  const hg = await a.assemble('huge\n');
  check(hg.ok && hg.bytes.length === 70000, 'assembler: retries with a larger output buffer');
  check(live === 0, 'assembler: buffers are freed', `${live} live`);
  const t = await a.assemble('trap\n');
  check(!t.ok && /boom/.test(t.diagnostics[0].message), 'assembler: a trap is reported with the fatal message', JSON.stringify(t));
  const after = await a.assemble('add rax, rbx\n');
  check(after.ok && instances === 2, 'assembler: a new instance after a trap');
  let threw = false; try { await WasmAssembler.create(new TextEncoder().encode('<!doctype html>')); } catch { threw = true; }
  check(threw, 'assembler: an HTML page in place of the module is rejected');

  const realPath = new URL('assembler/dist/wuica_asm.wasm', root);
  if (fs.existsSync(realPath)) {
    const real = await WasmAssembler.create(fs.readFileSync(realPath));
    for (const ex of EXAMPLES) {
      for (const syntax of ['intel', 'att']) {
        const r = await real.assemble(ex.text[syntax], syntax);
        check(r.ok && r.bytes.length === ex.hex.length / 2, `real assembler: example ${ex.id} (${syntax})`, JSON.stringify(r.ok ? Buffer.from(r.bytes).toString('hex') : r.diagnostics));
      }
    }
    const i = await real.assemble(EXAMPLES[0].text.intel, 'intel'), t2 = await real.assemble(EXAMPLES[0].text.att, 'att');
    check(Buffer.from(i.bytes).toString('hex') === EXAMPLES[0].hex && Buffer.from(t2.bytes).toString('hex') === EXAMPLES[0].hex, 'real assembler: the first example gives the listed machine code');
    const hinted = await real.assemble('{load} mov rax, rbx\n  {store} mov ecx, eax\n', 'intel');
    check(hinted.ok && hinted.bytes.length === 5, 'real assembler: GNU {load}/{store} hints are accepted', JSON.stringify(hinted.ok ? Buffer.from(hinted.bytes).toString('hex') : hinted.diagnostics));
    const bad = await real.assemble('nop\nfrobnicate rax\n', 'intel');
    check(!bad.ok && bad.diagnostics[0].line === 2, 'real assembler: diagnostics', JSON.stringify(bad));
  } else console.log('(no assembler/dist/wuica_asm.wasm: the real assembler was not tested)');
}

console.log(`${count} module checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
