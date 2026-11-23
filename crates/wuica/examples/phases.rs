//! Times the phases of an analysis: cargo run --release -p wuica --example phases -- HEXFILE ARCH
use std::time::Instant;
use wuica_core::analyze::sim_summary;
use wuica_core::{config::UArch, data::ArchData, facile, instr_builder::build_instructions, sim};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let hex = std::fs::read_to_string(&args[1]).unwrap();
    let arch = args.get(2).map(String::as_str).unwrap_or("SKL");
    let uarch = UArch::from_json(&std::fs::read_to_string("data/uarch.json").unwrap()).unwrap();
    let config = &uarch.configs[arch];
    let data = ArchData::from_json(&std::fs::read_to_string(format!("data/arch/{}.json", config.name)).unwrap()).unwrap();
    let code = wuica_xed::parse_hex(hex.trim()).unwrap();
    let t = Instant::now();
    let decoded = wuica_xed::decode(&code, &config.xed_name).unwrap();
    let t_dec = t.elapsed();
    let t = Instant::now();
    let instrs = build_instructions(&decoded.instrs, config, &uarch, &data, 0, false, false);
    let t_build = t.elapsed();
    let t = Instant::now();
    let r = sim::simulate(&instrs, config, &uarch, &sim::SimOptions::default()).unwrap();
    let t_sim = t.elapsed();
    let t = Instant::now();
    let table = r.uops_table();
    let t_table = t.elapsed();
    let t = Instant::now();
    let dep = facile::compute_dependency_limit(&instrs, config, "diff");
    let t_dep = t.elapsed();
    let t = Instant::now();
    let report = facile::bottleneck_report(&instrs, &decoded.instrs, config, 0, dep, &sim_summary(&r));
    let t_rep = t.elapsed();
    println!("{} instructions, TP {}: decode {:?}, build {:?}, simulate {:?}, table {:?}, dependency limit {:?}, report {:?} ({} + {} bytes)",
        instrs.instrs.len(), r.tp, t_dec, t_build, t_sim, t_table, t_dep, t_rep, table.len(), report.len());
}
