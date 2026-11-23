//! End to end: from the bytes of each simulation fixture (main and extra set, all option variants, including the blocks of
//! 1000 instructions) to the complete text that the reference prints. Cases in which the reference raises an exception must
//! give an error or, where it only fails while writing the `-json` file, are not compared.

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
        engine.load_arch(&name, &std::fs::read_to_string(&path).unwrap()).unwrap();
    }

    let mut lines: Vec<String> = Vec::new();
    for set in ["sim_fixtures", "extra_sim_fixtures"] {
        // only the fields of `Case` are needed: the large `json` field is left out
        lines.extend(wuica_testkit::lines_without_json(format!("{}/fixtures/generated/{set}.jsonl.gz", root())));
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
                let name = format!("{} {} {}", c.file, c.arch, c.options);
                let result = engine.analyze(&request);
                if let Some(error) = &c.error {
                    ref_errors.fetch_add(1, Ordering::Relaxed);
                    // the reference fails while writing the -json file (after the analysis): wuica has a result there
                    if !error.starts_with("TypeError: list indices") && result.is_ok() {
                        failures.lock().unwrap().push(format!("{name}: the reference fails ({error}), wuica does not"));
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
                        }
                    }
                }
            });
        }
    });
    let failures = failures.into_inner().unwrap();
    println!("{} cases compared, {} cases in which the reference fails, {} failures", compared.into_inner(), ref_errors.into_inner(), failures.len());
    for f in failures.iter().take(30) {
        println!("  {f}");
    }
    assert!(failures.is_empty());
}
