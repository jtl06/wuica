// Differential test of every interface but the page: the same random requests (tests-js/fuzz-cases.mjs) through
//   lib       the npm library (packages/wuica, createWuica) -- the reference here
//   wasm      the analyzer module through web/js/engine.js in Node (what the page runs, without the browser)
//   native    the native command-line tool (crates/wuica-cli, -json)
//   npmcli    the npm package's command-line tool (-json), on every 4th case (a process per case)
//   rest      the API server (server/bin/wuica-server.js, run here on a free port): POST /api/analyze/<arch>
//   mcp-http  the server's MCP endpoint (/mcp, Streamable HTTP): tool analyze, format "both"
//   mcp-stdio the npm package's MCP server (wuica mcp, stdio): tool analyze, format "both"
// must give the same result: the analysis response (tp, mode, limits, uop table, report text, critical path, ...),
// or a failure of the same kind (code; trapped). The MCP tools give the compact form: compared with the library's
// summarize() of its result, and the text with its report.
//
//   node tests-js/interfaces.mjs [COUNT] [--seed N]       (default 150 cases, seed 1)
//
// Needs packages/wuica/dist (packages/wuica/build.sh), packages/wuica/node_modules and server/node_modules (npm ci),
// the native tool (WUICA_CLI, else target/check-fast/wuica or target/release/wuica) and data/.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fuzzCases, essence, firstDiff } from './fuzz-cases.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const seedAt = args.indexOf('--seed');
const SEED = seedAt >= 0 ? Number(args[seedAt + 1]) : 1;
const COUNT = Number(args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--seed') ?? 150);

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; if (failed <= 40) console.log(`FAIL ${what}${detail ? ': ' + String(detail).slice(0, 1500) : ''}`); } return cond; }

const PKG = path.join(ROOT, 'packages/wuica');
const need = [[path.join(PKG, 'dist/manifest.json'), 'packages/wuica/dist (run packages/wuica/build.sh)'],
  [path.join(PKG, 'node_modules'), 'packages/wuica/node_modules (npm ci)'], [path.join(ROOT, 'server/node_modules'), 'server/node_modules (npm ci)'],
  [path.join(ROOT, 'data/uarch.json'), 'data/']];
for (const [p, what] of need) if (!fs.existsSync(p)) { console.log(`missing: ${what}`); process.exit(1); }
const CLI = [process.env.WUICA_CLI, path.join(ROOT, 'target/check-fast/wuica'), path.join(ROOT, 'target/release/wuica')].find((p) => p && fs.existsSync(p));
if (!CLI) { console.log('the native tool is missing (cargo build -p wuica-cli, or set WUICA_CLI)'); process.exit(1); }

const sdk = createRequire(path.join(ROOT, 'server/package.json'));
const imp = (m) => import(pathToFileURL(sdk.resolve(m).replace('/dist/cjs/', '/dist/esm/')).href);
const { Client } = await imp('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await imp('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioClientTransport } = await imp('@modelcontextprotocol/sdk/client/stdio.js');
const { createWuica } = await import(pathToFileURL(path.join(PKG, 'lib/index.js')).href);
const { WasmEngine, makeRequest } = await import(pathToFileURL(path.join(ROOT, 'web/js/engine.js')).href);

// ---- the interfaces
const lib = await createWuica();
const uarch = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/uarch.json'), 'utf8'));
const wasmPath = path.join(ROOT, 'target/wasm32-unknown-unknown/release/wuica_wasm.wasm');
const engine = await WasmEngine.create(fs.readFileSync(wasmPath));
await engine.loadUarch(fs.readFileSync(path.join(ROOT, 'data/uarch.json')));
async function wasm(c) {
  const table = uarch.configs[c.arch].name;
  if (!engine.hasArch(table)) await engine.loadArch(table, fs.readFileSync(path.join(ROOT, 'data/arch', `${table}.json`)));
  return engine.analyze(makeRequest(c.hex, c.arch, c.options));
}

const cliArgs = (c) => {
  const a = [c.hex, '-arch', c.arch, '-json'];
  for (const [k, v] of Object.entries(c.options)) {
    if (v === true) a.push(k === 'includeTrace' ? '-trace' : `-${k}`);
    else if (v !== false) a.push(`-${k}`, String(v));
  }
  return a;
};
function runProc(cmd, argv, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
async function native(c) {
  const r = await runProc(CLI, [...cliArgs(c), '-data', path.join(ROOT, 'data')]);
  if (r.code !== 0) return { error: r.err.trim(), exit: r.code };
  return JSON.parse(r.out);
}
async function npmcli(c) {
  const r = await runProc(process.execPath, [path.join(PKG, 'bin/wuica.js'), ...cliArgs(c)]);
  try { return JSON.parse(r.out); } catch { return { error: r.err.trim() || r.out, exit: r.code }; }
}

// the server, as it is deployed (its own process), on a free port, without a rate limit
const server = spawn(process.execPath, [path.join(ROOT, 'server/bin/wuica-server.js')], {
  cwd: ROOT, env: { ...process.env, WUICA_PORT: '0', WUICA_WORKERS: '2', WUICA_RATE_BURST: '0', WUICA_LOG: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
});
process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* gone */ } }); // also when a check throws
const base = await new Promise((resolve, reject) => {
  let buf = '';
  server.stdout.on('data', (d) => { buf += d; const m = /"address":"([^"]+)"/.exec(buf); if (m) resolve(`http://${m[1]}`); });
  server.on('exit', (code) => reject(new Error(`the server exited (${code})`)));
});
async function rest(c) {
  const res = await fetch(`${base}/api/analyze/${encodeURIComponent(c.arch)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hex: c.hex, options: c.options }) });
  const j = await res.json();
  j.status = res.status;
  return j;
}
const mcpHttp = new Client({ name: 'wuica-interfaces', version: '0' });
await mcpHttp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
const mcpStdio = new Client({ name: 'wuica-interfaces', version: '0' });
const stdio = new StdioClientTransport({ command: process.execPath, args: [path.join(PKG, 'bin/wuica.js'), 'mcp'], cwd: ROOT, stderr: 'ignore' });
await mcpStdio.connect(stdio);
process.on('exit', () => { try { process.kill(stdio.pid, 'SIGTERM'); } catch { /* gone */ } });
process.on('uncaughtException', (e) => { console.log(`FAIL the test ran to the end: ${e?.stack ?? e}`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log(`FAIL the test ran to the end: ${e?.stack ?? e}`); process.exit(1); });
async function mcp(client, c) {
  const r = await client.callTool({ name: 'analyze', arguments: { arch: c.arch, hex: c.hex, options: c.options, format: 'both' } });
  const first = JSON.parse(r.content[0].text);
  return { isError: !!r.isError, summary: first, text: r.content[1]?.text ?? null };
}

// ---- the cases
const cases = fuzzCases({ seed: SEED, count: COUNT });
console.log(`interfaces: ${cases.length} cases (seed ${SEED}); native tool ${path.relative(ROOT, CLI)}; server ${base}`);
const tally = { ok: 0, failed: 0, trapped: 0 };
const diffs = new Map(); // interface -> number of cases that differ
const compared = (name, c, detail) => {
  if (!detail) { count++; return; }
  diffs.set(name, (diffs.get(name) ?? 0) + 1);
  check(false, `${name} differs from the library on case ${c.id} (${c.arch} ${JSON.stringify(c.options)} hex ${c.hex.slice(0, 60)}${c.hex.length > 60 ? '…' : ''})`, JSON.stringify(detail));
};
const t0 = Date.now();
for (const [i, c] of cases.entries()) {
  const ref = await lib.analyze(c.arch, { hex: c.hex, options: c.options });
  const want = essence(ref);
  tally[ref.code === 0 ? 'ok' : ref.trapped ? 'trapped' : 'failed']++;
  const [w, n, r, mh, ms, nc] = await Promise.all([wasm(c), native(c), rest(c), mcp(mcpHttp, c), mcp(mcpStdio, c), i % 4 === 0 ? npmcli(c) : null]);
  for (const [name, got] of [['wasm', w], ['native', n], ['rest', r], ['npmcli', nc]]) {
    if (got === null) continue;
    let e = essence(got);
    // a trap: the native tool aborts (a Rust panic) instead of trapping; only its failure is compared
    if (name === 'native' && want.failed) e = { failed: !!e.failed, trapped: want.trapped };
    if (name === 'wasm' && want.failed) e = { failed: !!e.failed, trapped: !!got.trapped };
    compared(name, c, firstDiff(want, e));
  }
  // the REST status: 200 for a result and for a failed analysis (code 3)
  if (!check(r.status === 200 && r.code === ref.code, `rest: status 200 and the same code (case ${c.id})`, JSON.stringify([r.status, r.code, ref.code]))) diffs.set('rest', (diffs.get('rest') ?? 0) + 1);
  // the MCP tools: the compact form of the library's result, and its report
  const summary = lib.summarize(ref);
  for (const [name, got] of [['mcp-http', mh], ['mcp-stdio', ms]]) {
    const wantS = ref.code === 0 ? summary : { code: ref.code, trapped: !!ref.trapped };
    const gotS = ref.code === 0 ? got.summary : { code: got.summary.code, trapped: !!got.summary.trapped };
    const d = firstDiff(wantS, gotS) ?? (ref.code === 0 && got.text !== ref.text ? { path: 'text', a: ref.text.slice(0, 200), b: String(got.text).slice(0, 200) } : null)
      ?? (got.isError !== (ref.code !== 0) ? { path: 'isError', a: ref.code !== 0, b: got.isError } : null);
    compared(name, c, d);
  }
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1} cases, ${Math.round((Date.now() - t0) / 1000)} s`);
}

// uiCA's ablation variants (not listed, but accepted) and the trace, through the interfaces that take them
for (const [i, c] of [
  { arch: 'CLX_noLSD', hex: '4801d84801c349ffcf75f5', options: {} }, { arch: 'CLX_noLSDUnrolling', hex: '4801d84801c349ffcf75f5', options: { noMacroFusion: true } },
  { arch: 'CLX_noMoveElim', hex: '4889c34889d84883c00149ffcf75f1', options: {} }, { arch: 'CLX_fullMoveElim', hex: '4889c34889d84883c00149ffcf75f1', options: {} },
  { arch: 'SKL', hex: '4801d84801c349ffcf75f5', options: { includeTrace: true } }, { arch: 'ZEN3', hex: '4883c00149ffcf75f7', options: { includeTrace: true, minIterations: 3 } },
].entries()) {
  c.id = `extra:${i}`;
  const ref = await lib.analyze(c.arch, { hex: c.hex, options: c.options });
  check(ref.code === 0 && (!c.options.includeTrace || (ref.trace && Array.isArray(ref.trace.cycles))), `extra case ${c.id}: the library gives a result`, JSON.stringify(ref.error ?? ''));
  const want = { ...essence(ref), trace: ref.trace ?? null };
  for (const [name, got] of [['wasm', await wasm(c)], ['native', await native(c)], ['rest', await rest(c)]]) {
    compared(name, c, firstDiff(want, { ...essence(got), trace: got.trace ?? null }));
  }
}

// a few requests that must fail the same way everywhere (a bad request: code 1; REST status 400)
const bad = [
  { what: 'unknown arch', arch: 'K8', hex: '4801d8', options: {}, code: 1, status: 404 },
  { what: 'odd hex', arch: 'SKL', hex: '48d', options: {}, code: 1, status: 400 },
  { what: 'unknown option', arch: 'SKL', hex: '4801d8', options: { minIteration: 5 }, code: 1, status: 400 },
  { what: 'bad option value', arch: 'SKL', hex: '4801d8', options: { initPolicy: 'bogus' }, code: 1, status: 400 },
  { what: 'option of the wrong type', arch: 'SKL', hex: '4801d8', options: { alignmentOffset: '3' }, code: 1, status: 400 },
];
for (const b of bad) {
  const l = await lib.analyze(b.arch, { hex: b.hex, options: b.options });
  const r = await rest(b);
  check(l.code === b.code && r.code === b.code && r.status === b.status, `${b.what}: code ${b.code} from the library and the REST API (status ${b.status})`, JSON.stringify([l.code, r.code, r.status]));
}

console.log(`results of the library: ${tally.ok} ok, ${tally.failed} failed, ${tally.trapped} trapped; differences: ${diffs.size ? JSON.stringify(Object.fromEntries(diffs)) : 'none'} (${Math.round((Date.now() - t0) / 1000)} s)`);
await mcpHttp.close();
await mcpStdio.close();
server.kill('SIGTERM');
console.log(`${count} interface checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
