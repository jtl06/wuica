//! The accuracy gate: the three prototype models (ZEN3, ADL-P, ICX) against the loops measured on their hardware.
//!
//! `fixtures/generated/accuracy.jsonl.gz` (generated, in the CI data asset; made by `microbench/accuracy_export.py` of the fork, see
//! docs/PORTING.md) holds the held-out random loops and BHive blocks of the last rounds and the dogfood loops, each with its machine code,
//! the analysis mode and the measured cycles per iteration on each CPU where it counts (the selection of docs/ACCURACY.md). This test
//! predicts every (loop, CPU) pair with the default options of the command-line tool, rounds the throughput as the set's header says
//! (2 decimals, as the tables used; the dogfood loops unrounded), and computes per set and CPU the share of loops within 5, 10 and 20 %
//! and the mean absolute percentage error, as docs/ACCURACY.md defines them.
//!
//! The numbers are compared with `crates/wuica/tests/accuracy_expected.json`. The test fails if a share (within 5/10/20 %) differs by
//! more than `share` percentage points or the MAPE by more than `mape` points from the expected value, in either direction (an
//! improvement fails too, so that the file never goes stale), or if the number of loops changes. To accept an intended change:
//!
//!     WUICA_ACCURACY_ACCEPT=1 cargo test --release -p wuica --test accuracy_gate
//!
//! The dogfood loops are printed loop by loop and scored, but not gated.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::sync::Mutex;
use wuica::{ArchData, Engine, Request};

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

const CPUS: [&str; 3] = ["ZEN3", "ADL-P", "ICX"];
const EXPECTED: &str = "crates/wuica/tests/accuracy_expected.json";

#[derive(serde::Deserialize)]
struct Header {
    format: String,
    options: BTreeMap<String, serde_json::Value>,
    sets: BTreeMap<String, SetInfo>,
}

#[derive(serde::Deserialize)]
struct SetInfo {
    kind: String,
    #[serde(rename = "tpDecimals")]
    tp_decimals: Option<usize>,
}

#[derive(serde::Deserialize)]
struct Row {
    set: String,
    name: String,
    hex: String,
    mode: String,
    cycles: BTreeMap<String, f64>,
}

#[derive(Clone, Copy, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
struct Score {
    loops: usize,
    within5: usize,
    within10: usize,
    within20: usize,
    mape: f64,
}

impl Score {
    fn share(&self, n: usize) -> f64 {
        100.0 * n as f64 / self.loops as f64
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Expected {
    tolerance: Tolerance,
    scores: BTreeMap<String, Score>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
struct Tolerance {
    /// percentage points of the share within 5/10/20 %
    share: f64,
    /// points of the MAPE
    mape: f64,
}

fn read_table() -> (Header, Vec<Row>) {
    let path = format!("{}/fixtures/generated/accuracy.jsonl.gz", root());
    let file = std::fs::File::open(&path).unwrap_or_else(|_| {
        panic!("{path} is missing: it is part of the CI data asset (ci/data-asset.txt), made by microbench/accuracy_export.py of the fork")
    });
    let mut lines = BufReader::new(flate2::read::GzDecoder::new(file)).lines();
    let header: Header = serde_json::from_str(&lines.next().expect("header").unwrap()).unwrap();
    assert_eq!(header.format, "wuica-accuracy-1", "unknown format of the accuracy table");
    let rows = lines.map(|l| serde_json::from_str(&l.unwrap()).unwrap()).collect();
    (header, rows)
}

#[test]
fn prototype_models_keep_their_accuracy() {
    let start = std::time::Instant::now();
    let (header, rows) = read_table();
    // the options of the table must be the defaults of the command-line tool, which Request::new has
    let defaults: BTreeMap<&str, serde_json::Value> = [
        ("alignmentOffset", 0.into()),
        ("initPolicy", "diff".into()),
        ("noMicroFusion", false.into()),
        ("noMacroFusion", false.into()),
        ("simpleFrontEnd", false.into()),
        ("minIterations", 10.into()),
        ("minCycles", 500.into()),
    ]
    .into_iter()
    .collect();
    for (k, v) in &header.options {
        assert_eq!(defaults.get(k.as_str()), Some(v), "accuracy table option {k}: the scorer uses the command-line defaults");
    }

    let uarch = std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("data/uarch.json");
    let mut probe = Engine::new();
    probe.load_uarch(&uarch).unwrap();
    // the binary tables, as the package, the site and the server ship them
    let tables: Vec<(String, Vec<u8>)> = CPUS
        .iter()
        .map(|cpu| {
            let name = probe.table_name(cpu).expect("prototype model in uarch.json").to_string();
            let json = std::fs::read_to_string(format!("{}/data/arch/{name}.json", root())).expect("table");
            (name, ArchData::from_json(&json).unwrap().to_bin())
        })
        .collect();

    // every (row, CPU) pair, predicted on all cores
    let jobs: Vec<(usize, &str)> = rows.iter().enumerate().flat_map(|(i, r)| r.cycles.keys().map(move |c| (i, c.as_str()))).collect();
    let results: Mutex<Vec<Option<(f64, &'static str)>>> = Mutex::new(vec![None; jobs.len()]);
    let next = Mutex::new(0usize);
    let n_threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    std::thread::scope(|s| {
        for _ in 0..n_threads {
            s.spawn(|| {
                let mut engine = Engine::new();
                engine.load_uarch(&uarch).unwrap();
                for (name, bin) in &tables {
                    engine.load_arch_bin(name, bin).unwrap();
                }
                loop {
                    let j = {
                        let mut n = next.lock().unwrap();
                        *n += 1;
                        *n - 1
                    };
                    if j >= jobs.len() {
                        break;
                    }
                    let (i, cpu) = jobs[j];
                    let mut request = Request::new(cpu);
                    request.hex = rows[i].hex.clone();
                    let r = engine.analyze(&request).unwrap_or_else(|e| panic!("{} {} on {cpu}: {e}", rows[i].set, rows[i].name));
                    results.lock().unwrap()[j] = Some((r.tp, r.mode));
                }
            });
        }
    });
    let results = results.into_inner().unwrap();

    // errors per (set, CPU), in the order of the table
    let mut errors: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut dogfood = Vec::new();
    for (&(i, cpu), res) in jobs.iter().zip(&results) {
        let (tp, mode) = res.expect("predicted");
        let row = &rows[i];
        assert_eq!(mode, row.mode, "{} {}: analysis mode", row.set, row.name);
        let info = &header.sets[&row.set];
        let tp = match info.tp_decimals {
            Some(d) => format!("{:.*}", d, tp).parse::<f64>().unwrap(),
            None => tp,
        };
        let m = row.cycles[cpu];
        let e = (tp - m).abs() / m * 100.0;
        if info.kind == "dogfood" {
            dogfood.push((row.name.as_str(), cpu, m, tp));
        }
        errors.entry(format!("{} {cpu}", row.set)).or_default().push(e);
    }
    let scores: BTreeMap<String, Score> = errors
        .iter()
        .map(|(k, es)| {
            let n = |t: f64| es.iter().filter(|&&e| e <= t).count();
            (k.clone(), Score { loops: es.len(), within5: n(5.0), within10: n(10.0), within20: n(20.0), mape: es.iter().sum::<f64>() / es.len() as f64 })
        })
        .collect();

    println!("dogfood loops (cycles per iteration: measured, predicted, error):");
    for (name, cpu, m, tp) in &dogfood {
        println!("  {name:<10} {cpu:<5} {m:>7.2} {tp:>7.2} {:>+5.0}%", (tp - m) / m * 100.0);
    }
    println!("{:<18} {:>6} {:>7} {:>7} {:>7} {:>6}", "set / CPU", "loops", "<=5%", "<=10%", "<=20%", "MAPE");
    for (k, s) in &scores {
        println!(
            "{k:<18} {:>6} {:>6.1}% {:>6.1}% {:>6.1}% {:>5.1}%",
            s.loops,
            s.share(s.within5),
            s.share(s.within10),
            s.share(s.within20),
            s.mape
        );
    }
    println!("{} cases scored in {:.1} s", jobs.len(), start.elapsed().as_secs_f64());

    // the gate (the dogfood loops are not gated)
    let gated: BTreeMap<String, Score> = scores.iter().filter(|(k, _)| !k.starts_with("dogfood ")).map(|(k, s)| (k.clone(), *s)).collect();
    let path = format!("{}/{EXPECTED}", root());
    let accept = std::env::var("WUICA_ACCURACY_ACCEPT").is_ok_and(|v| !v.is_empty() && v != "0");
    let old: Option<Expected> = std::fs::read_to_string(&path).ok().map(|s| serde_json::from_str(&s).expect("accuracy_expected.json"));
    let tolerance = old.as_ref().map_or(Tolerance { share: 0.1, mape: 0.02 }, |o| o.tolerance);
    if accept {
        let mut text = serde_json::to_string_pretty(&Expected { tolerance, scores: gated }).unwrap();
        text.push('\n');
        std::fs::write(&path, text).unwrap();
        println!("wrote {EXPECTED}");
        return;
    }
    let old = old.unwrap_or_else(|| panic!("{EXPECTED} is missing; write it with WUICA_ACCURACY_ACCEPT=1"));
    let mut problems = Vec::new();
    for (k, e) in &old.scores {
        let Some(s) = gated.get(k) else {
            problems.push(format!("{k}: not in the accuracy table any more"));
            continue;
        };
        if s.loops != e.loops {
            problems.push(format!("{k}: {} loops instead of {} (the accuracy table changed)", s.loops, e.loops));
            continue;
        }
        for (what, new, exp) in [("within 5%", s.within5, e.within5), ("within 10%", s.within10, e.within10), ("within 20%", s.within20, e.within20)] {
            let d = s.share(new) - e.share(exp);
            if d.abs() > tolerance.share {
                problems.push(format!(
                    "{k}: {what} {:.2}% instead of {:.2}% ({d:+.2} points, tolerance {}): {}",
                    s.share(new),
                    e.share(exp),
                    tolerance.share,
                    if d < 0.0 { "worse" } else { "better: update the expected values" }
                ));
            }
        }
        let d = s.mape - e.mape;
        if d.abs() > tolerance.mape {
            problems.push(format!(
                "{k}: MAPE {:.3}% instead of {:.3}% ({d:+.3} points, tolerance {}): {}",
                s.mape,
                e.mape,
                tolerance.mape,
                if d > 0.0 { "worse" } else { "better: update the expected values" }
            ));
        }
    }
    for k in gated.keys().filter(|k| !old.scores.contains_key(*k)) {
        problems.push(format!("{k}: new in the accuracy table: update the expected values"));
    }
    assert!(
        problems.is_empty(),
        "the accuracy of the prototype models changed:\n  {}\nIf the change is intended, accept it with:\n  WUICA_ACCURACY_ACCEPT=1 cargo test --release -p wuica --test accuracy_gate\n(this rewrites {EXPECTED})",
        problems.join("\n  ")
    );
}
