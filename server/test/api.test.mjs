// Every REST endpoint, as JSON and as text, against the library's own results.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createWuica } from 'wuica';
import { start, post, get, HEX, ASM, plain } from './helpers.mjs';

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
  assert.equal(v.json.uiCA.commit, '8f24bd3');
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
    assert.deepEqual(r.json, plain(await w.analyze(arch, req)), arch);
    assert.equal(r.json.code, 0);
  }
  // case-insensitive ids, '-' optional, URL-encoded
  const r = await post(s.base, '/api/analyze/adlp', { hex: HEX });
  assert.equal(r.json.arch, 'ADL-P');
  assert.equal((await post(s.base, `/api/analyze/${encodeURIComponent('ADL-P')}`, { hex: HEX })).json.arch, 'ADL-P');
});

test('POST /api/analyze/<arch>: text/plain is uiCA\'s report', async () => {
  const r = await post(s.base, '/api/analyze/SKL', { hex: HEX }, { Accept: 'text/plain' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.equal(r.text, (await w.analyze('SKL', { hex: HEX })).text);
  assert.match(r.text, /^Throughput \(in cycles per iteration\): /);
});

test('analyze failures: status codes and the contract\'s {code, error, stderr}', async () => {
  // assembler error: code 2, HTTP 200 (like a failed compile in Compiler Explorer), positioned stderr
  const a = await post(s.base, '/api/analyze/SKL', { source: 'add rax, rbx\nfrobnicate rax' });
  assert.equal(a.status, 200);
  assert.equal(a.json.code, 2);
  assert.deepEqual(a.json.stderr[0].tag, { line: 2, column: 1, severity: 'error', text: "invalid instruction mnemonic 'frobnicate'" });
  assert.deepEqual(a.json, plain(await w.analyze('SKL', { source: 'add rax, rbx\nfrobnicate rax' })));
  const at = await post(s.base, '/api/analyze/SKL', { source: 'frobnicate rax' }, { Accept: 'text/plain' });
  assert.equal(at.status, 200);
  assert.match(at.text, /^<input>:1:1: error: invalid instruction mnemonic 'frobnicate'\n/);
  // bad requests: 400
  for (const body of [{}, { hex: HEX, source: ASM }, { hex: 'xyz' }, { hex: HEX, bogus: 1 }, { hex: HEX, options: { fast: true } }, { source: ASM, syntax: 'masm' }]) {
    const r = await post(s.base, '/api/analyze/SKL', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, 1);
    assert.deepEqual(r.json, plain(await w.analyze('SKL', body)));
  }
  // unknown microarchitecture: 404
  const u = await post(s.base, '/api/analyze/K8', { hex: HEX });
  assert.equal(u.status, 404);
  assert.equal(u.json.code, 1);
  assert.match(u.json.error, /^unknown microarchitecture: K8/);
  assert.equal((await post(s.base, '/api/analyze/', { hex: HEX })).status, 404);
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
