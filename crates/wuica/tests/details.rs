//! `"details": true` (docs/WASM-API.md): on a sample of the simulation fixtures (every case of the main set, with its options),
//! the response with details is the default response plus the field `details` (byte for byte), the port set gives the "Ports"
//! limit, and the issue slots add up to the issue width per cycle of the window. Plus hand-checked cases.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use wuica::{Engine, Request, Response};
use wuica_core::details::Details;

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

/// the details against the rest of the response; an error message if they do not fit
fn check(r: &Response, d: &Details) -> Result<(), String> {
    if d.rows.len() != r.rows.len() {
        return Err(format!("{} detail rows for {} rows", d.rows.len(), r.rows.len()));
    }
    for (k, (row, det)) in r.rows.iter().zip(&d.rows).enumerate() {
        if (row.kind == "instr") != det.is_some() {
            return Err(format!("row {k} ({}): details {}", row.kind, if det.is_some() { "present" } else { "missing" }));
        }
        if let Some(det) = det {
            if det.length * 2 != row.opcode.as_deref().unwrap_or("").len() as i64 {
                return Err(format!("row {k}: length {}", det.length));
            }
            if !row.notes.contains('X') {
                for p in det.port_data.iter().flat_map(|p| &p.ports) {
                    if !r.columns.contains(p) {
                        return Err(format!("row {k}: port {p} is not a column of the uop table"));
                    }
                }
            }
        }
    }
    if let Some(ports) = &d.ports {
        let limit = r.limits.iter().find(|l| l.name == "Ports").map_or(0.0, |l| l.tp);
        if wuica_core::facile::py_format2(ports.tp) != format!("{limit:.2}") {
            return Err(format!("port set {:?}: {} uops / {} ports = {}, but the Ports limit is {limit}", ports.ports, ports.uops, ports.ports.len(), ports.tp));
        }
        let sum: f64 = ports.rows.iter().sum();
        if (sum - ports.uops).abs() > 1e-6 {
            return Err(format!("the rows' uops on the port set ({sum}) are not its uops ({})", ports.uops));
        }
    }
    if let Some(issue) = &d.issue {
        let s = &issue.slots;
        let total = (s.issued + s.front_end + s.rob + s.rs + s.other) * issue.iterations as f64;
        let expected = (issue.width * issue.cycles) as f64;
        // the slots per iteration are rounded to two decimals
        if (total - expected).abs() > 0.03 * issue.iterations as f64 {
            return Err(format!("issue slots {total} for {} cycles × width {}", issue.cycles, issue.width));
        }
        if issue.issued.len() != issue.cause.len() || issue.issued.len() as i64 > issue.cycles {
            return Err("per-cycle lists".into());
        }
    }
    Ok(())
}

fn analyze(engine: &Engine, arch: &str, hex: &str, details: bool) -> Response {
    let mut request = Request::new(arch);
    request.hex = hex.to_string();
    request.details = details;
    engine.analyze(&request).unwrap()
}

#[test]
fn hand_checked_details() {
    let engine = engine();
    // add rax, [rsi]; dec r15; jnz
    let r = analyze(&engine, "SKL", "48030649ffcf75f9", true);
    let d = r.details.as_ref().unwrap();
    check(&r, d).unwrap();
    let add = d.rows[0].as_ref().unwrap();
    let ports: Vec<Vec<&str>> = add.port_data.iter().map(|p| p.ports.iter().map(|s| s.as_str()).collect()).collect();
    assert!(ports.contains(&vec!["Port 0", "Port 1", "Port 5", "Port 6"]) && ports.contains(&vec!["Port 2", "Port 3"]), "{ports:?}");
    assert!(add.latencies.iter().any(|l| l.from == "RAX" && l.to == "RAX" && l.cycles == 1), "{:?}", add.latencies);
    assert!(add.latencies.iter().any(|l| l.from == "[RSI]" && l.to == "RAX" && l.cycles >= 5), "{:?}", add.latencies);
    assert_eq!((add.length, add.offset, add.lcp, add.microcoded), (3, 0, false, false));
    let dec = d.rows[1].as_ref().unwrap();
    assert!(dec.macro_fused_with_next && d.rows[2].as_ref().unwrap().macro_fused_with_prev);

    // add ax, 0x1234 (66 05 34 12: a length-changing prefix) at offset 14: crosses the 16-byte boundary
    let mut request = Request::new("SKL");
    request.hex = "6605341249ffcf75f6".into();
    request.alignment_offset = 14;
    request.details = true;
    let r = engine.analyze(&request).unwrap();
    let d = r.details.as_ref().unwrap();
    let add = d.rows[0].as_ref().unwrap();
    assert!(add.lcp);
    assert_eq!((add.offset, add.crosses.clone()), (14, vec![16]));

    // four independent adds on SKL: the ports p0156 carry 4 uops (the loop's dec/jnz on p06 is in the union)
    let r = analyze(&engine, "SKL", "4801c04801db4801c94801d249ffcf75f0", true);
    let d = r.details.as_ref().unwrap();
    check(&r, d).unwrap();
    let ps = d.ports.as_ref().unwrap();
    assert_eq!(ps.ports, ["Port 0", "Port 1", "Port 5", "Port 6"]);
    assert_eq!(ps.uops, 5.0);

    // a long dependency chain: issue stalls on a full reorder buffer or scheduler
    let r = analyze(&engine, "SKL", &"480fafc0".repeat(8), true);
    let d = r.details.as_ref().unwrap();
    check(&r, d).unwrap();
    let issue = d.issue.as_ref().unwrap();
    assert!(issue.slots.rob + issue.slots.rs > 0.0, "{issue:?}");

    // without the flag: no details
    assert!(analyze(&engine, "SKL", "48030649ffcf75f9", false).details.is_none());
}

#[test]
fn details_change_nothing_else_on_fixtures() {
    let engine = engine();
    let lines: Vec<String> = wuica_testkit::lines_without_json(format!("{}/fixtures/generated/sim_fixtures.jsonl.gz", root())).collect();
    let next = AtomicUsize::new(0);
    let checked = AtomicUsize::new(0);
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
                let plain = engine.analyze(&request);
                request.details = true;
                let detailed = engine.analyze(&request);
                let name = format!("{} {}", c["file"], c["arch"]);
                match (plain, detailed) {
                    (Ok(plain), Ok(mut detailed)) => {
                        checked.fetch_add(1, Ordering::Relaxed);
                        let Some(d) = detailed.details.take() else {
                            failures.lock().unwrap().push(format!("{name}: no details"));
                            continue;
                        };
                        if let Err(e) = check(&detailed, &d) {
                            failures.lock().unwrap().push(format!("{name}: {e}"));
                        }
                        let (a, b) = (serde_json::to_string(&plain).unwrap(), serde_json::to_string(&detailed).unwrap());
                        if a != b || plain.text_with_hyperlinks != detailed.text_with_hyperlinks {
                            failures.lock().unwrap().push(format!("{name}: the response differs with details"));
                        }
                    }
                    (Err(a), Err(b)) if a == b => {}
                    (a, b) => failures.lock().unwrap().push(format!("{name}: {:?} vs {:?}", a.err(), b.err())),
                }
            });
        }
    });
    let failures = failures.into_inner().unwrap();
    let n = checked.load(Ordering::Relaxed);
    println!("{n} cases compared with and without details, {} failures", failures.len());
    assert!(n > 1000, "only {n} cases");
    assert!(failures.is_empty(), "{} failures, e.g.:\n{}", failures.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}
