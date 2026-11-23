#!/usr/bin/env node
// A small load benchmark: keeps C requests in flight for D seconds and reports requests/s and latency percentiles.
//
//   node bench/load.mjs                          # starts a server (child process, rate limit off) and runs every case
//   node bench/load.mjs --url http://127.0.0.1:8787 --case analyze-asm -c 32 -d 10
//   options: --workers N (started server), -c concurrency (default 2 x workers), -d seconds (default 5), --case NAME
//
// Cases: analyze-asm (the README's loop as assembly, SKL), analyze-hex (hex, SKL), compare (hex, all 15 models),
// archs (GET /api/archs), mcp-analyze (tools/call analyze over /mcp).

import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (names, d) => { const i = args.findIndex((a) => names.includes(a)); return i >= 0 ? args[i + 1] : d; };
const workers = Number(opt(['--workers'], os.availableParallelism()));
const concurrency = Number(opt(['-c', '--concurrency'], 2 * workers));
const duration = Number(opt(['-d', '--duration'], 5));
const only = opt(['--case'], null);
let url = opt(['--url'], null);

const LOOP = 'loop:\n add rax, [rsi]\n add rsi, 8\n dec rcx\n jnz loop\n';
const CASES = {
  'analyze-asm': { method: 'POST', path: '/api/analyze/SKL', body: { source: LOOP } },
  'analyze-hex': { method: 'POST', path: '/api/analyze/SKL', body: { hex: '4801d84801c349ffcf75f5' } },
  compare: { method: 'POST', path: '/api/compare', body: { hex: '4801d84801c349ffcf75f5' } },
  archs: { method: 'GET', path: '/api/archs' },
  'mcp-analyze': {
    method: 'POST', path: '/mcp', headers: { Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'analyze', arguments: { arch: 'SKL', source: LOOP, format: 'json' } } },
  },
};

let child = null;
if (!url) {
  child = spawn(process.execPath, [fileURLToPath(new URL('../bin/wuica-server.js', import.meta.url))], {
    env: { ...process.env, WUICA_PORT: '0', WUICA_WORKERS: String(workers), WUICA_RATE_BURST: '0', WUICA_LOG: '0', WUICA_MAX_QUEUE: '100000' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  url = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /"address":"([^"]+)"/.exec(buf);
      if (m) resolve(`http://${m[1]}`);
    });
    child.on('exit', (c) => reject(new Error(`server exited (${c})`)));
  });
}

const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
const u = new URL(url);

function request(c) {
  const payload = c.body ? JSON.stringify(c.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      agent, host: u.hostname, port: u.port, path: c.path, method: c.method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...c.headers },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(payload);
  });
}

async function run(name, c) {
  for (let i = 0; i < concurrency; i++) await request(c); // warm-up
  const lat = [];
  const statuses = {};
  const end = performance.now() + duration * 1000;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < end) {
      const t = performance.now();
      const st = await request(c);
      lat.push(performance.now() - t);
      statuses[st] = (statuses[st] ?? 0) + 1;
    }
  }));
  lat.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1);
  console.log(`${name.padEnd(12)} ${(lat.length / duration).toFixed(0).padStart(7)} req/s   p50 ${p(0.5)} ms   p99 ${p(0.99)} ms   statuses ${JSON.stringify(statuses)}`);
}

console.log(`${url}: ${child ? `${workers} workers, ` : ''}${concurrency} in flight, ${duration} s per case (${os.cpus()[0]?.model ?? ''}, ${os.availableParallelism()} CPUs)`);
for (const [name, c] of Object.entries(CASES)) if (!only || only === name) await run(name, c);
agent.destroy();
child?.kill('SIGTERM');
