//! The compact computation of the dependency cycle (`compute_dependency_limit_with_cycle`, used for the critical path of the
//! response) against the generic one (`compute_dependency_cycle`, the latency graph of the reference): the same ratio, the same
//! edges in the same order (cycles with equal ratios are where they could differ), and the same instruction for each node, on
//! every instruction fixture with each initial-value policy.

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use wuica_core::config::UArch;
use wuica_core::facile::{compute_dependency_cycle, compute_dependency_limit, compute_dependency_limit_with_cycle};
use wuica_core::model::InstrList;

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

#[derive(serde::Deserialize)]
struct Case {
    file: String,
    arch: String,
    error: Option<String>,
    #[serde(flatten)]
    list: Option<InstrList>,
}

#[test]
fn compact_dependency_cycle_equals_the_latency_graph() {
    let uarch = UArch::from_json(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap();
    let mut lines: Vec<String> = Vec::new();
    for set in ["instr_fixtures", "extra_instr_fixtures"] {
        let file = std::fs::File::open(format!("{}/fixtures/generated/{set}.jsonl.gz", root())).expect("run tools/export_fixtures.py");
        lines.extend(BufReader::with_capacity(1 << 20, flate2::read::GzDecoder::new(file)).lines().map(|l| l.unwrap()));
    }
    let next = AtomicUsize::new(0);
    let (checked, with_cycle) = (AtomicUsize::new(0), AtomicUsize::new(0));
    let failures: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(line) = lines.get(i) else { break };
                let c: Case = serde_json::from_str(line).unwrap();
                let (None, Some(list)) = (&c.error, &c.list) else { continue };
                let config = &uarch.configs[&c.arch];
                for policy in ["diff", "same", "stack"] {
                    let (maximum, graph) = compute_dependency_cycle(list, config, policy);
                    let cycle = compute_dependency_limit_with_cycle(list, config, policy);
                    let mut owner: Vec<Option<u32>> = vec![None; list.operands.len()];
                    for (i, nodes) in graph.nodes_for_instr.iter().enumerate() {
                        for &op in nodes {
                            owner[op as usize].get_or_insert(i as u32);
                        }
                    }
                    checked.fetch_add(1, Ordering::Relaxed);
                    if !cycle.edges_on_max_cycle.is_empty() {
                        with_cycle.fetch_add(1, Ordering::Relaxed);
                    }
                    let limit = compute_dependency_limit(list, config, policy);
                    if maximum.max_cycle_ratio.to_bits() != cycle.max_cycle_ratio.to_bits()
                        || limit.to_bits() != cycle.max_cycle_ratio.to_bits()
                        || maximum.edges_on_max_cycle != cycle.edges_on_max_cycle
                        || owner != cycle.instr_of_node
                    {
                        failures.lock().unwrap().push(format!("{} {} {policy}", c.file, c.arch));
                    }
                }
            });
        }
    });
    let failures = failures.into_inner().unwrap();
    println!("{} cases checked, {} with a cycle, {} failures", checked.into_inner(), with_cycle.load(Ordering::Relaxed), failures.len());
    for f in failures.iter().take(30) {
        println!("  {f}");
    }
    assert!(failures.is_empty());
    assert!(with_cycle.into_inner() > 1000);
}
