// Per-request limits: body, source, instructions, simulation options, compare.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start, post, HEX, TRAP } from './helpers.mjs';

let s;
before(async () => { s = await start(); });
after(() => s.close());

test('body larger than 256 KB: 413 (declared length and chunked)', async () => {
  const big = JSON.stringify({ source: 'nop\n'.repeat(70_000) });
  assert.ok(big.length > 256 * 1024);
  const r = await post(s.base, '/api/analyze/SKL', big);
  assert.equal(r.status, 413);
  assert.equal(r.json.code, 1);
  assert.match(r.json.error, /256 KB/);
  // chunked (no Content-Length)
  const status = await new Promise((resolve, reject) => {
    const u = new URL(s.base + '/api/analyze/SKL');
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    for (let i = 0; i < 40; i++) req.write('x'.repeat(8192));
    req.end();
  });
  assert.equal(status, 413);
  // also on /mcp
  assert.equal((await post(s.base, '/mcp', big, { Accept: 'application/json, text/event-stream' })).status, 413);
});

test('source larger than 64 KB, hex longer than 64 K characters: 413', async () => {
  const r = await post(s.base, '/api/analyze/SKL', { source: 'nop\n'.repeat(17_000) });
  assert.equal(r.status, 413);
  assert.equal(r.json.code, 1);
  assert.match(r.json.error, /`source` is larger than 64 KB/);
  assert.equal((await post(s.base, '/api/analyze/SKL', { hex: '90'.repeat(33_000) })).status, 413);
  assert.equal((await post(s.base, '/api/assemble', { source: 'nop\n'.repeat(17_000) })).status, 413);
  assert.equal((await post(s.base, '/api/compare', { source: 'nop\n'.repeat(17_000) })).status, 413);
});

test('more than 10,000 instructions: 400', async () => {
  // hex: 10,001 one-byte instructions
  const h = await post(s.base, '/api/analyze/SKL', { hex: '90'.repeat(10_001) });
  assert.equal(h.status, 400);
  assert.equal(h.json.code, 1);
  assert.match(h.json.error, /too many instructions: 10001/);
  // exactly 10,000: accepted
  const ok = await post(s.base, '/api/analyze/SKL', { hex: '90'.repeat(10_000) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.code, 0);
  // 3,334 three-byte instructions (> 10,000 bytes, decoded and counted): accepted
  assert.equal((await post(s.base, '/api/analyze/SKL', { hex: '4801d8'.repeat(3334) })).json.code, 0);
  // assembly that expands (.rept), small source
  const rept = await post(s.base, '/api/analyze/SKL', { source: '.rept 20000\nadd rax, rbx\n.endr\n' });
  assert.equal(rept.status, 400);
  assert.match(rept.json.error, /too many instructions: 20000/);
  // GNU as's {load} hint is removed at the start of a line, before the directive
  const hinted = await post(s.base, '/api/analyze/SKL', { source: '{load}.rept 20000\nnop\n{load}.endr\n' });
  assert.equal(hinted.status, 400, hinted.text.slice(0, 200));
  assert.match(hinted.json.error, /too many instructions: 20000/);
  // expands to more than 15 bytes per allowed instruction: refused without decoding
  const fill = await post(s.base, '/api/analyze/SKL', { source: '.fill 200000, 1, 0x90\n' });
  assert.equal(fill.status, 400);
  assert.match(fill.json.error, /too many instructions: 200000 bytes of machine code/);
  // compare too
  assert.equal((await post(s.base, '/api/compare', { source: '.rept 10001\nnop\n.endr' })).status, 400);
  // MCP: a tool error
  const m = await mcpCall('analyze', { arch: 'SKL', hex: '90'.repeat(10_001) });
  assert.equal(m.result.isError, true);
  assert.match(m.result.content[0].text, /too many instructions/);
});

test('minIterations / minCycles above the caps: 400 (not clamped)', async () => {
  for (const options of [{ minIterations: 1001 }, { minCycles: 20_001 }, TRAP.options]) {
    const r = await post(s.base, '/api/analyze/SKL', { hex: HEX, options });
    assert.equal(r.status, 400, JSON.stringify(options));
    assert.equal(r.json.code, 1);
    assert.match(r.json.error, /the limit of this server is (1000|20000)/);
  }
  // at the caps: accepted
  const ok = await post(s.base, '/api/analyze/SKL', { hex: HEX, options: { minIterations: 1000, minCycles: 20_000 } });
  assert.equal(ok.json.code, 0);
  // compare and MCP use the same caps
  assert.equal((await post(s.base, '/api/compare', { hex: HEX, options: { minCycles: 50_000 } })).status, 400);
  const m = await mcpCall('analyze', { arch: 'SKL', hex: HEX, options: { minIterations: 5000 } });
  assert.equal(m.result.isError, true);
  assert.match(m.result.content[0].text, /minIterations/);
});

test('the trap input of the package\'s tests is refused by the caps', async () => {
  const r = await post(s.base, '/api/analyze/SKL', TRAP);
  assert.equal(r.status, 400);
  assert.equal((await post(s.base, '/api/analyze/SKL', { hex: HEX })).json.code, 0);
});

test('compare: at most all listed microarchitectures', async () => {
  const r = await post(s.base, '/api/compare', { hex: HEX, archs: Array(16).fill('SKL') });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /at most 15/);
  assert.equal((await post(s.base, '/api/compare', { hex: HEX, archs: Array(15).fill('SKL') })).json.code, 0);
});

async function mcpCall(name, args) {
  const r = await post(s.base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { Accept: 'application/json, text/event-stream' });
  assert.equal(r.status, 200);
  return r.json;
}
