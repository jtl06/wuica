#!/usr/bin/env node
// Runs the test suites of the repository in parallel; called by scripts/check.sh (which sets up PATH, sccache and --remote).
//
//   node scripts/check.mjs [quick|full] [--only PATTERN] [--part PART] [--jobs N] [--chrome-jobs N|auto] [--no-wasm-build] [--wasm-only] [--no-skip] [--list]
//
// - Builds first, each skipped while its inputs are unchanged (content hash stamps in target/check/stamps/): the Rust test
//   binaries (profile check-fast, cargo decides), the WebAssembly module (./build-wasm.sh, release profile), the site
//   (web/build.sh) and the npm package's dist/ (packages/wuica/build.sh).
// - Suites: every Rust test binary of the workspace (unit tests together as one suite), tests-js/analyze_fixtures.mjs,
//   tests-js/decode_fixtures.mjs, every tests-js/web_*.mjs (found by glob; those that start Chrome are "browser" suites, at
//   most --chrome-jobs of them at a time), the npm package's and the API server's tests, tests-js/interfaces.mjs, and the
//   type check (scripts/typecheck.mjs).
// - Serial suites: the suites whose checks bound wall-clock or frame time (see SERIAL below) run one at a time, after every
//   other suite has finished, with nothing beside them; the other browser suites run --chrome-jobs at a time.
// --chrome-jobs N: default $WUICA_CHROME_JOBS, else 2; 'auto' is a quarter of the CPUs, 2 to 16 (scripts/check-remote.sh
//   sets it on the check runner).
// - quick: the simulation fixtures only for a few configurations, analyze_fixtures on every 7th case, web_trace on every 16th
//   case, browser suites only if their last run took at most 10 s, no npm package or server, no doc tests. full: everything,
//   including the simulation fixtures of the set 'more' (fixtures/generated/more_sim_fixtures.jsonl.gz) if present.
// - Each suite's output goes to target/check/<suite>.log; at the end one table, and the tail of the logs of failed suites;
//   the table also as target/check/results.json. The exit status is 1 if anything failed.
// --only PATTERN: only the suites whose name matches the regular expression (and the builds they need).
// --part PART: one part of the suites, for running them on several machines (together the parts are every suite once):
//   main (every suite that is not a browser suite; its serial ones at its end), serial (the serial browser suites),
//   browser:K/N (the K-th of N groups of the other browser suites: every N-th by name).
// --no-skip: a skipped suite (e.g. no Chrome, or a suite that skipped itself) counts as a failure (CI).
// With $GITHUB_STEP_SUMMARY set (GitHub Actions), the table is also appended to that file as Markdown.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../tests-js/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'target');
const RUST_TARGET = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : TARGET;
const OUT = path.join(TARGET, 'check');
const STAMPS = path.join(OUT, 'stamps');
// always in ./target: the suites and web/build.sh look for it there
const WASM = path.join(TARGET, 'wasm32-unknown-unknown/release/wuica_wasm.wasm');
const PROFILE = 'check-fast';
const MORE_SIM = path.join(ROOT, 'fixtures/generated/more_sim_fixtures.jsonl.gz');

// ---- options
const argv = process.argv.slice(2);
const opts = { mode: 'quick', only: null, part: null, jobs: 0, chromeJobs: null, noWasmBuild: false, wasmOnly: false, noSkip: false, list: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === 'quick' || a === 'full') opts.mode = a;
  else if (a === '--only') opts.only = new RegExp(argv[++i], 'i');
  else if (a === '--part') opts.part = argv[++i];
  else if (a === '--jobs' || a === '-j') opts.jobs = Number(argv[++i]);
  else if (a === '--chrome-jobs') opts.chromeJobs = argv[++i];
  else if (a === '--no-wasm-build') opts.noWasmBuild = true;
  else if (a === '--wasm-only') opts.wasmOnly = true;
  else if (a === '--no-skip') opts.noSkip = true;
  else if (a === '--list') opts.list = true;
  else { console.error(`check: unknown argument ${a}\nusage: scripts/check.sh [quick|full] [--only PATTERN] [--part PART] [--jobs N] [--chrome-jobs N|auto] [--no-skip] [--remote HOST] [--list]`); process.exit(2); }
}
const part = opts.part === null ? null : /^(main|serial)$|^browser:(\d+)\/(\d+)$/.exec(opts.part);
if (opts.part !== null && !(part && (!part[2] || (+part[2] >= 1 && +part[2] <= +part[3])))) { console.error(`check: --part main, serial or browser:K/N (1 <= K <= N), not ${opts.part}`); process.exit(2); }
const QUICK = opts.mode === 'quick';
const CPUS = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const JOBS = opts.jobs > 0 ? opts.jobs : CPUS;
const chromeJobsArg = String(opts.chromeJobs ?? process.env.WUICA_CHROME_JOBS ?? 2);
const CHROME_JOBS = chromeJobsArg === 'auto' ? Math.max(2, Math.min(16, Math.floor(CPUS / 4))) : Number(chromeJobsArg);
if (!(Number.isInteger(CHROME_JOBS) && CHROME_JOBS >= 1)) { console.error(`check: --chrome-jobs (or WUICA_CHROME_JOBS) must be a number from 1 or auto, not ${chromeJobsArg}`); process.exit(2); }

// ---- per-suite settings for the two modes
// A suite can run as several variants (each a row in the table) with different environments:
// quick: the simulation fixtures for a few configurations (the test's own filter WUICA_ARCH);
// full: analyze_fixtures (every case, single-threaded, the longest suite) in 4 parallel shards (WUICA_SHARD), and
// web_noscroll_browser (13 cases, the longest browser suite) in 8
const shards = (n) => [...Array(n).keys()].map((k) => ({ tag: `${k + 1}/${n}`, env: { WUICA_SHARD: `${k}/${n}` } }));
const VARIANTS = {
  quick: { 'wuica-core:sim_fixtures': ['SKL', 'ZEN3'].map((a) => ({ tag: a, env: { WUICA_ARCH: a } })) },
  full: {
    analyze_fixtures: shards(4),
    web_noscroll_browser: shards(8),
    // the set 'more' (cases with options and the -json output), if present
    ...(fs.existsSync(MORE_SIM) ? { 'wuica-core:sim_fixtures': [{ tag: 'main+extra', env: {} }, { tag: 'more', env: { WUICA_SET: 'more', WUICA_MORE_SIM_FIXTURES: MORE_SIM } }] } : {}),
  },
};
const variants = (name) => VARIANTS[opts.mode][name] ?? [{ tag: null, env: {} }];
const ARGS = {
  quick: { analyze_fixtures: ['7'], web_trace: ['16'], web_interfaces_browser: ['60', '8'] },
  full: { analyze_fixtures: ['1'] },
};
const QUICK_BROWSER_MAX_S = 10; // quick runs a browser suite only if its last run took at most this long
// Serial suites: those whose checks bound wall-clock or frame time, which other suites running beside them would make fail
// without a fault of the code. Each runs alone, after all other suites. A browser suite is serial if it imports one of
// tests-js/cdp.mjs's timing bounds (FRAME_MS, LONG_TASK_MS, TIMING_SLACK: the "under a frame" and "no long task" checks);
// any suite is if it is listed here, with the reason.
const SERIAL = {
  web_asm_tokens: 'bounds in ms (a 200 KB line, the pathological lines, the SHA-256 showcase): 245 ms of 500 alone on the check runner, 507 to 515 ms beside the other suites',
  web_robust_browser: 'bounds of its own in ms: a huge .rept leaves no gap over 1 s, a new assembly supersedes within 2.5 s, Cancel within 1 s, hex at once within 5 s',
  web_host_browser: "types every 200 ms while an update waits for the page's 1.2 s quiet time (no reload while typing); which requests come before the first result",
  web_upgrade_browser: "its scenarios hold a page's update reload with a key press every 200 ms against the 1.2 s quiet time, and wait for a deploy's worker to take over; two profiles run side by side",
  web_sw_update_browser: "its race needs a page held 6 s at its start while another tab's update check lands, sampled every 250 ms: beside other suites the race did not happen, or its states were missed (4 of 48 runs, 8 at a time)",
};
const TIMING_BOUND = /\b(FRAME_MS|LONG_TASK_MS|TIMING_SLACK)\b/;

// ---- helpers
const rel = (p) => path.relative(ROOT, p) || '.';
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)}s`);
const logName = (name) => name.replace(/[^\w.+-]+/g, '_');

/** sha256 over the paths and contents of files and directories (followed through symlinks), plus extra strings */
function hashInputs(paths, extra = []) {
  const skip = (r) => /(^|\/)(\.DS_Store|node_modules|\.git)$/.test(r) || r === 'web/dist' || r === 'packages/wuica/dist' || /^crates\/[^/]+\/tests$/.test(r);
  const h = crypto.createHash('sha256');
  const walk = (r) => {
    const abs = path.isAbsolute(r) ? r : path.join(ROOT, r);
    let st;
    try { st = fs.statSync(abs); } catch { h.update(`${r}\0missing\0`); return; }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs).sort()) if (!skip(`${r}/${e}`)) walk(`${r}/${e}`);
    } else {
      h.update(`${r}\0`); h.update(fs.readFileSync(abs)); h.update('\0');
    }
  };
  paths.forEach(walk);
  for (const x of extra) h.update(`${x}\0`);
  return h.digest('hex');
}

let previous = {};
try { previous = JSON.parse(fs.readFileSync(path.join(OUT, 'times.json'), 'utf8')); } catch {}

// ---- running a command into a log file
const running = new Set();
function exec(cmd, args, { cwd = ROOT, env = {}, log, timeout = 20 * 60 } = {}) {
  return new Promise((resolve) => {
    const fd = fs.openSync(log, 'a');
    fs.writeSync(fd, `$ ${[cmd, ...args].join(' ')}   (in ${rel(cwd)})\n`);
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], detached: true });
    running.add(child);
    const timer = setTimeout(() => { fs.writeSync(fd, `\ncheck: timeout after ${timeout} s\n`); kill(child); }, timeout * 1000);
    const done = (code) => { clearTimeout(timer); running.delete(child); fs.closeSync(fd); resolve(code); };
    child.on('error', (e) => { fs.writeSync(fd, `\ncheck: ${e.message}\n`); done(127); });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}
function kill(child) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const c of running) kill(c); process.exit(130); });

// cargo with JSON messages: the artifacts on stdout (parsed), the rendered diagnostics on stderr (to the log)
function cargoJson(args, log, env = {}) {
  return new Promise((resolve) => {
    const fd = fs.openSync(log, 'a');
    fs.writeSync(fd, `$ cargo ${args.join(' ')}\n`);
    const child = spawn('cargo', [...args, '--message-format=json-render-diagnostics'], { cwd: ROOT, env: { ...process.env, CARGO_TARGET_DIR: RUST_TARGET, ...env }, stdio: ['ignore', 'pipe', fd], detached: true });
    running.add(child);
    let buf = '';
    const artifacts = [];
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const m = JSON.parse(line); if (m.reason === 'compiler-artifact' && m.executable) artifacts.push(m); } catch { fs.writeSync(fd, line + '\n'); }
      }
    });
    child.on('error', (e) => { fs.writeSync(fd, `check: ${e.message}\n`); });
    child.on('close', (code) => { running.delete(child); fs.closeSync(fd); resolve({ code: code ?? 1, artifacts }); });
  });
}

// ---- count lines
function rustCount(out) {
  let passed = 0, failed = 0;
  for (const m of out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) { passed += +m[1]; failed += +m[2]; }
  const cases = out.split('\n').find((l) => /\b\d+ cases\b/.test(l) && !l.startsWith('$'));
  const compared = [...out.matchAll(/^\s*(\d+) compared\s*$/gm)].map((m) => m[1]);
  const info = cases ? cases.trim().replace(/^\.+/, '') : compared.length ? `${compared.join(' + ')} compared` : '';
  return `${passed} passed${failed ? `, ${failed} failed` : ''}${info ? `; ${info}` : ''}`;
}
function nodeTestCount(out) {
  // the spec reporter prints "ℹ tests 32", the TAP reporter (Node 22 without a terminal) "# tests 32"
  const g = (k) => (out.match(new RegExp(`^(?:ℹ|#) ${k} (\\d+)`, 'm')) || [])[1];
  return `${g('tests') ?? '?'} tests, ${g('pass') ?? '?'} pass, ${g('fail') ?? '?'} fail${+g('skipped') ? `, ${g('skipped')} skipped` : ''}`;
}
function jsCount(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('$ '));
  return [...lines].reverse().find((l) => /\b\d+ [\w ]*(cases|checks|tests)\b/i.test(l)) || lines.at(-1) || '';
}

// ---- the plan
const tasks = new Map();
function task(t) { tasks.set(t.name, { deps: [], weight: 1, browser: false, serial: false, ...t }); }

/** a build that is skipped while the hash of its inputs is unchanged and its outputs exist */
function stamped(name, inputs, outputs, run) {
  return async (log) => {
    const hash = inputs();
    const stamp = path.join(STAMPS, name);
    let old = null;
    try { old = fs.readFileSync(stamp, 'utf8'); } catch {}
    if (old === hash && outputs.every(exists)) { fs.appendFileSync(log, `up to date (inputs ${hash.slice(0, 12)})\n`); return { status: 'pass', count: 'up to date' }; }
    const r = await run(log);
    if (r.status === 'pass') { fs.mkdirSync(STAMPS, { recursive: true }); fs.writeFileSync(stamp, hash); }
    return r;
  };
}

// Rust: the targets from cargo metadata; the executables are known after the build
const meta = JSON.parse(spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '{"packages":[]}');
const executables = new Map(); // `${manifest}|${target}|${kind}` -> path
let cliBinary = null;
const rustHalf = Math.max(1, Math.ceil(JOBS / 2));

task({
  name: 'build:rust', kind: 'build', weight: rustHalf, run: async (log) => {
    const r = await cargoJson(['test', '--profile', PROFILE, '--workspace', '--no-run'], log);
    for (const a of r.artifacts) if (a.profile.test) executables.set(`${a.manifest_path}|${a.target.name}|${a.target.kind[0]}`, a.executable);
    if (r.code) return { status: 'fail', count: `cargo test --no-run: exit ${r.code}` };
    const b = await cargoJson(['build', '--profile', PROFILE, '-p', 'wuica-cli'], log);
    cliBinary = b.artifacts.find((a) => a.target.kind.includes('bin'))?.executable ?? null;
    if (b.code) return { status: 'fail', count: `cargo build -p wuica-cli: exit ${b.code}` };
    return { status: 'pass', count: `${executables.size} test binaries (profile ${PROFILE})` };
  },
});

for (const p of meta.packages) {
  for (const t of p.targets) {
    if (t.kind[0] !== 'test') continue;
    const base = `${p.name}:${t.name}`;
    for (const v of variants(base)) {
      task({
        name: v.tag ? `${base}[${v.tag}]` : base, kind: 'rust', deps: ['build:rust'], weight: Math.min(4, JOBS),
        run: async (log) => {
          const exe = executables.get(`${p.manifest_path}|${t.name}|test`);
          if (!exe) return { status: 'fail', count: 'no executable from the build' };
          const code = await exec(exe, ['--show-output'], { cwd: path.dirname(p.manifest_path), env: v.env, log });
          return { status: code ? 'fail' : 'pass', count: rustCount(fs.readFileSync(log, 'utf8')) };
        },
      });
    }
  }
}
task({
  name: 'rust:unit', kind: 'rust', deps: ['build:rust'], run: async (log) => {
    // every test executable of the build that is not an integration test: the unit tests of libraries (lib, cdylib, ...) and binaries
    let worst = 0;
    for (const [key, exe] of executables) {
      const [manifest, , kind] = key.split('|');
      if (kind !== 'test') worst = Math.max(worst, await exec(exe, ['--show-output'], { cwd: path.dirname(manifest), log }));
    }
    return { status: worst ? 'fail' : 'pass', count: rustCount(fs.readFileSync(log, 'utf8')) };
  },
});
if (!QUICK) {
  task({
    name: 'rust:doc', kind: 'rust', deps: ['build:rust'], weight: rustHalf, run: async (log) => {
      const code = await exec('cargo', ['test', '--profile', PROFILE, '--workspace', '--doc'], { env: { CARGO_TARGET_DIR: RUST_TARGET }, log });
      return { status: code ? 'fail' : 'pass', count: rustCount(fs.readFileSync(log, 'utf8')) };
    },
  });
}

// WebAssembly, site, npm package
const rustcVersion = (spawnSync('rustc', ['-V'], { encoding: 'utf8' }).stdout || '').trim();
const LICENSES = ['LICENSE', 'third_party/xed/LICENSE', 'assembler/LICENSE-LLVM.txt'];
task({
  name: 'build:wasm', kind: 'build', weight: rustHalf,
  run: opts.noWasmBuild
    ? async (log) => (exists(WASM) ? (fs.appendFileSync(log, `using ${rel(WASM)} as it is (--no-wasm-build)\n`), { status: 'pass', count: 'prebuilt (not rebuilt here)' }) : { status: 'fail', count: `${rel(WASM)} missing (--no-wasm-build)` })
    : stamped('wasm', () => hashInputs(['crates', 'third_party', 'build-wasm.sh', 'Cargo.toml', 'Cargo.lock'], [rustcVersion]), [WASM], async (log) => {
      // build-wasm.sh writes to ./target (the paths are fixed), whatever CARGO_TARGET_DIR is
      const env = { ...process.env }; delete env.CARGO_TARGET_DIR;
      const code = await new Promise((resolve) => {
        const fd = fs.openSync(log, 'a');
        const c = spawn('./build-wasm.sh', [], { cwd: ROOT, env, stdio: ['ignore', fd, fd], detached: true });
        running.add(c);
        c.on('exit', (code) => { running.delete(c); fs.closeSync(fd); resolve(code ?? 1); });
      });
      return { status: code ? 'fail' : 'pass', count: code ? `exit ${code}` : `rebuilt, ${(fs.statSync(WASM).size / 1e6).toFixed(1)} MB` };
    }),
});
task({
  name: 'build:web', kind: 'build', deps: ['build:wasm'],
  run: stamped('web', () => hashInputs(['web', 'data', 'assembler/dist/wuica_asm.wasm', ...LICENSES, WASM]), [path.join(ROOT, 'web/dist/manifest.json')], async (log) => {
    const code = await exec('web/build.sh', [], { env: { WUICA_WASM: WASM }, log });
    return { status: code ? 'fail' : 'pass', count: code ? `exit ${code}` : 'rebuilt' };
  }),
});
const PKG = path.join(ROOT, 'packages/wuica');
if (!QUICK) {
  task({
    name: 'build:npm', kind: 'build', deps: ['build:wasm'],
    run: async (log) => {
      // (also when the installation predates TypeScript: installing later, in the typecheck task, would replace
      // node_modules under the package's running tests)
      if (!exists(path.join(PKG, 'node_modules/typescript'))) {
        const code = await exec('npm', ['ci', '--no-audit', '--no-fund'], { cwd: PKG, log });
        if (code) return { status: 'fail', count: `npm ci: exit ${code}` };
      }
      // (the binary tables come from data/ through tools/encode-tables.sh and the core's table_bin.rs)
      // (and the page's modules it copies into lib/web: web/js, web-modules.json)
      return stamped('npm', () => hashInputs(['packages/wuica/build.sh', 'packages/wuica/copy-web.mjs', 'packages/wuica/web-modules.json', 'web/js', 'data', 'assembler/dist/wuica_asm.wasm', 'tools/encode-tables.sh', 'crates/wuica-core/src', 'crates/wuica-core/examples', ...LICENSES, WASM]), [path.join(PKG, 'dist/manifest.json')], async (log) => {
        const code = await exec('./build.sh', [], { cwd: PKG, env: { WUICA_WASM: WASM }, log });
        return { status: code ? 'fail' : 'pass', count: code ? `exit ${code}` : 'rebuilt' };
      })(log);
    },
  });
  task({
    name: 'npm:wuica', kind: 'js', deps: ['build:npm', 'build:rust'], weight: 2,
    run: async (log) => {
      const code = await exec('node', ['--test'], { cwd: PKG, env: cliBinary ? { WUICA_CLI: cliBinary } : {}, log });
      return { status: code ? 'fail' : 'pass', count: nodeTestCount(fs.readFileSync(log, 'utf8')) };
    },
  });
  // the API server (server/): its dependencies (the package is a file: dependency, so after build:npm)
  const SERVER = path.join(ROOT, 'server');
  task({
    name: 'build:server', kind: 'build', deps: ['build:npm'],
    run: async (log) => {
      if (exists(path.join(SERVER, 'node_modules'))) { fs.appendFileSync(log, 'server/node_modules present\n'); return { status: 'pass', count: 'node_modules present' }; }
      const code = await exec('npm', ['ci', '--no-audit', '--no-fund'], { cwd: SERVER, log });
      return { status: code ? 'fail' : 'pass', count: code ? `npm ci: exit ${code}` : 'npm ci' };
    },
  });
  task({
    name: 'npm:server', kind: 'js', deps: ['build:server'], weight: 2,
    run: async (log) => {
      const code = await exec('node', ['--test', '--test-concurrency=1', ...fs.readdirSync(path.join(SERVER, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `test/${f}`)], { cwd: SERVER, log });
      return { status: code ? 'fail' : 'pass', count: nodeTestCount(fs.readFileSync(log, 'utf8')) };
    },
  });
  // tsc --noEmit --checkJs over the package, the server and the shared page modules (TypeScript: a development
  // dependency of the package; build:server for the server's imports)
  task({
    name: 'typecheck', kind: 'js', deps: ['build:npm', 'build:server'],
    run: async (log) => {
      const code = await exec('node', ['scripts/typecheck.mjs'], { log });
      const m = /(\d+ files type-checked, \d+ errors)/.exec(fs.readFileSync(log, 'utf8'));
      return { status: code ? 'fail' : 'pass', count: m ? m[1] : `exit ${code}` };
    },
  });
  // the same random requests through the library, the native and npm tools, the server's REST and MCP, the stdio MCP
  task({
    name: 'interfaces', kind: 'js', deps: ['build:server', 'build:rust', 'build:wasm'], weight: 2,
    run: async (log) => {
      const code = await exec('node', ['tests-js/interfaces.mjs', '300'], { env: cliBinary ? { WUICA_CLI: cliBinary } : {}, log });
      return { status: code ? 'fail' : 'pass', count: jsCount(fs.readFileSync(log, 'utf8')) };
    },
  });
}

// JavaScript suites
const chrome = findChrome();
const jsSuites = ['analyze_fixtures', 'decode_fixtures', ...fs.readdirSync(path.join(ROOT, 'tests-js')).filter((f) => /^web_.*\.mjs$/.test(f)).sort().map((f) => f.slice(0, -4))];
for (const name of jsSuites) {
  const file = path.join(ROOT, 'tests-js', `${name}.mjs`);
  // (a browser suite by its name too: the newer ones start Chrome through tests-js/cdp.mjs and name no flag)
  const src = fs.readFileSync(file, 'utf8');
  const browser = /_browser$/.test(name) || /remote-debugging-port|--headless/.test(src);
  const serial = name in SERIAL || (browser && TIMING_BOUND.test(src));
  const args = ARGS[opts.mode][name] ?? [];
  const vs = variants(name);
  for (const v of vs) {
    const full = v.tag ? `${name}[${v.tag}]` : name;
    task({
      // (analyze_fixtures: on the site's binary tables, web/dist/data/arch/*.bin)
      // (web_pkg_copies: after build:npm, which refreshes the copies)
      // (est: a new shard's first estimate, from the whole suite's last time)
      name: full, kind: 'js', browser, serial, weight: browser ? 2 : 1, est: v.tag && previous[name] ? previous[name] / vs.length : undefined, deps: name === 'web_pkg_copies' && !QUICK ? ['build:npm'] : name.startsWith('web_') || name === 'analyze_fixtures' ? ['build:web'] : ['build:wasm'],
      skip: browser && !chrome ? 'no Chrome' : browser && QUICK && previous[full] > QUICK_BROWSER_MAX_S ? `slow (${previous[full].toFixed(0)} s): full only` : null,
      run: async (log) => {
        const code = await exec('node', [rel(file), ...args], { env: v.env, log });
        const out = fs.readFileSync(log, 'utf8');
        const last = out.trim().split('\n').at(-1);
        if (!code && /\bskipped\b/i.test(last) && !/\b\d+ [\w ]*(cases|checks|tests)\b/i.test(last)) return { status: 'skip', count: last };
        return { status: code ? 'fail' : 'pass', count: jsCount(out) };
      },
    });
  }
}

// ---- selection
let selected = [...tasks.values()].filter((t) => t.kind !== 'build');
if (opts.wasmOnly) selected = [];
if (part?.[1] === 'main') selected = selected.filter((t) => !t.browser);
else if (part?.[1] === 'serial') selected = selected.filter((t) => t.browser && t.serial);
else if (part) selected = selected.filter((t) => t.browser && !t.serial).sort((a, b) => (a.name < b.name ? -1 : 1)).filter((_, i) => i % +part[3] === +part[2] - 1);
if (opts.only) selected = selected.filter((t) => opts.only.test(t.name));
const wanted = new Set(opts.wasmOnly ? ['build:wasm'] : []);
const addDeps = (t) => { if (wanted.has(t.name)) return; wanted.add(t.name); t.deps.forEach((d) => addDeps(tasks.get(d))); };
selected.forEach(addDeps);
const plan = [...tasks.values()].filter((t) => wanted.has(t.name));

if (opts.list) {
  for (const t of plan) console.log(`${t.name.padEnd(36)} ${t.kind.padEnd(5)} ${t.browser ? 'browser ' : ''}${t.serial ? 'serial ' : ''}${t.skip ? `(skipped: ${t.skip})` : ''}${t.deps.length ? `  after ${t.deps.join(', ')}` : ''}`);
  process.exit(0);
}

// ---- scheduling: at most JOBS slots in use (a task takes `weight` slots), at most --chrome-jobs browser suites, longest first;
// a serial suite only when every other suite is done and nothing runs, and nothing beside it
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.log')) fs.rmSync(path.join(OUT, f));
const t0 = Date.now();
const state = new Map(plan.map((t) => [t.name, 'waiting']));
const results = new Map();
let slots = 0, chromes = 0, active = 0, serialRunning = false;
const estimate = (t) => previous[t.name] ?? t.est ?? (t.kind === 'build' ? 1000 : t.kind === 'rust' ? 10 : 5);
const nSerial = plan.filter((t) => t.serial && !t.skip).length;
console.log(`check ${opts.mode}: ${plan.filter((t) => t.kind !== 'build').length} suites, ${JOBS} jobs, ${CHROME_JOBS} browser suite${CHROME_JOBS > 1 ? 's' : ''} at a time${nSerial ? ` (${nSerial} serial: alone, at the end)` : ''}${process.env.RUSTC_WRAPPER ? `, RUSTC_WRAPPER=${path.basename(process.env.RUSTC_WRAPPER)}` : ''}; logs in ${rel(OUT)}/`);

await new Promise((finish) => {
  const pump = () => {
    for (const t of plan) {
      if (state.get(t.name) !== 'waiting') continue;
      const deps = t.deps.map((d) => results.get(d));
      if (deps.some((r) => r && r.status !== 'pass')) { state.set(t.name, 'done'); results.set(t.name, { status: 'not run', count: `${t.deps.find((d) => results.get(d)?.status !== 'pass')} failed`, time: 0 }); continue; }
      if (t.skip) { state.set(t.name, 'done'); results.set(t.name, { status: 'skip', count: t.skip, time: 0 }); }
    }
    const ready = plan.filter((t) => state.get(t.name) === 'waiting' && t.deps.every((d) => results.get(d)?.status === 'pass')).sort((a, b) => estimate(b) - estimate(a));
    for (const t of ready) {
      if (serialRunning) break;
      if (t.serial && (active > 0 || plan.some((u) => !u.serial && state.get(u.name) !== 'done'))) continue;
      const w = Math.min(t.weight, JOBS);
      if (slots + w > JOBS && slots > 0) continue;
      if (t.browser && chromes >= CHROME_JOBS) continue;
      slots += w; if (t.browser) chromes++;
      active++; if (t.serial) serialRunning = true;
      state.set(t.name, 'running');
      const start = Date.now();
      const log = path.join(OUT, `${logName(t.name)}.log`);
      fs.writeFileSync(log, '');
      t.run(log).catch((e) => ({ status: 'fail', count: `check: ${e.stack || e}` })).then((r) => {
        slots -= w; if (t.browser) chromes--;
        active--; if (t.serial) serialRunning = false;
        r.time = (Date.now() - start) / 1000;
        r.log = log;
        results.set(t.name, r);
        state.set(t.name, 'done');
        const n = { running: 0, waiting: 0 };
        for (const s of state.values()) if (s in n) n[s]++;
        console.log(`  ${r.status.toUpperCase().padEnd(5)} ${t.name.padEnd(34)} ${fmtTime(r.time).padStart(7)}   ${String(r.count).slice(0, 70)}${n.running + n.waiting ? `   [${n.running} running, ${n.waiting} waiting]` : ''}`);
        pump();
      });
    }
    if ([...state.values()].every((s) => s === 'done')) finish();
  };
  pump();
});

// ---- summary
const total = (Date.now() - t0) / 1000;
const times = { ...previous };
for (const [name, r] of results) if (r.time > 0 && (r.status === 'pass' || r.status === 'fail')) times[name] = r.time;
fs.writeFileSync(path.join(OUT, 'times.json'), JSON.stringify(times, null, 1) + '\n');

const rows = plan.map((t) => [t.name, results.get(t.name)]);
const failed = rows.filter(([, r]) => r.status === 'fail' || r.status === 'not run' || (opts.noSkip && r.status === 'skip'));
for (const [name, r] of failed) {
  if (!r.log) continue;
  const lines = fs.readFileSync(r.log, 'utf8').trimEnd().split('\n');
  console.log(`\n---- ${name}: last ${Math.min(40, lines.length)} lines of ${rel(r.log)}`);
  console.log(lines.slice(-40).join('\n'));
}
const w = Math.max(...rows.map(([n]) => n.length), 5);
console.log(`\n${'suite'.padEnd(w)}  result   time     count`);
console.log(`${'-'.repeat(w)}  -------  -------  ${'-'.repeat(40)}`);
for (const [name, r] of rows) console.log(`${name.padEnd(w)}  ${r.status.toUpperCase().padEnd(7)}  ${(r.time ? fmtTime(r.time) : '-').padStart(7)}  ${String(r.count).slice(0, 110)}`);
const count = (s) => rows.filter(([, r]) => r.status === s).length;
const verdict = `check ${opts.mode}: ${failed.length ? 'FAILED' : 'ok'}: ${count('pass')} passed, ${count('fail')} failed, ${count('not run')} not run, ${count('skip')} skipped${opts.noSkip && count('skip') ? ' (--no-skip: skips fail)' : ''}; ${fmtTime(total)} with ${JOBS} jobs`;
console.log(`\n${verdict}`);
// the table for programs (scripts/check-remote.sh, comparisons of runs)
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
  mode: opts.mode, ok: !failed.length, verdict, seconds: total, jobs: JOBS, chromeJobs: CHROME_JOBS, cpus: CPUS, host: os.hostname(),
  suites: rows.map(([name, r]) => ({ name, status: r.status, seconds: r.time, count: String(r.count), serial: tasks.get(name).serial, log: r.log ? rel(r.log) : null })),
}, null, 1) + '\n');
if (process.env.GITHUB_STEP_SUMMARY) {
  const cell = (x) => String(x).replace(/\|/g, '\\|');
  const md = [`### ${verdict}`, '', '| suite | result | time | count |', '|---|---|---:|---|',
    ...rows.map(([name, r]) => `| ${cell(name)} | ${r.status.toUpperCase()} | ${r.time ? fmtTime(r.time) : '-'} | ${cell(String(r.count).slice(0, 110))} |`), ''];
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n'); } catch (e) { console.error(`check: cannot write the job summary: ${e.message}`); }
}
process.exit(failed.length ? 1 : 0);
