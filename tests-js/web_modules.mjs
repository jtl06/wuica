// Tests of the page's other DOM-free modules: mock engine and its data, examples, microarchitecture menu,
// URL state, assembler adapter. Usage: node tests-js/web_modules.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { MockEngine, recordedCases, SYNTHETIC_HEX, MOCK_ERROR_HEX } from '../web/js/engine-mock.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES, SHOWCASE_EXAMPLES, MOCK_EXAMPLES } from '../web/js/examples.js';
import { parseHexInput } from '../web/js/hex-input.js';
import { archGroups, ARCH_ORDER, ARCH_INFO } from '../web/js/archs.js';
import { DEFAULT_STATE, encodeState, decodeState, clampInt } from '../web/js/url-state.js';
import { WasmAssembler, parseDiagnostics, isWasm, stripHints } from '../web/js/assembler.js';
import { MockAssembler } from '../web/js/assembler-mock.js';
import { formatListing } from '../web/js/listing.js';
import { tableBytes } from './tables.mjs'; // the binary tables (the module reads no JSON tables)

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
  for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES, ...MOCK_EXAMPLES]) {
    const d = await real.decode(ex.hex, 'SKYLAKE');
    const lines = ex.text.hex.trim().split('\n');
    const listed = lines.length - (ex.id === 'synthetic' ? 1 : 0); // the synthetic one has an undecodable byte
    check(Array.isArray(d) && d.length === listed, `example ${ex.id}: decodes into its ${listed} instructions`, JSON.stringify(d).slice(0, 120));
    if (ex.id !== 'synthetic') check(d.every((i, k) => k === d.length - 1 || lines[k].endsWith('    ' + i.asm)), `example ${ex.id}: the listing shows what the decoder reads`, d.map((i) => i.asm).join('; '));
  }
  // the showcase: SHA-256, 64 rounds unrolled (2,949 instructions, one loop); the throughput equals the Python uiCA's
  const sha = SHOWCASE_EXAMPLES.find((e) => e.id === 'sha256');
  const d = await real.decode(sha.hex, 'SKYLAKE');
  check(Array.isArray(d) && d.length === 2949 && /^jnz /.test(d.at(-1).asm) && sha.hex.length === 2 * 11602, 'showcase: 2,949 instructions, 11,602 bytes, ends in a branch', `${d?.length} ${d?.at?.(-1)?.asm}`);
  if (exists('data/uarch.json') && exists('data/arch/SKL.json')) {
    await real.loadUarch(fs.readFileSync(new URL('data/uarch.json', root)));
    await real.loadArch('SKL', tableBytes('SKL'));
    // the module that ships reads only binary tables: a JSON table is an error that says so
    let jsonError = '';
    try { await real.loadArch('SKX', fs.readFileSync(new URL('data/arch/SKX.json', root))); } catch (e) { jsonError = String(e.message); }
    check(/reads only binary tables \(data\/arch\/<NAME>\.bin, written from the JSON by tools\/encode-tables\.sh\)/.test(jsonError) && !real.hasArch('SKX'), 'a JSON table: an error that says the module reads binary tables', jsonError);
    const t0 = performance.now();
    const r = await real.analyze(makeRequest(sha.hex, 'SKL'));
    const ms = performance.now() - t0;
    check(r.tp === 744.25 && r.mode === 'loop' && r.rows.filter((x) => x.kind === 'instr').length === 2949, 'showcase: 744.25 cycles/iteration on SKL (as uiCA)', `${r.tp} ${r.mode}`);
    console.log(`showcase on SKL: ${ms.toFixed(0)} ms`);
  }
} else console.log('(no real module: examples not decoded)');

// --- examples -------------------------------------------------------------------------------------------------------
{
  const cases = recordedCases();
  const all = [...EXAMPLES, ...CLASSIC_EXAMPLES, ...MOCK_EXAMPLES];
  check(EXAMPLES.length >= 3 && CLASSIC_EXAMPLES.length >= 9 && new Set(all.map((e) => e.id)).size === all.length, 'examples: at least three basics, the classic loops, unique ids');
  for (const ex of CLASSIC_EXAMPLES) check(/^\s+j\w+ loop$/.test(ex.text.intel.trim().split('\n').at(-1)) && ex.text.intel.startsWith('loop:'), `example ${ex.id}: a loop ending in a backward branch`);
  check(['dot1', 'dot4'].every((id) => CLASSIC_EXAMPLES.some((e) => e.id === id)), 'examples: the A–B demo pair exists');
  for (const ex of SHOWCASE_EXAMPLES) {
    const p = parseHexInput(ex.text.hex);
    const asm = typeof ex.asm === 'function' ? await ex.asm() : null;
    check(!ex.hexOnly && p.ok && p.hex === ex.hex && typeof asm === 'string' && asm.startsWith('loop:\n') && /\n {2}jnz loop\n$/.test(asm) && !all.some((e) => e.id === ex.id),
      `example ${ex.id}: its hex parses to its machine code; its Intel assembly loads on request (showcase-asm.js)`);
  }
  for (const ex of all) {
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
    ICL: { name: 'ICL', XEDName: 'ICE_LAKE', experimental: false },
    CLX_noLSD: { name: 'CLX', XEDName: 'CASCADE_LAKE', experimental: false }, CLX_SimplePorts_noMoveElim: { name: 'CLX', XEDName: 'CASCADE_LAKE', experimental: false },
    ICX: { name: 'ICX', XEDName: 'ICE_LAKE_SERVER', experimental: true }, ZEN3: { name: 'ZEN3', XEDName: 'ALL', experimental: true },
    'ADL-P': { name: 'ADL-P', XEDName: 'ALDER_LAKE', experimental: true }, NEW: { name: 'NEWT', XEDName: 'FUTURE', experimental: false }, ZEN4: { name: 'ZEN4', XEDName: 'ALL', experimental: true },
  } });
  const keys = g[0].items.map((i) => i.key).join();
  check(g.length === 1 && g[0].label === 'by release date', 'archs: one group');
  check(keys === 'SNB,SKL,CLX,ICL,ZEN3,RKL,ICX,ADL-P,NEW,ZEN4', 'archs: in order of release, unknown ones last', keys);
  check(!g[0].items.some((i) => i.key.includes('_')), 'archs: configurations with "_" are hidden');
  const t = Object.fromEntries(g[0].items.map((i) => [i.key, i]));
  check(t.ICL.title === 'ICL · Ice Lake client (2019)' && t.ICX.title === 'ICX · Ice Lake server (2021) · prototype' && t.ZEN3.title === 'ZEN3 · AMD Zen 3 (2020) · prototype' && t.NEW.title === 'NEW' && t.ZEN4.title === 'ZEN4 · prototype', 'archs: titles', JSON.stringify(g[0].items.map((i) => i.title)));
  check(t.ICX.experimental && t.ZEN3.experimental && !t.ICL.experimental && !t.SKL.experimental, 'archs: prototypes are marked');
  check(t.NEW.table === 'NEWT' && t.NEW.chip === 'FUTURE', 'archs: table and chip come from the configuration');
  const years = ARCH_ORDER.map((k) => ARCH_INFO[k].year);
  check(ARCH_ORDER.length === 15 && years.every((y, i) => i === 0 || y >= years[i - 1]), 'archs: the order is oldest to newest', years.join());
  check(archGroups(null).length === 0, 'archs: no data');
  if (exists('data/uarch.json')) {
    const real = archGroups(JSON.parse(fs.readFileSync(new URL('data/uarch.json', root))));
    check(real.length === 1 && real[0].items.map((i) => i.key).join() === ARCH_ORDER.join(), 'archs: the real uarch.json', JSON.stringify(real.map((x) => x.items.map((i) => i.key))));
    check(real[0].items.every((i) => exists(`data/arch/${i.table}.json`)), 'archs: every listed model has its table in data/arch');
  }
}

// --- objdump listing ------------------------------------------------------------------------------------------------
{
  const m = new MockEngine();
  await m.loadUarch(JSON.stringify(UARCH));
  await m.loadArch('SKL', '{}');
  const chain = await m.analyze(makeRequest(EXAMPLES[0].hex, 'SKL'));
  const l = formatListing(chain.rows);
  check(l.text === '   0:  48 83 c0 01    add rax, 0x1\n   4:  48 83 c0 01    add rax, 0x1\n   8:  49 ff cf       dec r15\n   b:  75 f3          jnz 0xfffffffffffffff5\n', 'listing: the first example, objdump style', JSON.stringify(l.text));
  check(l.lines.map((x) => x.offset).join() === '0,4,8,11' && l.lines[3].bytes === '75 f3', 'listing: offsets and bytes (the macro-fused branch is its own line)', JSON.stringify(l.lines));
  check(parseHexInput(l.text).hex === EXAMPLES[0].hex, 'listing: pasted into the hex input it gives the same machine code');
  for (const c of recordedCases()) {
    await m.loadArch(c.arch, '{}');
    const r = await m.analyze(makeRequest(c.hex, c.arch));
    const t = formatListing(r.rows);
    const instrs = r.rows.filter((x) => x.kind === 'instr');
    check(t.lines.length === instrs.length && t.lines.every((x, i) => x.text === instrs[i].label), `listing ${c.source}/${c.arch}: one line per instruction`);
    check(parseHexInput(t.text).hex === instrs.map((x) => x.opcode).join('').toLowerCase(), `listing ${c.source}/${c.arch}: round trip through the hex input`);
  }
  const syn = await m.analyze(makeRequest(SYNTHETIC_HEX, 'SKL'));
  const st = formatListing(syn.rows);
  check(syn.rows.some((x) => x.kind !== 'instr') && st.lines.length === syn.rows.filter((x) => x.kind === 'instr').length && !/Uop/.test(st.text), 'listing: regMerge/stackSync rows are not instructions', st.text);
  check(syn.rows.some((x) => x.notes === 'M') && st.lines.some((x) => x.text === syn.rows.find((y) => y.notes === 'M').label), 'listing: the macro-fused row is listed');
  // offsets grow past four digits; a 15-byte instruction; no rows
  const many = Array.from({ length: 5000 }, () => ({ kind: 'instr', opcode: '4883C001', label: 'add rax, 0x1' }));
  many.push({ kind: 'instr', opcode: '26663E2E6567F0F2F348C7841100000000FF', label: 'long' }, { kind: 'stackSync', label: '<Stack Sync Uop>' });
  const big = formatListing(many);
  const last = big.text.trimEnd().split('\n').at(-1);
  check(big.lines.length === 5001 && last.startsWith('4e20:  26 66 3e') && big.text.startsWith('   0:  48 83 c0 01') && big.lines[5000].bytes.split(' ').length === 18, 'listing: wide offsets, long instructions', last);
  check(formatListing([]).text === '' && formatListing(null).lines.length === 0, 'listing: nothing to list');
}

// --- URL state ------------------------------------------------------------------------------------------------------
{
  check(encodeState(DEFAULT_STATE) === '' && decodeState('') === null && decodeState('#about') === null && decodeState('#v=2&m=asm') === null, 'url: defaults give no fragment; foreign fragments are ignored');
  const s = { mode: 'asm', syntax: 'att', arch: 'ADL-P', text: 'loop:\n\taddq $1, %rax   # ünï → ✓ & = #\n\tjnz loop\n', alignmentOffset: 31, initPolicy: 'stack', simpleFrontEnd: true, noMicroFusion: true, noMacroFusion: true, minIterations: 7, minCycles: 1234 };
  const f = encodeState(s);
  check(/^[A-Za-z0-9=&_-]+$/.test(f), 'url: the fragment needs no escaping', f);
  check(JSON.stringify(decodeState('#' + f)) === JSON.stringify({ ...DEFAULT_STATE, ...s }) && JSON.stringify(decodeState(f)) === JSON.stringify({ ...DEFAULT_STATE, ...s }), 'url: round trip of every field');
  const h = { ...DEFAULT_STATE, mode: 'hex', text: '48 01 d8\n   0:\t49 ff cf\tdec r15\n', arch: 'ZEN3' };
  check(JSON.stringify(decodeState(encodeState(h))) === JSON.stringify(h) && !encodeState(h).includes('m=') && !encodeState(h).includes('ip='), 'url: defaults are left out (hex: no m=)');
  // assembly is the default input, but a link without m= is hex (links made when hex was the default keep their meaning)
  const a = { ...DEFAULT_STATE, text: 'add rax, 1\n' };
  check(encodeState(a) === 'v=1&m=asm&c=YWRkIHJheCwgMQo' && JSON.stringify(decodeState(encodeState(a))) === JSON.stringify(a) && decodeState('v=1&c=OTA').mode === 'hex'
    && DEFAULT_STATE.mode === 'asm' && encodeState({ ...DEFAULT_STATE, mode: 'hex' }) === 'v=1&m=hex' && decodeState('v=1&m=hex').mode === 'hex', 'url: assembly is the default; links without m= are hex', encodeState(a));
  check(decodeState(encodeState({ ...DEFAULT_STATE, mode: 'hex', syntax: 'att', text: 'x' })).syntax === 'intel', 'url: the syntax is only kept for assembly');
  const evil = decodeState('v=1&m=evil&s=x&a=%3Cscript%3E&al=99&mi=-5&mc=1e9&ip=nope&sfe=yes&c=!!!&zzz=1');
  check(JSON.stringify(evil) === JSON.stringify({ ...DEFAULT_STATE, mode: 'hex', alignmentOffset: 63 }), 'url: bad values fall back to the defaults (no m=asm: hex)', JSON.stringify(evil));
  // the checked CPUs: a short list; the focused CPU (a=) is one of them; old links: one CPU, or all with cmpcpu=1
  const m = { ...DEFAULT_STATE, arch: 'ZEN3', cpus: 'SKL,ZEN3,ADL-P', text: 'nop\n' };
  check(encodeState(m) === 'v=1&m=asm&a=ZEN3&as=SKL,ZEN3,ADL-P&c=bm9wCg' && JSON.stringify(decodeState(encodeState(m))) === JSON.stringify(m), 'url: the checked CPUs round trip', encodeState(m));
  // the default CPU focused, with an earlier CPU checked: a= is needed (without it the first of the list is focused)
  const d = { ...DEFAULT_STATE, cpus: 'HSW,SKL', text: 'nop\n' };
  check(encodeState(d) === 'v=1&m=asm&a=SKL&as=HSW,SKL&c=bm9wCg' && JSON.stringify(decodeState(encodeState(d))) === JSON.stringify(d)
    && encodeState({ ...d, cpus: 'SKL,ZEN3' }) === 'v=1&m=asm&as=SKL,ZEN3&c=bm9wCg', 'url: SKL focused with HSW checked round trips', encodeState(d));
  check(encodeState({ ...DEFAULT_STATE, arch: 'ZEN3', cpus: 'ZEN3' }) === 'v=1&m=asm&a=ZEN3' && encodeState({ ...DEFAULT_STATE, cpus: 'all' }) === 'v=1&m=asm&as=all', 'url: one CPU needs no list; all of them is "all"');
  check(decodeState('v=1&as=HSW,ICL').arch === 'HSW' && decodeState('v=1&as=HSW,ICL').cpus === 'HSW,ICL' && decodeState('v=1&a=ZEN3').cpus === '' && decodeState('v=1&a=ZEN3&cmpcpu=1').cpus === 'all',
    'url: without a=, the first checked CPU is focused; an old link with the table of all CPUs open checks them all');
  check(decodeState('v=1&as=SKL,%3Cx%3E,SKL,,ICL').cpus === 'SKL,ICL' && decodeState('v=1&as=%E0%A4%A').cpus === '' && decodeState('v=1&as=' + 'A,'.repeat(200)).arch === 'A' && decodeState('v=1&as=' + 'A,'.repeat(200)).cpus === '', 'url: bad CPU lists are cleaned');
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
  let instances = 0, live = 0, runs = 0;
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
        runs++;
        memory.grow(1);
        const m = new Uint8Array(memory.buffer);
        const src = new TextDecoder().decode(m.subarray(text, m.indexOf(0, text)));
        put(err, errCap, '');
        if (src.includes('trap')) { fatal = malloc(64); live--; put(fatal, 64, 'LLVM ERROR: boom'); throw new WebAssembly.RuntimeError('unreachable'); }
        if (src.includes('bogus')) { put(err, errCap, `<input>:${src.split('\n').findIndex((l) => l.includes('bogus')) + 1}:3: error: invalid instruction mnemonic 'bogus'\n  bogus\n  ^\n`); return -1; }
        const n = src.includes('enormous') ? 2000000 : src.includes('huge') ? 70000 : 3;
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
  const runsBefore = runs;
  const en = await a.assemble('enormous\n');
  check(!en.ok && runs === runsBefore + 1 && en.diagnostics[0].message === 'Too much machine code: 2,000,000 bytes (at most 1,048,576)',
    'assembler: more than 1 MiB of machine code is an error after one run (no second, larger run)', JSON.stringify([en, runs - runsBefore]));
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
    for (const ex of [...EXAMPLES, ...CLASSIC_EXAMPLES]) {
      for (const syntax of ['intel', 'att']) {
        const r = await real.assemble(ex.text[syntax], syntax);
        check(r.ok && (CLASSIC_EXAMPLES.includes(ex) ? Buffer.from(r.bytes).toString('hex') === ex.hex : r.bytes.length === ex.hex.length / 2), `real assembler: example ${ex.id} (${syntax})`, JSON.stringify(r.ok ? Buffer.from(r.bytes).toString('hex') : r.diagnostics));
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
