//! The parameters of model round 11, one at a time: each case of `model_r11.jsonl.gz` is a block that the reference (the fork's
//! `improve-r11`) ran with one round-11 parameter switched on in a configuration that does not have it, or switched off in one
//! that has it (made with `tools/gen_model_r11_cases.py` on the reference machine; see docs/PORTING.md, "Model round 11"). The shipped
//! configurations switch several on at once; these cases check each mechanism alone. wuica must give the same throughput, text
//! and `-json` trace, and the parameter must change the result (otherwise the case would not test it).
//!
//! Fields of a case: `variant` (a name), `base` (the configuration), `set` (the parameters, with their JSON values), `file`, `options`,
//! `hex`, and the reference's `TP`, `stdout` and (for one case of most variants) `json`.

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
    tp: f64,
    stdout: String,
    /// (only in some cases: the traces are most of the file's size)
    json: Option<serde_json::Value>,
}

fn request(arch: &str, c: &Case) -> Request {
    let o = &c.options;
    let mut r = Request::new(arch);
    r.hex = c.hex.clone();
    r.alignment_offset = o["alignmentOffset"].as_i64().unwrap_or(0);
    r.init_policy = o["initPolicy"].as_str().unwrap_or("diff").to_string();
    r.simple_front_end = o["simpleFrontEnd"].as_bool().unwrap_or(false);
    r.include_trace = true;
    r
}

#[test]
fn each_round_11_parameter_alone_matches_the_reference() {
    let path = format!("{}/crates/wuica/tests/model_r11.jsonl.gz", root());
    let cases: Vec<Case> = wuica_testkit::lines(&path).map(|l| serde_json::from_str(&l).unwrap()).collect();
    assert!(!cases.is_empty());

    // the configurations of the cases: the base configuration with the parameters set, under a key of its own (the instruction
    // table stays the base's)
    let mut uarch: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap();
    let configs = uarch["configs"].as_object_mut().unwrap();
    let key = |i: usize, c: &Case| format!("{}~{}~{i}", c.base, c.variant);
    for (i, c) in cases.iter().enumerate() {
        let mut config = configs[&c.base].clone();
        for (k, v) in &c.set {
            assert!(config.get(k).is_some(), "{k} is not a field of the configuration");
            config[k] = v.clone();
        }
        configs.insert(key(i, c), config);
    }
    let mut engine = Engine::new();
    engine.load_uarch(&uarch.to_string()).unwrap();
    for c in &cases {
        let name = &c.base;
        engine.load_arch(name, &std::fs::read_to_string(format!("{}/data/arch/{name}.json", root())).unwrap()).unwrap();
    }

    let mut failures = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let name = format!("{} ({} {} {} {})", c.variant, c.base, c.file, c.options, serde_json::Value::Object(c.set.clone()));
        let r = match engine.analyze(&request(&key(i, c), c)) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{name}: error {e}"));
                continue;
            }
        };
        if r.tp != c.tp {
            failures.push(format!("{name}: TP {} != {}", r.tp, c.tp));
        } else if r.text_with_hyperlinks != c.stdout {
            failures.push(format!("{name}: text differs"));
        } else if let (Some(expected), Some(trace)) = (&c.json, &r.trace) {
            if let Some(d) = wuica_core::jsoncmp::diff(trace, expected) {
                failures.push(format!("{name}: trace differs: {d}"));
            }
        }
        // the parameter matters for this block: the base configuration gives another result
        let base = engine.analyze(&request(&c.base, c)).unwrap();
        let same_trace = match (&c.json, &base.trace) {
            (Some(expected), Some(trace)) => wuica_core::jsoncmp::diff(trace, expected).is_none(),
            _ => true,
        };
        if base.text_with_hyperlinks == c.stdout && same_trace {
            failures.push(format!("{name}: the parameter does not change the result of this block"));
        }
    }
    println!("{} cases, {} failures", cases.len(), failures.len());
    for f in &failures {
        println!("  {f}");
    }
    assert!(failures.is_empty());
}
