//! The critical dependency cycle (`criticalPath` of the response): on a sample of the simulation fixtures, it is a closed cycle
//! of rows of the uop table, and the sum of its latencies divided by the number of iterations it spans is the "Dependencies"
//! limit of the same response. Plus hand-checked cases.

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use wuica::{Engine, Request, Response};

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

fn engine() -> Engine {
    let mut engine = Engine::new();
    engine.load_uarch(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap();
    for entry in std::fs::read_dir(format!("{}/data/arch", root())).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_stem().unwrap().to_str().unwrap().to_string();
        engine.load_arch(&name, &std::fs::read_to_string(&path).unwrap()).unwrap();
    }
    engine
}

/// Checks the critical path of a response against its other fields; an error message if it does not fit.
fn check(r: &Response) -> Result<(), String> {
    let dep = r.limits.iter().find(|l| l.name == "Dependencies");
    let Some(cp) = &r.critical_path else {
        return match dep {
            Some(l) => Err(format!("a Dependencies limit ({}) without a critical path", l.tp)),
            None => Ok(()),
        };
    };
    let dep = dep.ok_or("a critical path without a Dependencies limit")?;
    let n = cp.edges.len();
    if n == 0 {
        return Err("no edges".into());
    }
    for (k, e) in cp.edges.iter().enumerate() {
        for row in [e.from, e.to] {
            if r.rows.get(row).map(|x| x.kind) != Some("instr") {
                return Err(format!("edge {k}: row {row} is not an instruction"));
            }
        }
        let next = &cp.edges[(k + 1) % n];
        if e.to != next.from {
            return Err(format!("edge {k} ends in row {}, the next one starts in row {}", e.to, next.from));
        }
        if e.latency < 0 || e.operand.is_empty() {
            return Err(format!("edge {k}: {e:?}"));
        }
    }
    if !cp.edges[n - 1].carried {
        return Err("the cycle does not start after a carried edge".into());
    }
    let latency: i64 = cp.edges.iter().map(|e| e.latency).sum();
    let iterations = cp.edges.iter().filter(|e| e.carried).count() as i64;
    let ratio = latency as f64 / iterations as f64;
    if ratio != cp.ratio {
        return Err(format!("{latency} cycles / {iterations} iterations = {ratio}, but ratio = {}", cp.ratio));
    }
    if wuica_core::facile::py_format2(ratio) != format!("{:.2}", dep.tp) {
        return Err(format!("ratio {ratio} is not the Dependencies limit {}", dep.tp));
    }
    Ok(())
}

fn analyze(engine: &Engine, arch: &str, hex: &str) -> Response {
    let mut request = Request::new(arch);
    request.hex = hex.to_string();
    engine.analyze(&request).unwrap()
}

#[test]
fn hand_checked_cycles() {
    let engine = engine();
    // add rax, 1; add rax, 1; dec r15; jnz: rax goes through both adds (1 cycle each) per iteration
    let r = analyze(&engine, "SKL", "4883c0014883c00149ffcf75f3");
    check(&r).unwrap();
    let cp = r.critical_path.as_ref().unwrap();
    assert_eq!(cp.ratio, 2.0);
    let edges: Vec<_> = cp.edges.iter().map(|e| (e.from, e.to, e.operand.as_str(), e.latency, e.carried)).collect();
    assert_eq!(edges, [(0, 1, "RAX", 1, false), (1, 0, "RAX", 1, true)]);

    // imul rax, rax (3 cycles) then add rax, rbx (1 cycle)
    let r = analyze(&engine, "SKL", "480fafc04801d849ffcf75f4");
    check(&r).unwrap();
    let cp = r.critical_path.as_ref().unwrap();
    assert_eq!(cp.ratio, 4.0);
    let edges: Vec<_> = cp.edges.iter().map(|e| (e.from, e.to, e.latency, e.carried)).collect();
    assert_eq!(edges, [(0, 1, 3, false), (1, 0, 1, true)]);

    // mov rax, rbx; dec r15; jnz: the loop counter is the only cycle
    let r = analyze(&engine, "SKL", "4889d849ffcf75f8");
    check(&r).unwrap();
    let cp = r.critical_path.as_ref().unwrap();
    assert_eq!((cp.edges.len(), cp.edges[0].from, cp.edges[0].operand.as_str(), cp.edges[0].carried), (1, 1, "R15", true));

    // no cycle: nothing
    let r = analyze(&engine, "SKL", "4889d8");
    assert!(r.critical_path.is_none() && !r.limits.iter().any(|l| l.name == "Dependencies"));
}

#[test]
fn critical_path_gives_the_dependency_limit_on_fixtures() {
    let engine = engine();
    let file = std::fs::File::open(format!("{}/fixtures/generated/sim_fixtures.jsonl.gz", root())).expect("run tools/export_fixtures.py");
    // every case of the main set (with the option variants)
    let lines: Vec<String> = BufReader::with_capacity(1 << 20, flate2::read::GzDecoder::new(file)).lines().map(|l| l.unwrap()).collect();

    let next = AtomicUsize::new(0);
    let (checked, with_path) = (AtomicUsize::new(0), AtomicUsize::new(0));
    let failures: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(line) = lines.get(i) else { break };
                let cut = line.find(", \"json\": ").unwrap_or(line.len() - 1);
                let c: serde_json::Value = serde_json::from_str(&format!("{}}}", &line[..cut])).unwrap();
                if c.get("error").is_some_and(|e| !e.is_null()) {
                    continue;
                }
                let o = &c["options"];
                let mut request = Request::new(c["arch"].as_str().unwrap());
                request.hex = c["hex"].as_str().unwrap().to_string();
                request.alignment_offset = o["alignmentOffset"].as_i64().unwrap_or(0);
                request.init_policy = o["initPolicy"].as_str().unwrap_or("diff").to_string();
                request.simple_front_end = o["simpleFrontEnd"].as_bool().unwrap_or(false);
                request.no_micro_fusion = o["noMicroFusion"].as_bool().unwrap_or(false);
                request.no_macro_fusion = o["noMacroFusion"].as_bool().unwrap_or(false);
                let Ok(r) = engine.analyze(&request) else { continue };
                checked.fetch_add(1, Ordering::Relaxed);
                if r.critical_path.is_some() {
                    with_path.fetch_add(1, Ordering::Relaxed);
                }
                if let Err(e) = check(&r) {
                    failures.lock().unwrap().push(format!("{} {}: {e}", c["file"], c["arch"]));
                }
            });
        }
    });
    let failures = failures.into_inner().unwrap();
    println!("{} cases checked, {} with a critical path, {} failures", checked.into_inner(), with_path.load(Ordering::Relaxed), failures.len());
    for f in failures.iter().take(30) {
        println!("  {f}");
    }
    assert!(failures.is_empty());
    assert!(with_path.into_inner() > 100);
}
