//! Checks the simulator against the simulation fixtures of the Python reference (see docs/PORTING.md): the throughput, the uop
//! table and the `-json` output, for the main set and the extra set. The instruction objects come from the instruction fixtures.
//!
//! Environment variables (for working on differences):
//! - `WUICA_SET`: `main` or `extra` (default: both)
//! - `WUICA_ARCH`: only this configuration; `WUICA_FILE`: only files whose name contains this; `WUICA_OPTS`: only cases whose
//!   options (as JSON) contain this
//! - `WUICA_TP_ONLY`: only check the throughput (fast)
//! - `WUICA_SHOW`: number of differences to print per kind and configuration (default 3)
//! - `WUICA_THREADS`: number of threads (default: 8, at most the number of cores)
//! - `WUICA_MORE_SIM_FIXTURES`: a further file of simulation cases in the format of the fixtures (set `more`), e.g. cases with
//!   options for which the fixtures have no `-json` output; their instruction objects are taken from the two instruction fixtures

use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wuica_core::config::UArch;
use wuica_core::jsoncmp;
use wuica_core::model::InstrList;
use wuica_core::sim::{simulate, InitPolicy, SimError, SimOptions};

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

#[derive(Deserialize)]
struct CaseHeader {
    file: String,
    arch: String,
    options: serde_json::Value,
    error: Option<String>,
}

#[derive(Deserialize)]
struct CaseTp {
    #[serde(rename = "TP")]
    tp: f64,
    #[allow(dead_code)]
    stdout: serde::de::IgnoredAny,
    #[allow(dead_code)]
    json: Option<serde::de::IgnoredAny>,
}

#[derive(Deserialize)]
struct CaseFull {
    #[serde(rename = "TP")]
    tp: f64,
    stdout: String,
    json: Option<serde_json::Value>,
}

/// the options that affect the instruction objects
fn instr_key(file: &str, arch: &str, options: &serde_json::Value) -> String {
    format!("{file}|{arch}|{}|{}|{}", options["alignmentOffset"], options["noMicroFusion"], options["noMacroFusion"])
}

fn lines(path: &str) -> impl Iterator<Item = String> {
    let file = std::fs::File::open(path).unwrap_or_else(|e| panic!("{path}: {e} (run tools/export_fixtures.py)"));
    BufReader::with_capacity(1 << 20, flate2::read::GzDecoder::new(file)).lines().map(|l| l.unwrap())
}

#[derive(Default)]
struct Stats {
    cases: usize,
    reference_errors: usize,
    no_instr_fixture: usize,
    tp_checked: usize,
    table_checked: usize,
    json_checked: usize,
    sim_time: Duration,
    /// (set, kind, configuration) -> (number of differences, examples)
    failures: BTreeMap<(String, String, String), (usize, Vec<String>)>,
}

impl Stats {
    fn fail(&mut self, set: &str, kind: &str, arch: &str, show: usize, msg: String) {
        let e = self.failures.entry((set.to_string(), kind.to_string(), arch.to_string())).or_default();
        e.0 += 1;
        if e.1.len() < show {
            e.1.push(msg);
        }
    }
}

fn table_part(s: &str) -> Option<&str> {
    let mut pos = 0;
    for line in s.split_inclusive('\n') {
        if line.starts_with('\u{250c}') {
            return Some(&s[pos..]);
        }
        pos += line.len();
    }
    None
}

fn first_difference(a: &str, b: &str) -> String {
    for (i, (x, y)) in a.lines().zip(b.lines()).enumerate() {
        if x != y {
            return format!("line {i}:\n      got      {x:?}\n      expected {y:?}");
        }
    }
    format!("{} lines, expected {}", a.lines().count(), b.lines().count())
}

#[test]
fn simulator_reproduces_the_simulation_fixtures() {
    let env = |name: &str| std::env::var(name).ok().filter(|s| !s.is_empty());
    let (only_set, only_arch, only_file, only_opts) = (env("WUICA_SET"), env("WUICA_ARCH"), env("WUICA_FILE"), env("WUICA_OPTS"));
    let tp_only = env("WUICA_TP_ONLY").is_some();
    let show: usize = env("WUICA_SHOW").map_or(3, |s| s.parse().unwrap());

    let uarch = Arc::new(UArch::from_json(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap());
    let stats = Arc::new(Mutex::new(Stats::default()));
    let start = Instant::now();

    let dir = format!("{}/fixtures/generated", root());
    let mut sets = vec![
        ("main", vec![format!("{dir}/instr_fixtures.jsonl.gz")], format!("{dir}/sim_fixtures.jsonl.gz")),
        ("extra", vec![format!("{dir}/extra_instr_fixtures.jsonl.gz")], format!("{dir}/extra_sim_fixtures.jsonl.gz")),
    ];
    if let Some(path) = env("WUICA_MORE_SIM_FIXTURES") {
        sets.push(("more", vec![format!("{dir}/instr_fixtures.jsonl.gz"), format!("{dir}/extra_instr_fixtures.jsonl.gz")], path));
    }
    for (set, instr_files, sim_file) in sets {
        if only_set.as_deref().is_some_and(|s| s != set) {
            continue;
        }
        // the instruction objects, as lines, by (file, configuration, options)
        let mut instr_cases: HashMap<String, String> = HashMap::new();
        for line in instr_files.iter().flat_map(|f| lines(f)) {
            let h: CaseHeader = serde_json::from_str(&line).unwrap();
            if only_arch.as_deref().is_some_and(|a| a != h.arch) || only_file.as_deref().is_some_and(|f| !h.file.contains(f)) {
                continue;
            }
            if h.error.is_none() {
                instr_cases.insert(instr_key(&h.file, &h.arch, &h.options), line);
            }
        }
        let instr_cases = Arc::new(instr_cases);

        // up to 8 threads by default (`WUICA_THREADS` to change it): other work shares the machine
        let available = std::thread::available_parallelism().map_or(4, |n| n.get());
        let n_threads = env("WUICA_THREADS").map_or(8, |s| s.parse().unwrap()).clamp(1, available);
        let (tx, rx) = sync_channel::<String>(4 * n_threads);
        let rx = Arc::new(Mutex::new(rx));
        let mut workers = Vec::new();
        for _ in 0..n_threads {
            let (rx, uarch, stats, instr_cases) = (rx.clone(), uarch.clone(), stats.clone(), instr_cases.clone());
            let (only_arch, only_file, only_opts) = (only_arch.clone(), only_file.clone(), only_opts.clone());
            workers.push(std::thread::spawn(move || loop {
                let line = match rx.lock().unwrap().recv() {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let h: CaseHeader = serde_json::from_str(&line).unwrap();
                if only_arch.as_deref().is_some_and(|a| a != h.arch)
                    || only_file.as_deref().is_some_and(|f| !h.file.contains(f))
                    || only_opts.as_deref().is_some_and(|o| !h.options.to_string().contains(o))
                {
                    continue;
                }
                let name = format!("{} {} {}", h.file, h.arch, h.options);
                let Some(instr_line) = instr_cases.get(&instr_key(&h.file, &h.arch, &h.options)) else {
                    stats.lock().unwrap().no_instr_fixture += 1;
                    continue;
                };
                let list: InstrList = serde_json::from_str(instr_line).unwrap_or_else(|e| panic!("{name}: {e}"));
                let o = &h.options;
                let options = SimOptions {
                    alignment_offset: o["alignmentOffset"].as_i64().unwrap_or(0),
                    init_policy: match o["initPolicy"].as_str().unwrap_or("diff") {
                        "diff" => InitPolicy::Diff,
                        "same" => InitPolicy::Same,
                        "stack" => InitPolicy::Stack,
                        p => panic!("{name}: initPolicy {p}"),
                    },
                    simple_front_end: o["simpleFrontEnd"].as_bool().unwrap_or(false),
                    min_iterations: o["minIterations"].as_i64().unwrap_or(10),
                    min_cycles: o["minCycles"].as_i64().unwrap_or(500),
                };
                let config = &uarch.configs[&h.arch];

                let t = Instant::now();
                let result = simulate(&list, config, &uarch, &options);
                let sim_time = t.elapsed();

                if let Some(error) = &h.error {
                    // The reference raised an exception. For exceptions in the simulation, the simulator returns an error; the
                    // exception for a fractional cycle number is raised when the JSON output is written, after the simulation.
                    let mut s = stats.lock().unwrap();
                    s.reference_errors += 1;
                    let in_json_output = error.starts_with("TypeError: list indices must be integers");
                    match &result {
                        Ok(r) if in_json_output => {
                            let json = r.to_json();
                            let n_cycles = json["cycles"].as_array().map_or(0, |c| c.len());
                            // a cycle number can only be a float if an instruction has a throughput limit
                            let possible = list.instrs.iter().any(|i| i.tp.is_some());
                            if n_cycles as i64 != r.max_cycle + 1 || !possible {
                                s.fail(set, "reference error", &h.arch, show, format!("{name}: no throughput limit ({error})"));
                            }
                        }
                        Err(SimError::ReferenceCrash(_)) if !in_json_output => {}
                        Ok(_) => s.fail(set, "reference error", &h.arch, show, format!("{name}: no error, expected: {error}")),
                        Err(e) => s.fail(set, "reference error", &h.arch, show, format!("{name}: {e}, expected: {error}")),
                    }
                    continue;
                }
                let (expected_tp, full) = if tp_only {
                    (serde_json::from_str::<CaseTp>(&line).unwrap().tp, None)
                } else {
                    let c: CaseFull = serde_json::from_str(&line).unwrap();
                    (c.tp, Some(c))
                };
                // compute the outputs outside of the lock
                let mut failures: Vec<(&str, String)> = Vec::new();
                let (mut table_checked, mut json_checked) = (0, 0);
                match &result {
                    Err(e) => failures.push(("error", format!("{name}: {e}"))),
                    Ok(r) => {
                        if r.tp != expected_tp {
                            failures.push(("TP", format!("{name}: {} != {}", r.tp, expected_tp)));
                        }
                        if let Some(c) = &full {
                            let table = r.uops_table();
                            table_checked = 1;
                            match (table_part(&table), table_part(&c.stdout).and_then(|t| t.strip_suffix('\n'))) {
                                (Some(got), Some(expected)) => {
                                    if got != expected {
                                        failures.push(("table", format!("{name}: {}", first_difference(got, expected))));
                                    } else if !c.stdout.strip_suffix('\n').is_some_and(|s| s.ends_with(&format!("\n\n{table}"))) {
                                        // the legend of the notes before the table
                                        failures.push(("table legend", format!("{name}: {:?}", table.lines().next())));
                                    }
                                }
                                _ => failures.push(("table", format!("{name}: no table"))),
                            }
                            if let Some(expected) = &c.json {
                                json_checked = 1;
                                if let Some(d) = jsoncmp::diff(&r.to_json(), expected) {
                                    failures.push(("json", format!("{name}: {d}")));
                                }
                            }
                        }
                    }
                }
                let mut s = stats.lock().unwrap();
                s.cases += 1;
                s.tp_checked += 1;
                s.table_checked += table_checked;
                s.json_checked += json_checked;
                s.sim_time += sim_time;
                for (kind, msg) in failures {
                    s.fail(set, kind, &h.arch, show, msg);
                }
            }));
        }
        for line in lines(&sim_file) {
            tx.send(line).unwrap();
        }
        drop(tx);
        for w in workers {
            w.join().unwrap();
        }
    }

    let s = stats.lock().unwrap();
    println!(
        "{} cases simulated and compared, {} cases where the reference fails checked, {} cases without instruction fixture skipped ({:.1} s)",
        s.cases,
        s.reference_errors,
        s.no_instr_fixture,
        start.elapsed().as_secs_f64()
    );
    println!("checked: {} throughputs, {} tables, {} JSON outputs", s.tp_checked, s.table_checked, s.json_checked);
    if s.cases > 0 {
        println!("simulation: {:.3} ms per case ({:.0} cases/s on one thread)", s.sim_time.as_secs_f64() * 1e3 / s.cases as f64, s.cases as f64 / s.sim_time.as_secs_f64());
    }
    let mut by_kind: BTreeMap<(String, String), usize> = BTreeMap::new();
    for ((set, kind, arch), (n, examples)) in &s.failures {
        *by_kind.entry((set.clone(), kind.clone())).or_default() += n;
        println!("{set} {kind} {arch}: {n} differences");
        for e in examples {
            println!("    {e}");
        }
    }
    for ((set, kind), n) in &by_kind {
        println!("TOTAL {set} {kind}: {n}");
    }
    let filtered = only_set.is_some() || only_arch.is_some() || only_file.is_some() || only_opts.is_some();
    if !filtered {
        assert!(s.cases > 14000, "only {} cases", s.cases);
        if !tp_only {
            assert!(s.json_checked > 1600, "only {} JSON outputs", s.json_checked);
        }
    }
    assert!(s.failures.is_empty(), "{} differences", s.failures.values().map(|f| f.0).sum::<usize>());
}

#[test]
fn unsupported_inputs_are_errors() {
    let uarch = UArch::from_json(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap();
    let empty = InstrList { operands: Vec::new(), instrs: Vec::new() };
    assert_eq!(simulate(&empty, &uarch.configs["SKL"], &uarch, &SimOptions::default()).unwrap_err(), SimError::NoInstructions);
    // simplePortAssignment uses Python's random
    assert!(matches!(simulate(&empty, &uarch.configs["CLX_SimplePorts"], &uarch, &SimOptions::default()), Err(SimError::Unsupported(_))));
    let defaults = SimOptions::default();
    assert_eq!((defaults.alignment_offset, defaults.init_policy, defaults.simple_front_end), (0, InitPolicy::Diff, false));
    assert_eq!((defaults.min_iterations, defaults.min_cycles), (10, 500));
}
