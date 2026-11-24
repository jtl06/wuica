// Every REST endpoint, as JSON and as text, against the library's own results.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createWuica, markdown, whatIfText, diffAnalyses, diffMarkdown, diffText } from 'wuica';
import fs from 'node:fs';
import path from 'node:path';
import { start, post, get, HEX, ASM, ROOT, plain, rest } from './helpers.mjs';

let s, w;
before(async () => { [s, w] = await Promise.all([start(), createWuica()]); });
after(() => s.close());

test('GET / and /healthz', async () => {
  const i = await get(s.base, '/');
  assert.equal(i.status, 200);
  assert.equal(i.json.site, 'https://wuica.jacen.li');
  assert.ok(Object.keys(i.json.endpoints).some((k) => k.startsWith('POST /api/analyze/')));
  const t = await get(s.base, '/', { Accept: 'text/plain' });
  assert.match(t.headers.get('content-type'), /^text\/plain/);
  assert.match(t.text, /https:\/\/wuica\.jacen\.li/);
  const h = await get(s.base, '/healthz');
  assert.equal(h.status, 200);
  assert.deepEqual({ ok: h.json.ok, workers: h.json.workers, ready: h.json.ready }, { ok: true, workers: 2, ready: 2 });
});

test('GET /api/archs: all fields, ?fields=, text', async () => {
  const a = await get(s.base, '/api/archs');
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, w.archs());
  assert.equal(a.json.length, 15);
  const f = await get(s.base, '/api/archs?fields=id,name');
  assert.deepEqual(f.json, w.archs('id,name'));
  assert.deepEqual(f.json[0], { id: 'SNB', name: 'Sandy Bridge' });
  // an unknown field is an error that lists the valid ones (it gave a list of empty objects)
  const bad = await get(s.base, '/api/archs?fields=bogus');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 1);
  assert.match(bad.json.error, /unknown field\(s\): bogus \(valid: id, name, year, prototype, table, xedChip\)/);
  assert.equal((await get(s.base, '/api/archs?fields=id,bogus')).status, 400);
  assert.deepEqual((await get(s.base, '/api/archs?fields=')).json, w.archs());
  const t = await get(s.base, '/api/archs', { Accept: 'text/plain' });
  assert.match(t.text, /^SNB {4}Sandy Bridge \(2011\)\n/);
  assert.match(t.text, /^ZEN3 +AMD Zen 3 \(2020\) {2}\[prototype\]$/m);
});

test('GET /api/version: JSON and text', async () => {
  const v = await get(s.base, '/api/version');
  assert.equal(v.status, 200);
  assert.equal(v.json.llvm, '22.1.2');
  assert.equal(v.json.xed, 'v10.0-1167-gc71679ee');
  assert.equal(v.json.uiCA.commit, /^uica_commit=([0-9a-f]+)/m.exec(fs.readFileSync(path.join(ROOT, 'ci/data-asset.txt'), 'utf8'))[1]); // the data asset's
  assert.match(v.json.wuica, /^\d+\.\d+\.\d+/);
  assert.match(v.json.data.uarchSha256, /^[0-9a-f]{64}$/);
  const t = await get(s.base, '/api/version', { Accept: 'text/plain' });
  assert.match(t.text, /^llvm: 22\.1\.2$/m);
});

test('POST /api/analyze/<arch>: hex and source, equal to the library', async () => {
  for (const [arch, req] of [['SKL', { hex: HEX }], ['ZEN3', { source: ASM }], ['ADL-P', { source: 'addq %rbx, %rax', syntax: 'att' }],
    ['ICL', { hex: HEX, options: { noMacroFusion: true, alignmentOffset: 5, initPolicy: 'same' } }]]) {
    const r = await post(s.base, `/api/analyze/${arch}`, req);
    assert.equal(r.status, 200, arch);
    assert.deepEqual(r.json, rest(await w.analyze(arch, req)), arch);
    assert.equal(r.json.code, 0);
  }
  // case-insensitive ids, '-' optional, URL-encoded
  const r = await post(s.base, '/api/analyze/adlp', { hex: HEX });
  assert.equal(r.json.arch, 'ADL-P');
  assert.equal((await post(s.base, `/api/analyze/${encodeURIComponent('ADL-P')}`, { hex: HEX })).json.arch, 'ADL-P');
});

test('POST /api/analyze/<arch>: the split-load caveat per CPU', async () => {
  // gcc's FIR: its loads advance by add rax, 0x20; ZEN3's model charges their line crossings, SKL's has no such cost
  const source = fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/caveats/fir8.s'), 'utf8');
  const skl = await post(s.base, '/api/analyze/SKL', { source });
  assert.deepEqual(skl.json.insights.caveats.map((c) => [c.id, c.instructions.length]), [['split', 7]]);
  const zen = await post(s.base, '/api/analyze/ZEN3', { source });
  assert.equal(zen.json.code, 0);
  assert.equal(zen.json.insights.caveats, undefined);
});

test('POST /api/analyze/<arch>: text/plain is uiCA\'s report', async () => {
  const r = await post(s.base, '/api/analyze/SKL', { hex: HEX }, { Accept: 'text/plain' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.equal(r.text, (await w.analyze('SKL', { hex: HEX })).text);
  assert.match(r.text, /^Throughput \(in cycles per iteration\): /);
});

test('POST /api/analyze/<arch>: text/plain for a CPU that cannot run the code: the report, then a blank line and the note', async () => {
  const source = fs.readFileSync(new URL('../../tests-js/fixtures/dogfood/avx512.s', import.meta.url), 'utf8');
  for (const arch of ['SKL', 'ZEN3']) {
    const r = await post(s.base, `/api/analyze/${arch}`, { source }, { Accept: 'text/plain' });
    const lib = await w.analyze(arch, { source });
    assert.equal(lib.unsupported, 'needs AVX-512');
    assert.ok(r.text.startsWith(lib.text.replace(/\n*$/, '\n')), arch);
    assert.match(r.text, new RegExp(`\\n\\nNot a result for ${arch}: needs AVX-512 \\(the throughput leaves out what it cannot run\\)\\n$`));
  }
});

test('POST /api/what-if/<arch>: the library\'s whatIf (the MCP tool what_if), per element, text, Markdown, errors', async () => {
  const DOT = 'loop:\n vfmadd231ps ymm0, ymm1, [rdi+rax]\n add rax, 32\n cmp rax, rdx\n jb loop\n';
  const body = { source: DOT, variants: ['unroll2', 'acc4', 'nochain'], per: 8 };
  const r = await post(s.base, '/api/what-if/SKL', body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, await w.whatIf('SKL', body));
  assert.equal(r.json.elementsPerIteration, 8);
  assert.deepEqual(r.json.variants.map((v) => v.id), ['unroll2', 'acc4', 'nochain']);
  assert.ok(r.json.variants.every((v) => v.error || v.perElement === v.tp / 8));
  const t = await post(s.base, '/api/what-if/SKL', body, { Accept: 'text/plain' });
  assert.match(t.headers.get('content-type'), /^text\/plain/);
  assert.equal(t.text, whatIfText(r.json));
  const m = await post(s.base, '/api/what-if/SKL', body, { Accept: 'text/markdown' });
  assert.match(m.headers.get('content-type'), /^text\/markdown/);
  assert.equal(m.text, markdown.whatIf(r.json));
  // errors: the status codes of analyze
  assert.equal((await post(s.base, '/api/what-if/NOPE', { hex: HEX })).status, 404);
  assert.equal((await post(s.base, '/api/what-if', { hex: HEX })).status, 404);
  for (const bad of [{ hex: HEX, variants: ['unroll3'] }, { hex: HEX, variants: 'acc2' }, { hex: HEX, per: 0 }, { hex: HEX, bogus: 1 }]) {
    const e = await post(s.base, '/api/what-if/SKL', bad);
    assert.equal(e.status, 400, JSON.stringify(bad));
    assert.equal(e.json.code, 1);
  }
  const asm = await post(s.base, '/api/what-if/SKL', { source: 'frob rax' });
  assert.equal(asm.status, 200);
  assert.equal(asm.json.code, 2);
});

test('POST /api/diff/<arch>: the library\'s diff (the MCP tool diff_blocks), text, Markdown, errors', async () => {
  const body = { a: { hex: HEX }, b: { source: ASM }, per: [1, 2] };
  const r = await post(s.base, '/api/diff/SKL', body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, await w.diff('SKL', body));
  assert.equal(r.json.perElement.b, r.json.b.tp / 2);
  const x = await diffAnalyses(w, 'SKL', body);
  assert.equal((await post(s.base, '/api/diff/SKL', body, { Accept: 'text/plain' })).text, diffText(x.result));
  const m = await post(s.base, '/api/diff/SKL', body, { Accept: 'text/markdown' });
  assert.match(m.headers.get('content-type'), /^text\/markdown/);
  assert.equal(m.text, diffMarkdown(x, { archTitle: 'SKL · Skylake (2015)' }));
  assert.equal((await post(s.base, '/api/diff/NOPE', body)).json.error.startsWith('unknown microarchitecture'), true);
  assert.equal((await post(s.base, '/api/diff/NOPE', body)).status, 404);
  assert.equal((await post(s.base, '/api/diff', body)).status, 404);
  const bad = await post(s.base, '/api/diff/SKL', { a: { hex: HEX } });
  assert.equal(bad.status, 400);
  const asm = await post(s.base, '/api/diff/SKL', { a: { hex: HEX }, b: { source: 'frob rax' } });
  assert.equal(asm.status, 200);
  assert.equal(asm.json.code, 2);
  assert.match(asm.json.error, /^B: /);
});

test('POST /api/what-if/<arch> with the variant align (64 analyses)', async () => {
  const body = { source: ASM, variants: ['align'] };
  const r = await post(s.base, '/api/what-if/SKL', body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, await w.whatIf('SKL', body));
  assert.equal(r.json.variants[0].id, 'align');
  const m = await post(s.base, '/api/what-if/SKL', body, { Accept: 'text/markdown' });
  assert.equal(m.text, markdown.whatIfAlignment(r.json));
});

test('clang -g -S output (NULs in its comments) through the server: analyze as the library', async () => {
  const text = fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/asm/dot-clang-O2-g.s'), 'utf8');
  const r = await post(s.base, '/api/analyze/SKL', { source: text });
  assert.equal(r.status, 200);
  assert.equal(r.json.code, 0, r.json.error);
  assert.equal(r.json.tp, (await w.analyze('SKL', { source: text })).tp);
  assert.ok(r.json.rows.filter((x) => x.kind === 'instr').every((x) => /^dot\.c:[34]$/.test(x.loc)));
});

test('POST /api/compare with per: cycles per element (one job or split into parts)', async () => {
  for (const archs of [['SKL', 'ZEN3'], undefined]) {
    const body = { hex: HEX, per: 4, ...(archs ? { archs } : {}) };
    const r = await post(s.base, '/api/compare', body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, await w.compare(body));
    assert.equal(r.json.elementsPerIteration, 4);
    assert.ok(r.json.results.every((x) => x.code !== 0 || x.perElement === x.tp / 4));
  }
  assert.equal((await post(s.base, '/api/compare', { hex: HEX, per: 0 })).status, 400);
  // per in text and Markdown too
  const body = { hex: HEX, archs: ['SKL'], per: 4 };
  assert.match((await post(s.base, '/api/compare', body, { Accept: 'text/plain' })).text, /^SKL +Skylake +2015 +2\.00 +0\.50 +Dependencies$/m);
  const md = await post(s.base, '/api/compare', body, { Accept: 'text/markdown' });
  assert.equal(md.text, markdown.cpuTable(await w.compare(body), { per: 4 }));
  assert.match(md.text, /\| per el \|/);
});

test('Accept: text/markdown: the package\'s Markdown for analyze and compare', async () => {
  const src = 'loop:\n  add rax, 1\n  add rax, 1\n  dec r15\n  jnz loop\n';
  const r = await post(s.base, '/api/analyze/SKL', { source: src }, { Accept: 'text/markdown' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/markdown; charset=utf-8/);
  const lib = await w.analyze('SKL', { source: src });
  assert.equal(r.text, markdown.report(lib, { arch: 'SKL · Skylake (2015)', insights: w.insights(lib), source: src }));
  assert.match(r.text, /^\*\*2\.00 cycles\/iteration\*\* · SKL · Skylake \(2015\)/);
  assert.match(r.text, /\| `jnz loop` +\|/, 'the branch target as the label in the source');
  const c = await post(s.base, '/api/compare', { hex: HEX, archs: ['SKL', 'ZEN3'] }, { Accept: 'text/markdown' });
  assert.equal(c.status, 200);
  assert.match(c.headers.get('content-type'), /^text\/markdown/);
  assert.equal(c.text, markdown.cpuTable(await w.compare({ hex: HEX, archs: ['SKL', 'ZEN3'] })));
  // failures: the status as for JSON, the error as Markdown; JSON still wins when both are accepted
  const bad = await post(s.base, '/api/analyze/SKL', { source: 'frobnicate rax' }, { Accept: 'text/markdown' });
  assert.equal(bad.status, 200);
  assert.match(bad.text, /^\*\*analysis failed:\*\* assembly failed/);
  const unknown = await post(s.base, '/api/analyze/NOPE', { hex: HEX }, { Accept: 'text/markdown' });
  assert.equal(unknown.status, 404);
  assert.match(unknown.text, /^\*\*analysis failed:\*\* unknown microarchitecture/);
  const both = await post(s.base, '/api/analyze/SKL', { hex: HEX }, { Accept: 'text/markdown, application/json' });
  assert.equal(both.json?.code, 0);
});

test('analyze failures: status codes and the contract\'s {code, error, stderr}', async () => {
  // assembler error: code 2, HTTP 200 (like a failed compile in Compiler Explorer), positioned stderr
  const a = await post(s.base, '/api/analyze/SKL', { source: 'add rax, rbx\nfrobnicate rax' });
  assert.equal(a.status, 200);
  assert.equal(a.json.code, 2);
  assert.deepEqual(a.json.stderr[0].tag, { line: 2, column: 1, severity: 'error', text: "invalid instruction mnemonic 'frobnicate'" });
  assert.deepEqual(a.json, rest(await w.analyze('SKL', { source: 'add rax, rbx\nfrobnicate rax' })));
  const at = await post(s.base, '/api/analyze/SKL', { source: 'frobnicate rax' }, { Accept: 'text/plain' });
  assert.equal(at.status, 200);
  assert.match(at.text, /^<input>:1:1: error: invalid instruction mnemonic 'frobnicate'\n/);
  // bad requests: 400
  for (const body of [{}, { hex: HEX, source: ASM }, { hex: 'xyz' }, { hex: HEX, bogus: 1 }, { hex: HEX, options: { fast: true } }, { source: ASM, syntax: 'masm' }]) {
    const r = await post(s.base, '/api/analyze/SKL', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, 1);
    assert.deepEqual(r.json, rest(await w.analyze('SKL', body)));
  }
  // unknown microarchitecture: 404
  const u = await post(s.base, '/api/analyze/K8', { hex: HEX });
  assert.equal(u.status, 404);
  assert.equal(u.json.code, 1);
  assert.match(u.json.error, /^unknown microarchitecture: K8/);
  assert.equal((await post(s.base, '/api/analyze/', { hex: HEX })).status, 404);
  assert.equal((await post(s.base, '/api/analyze/%20', { hex: HEX })).status, 404); // blank: as empty
  assert.equal((await post(s.base, '/api/analyze/skl%20', { hex: HEX })).json.arch, 'SKL'); // whitespace around: ignored
  // not JSON
  const j = await post(s.base, '/api/analyze/SKL', '{"hex": ');
  assert.equal(j.status, 400);
  assert.equal(j.json.code, 1);
});

test('POST /api/compare: JSON, archs, text', async () => {
  const all = await post(s.base, '/api/compare', { hex: HEX });
  assert.equal(all.status, 200);
  assert.deepEqual(all.json, plain(await w.compare({ hex: HEX })));
  assert.equal(all.json.results.length, 15);
  const some = await post(s.base, '/api/compare', { source: ASM, archs: ['SKL', 'zen3', 'K8'] });
  assert.deepEqual(some.json, plain(await w.compare({ source: ASM, archs: ['SKL', 'zen3', 'K8'] })));
  assert.equal(some.json.results[2].code, 1);
  const t = await post(s.base, '/api/compare', { hex: HEX, archs: ['SKL', 'ZEN3'] }, { Accept: 'text/plain' });
  assert.match(t.text, /^Arch +Model +Year +TP +Bottlenecks\nSKL +Skylake +2015 +2\.00 +Dependencies\n/);
  const bad = await post(s.base, '/api/compare', { hex: HEX, archs: 'SKL' });
  assert.equal(bad.status, 400);
  const e = await post(s.base, '/api/compare', { source: 'frobnicate' });
  assert.equal(e.status, 200);
  assert.equal(e.json.code, 2);
});

test('POST /api/assemble: JSON, text, errors', async () => {
  const r = await post(s.base, '/api/assemble', { source: 'vaddps zmm0, zmm1, zmm2' });
  assert.equal(r.status, 200);
  const lib = plain(await w.assemble('vaddps zmm0, zmm1, zmm2'));
  assert.deepEqual(r.json, lib);
  assert.deepEqual(Object.keys(r.json), ['code', 'hex', 'length', 'stderr']);
  const att = await post(s.base, '/api/assemble', { source: 'addq %rbx, %rax', syntax: 'att' });
  assert.equal(att.json.hex, '4801d8');
  const t = await post(s.base, '/api/assemble', { source: 'add rax, rbx' }, { Accept: 'text/plain' });
  assert.equal(t.text, '4801d8\n');
  const e = await post(s.base, '/api/assemble', { source: 'mov rax, [' });
  assert.equal(e.status, 200);
  assert.equal(e.json.code, 2);
  assert.deepEqual(e.json, plain(await w.assemble('mov rax, [')));
  for (const body of [{ source: 'nop', hex: '90' }, { source: 'nop', syntax: 'masm' }, {}, [1]]) {
    const b = await post(s.base, '/api/assemble', body);
    assert.equal(b.status, 400, JSON.stringify(body));
    assert.equal(b.json.code, 1);
  }
});

test('unknown routes and methods', async () => {
  assert.equal((await get(s.base, '/api/nope')).status, 404);
  assert.equal((await get(s.base, '/nope')).status, 404);
  const m = await get(s.base, '/api/analyze/SKL');
  assert.equal(m.status, 405);
  assert.equal(m.json.code, 1);
  assert.match(m.headers.get('allow'), /POST/);
  assert.equal((await post(s.base, '/api/archs', {})).status, 405);
});

test('CORS: any origin, GET/POST, preflight, no credentials', async () => {
  const pre = await fetch(s.base + '/api/analyze/SKL', {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  assert.match(pre.headers.get('access-control-allow-headers'), /Content-Type/i);
  assert.equal(pre.headers.get('access-control-allow-credentials'), null);
  const g = await get(s.base, '/api/archs', { Origin: 'https://example.org' });
  assert.equal(g.headers.get('access-control-allow-origin'), '*');
  const p = await post(s.base, '/api/analyze/SKL', { hex: HEX }, { Origin: 'https://example.org' });
  assert.equal(p.headers.get('access-control-allow-origin'), '*');
  assert.equal(p.headers.get('access-control-allow-credentials'), null);
  // errors carry it too (the browser must be able to read them)
  assert.equal((await post(s.base, '/api/analyze/K8', { hex: HEX })).headers.get('access-control-allow-origin'), '*');
});

test('a whole function: its loop (`loop`), as the library reads it; a bad `loop` is a 400; compare keeps it in its parts', async () => {
  const fn = fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/loop-find/crc_a.s'), 'utf8');
  const a = await post(s.base, '/api/analyze/ZEN3', { source: fn });
  assert.equal(a.status, 200);
  assert.equal(a.json.loop.name, 'loop .L3');
  const lib = await w.analyze('ZEN3', { source: fn });
  assert.equal(a.json.hex, lib.hex);
  assert.equal(a.json.tp, lib.tp);
  const whole = await post(s.base, '/api/analyze/ZEN3', { source: fn, loop: 'whole' });
  assert.equal(whole.json.loop, undefined);
  assert.ok(whole.json.hex.length > a.json.hex.length);
  // CRLF line ends (a file saved on Windows): the same
  const crlf = await post(s.base, '/api/analyze/ZEN3', { source: fn.replace(/\n/g, '\r\n') });
  assert.equal(crlf.json.hex, a.json.hex);
  assert.equal(crlf.json.loop.name, 'loop .L3');
  const bad = await post(s.base, '/api/analyze/ZEN3', { source: fn, loop: 'inner' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 1);
  // four microarchitectures: split into parts on the two workers, each with the same loop
  const c = await post(s.base, '/api/compare', { source: fn, archs: ['SKL', 'ICL', 'ADL-P', 'ZEN3'] });
  assert.equal(c.json.code, 0);
  assert.equal(c.json.hex, lib.hex);
  assert.equal(c.json.loop.name, 'loop .L3');
  assert.equal(c.json.results.find((r) => r.arch === 'ZEN3').tp, lib.tp);
});
