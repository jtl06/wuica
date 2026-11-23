//! One-off end-to-end check: simulator + bottleneck analysis reproduce the whole `stdout` of the simulation fixtures
//! (throughput line, `printBottlenecks`, uop table). Shows how `facile::SimSummary` is made from `sim::SimResult`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use wuica_core::config::UArch;
use wuica_core::decoded::DecodedInstr;
use wuica_core::facile::{bottleneck_report, compute_dependency_limit, InstrInstanceSummary, InstrSource, SimSummary, UopSummary};
use wuica_core::model::InstrList;
use wuica_core::sim::{simulate, InitPolicy, SimOptions, SimResult, UopSource};

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
struct Header {
    file: String,
    arch: String,
    options: serde_json::Value,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct Case {
    stdout: String,
    #[allow(dead_code)]
    json: Option<serde::de::IgnoredAny>,
}

/// `facile::SimSummary` from the result of the simulation
fn summary(r: &SimResult) -> SimSummary {
    let uop = |u: u32| {
        let uop = &r.uops[u as usize];
        UopSummary { actual_port: uop.actual_port.map(|p| r.port_name(p).to_string()), eliminated: uop.eliminated, div_cycles: uop.div_cycles }
    };
    let unfused = |lams: &mut dyn Iterator<Item = u32>| -> Vec<UopSummary> {
        lams.flat_map(|l| r.laminated_uops[l as usize].unfused_uops()).map(uop).collect()
    };
    SimSummary {
        tp: r.tp,
        is_loop: !r.unroll,
        n_rounds: r.n_relevant_rounds(),
        instances: r
            .relevant_instr_instances_for_instr
            .iter()
            .map(|list| {
                list.iter()
                    .map(|&i| {
                        let inst = &r.instr_instances[i as usize];
                        InstrInstanceSummary {
                            source: match inst.source {
                                Some(UopSource::Mite) => Some(InstrSource::Mite),
                                Some(UopSource::Dsb) => Some(InstrSource::Dsb),
                                Some(UopSource::Lsd) => Some(InstrSource::Lsd),
                                _ => None,
                            },
                            uops: unfused(&mut inst.uops()),
                            other_uops: unfused(&mut inst.reg_merge_uops.iter().chain(&inst.stack_sync_uops).copied()),
                        }
                    })
                    .collect()
            })
            .collect(),
    }
}

#[test]
fn simulator_and_bottleneck_analysis_reproduce_stdout() {
    let uarch = UArch::from_json(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).unwrap()).unwrap();
    let key = |file: &str, arch: &str, o: &serde_json::Value| format!("{file}|{arch}|{}|{}|{}", o["alignmentOffset"], o["noMicroFusion"], o["noMacroFusion"]);
    let (mut n, mut bad, mut crashes) = (0, 0, 0);
    for (decode, instr, sim) in [
        ("fixtures/decode_fixtures.jsonl.gz", "fixtures/generated/instr_fixtures.jsonl.gz", "fixtures/generated/sim_fixtures.jsonl.gz"),
        ("fixtures/decode_fixtures_extra.jsonl.gz", "fixtures/generated/extra_instr_fixtures.jsonl.gz", "fixtures/generated/extra_sim_fixtures.jsonl.gz"),
    ] {
        let mut disas: HashMap<(String, String), Vec<DecodedInstr>> = HashMap::new();
        for line in lines(decode) {
            let d: DecodeLine = serde_json::from_str(&line).unwrap();
            disas.insert((d.file, d.chip), d.instrs);
        }
        let mut instr_cases: HashMap<String, String> = HashMap::new();
        for line in lines(instr) {
            let h: Header = serde_json::from_str(&line).unwrap();
            if h.error.is_none() {
                instr_cases.insert(key(&h.file, &h.arch, &h.options), line);
            }
        }
        for line in lines(sim) {
            let h: Header = serde_json::from_str(&line).unwrap();
            let Some(instr_line) = instr_cases.get(&key(&h.file, &h.arch, &h.options)) else { continue };
            if h.error.is_some() {
                continue;
            }
            let list: InstrList = serde_json::from_str(instr_line).unwrap();
            let o = &h.options;
            let policy = o["initPolicy"].as_str().unwrap_or("diff");
            let options = SimOptions {
                alignment_offset: o["alignmentOffset"].as_i64().unwrap_or(0),
                init_policy: match policy {
                    "same" => InitPolicy::Same,
                    "stack" => InitPolicy::Stack,
                    _ => InitPolicy::Diff,
                },
                simple_front_end: o["simpleFrontEnd"].as_bool().unwrap_or(false),
                min_iterations: o["minIterations"].as_i64().unwrap_or(10),
                min_cycles: o["minCycles"].as_i64().unwrap_or(500),
            };
            let config = &uarch.configs[&h.arch];
            let r = simulate(&list, config, &uarch, &options).unwrap();
            let d = &disas[&(h.file.clone(), config.xed_name.clone())];
            let s = summary(&r);
            let report = std::panic::catch_unwind(|| {
                let dep_limit = compute_dependency_limit(&list, config, policy);
                bottleneck_report(&list, d, config, options.alignment_offset, dep_limit, &s)
            });
            let Ok(report) = report else {
                crashes += 1;
                continue;
            };
            let stdout = format!("Throughput (in cycles per iteration): {:.2}\n{report}\n{}\n", r.tp, r.uops_table());
            let c: Case = serde_json::from_str(&line).unwrap();
            n += 1;
            if stdout != c.stdout {
                bad += 1;
                if bad <= 5 {
                    println!("{} {} {}:\n{}\n--- expected ---\n{}", h.file, h.arch, h.options, stdout, c.stdout);
                }
            }
        }
    }
    println!("{n} cases, {bad} differences, {crashes} panics in the bottleneck analysis");
    assert_eq!(bad + crashes, 0);
}
