//! End to end: from the bytes of each simulation fixture (main and extra set, all option variants, including the blocks of
//! 1000 instructions) to the complete text that the reference prints. The fixtures come from the fixed reference (docs/DEVIATIONS.md),
//! which raises no exception on them; a case with an `error` is a failure, unless it is an input error (`InputError: ...`), which
//! wuica must report with the same text.
//!
//! `WUICA_E2E_FILE`: compare the cases of this file (in the format of the simulation fixtures) instead, e.g. random blocks run on
//! the reference (the example `fuzz`, `--dump`); where a case has the `-json` output, the trace is compared too.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use wuica::{Engine, Request};

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

#[derive(serde::Deserialize)]
struct Case {
    file: String,
    arch: String,
    options: serde_json::Value,
    hex: String,
    #[serde(rename = "TP")]
    tp: Option<f64>,
    stdout: Option<String>,
    error: Option<String>,
}

#[test]
fn reproduces_the_text_output_of_the_reference() {
    let mut engine = Engine::new();
    engine.load_uarch(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap();
    for entry in std::fs::read_dir(format!("{}/data/arch", root())).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_stem().unwrap().to_str().unwrap().to_string();
        // the binary form of the table, as the package and the site ship it (src/table_bin.rs of the core)
        let bin = wuica::ArchData::from_json(&std::fs::read_to_string(&path).unwrap()).unwrap().to_bin();
        engine.load_arch_bin(&name, &bin).unwrap();
    }

    let mut lines: Vec<String> = Vec::new();
    let other_file = std::env::var("WUICA_E2E_FILE").ok().filter(|s| !s.is_empty());
    if let Some(path) = &other_file {
        lines.extend(wuica_testkit::lines(path));
    } else {
        for set in ["sim_fixtures", "extra_sim_fixtures"] {
            // only the fields of `Case` are needed: the large `json` field is left out
            lines.extend(wuica_testkit::lines_without_json(format!("{}/fixtures/generated/{set}.jsonl.gz", root())));
        }
    }

    let next = AtomicUsize::new(0);
    let (compared, ref_errors) = (AtomicUsize::new(0), AtomicUsize::new(0));
    let failures: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(line) = lines.get(i) else { break };
                let c: Case = serde_json::from_str(line).unwrap();
                let o = &c.options;
                let mut request = Request::new(&c.arch);
                request.hex = c.hex.clone();
                request.alignment_offset = o["alignmentOffset"].as_i64().unwrap_or(0);
                request.init_policy = o["initPolicy"].as_str().unwrap_or("diff").to_string();
                request.simple_front_end = o["simpleFrontEnd"].as_bool().unwrap_or(false);
                request.no_micro_fusion = o["noMicroFusion"].as_bool().unwrap_or(false);
                request.no_macro_fusion = o["noMacroFusion"].as_bool().unwrap_or(false);
                request.min_iterations = o["minIterations"].as_i64().unwrap_or(10);
                request.min_cycles = o["minCycles"].as_i64().unwrap_or(500);
                let expected_trace = other_file.as_ref().and_then(|_| serde_json::from_str::<serde_json::Value>(line).ok()?.get("json").cloned());
                request.include_trace = expected_trace.is_some();
                let name = format!("{} {} {}", c.file, c.arch, c.options);
                let result = engine.analyze(&request);
                if let Some(error) = &c.error {
                    ref_errors.fetch_add(1, Ordering::Relaxed);
                    match (error.strip_prefix("InputError: "), &result) {
                        (Some(expected), Err(e)) if e == expected => {}
                        (Some(expected), _) => failures.lock().unwrap().push(format!("{name}: the reference reports {expected:?}, wuica {:?}", result.as_ref().err())),
                        (None, _) => failures.lock().unwrap().push(format!("{name}: the reference fails: {error}")),
                    }
                    continue;
                }
                compared.fetch_add(1, Ordering::Relaxed);
                match result {
                    Err(e) => failures.lock().unwrap().push(format!("{name}: error: {e}")),
                    Ok(r) => {
                        if Some(r.tp) != c.tp {
                            failures.lock().unwrap().push(format!("{name}: TP {} != {:?}", r.tp, c.tp));
                        } else if Some(&r.text_with_hyperlinks) != c.stdout.as_ref() {
                            failures.lock().unwrap().push(format!("{name}: text differs"));
                        } else if r.rows.iter().any(|row| row.values.len() != r.columns.len()) || r.text.contains('\x1b') {
                            failures.lock().unwrap().push(format!("{name}: malformed response"));
                        } else if let (Some(expected), Some(trace)) = (&expected_trace, &r.trace) {
                            if let Some(d) = wuica_core::jsoncmp::diff(trace, expected) {
                                failures.lock().unwrap().push(format!("{name}: trace differs: {d}"));
                            }
                        }
                    }
                }
            });
        }
    });
    let failures = failures.into_inner().unwrap();
    println!("{} cases compared, {} input errors of the reference, {} failures", compared.into_inner(), ref_errors.into_inner(), failures.len());
    for f in failures.iter().take(30) {
        println!("  {f}");
    }
    assert!(failures.is_empty());
}

/// The input errors of the fixed reference (docs/DEVIATIONS.md) that the fixtures do not contain, with its text (checked with
/// the reference, jtl06/uiCA branch crash-fixes).
#[test]
fn input_errors_have_the_text_of_the_reference() {
    let mut engine = Engine::new();
    engine.load_uarch(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap();
    engine.load_arch("SKL", &std::fs::read_to_string(format!("{}/data/arch/SKL.json", root())).unwrap()).unwrap();
    // minIterations 0: the simulation stops before the first iteration is complete (upstream: IndexError)
    let mut request = Request::new("SKL");
    request.hex = "4801D8".to_string();
    request.min_iterations = 0;
    request.min_cycles = 0;
    assert_eq!(engine.analyze(&request).err().as_deref(), Some("no iteration was completed (minIterations must be at least 1, or minCycles larger)"));
}
