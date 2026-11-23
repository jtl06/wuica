//! One-off: the simulation cases without instruction fixtures (blocks of more than 2000 bytes), with the instruction builder.
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use wuica_core::config::UArch;
use wuica_core::data::ArchData;
use wuica_core::decoded::DecodedInstr;
use wuica_core::instr_builder::build_instructions;
use wuica_core::sim::{simulate, SimOptions};

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}
fn lines(path: &str) -> impl Iterator<Item = String> {
    let file = std::fs::File::open(format!("{}/{path}", root())).unwrap();
    BufReader::with_capacity(1 << 20, flate2::read::GzDecoder::new(file)).lines().map(|l| l.unwrap())
}
#[derive(serde::Deserialize)]
struct DecodeLine {
    file: String,
    chip: String,
    instrs: Vec<DecodedInstr>,
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
}
#[test]
fn big_blocks() {
    let uarch = UArch::from_json(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).unwrap()).unwrap();
    let mut disas: HashMap<(String, String), Vec<DecodedInstr>> = HashMap::new();
    for line in lines("fixtures/decode_fixtures.jsonl.gz") {
        let d: DecodeLine = serde_json::from_str(&line).unwrap();
        disas.insert((d.file, d.chip), d.instrs);
    }
    let mut data: HashMap<String, ArchData> = HashMap::new();
    let (mut n, mut bad) = (0, 0);
    for line in lines("fixtures/generated/sim_fixtures.jsonl.gz") {
        // the hex string comes after the options: skip small cases cheaply
        if line.len() < 4000 {
            continue;
        }
        let c: Case = serde_json::from_str(&line).unwrap();
        if c.hex.len() <= 4000 || c.tp.is_none() {
            continue;
        }
        assert_eq!(c.options.to_string(), "{}");
        let config = &uarch.configs[&c.arch];
        let d = data.entry(config.name.clone()).or_insert_with(|| {
            ArchData::from_json(&std::fs::read_to_string(format!("{}/data/arch/{}.json", root(), config.name)).unwrap()).unwrap()
        });
        let decoded = &disas[&(c.file.clone(), config.xed_name.clone())];
        let list = build_instructions(decoded, config, &uarch, d, 0, false, false);
        let t = std::time::Instant::now();
        let r = simulate(&list, config, &uarch, &SimOptions::default()).unwrap();
        let ms = t.elapsed().as_secs_f64() * 1e3;
        let table = r.uops_table();
        let ok = Some(r.tp) == c.tp && c.stdout.as_deref().is_some_and(|s| s.ends_with(&format!("\n\n{table}\n")));
        n += 1;
        bad += !ok as usize;
        println!("{} {}: {} instructions, {} uops, {:.1} ms, TP {} (expected {:?}), {}", c.file, c.arch, list.instrs.len(), r.uops.len(), ms, r.tp, c.tp, if ok { "ok" } else { "DIFFERENT" });
    }
    println!("{n} cases, {bad} differences");
    assert_eq!(bad, 0);
}
