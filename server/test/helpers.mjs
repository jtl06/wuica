import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.js';
import { insights, detailInsights } from 'wuica';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const HEX = '4801d84801c349ffcf75f5';
export const ASM = 'top:\n  add rax, rbx\n  add rbx, rax\n  dec r15\n  jnz top\n';
export const TRAP = { hex: '48f7f1'.repeat(200), options: { minIterations: 10000, minCycles: 100000 } };

// Starts an app on an ephemeral port. Defaults for tests: 2 workers, no rate limit, no logs.
export async function start(options = {}) {
  const app = await createApp({ workers: 2, rateBurst: 0, log: false, ...options });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  return { app, base, close: () => app.close(2000) };
}

export async function post(base, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const json = res.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : undefined;
  return { status: res.status, headers: res.headers, text, json };
}

export async function get(base, p, headers = {}) {
  const res = await fetch(base + p, { headers });
  const text = await res.text();
  const json = res.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : undefined;
  return { status: res.status, headers: res.headers, text, json };
}

// The assembly sources of fixtures/extra-src (in the repository).
export function fixtureSources() {
  const dir = path.join(ROOT, 'fixtures', 'extra-src');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.s')).sort().map((f) => ({ name: f, source: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

// The library's result without the fields that do not cross the HTTP boundary (`bytes`, a Uint8Array).
export const plain = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'bytes' && v instanceof Uint8Array ? undefined : v)));
// a library result as POST /api/analyze returns it: with `insights` (the package's insights.js) on success
export const rest = (r) => { const p = plain(r); const ins = p.code === 0 ? insights(p) : null; return ins ? { ...p, insights: { ...ins, ...detailInsights(p) } } : p; };

// POST over node:http with a given agent (fetch opens one connection per parallel request, and macOS accepts at most
// 128 pending connections per listening socket: kern.ipc.somaxconn).
export function postHttp(agent, base, p, body, headers = {}) {
  const u = new URL(base + p);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      agent, host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: /^application\/json/.test(res.headers['content-type'] ?? '') ? JSON.parse(text) : undefined });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}
