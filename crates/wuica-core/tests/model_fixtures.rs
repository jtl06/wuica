//! Checks that the data model holds everything that the instruction fixtures of the Python reference contain, and that the
//! configurations load.

use std::io::BufRead;
use wuica_core::{config::UArch, jsoncmp, model::InstrList};

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

#[test]
fn model_round_trips_the_instruction_fixtures() {
    let path = format!("{}/fixtures/generated/instr_fixtures.jsonl.gz", root());
    let reader = wuica_testkit::open(path);
    let (mut cases, mut instrs) = (0, 0);
    for line in reader.lines() {
        let case: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        if case.get("error").is_some() {
            continue;
        }
        let name = format!("{} {} {}", case["file"], case["arch"], case["options"]);
        let expected = serde_json::json!({"operands": case["operands"], "instrs": case["instrs"]});
        let list: InstrList = serde_json::from_value(expected.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        if let Some(d) = jsoncmp::diff(&serde_json::to_value(&list).unwrap(), &expected) {
            panic!("{name}: {d}");
        }
        // the fixtures use the canonical numbering of the operands
        assert_eq!(list.renumbered(), list, "{name}: numbering");
        cases += 1;
        instrs += list.instrs.len();
    }
    assert!(cases > 5000, "only {cases} cases");
    println!("{cases} cases, {instrs} instructions");
}

#[test]
fn configurations_load() {
    let json = std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py");
    let uarch = UArch::from_json(&json).unwrap();
    assert!(uarch.configs.len() >= 19);
    let skl = &uarch.configs["SKL"];
    assert_eq!(skl.xed_name, "SKYLAKE");
    assert_eq!(skl.ports(&uarch).len(), 8);
    // loading and writing a configuration loses nothing
    let original: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(jsoncmp::diff(&serde_json::to_value(&uarch).unwrap(), &original), None);
}
