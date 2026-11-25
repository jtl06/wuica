//! The parameters of model round 11, one at a time (see docs/PORTING.md, "Model round 11"). Two sets of cases that the reference
//! (the fork's `improve-r11`) ran with round-11 parameters set in a configuration, each in a new process:
//!
//! - `model_r11.jsonl.gz` (`tools/gen_model_r11_cases.py`): a block per mechanism with one parameter switched on in a configuration
//!   that does not have it, or switched off in one that has it. The shipped configurations switch several on at once; these cases
//!   check each mechanism alone, and the parameter must change the result (otherwise the case would not test it).
//! - `model_r11_boundary.jsonl.gz` (`tools/gen_model_r11_boundary.py`): blocks at the boundaries of each mechanism (a load at the
//!   end of a store, a loop that ends exactly on a 64-byte line, register files and queues one entry from full, free delays,
//!   moves in each rename slot, fusion at 15 bytes, fast adds feeding loads and stores, ...), chosen from the generated blocks of
//!   the review of the round so that each of a list of deliberate off-by-one changes of the port makes some of them differ.
//!
//! wuica must give the same throughput, text and (where the case has it) `-json` trace, or the reference's input error.
//!
//! Fields of a case: `variant` (a name), `base` (the configuration), `set` (the parameters, with their JSON values), `file`, `options`,
//! `hex`, and the reference's `TP`, `stdout` and `json`, or its `error`.

use wuica::{Engine, Request};

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

#[derive(serde::Deserialize)]
struct Case {
    variant: String,
    base: String,
    set: serde_json::Map<String, serde_json::Value>,
    file: String,
    options: serde_json::Value,
    hex: String,
    #[serde(rename = "TP")]
    tp: Option<f64>,
    stdout: Option<String>,
    /// (only in some cases: the traces are most of the files' size)
    json: Option<serde_json::Value>,
    /// the reference's input error
    error: Option<String>,
}

fn request(arch: &str, c: &Case) -> Request {
    let o = &c.options;
    let mut r = Request::new(arch);
    r.hex = c.hex.clone();
    r.alignment_offset = o["alignmentOffset"].as_i64().unwrap_or(0);
    r.init_policy = o["initPolicy"].as_str().unwrap_or("diff").to_string();
    r.simple_front_end = o["simpleFrontEnd"].as_bool().unwrap_or(false);
    r.no_micro_fusion = o["noMicroFusion"].as_bool().unwrap_or(false);
    r.no_macro_fusion = o["noMacroFusion"].as_bool().unwrap_or(false);
    r.min_iterations = o["minIterations"].as_i64().unwrap_or(10);
    r.min_cycles = o["minCycles"].as_i64().unwrap_or(500);
    r.include_trace = c.json.is_some();
    r
}

/// The cases of a file, and an engine whose configurations include one per case (the base configuration with the parameters set,
/// under a key of its own; the instruction table stays the base's).
fn load(file: &str) -> (Vec<Case>, Engine, Vec<String>) {
    let path = format!("{}/crates/wuica/tests/{file}", root());
    let cases: Vec<Case> = wuica_testkit::lines(&path).map(|l| serde_json::from_str(&l).unwrap()).collect();
    assert!(!cases.is_empty());
    let mut uarch: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap();
    let configs = uarch["configs"].as_object_mut().unwrap();
    let keys: Vec<String> = cases.iter().enumerate().map(|(i, c)| format!("{}~{}~{i}", c.base, c.variant)).collect();
    for (c, key) in cases.iter().zip(&keys) {
        let mut config = configs[&c.base].clone();
        for (k, v) in &c.set {
            assert!(config.get(k).is_some(), "{k} is not a field of the configuration");
            config[k] = v.clone();
        }
        configs.insert(key.clone(), config);
    }
    let mut engine = Engine::new();
    engine.load_uarch(&uarch.to_string()).unwrap();
    let mut tables: Vec<&str> = cases.iter().map(|c| c.base.as_str()).collect();
    tables.sort();
    tables.dedup();
    for name in tables {
        engine.load_arch(name, &std::fs::read_to_string(format!("{}/data/arch/{name}.json", root())).unwrap()).unwrap();
    }
    (cases, engine, keys)
}

/// compares a case with the reference; returns the description of the difference
fn check(engine: &Engine, key: &str, c: &Case) -> Option<String> {
    let result = engine.analyze(&request(key, c));
    if let Some(error) = &c.error {
        let expected = error.strip_prefix("InputError: ");
        return match (expected, &result) {
            (Some(expected), Err(e)) if e == expected => None,
            _ => Some(format!("the reference reports {error:?}, wuica {:?}", result.as_ref().err())),
        };
    }
    let r = match result {
        Ok(r) => r,
        Err(e) => return Some(format!("error {e}")),
    };
    if Some(r.tp) != c.tp {
        Some(format!("TP {} != {:?}", r.tp, c.tp))
    } else if Some(&r.text_with_hyperlinks) != c.stdout.as_ref() {
        Some("text differs".to_string())
    } else if let (Some(expected), Some(trace)) = (&c.json, &r.trace) {
        wuica_core::jsoncmp::diff(trace, expected).map(|d| format!("trace differs: {d}"))
    } else {
        None
    }
}

fn name(c: &Case) -> String {
    format!("{} ({} {} {} {})", c.variant, c.base, c.file, c.options, serde_json::Value::Object(c.set.clone()))
}

fn report(what: &str, n: usize, failures: &[String]) {
    println!("{what}: {n} cases, {} failures", failures.len());
    for f in failures.iter().take(40) {
        println!("  {f}");
    }
    assert!(failures.is_empty());
}

#[test]
fn each_round_11_parameter_alone_matches_the_reference() {
    let (cases, engine, keys) = load("model_r11.jsonl.gz");
    let mut failures = Vec::new();
    for (c, key) in cases.iter().zip(&keys) {
        if let Some(d) = check(&engine, key, c) {
            failures.push(format!("{}: {d}", name(c)));
        }
        // the parameter matters for this block: the base configuration gives another result
        let base = engine.analyze(&request(&c.base, c)).unwrap();
        let same_trace = match (&c.json, &base.trace) {
            (Some(expected), Some(trace)) => wuica_core::jsoncmp::diff(trace, expected).is_none(),
            _ => true,
        };
        if Some(&base.text_with_hyperlinks) == c.stdout.as_ref() && same_trace {
            failures.push(format!("{}: the parameter does not change the result of this block", name(c)));
        }
    }
    report("one parameter at a time", cases.len(), &failures);
}

#[test]
fn the_boundaries_of_each_round_11_mechanism_match_the_reference() {
    let (cases, engine, keys) = load("model_r11_boundary.jsonl.gz");
    let mut failures = Vec::new();
    for (c, key) in cases.iter().zip(&keys) {
        if let Some(d) = check(&engine, key, c) {
            failures.push(format!("{}: {d}", name(c)));
        }
    }
    report("boundaries", cases.len(), &failures);
}
