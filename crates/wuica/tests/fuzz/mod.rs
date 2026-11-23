//! The fuzzer: random blocks, analyzed with random options on all CPUs, each under `catch_unwind`. Used by the test
//! `tests/fuzz_short.rs` (a short run, a suite of scripts/check.sh) and the example `fuzz` (long runs, and replaying a case).
//!
//! A block is 1 to 60 instructions drawn from all encodings in the decode fixtures (main and extra set), sometimes with a few
//! random bytes in between, and in about half of the blocks a branch back to the start at the end (loop mode; otherwise the
//! block is analyzed unrolled, unless it happens to end with a branch). Case `i` of seed `s` depends only on `(s, i)`.
//!
//! A finding is a panic, or an error that says that the reference fails ("the reference implementation fails ..."). Errors
//! about the input (no instructions, unsupported instruction, ...) are counted but are not findings.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, Once};
use std::time::{Duration, Instant};
use wuica::{Engine, Request};

pub const CPUS: [&str; 15] = ["SKL", "SKX", "KBL", "CFL", "CLX", "HSW", "BDW", "IVB", "SNB", "ICL", "TGL", "RKL", "ZEN3", "ADL-P", "ICX"];

pub fn root() -> String {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..").to_string()
}

/// All tables and configurations.
pub fn engine() -> Engine {
    let mut engine = Engine::new();
    engine.load_uarch(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap();
    for entry in std::fs::read_dir(format!("{}/data/arch", root())).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_stem().unwrap().to_str().unwrap().to_string();
        engine.load_arch(&name, &std::fs::read_to_string(&path).unwrap()).unwrap();
    }
    engine
}

/// The distinct encodings (`opcode` of each decoded instruction) of the decode fixtures, sorted.
pub fn encodings() -> Vec<Vec<u8>> {
    let mut set = std::collections::BTreeSet::new();
    for file in ["fixtures/decode_fixtures.jsonl.gz", "fixtures/decode_fixtures_extra.jsonl.gz"] {
        let f = std::fs::File::open(format!("{}/{file}", root())).unwrap();
        for line in BufReader::new(flate2::read::GzDecoder::new(f)).lines() {
            let v: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
            for i in v["instrs"].as_array().unwrap() {
                set.insert(i["opcode"].as_str().unwrap().to_string());
            }
        }
    }
    set.into_iter().map(|h| (0..h.len()).step_by(2).map(|k| u8::from_str_radix(&h[k..k + 2], 16).unwrap()).collect()).collect()
}

/// the output function of SplitMix64
fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// SplitMix64
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64, index: u64) -> Rng {
        // the state is a hash of (seed, index): with a state of seed ^ index * increment, case i + 1 would draw the numbers of case
        // i shifted by one
        Rng(mix(mix(seed).wrapping_add(index)))
    }
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        mix(self.0)
    }
    /// uniform in 0..n
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    /// true with probability p percent
    pub fn pct(&mut self, p: u64) -> bool {
        self.below(100) < p
    }
}

/// Case `index` of `seed`.
pub fn case(encodings: &[Vec<u8>], seed: u64, index: u64) -> Request {
    let mut r = Rng::new(seed, index);
    let n = if r.pct(50) { 1 + r.below(12) } else { 1 + r.below(60) };
    let mut code: Vec<u8> = Vec::new();
    for _ in 0..n {
        if r.pct(3) {
            for _ in 0..1 + r.below(3) {
                code.push(r.next() as u8);
            }
        }
        code.extend_from_slice(&encodings[r.below(encodings.len() as u64) as usize]);
    }
    if r.pct(50) {
        // a branch back to the start
        let kind = r.below(4);
        if kind == 3 {
            code.extend_from_slice(&[0x49, 0xFF, 0xCF]); // dec r15 (macro-fusible with the jnz below)
        }
        let short = code.len() + 2 <= 128;
        match (kind, short) {
            (1, true) => code.extend_from_slice(&[0xEB, (-((code.len() + 2) as i64)) as u8]), // jmp rel8
            (2, _) | (_, false) => {
                let rel = -((code.len() + 6) as i64) as i32;
                code.extend_from_slice(&[0x0F, 0x85]); // jnz rel32
                code.extend_from_slice(&rel.to_le_bytes());
            }
            _ => code.extend_from_slice(&[0x75, (-((code.len() + 2) as i64)) as u8]), // jnz rel8
        }
    }
    let mut req = Request::new(CPUS[r.below(CPUS.len() as u64) as usize]);
    req.hex = code.iter().map(|b| format!("{b:02X}")).collect();
    if r.pct(30) {
        req.alignment_offset = r.below(64) as i64;
    }
    req.init_policy = match r.below(10) {
        0 => "same",
        1 => "stack",
        _ => "diff",
    }
    .to_string();
    req.simple_front_end = r.pct(10);
    req.no_micro_fusion = r.pct(10);
    req.no_macro_fusion = r.pct(10);
    if r.pct(10) {
        req.min_iterations = 1 + r.below(30) as i64;
        req.min_cycles = r.below(600) as i64;
    }
    req.include_trace = r.pct(3);
    req
}

/// The options of a request, as in the fixtures
pub fn options_json(req: &Request) -> serde_json::Value {
    let mut o = serde_json::Map::new();
    if req.alignment_offset != 0 {
        o.insert("alignmentOffset".into(), req.alignment_offset.into());
    }
    if req.init_policy != "diff" {
        o.insert("initPolicy".into(), req.init_policy.clone().into());
    }
    if req.simple_front_end {
        o.insert("simpleFrontEnd".into(), true.into());
    }
    if req.no_micro_fusion {
        o.insert("noMicroFusion".into(), true.into());
    }
    if req.no_macro_fusion {
        o.insert("noMacroFusion".into(), true.into());
    }
    if req.min_iterations != 10 || req.min_cycles != 500 {
        o.insert("minIterations".into(), req.min_iterations.into());
        o.insert("minCycles".into(), req.min_cycles.into());
    }
    serde_json::Value::Object(o)
}

pub fn describe(seed: u64, index: u64, req: &Request) -> String {
    format!("case {seed}:{index} arch {} options {} includeTrace {} hex {}", req.arch, options_json(req), req.include_trace, req.hex)
}

pub enum Outcome {
    Ok { mode: &'static str },
    /// an error about the input (or the request)
    InputError(String),
    /// "the reference implementation fails ..."
    ReferenceCrash(String),
    Panic(String),
}

thread_local! {
    static PANIC_MESSAGE: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// Panics are caught: their message (and location) is kept for the report instead of being printed.
fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_default();
            let loc = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
            PANIC_MESSAGE.with(|m| *m.borrow_mut() = format!("{msg}{loc}"));
        }));
    });
}

pub fn run(engine: &Engine, req: &Request) -> Outcome {
    install_panic_hook();
    match catch_unwind(AssertUnwindSafe(|| engine.analyze(req))) {
        Ok(Ok(r)) => Outcome::Ok { mode: r.mode },
        Ok(Err(e)) if e.contains("reference implementation fails") => Outcome::ReferenceCrash(e),
        Ok(Err(e)) => Outcome::InputError(e),
        Err(_) => Outcome::Panic(PANIC_MESSAGE.with(|m| m.borrow().clone())),
    }
}

#[derive(Default)]
pub struct Totals {
    pub blocks: u64,
    pub ok_loop: u64,
    pub ok_unroll: u64,
    /// error message (the first 70 characters) -> (count, first case)
    pub input_errors: BTreeMap<String, (u64, String)>,
    /// kind -> (count, first cases)
    pub findings: BTreeMap<String, (u64, Vec<String>)>,
    /// cases that took longer than the slow limit
    pub slow: Vec<(f64, String)>,
}

impl Totals {
    pub fn n_findings(&self) -> u64 {
        self.findings.values().map(|v| v.0).sum()
    }

    pub fn report(&self) -> String {
        let mut s = format!(
            "{} blocks: {} results (loop {}, unroll {}), {} input errors, {} findings\n",
            self.blocks,
            self.ok_loop + self.ok_unroll,
            self.ok_loop,
            self.ok_unroll,
            self.input_errors.values().map(|v| v.0).sum::<u64>(),
            self.n_findings()
        );
        for (e, (n, c)) in &self.input_errors {
            s += &format!("  input error {n:>9}  {e}\n      e.g. {c}\n");
        }
        for (k, (n, cases)) in &self.findings {
            s += &format!("  FINDING {n:>9}  {k}\n");
            for c in cases {
                s += &format!("      {c}\n");
            }
        }
        for (t, c) in &self.slow {
            s += &format!("  slow ({t:.1} s): {c}\n");
        }
        s
    }
}

/// Runs cases `start..end` of `seed` on `threads` threads. `progress`: print a line every this many seconds (0: never).
/// A case that runs longer than `slow_limit` is listed; one that runs longer than `hang_limit` ends the process with its
/// description (a thread cannot be stopped).
pub fn run_range(engine: &Engine, encodings: &[Vec<u8>], seed: u64, start: u64, end: u64, threads: usize, progress: u64, slow_limit: Duration,
                 hang_limit: Duration) -> Totals {
    let next = AtomicU64::new(start);
    let totals = Mutex::new(Totals::default());
    let done = AtomicUsize::new(0);
    // per thread: (index of the running case + 1, or 0; its start time)
    let running: Vec<Mutex<(u64, Instant)>> = (0..threads).map(|_| Mutex::new((0, Instant::now()))).collect();
    let t0 = Instant::now();
    std::thread::scope(|s| {
        for t in 0..threads {
            let (next, totals, running, done) = (&next, &totals, &running, &done);
            s.spawn(move || {
                let mut local = Totals::default();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= end {
                        break;
                    }
                    let req = case(encodings, seed, i);
                    let started = Instant::now();
                    *running[t].lock().unwrap() = (i + 1, started);
                    let outcome = run(engine, &req);
                    *running[t].lock().unwrap() = (0, started);
                    let elapsed = started.elapsed();
                    local.blocks += 1;
                    if elapsed > slow_limit {
                        local.slow.push((elapsed.as_secs_f64(), describe(seed, i, &req)));
                    }
                    let kind = match outcome {
                        Outcome::Ok { mode: "loop" } => {
                            local.ok_loop += 1;
                            None
                        }
                        Outcome::Ok { .. } => {
                            local.ok_unroll += 1;
                            None
                        }
                        Outcome::InputError(e) => {
                            let key: String = e.chars().take(70).collect();
                            let entry = local.input_errors.entry(key).or_insert((0, String::new()));
                            entry.0 += 1;
                            if entry.1.is_empty() {
                                entry.1 = describe(seed, i, &req);
                            }
                            None
                        }
                        Outcome::ReferenceCrash(e) => Some(format!("reference crash: {e}")),
                        Outcome::Panic(e) => Some(format!("panic: {e}")),
                    };
                    if let Some(kind) = kind {
                        let e = local.findings.entry(kind).or_insert((0, Vec::new()));
                        e.0 += 1;
                        if e.1.len() < 5 {
                            e.1.push(describe(seed, i, &req));
                        }
                    }
                    if local.blocks % 1000 == 0 {
                        merge(&mut totals.lock().unwrap(), std::mem::take(&mut local));
                    }
                }
                merge(&mut totals.lock().unwrap(), local);
                done.fetch_add(1, Ordering::Relaxed);
            });
        }
        // watchdog and progress
        let mut last_progress = Instant::now();
        // WUICA_FUZZ_RUNNING=FILE: the cases that have run for more than a second, kept up to date in FILE (the example `fuzz`
        // uses it to find the case that made a child process run out of memory)
        let running_file = std::env::var("WUICA_FUZZ_RUNNING").ok();
        let mut written: Vec<u64> = Vec::new();
        while done.load(Ordering::Relaxed) < threads {
            std::thread::sleep(Duration::from_millis(200));
            if let Some(path) = &running_file {
                let mut long: Vec<u64> =
                    running.iter().map(|r| *r.lock().unwrap()).filter(|&(i, t)| i != 0 && t.elapsed() > Duration::from_secs(1)).map(|(i, _)| i - 1).collect();
                long.sort();
                if long != written {
                    let text: String = long.iter().map(|i| format!("{i}\n")).collect();
                    let _ = std::fs::write(path, text);
                    written = long;
                }
            }
            for r in &running {
                let (i, started) = *r.lock().unwrap();
                if i != 0 && started.elapsed() > hang_limit {
                    let req = case(encodings, seed, i - 1);
                    eprintln!("HANG (> {} s): {}", hang_limit.as_secs(), describe(seed, i - 1, &req));
                    println!("HANGCASE {}", i - 1);
                    std::process::exit(3);
                }
            }
            if progress > 0 && last_progress.elapsed() > Duration::from_secs(progress) {
                last_progress = Instant::now();
                let tt = totals.lock().unwrap();
                eprintln!(
                    "[{:.0} s] about {} of {} cases done, {} findings",
                    t0.elapsed().as_secs_f64(),
                    next.load(Ordering::Relaxed).min(end) - start,
                    end - start,
                    tt.n_findings()
                );
            }
        }
    });
    totals.into_inner().unwrap()
}

impl Totals {
    /// as one line of JSON (the chunks of the example `fuzz` report their totals this way)
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "blocks": self.blocks, "ok_loop": self.ok_loop, "ok_unroll": self.ok_unroll,
            "input_errors": self.input_errors.iter().map(|(k, (n, c))| serde_json::json!([k, n, c])).collect::<Vec<_>>(),
            "findings": self.findings.iter().map(|(k, (n, c))| serde_json::json!([k, n, c])).collect::<Vec<_>>(),
            "slow": self.slow.iter().map(|(t, c)| serde_json::json!([t, c])).collect::<Vec<_>>(),
        })
    }

    pub fn from_json(v: &serde_json::Value) -> Totals {
        let u = |k: &str| v[k].as_u64().unwrap_or(0);
        let mut t = Totals { blocks: u("blocks"), ok_loop: u("ok_loop"), ok_unroll: u("ok_unroll"), ..Totals::default() };
        for e in v["input_errors"].as_array().into_iter().flatten() {
            t.input_errors.insert(e[0].as_str().unwrap().to_string(), (e[1].as_u64().unwrap(), e[2].as_str().unwrap().to_string()));
        }
        for e in v["findings"].as_array().into_iter().flatten() {
            let cases = e[2].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect();
            t.findings.insert(e[0].as_str().unwrap().to_string(), (e[1].as_u64().unwrap(), cases));
        }
        for e in v["slow"].as_array().into_iter().flatten() {
            t.slow.push((e[0].as_f64().unwrap(), e[1].as_str().unwrap().to_string()));
        }
        t
    }

    pub fn add(&mut self, other: Totals) {
        merge(self, other)
    }
}

fn merge(into: &mut Totals, from: Totals) {
    into.blocks += from.blocks;
    into.ok_loop += from.ok_loop;
    into.ok_unroll += from.ok_unroll;
    for (k, (n, c)) in from.input_errors {
        let e = into.input_errors.entry(k).or_insert((0, c));
        e.0 += n;
    }
    for (k, (n, cases)) in from.findings {
        let e = into.findings.entry(k).or_insert((0, Vec::new()));
        e.0 += n;
        for c in cases {
            if e.1.len() < 5 {
                e.1.push(c);
            }
        }
    }
    into.slow.extend(from.slow);
}
