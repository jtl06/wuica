//! Checks the instruction builder against the instruction fixtures of the Python reference: for every case, the instruction
//! objects built from the decoded records must be equal to those of the reference (see docs/PORTING.md for the formats).
//!
//! All failing cases are reported, grouped by the path of their first difference (without array indices).
//! To look at one case, set `WUICA_CASE` to words that its name must contain, e.g. `WUICA_CASE="x_zmm_mix.o SKX {}"`: the
//! first differences of the matching cases are printed in full, and only they are run.
//! To check further fixtures (same formats), set `WUICA_FIXTURES` to the absolute paths of a decode-fixture file and an
//! instruction-fixture file, separated by a space.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use wuica_core::config::UArch;
use wuica_core::data::ArchData;
use wuica_core::decoded::DecodedInstr;
use wuica_core::instr_builder::build_instructions;
use wuica_core::jsoncmp;
use wuica_core::model::InstrList;

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

fn lines(path: &str) -> impl Iterator<Item = String> {
    wuica_testkit::lines(path)
}

#[derive(serde::Deserialize)]
struct DecodeCase {
    file: String,
    chip: String,
    instrs: Vec<DecodedInstr>,
}

#[derive(serde::Deserialize)]
struct InstrCase {
    file: String,
    arch: String,
    options: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    operands: serde_json::Value,
    #[serde(default)]
    instrs: serde_json::Value,
}

/// Removes the array indices from the path of a difference ("$.instrs[3].portData[0][1]: 1 != 2" -> "$.instrs[].portData[][]").
fn group_of(difference: &str) -> String {
    let path = difference.split(": ").next().unwrap_or(difference);
    let mut group = String::new();
    let mut in_index = false;
    for c in path.chars() {
        match c {
            '[' => {
                in_index = true;
                group.push_str("[]");
            }
            ']' => in_index = false,
            _ if in_index => {}
            _ => group.push(c),
        }
    }
    group
}

/// A failing case; `group` is the path of its first difference without array indices.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Failure {
    group: String,
    name: String,
    difference: String,
}

#[derive(Default)]
struct Results {
    cases: usize,
    instrs: usize,
    skipped: usize,
    failures: Vec<Failure>,
}

/// Runs all cases of a pair of fixture files; returns (cases, instructions).
fn check(decode_fixtures: &str, instr_fixtures: &str) -> (usize, usize) {
    // One set at a time: the tests of this file run in parallel, each set uses up to 8 threads (the machine is shared), and the
    // panic hook is replaced while a set runs.
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let _guard = ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let uarch = UArch::from_json(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap();
    let mut tables: HashMap<String, ArchData> = HashMap::new();
    for config in uarch.configs.values() {
        if !tables.contains_key(&config.name) {
            let path = format!("{}/data/arch/{}.json", root(), config.name);
            let json = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
            tables.insert(config.name.clone(), ArchData::from_json(&json).unwrap_or_else(|e| panic!("{path}: {e}")));
        }
    }
    let mut decoded: HashMap<(String, String), Vec<DecodedInstr>> = HashMap::new();
    for line in lines(decode_fixtures) {
        let case: DecodeCase = serde_json::from_str(&line).unwrap();
        decoded.insert((case.file, case.chip), case.instrs);
    }
    let filter: Vec<String> = std::env::var("WUICA_CASE").map(|f| f.split_whitespace().map(String::from).collect()).unwrap_or_default();

    let all_lines: Vec<String> = lines(instr_fixtures).collect();
    let next = Mutex::new(0usize);
    let results = Mutex::new(Results::default());
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    std::thread::scope(|scope| {
        for _ in 0..std::thread::available_parallelism().map_or(4, |n| n.get()).min(8) {
            scope.spawn(|| loop {
                let i = {
                    let mut next = next.lock().unwrap();
                    *next += 1;
                    *next - 1
                };
                let Some(line) = all_lines.get(i) else { break };
                let case: InstrCase = serde_json::from_str(line).unwrap();
                let name = format!("{} {} {}", case.file, case.arch, serde_json::Value::Object(case.options.clone()));
                if case.error.is_some() || !filter.iter().all(|word| name.contains(word.as_str())) {
                    results.lock().unwrap().skipped += 1;
                    continue;
                }
                let expected = serde_json::json!({"operands": case.operands, "instrs": case.instrs});
                // a panic (of the builder, or because the case cannot be run) is a failure of the case
                let built = std::panic::catch_unwind(|| {
                    for option in case.options.keys() {
                        assert!(matches!(option.as_str(), "alignmentOffset" | "noMicroFusion" | "noMacroFusion"), "unknown option {option}");
                    }
                    let config = uarch.configs.get(&case.arch).unwrap_or_else(|| panic!("unknown configuration"));
                    let disas = decoded
                        .get(&(case.file.clone(), config.xed_name.clone()))
                        .unwrap_or_else(|| panic!("no decoded records for chip {}", config.xed_name));
                    let alignment_offset = case.options.get("alignmentOffset").map_or(0, |v| v.as_i64().unwrap());
                    let flag = |key: &str| case.options.get(key).is_some_and(|v| v.as_bool().unwrap());
                    let table = &tables[&config.name];
                    let list = build_instructions(disas, config, &uarch, table, alignment_offset, flag("noMicroFusion"), flag("noMacroFusion"));
                    (list, disas.len())
                });
                let mut n_instrs = 0;
                let failure = match built {
                    Ok((list, n)) => {
                        n_instrs = n;
                        let list: InstrList = list.renumbered();
                        jsoncmp::diff(&serde_json::to_value(&list).unwrap(), &expected).map(|d| (group_of(&d), d))
                    }
                    Err(panic) => {
                        let message = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()));
                        Some(("panic".to_string(), message.unwrap_or_default()))
                    }
                };
                let mut results = results.lock().unwrap();
                results.cases += 1;
                results.instrs += n_instrs;
                if let Some((group, difference)) = failure {
                    results.failures.push(Failure { group, name, difference });
                }
            });
        }
    });
    std::panic::set_hook(hook);

    let Results { cases, instrs, skipped, mut failures } = results.into_inner().unwrap();
    failures.sort();
    let mut groups: BTreeMap<&str, Vec<&Failure>> = BTreeMap::new();
    for failure in &failures {
        groups.entry(&failure.group).or_default().push(failure);
    }
    println!("{instr_fixtures}: {cases} cases, {instrs} instructions, {skipped} skipped, {} failing cases", failures.len());
    let mut groups: Vec<_> = groups.into_iter().collect();
    groups.sort_by_key(|(_, cases)| std::cmp::Reverse(cases.len()));
    for (group, cases) in &groups {
        println!("{:6} {group}", cases.len());
        for failure in cases.iter().take(if filter.is_empty() { 3 } else { usize::MAX }) {
            println!("         {}: {}", failure.name, failure.difference);
        }
    }
    assert!(failures.is_empty(), "{instr_fixtures}: {} of {cases} cases differ from the reference", failures.len());
    (cases, instrs)
}

#[test]
fn builder_reproduces_the_instruction_fixtures() {
    let (cases, _) = check("fixtures/decode_fixtures.jsonl.gz", "fixtures/generated/instr_fixtures.jsonl.gz");
    assert!(cases >= 8056 || std::env::var("WUICA_CASE").is_ok(), "only {cases} cases");
}

/// The extra set: hand-written blocks for paths that the main corpus does not reach (e.g. code with ZMM registers), each
/// exported in a new process of the reference.
#[test]
fn builder_reproduces_the_extra_instruction_fixtures() {
    let (cases, _) = check("fixtures/decode_fixtures_extra.jsonl.gz", "fixtures/generated/extra_instr_fixtures.jsonl.gz");
    assert!(cases >= 3040 || std::env::var("WUICA_CASE").is_ok(), "only {cases} cases");
}

/// Further fixtures, given by the environment variable `WUICA_FIXTURES` (see the top of this file); passes if it is not set.
#[test]
fn builder_reproduces_additional_fixtures() {
    let Ok(paths) = std::env::var("WUICA_FIXTURES") else { return };
    let paths: Vec<&str> = paths.split_whitespace().collect();
    assert_eq!(paths.len(), 2, "WUICA_FIXTURES: two paths");
    let (cases, _) = check(paths[0], paths[1]);
    assert!(cases > 0 || std::env::var("WUICA_CASE").is_ok(), "no cases");
}
