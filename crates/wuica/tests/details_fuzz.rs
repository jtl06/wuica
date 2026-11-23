//! `"details": true` against the rest of the response on random blocks (tests/fuzz/mod.rs, all 15 CPUs, random options): the
//! response with details is the default one plus `details` (byte for byte); the port set is the one an independent computation
//! from the rows' `portData` finds (Facile's unions of two allowed port sets) and gives the "Ports" limit; a row's uops in the uop
//! table run only on the allowed ports of its `uopList`, as many as it lists; the issue log's issued uops per iteration are the
//! table's "Issued" uops, and its window's cycles per iteration are the throughput (but in at most 1 % of the blocks without a
//! trace: docs/plans/qa-r2.md, D1). `WUICA_DETAILS_FUZZ_SEED` and `WUICA_DETAILS_FUZZ_BLOCKS` change the seed and the number
//! of blocks (default 3000).
mod fuzz;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use wuica::{Engine, Request, Response};
use wuica_core::details::Details;

fn col(r: &Response, name: &str) -> Option<usize> {
    r.columns.iter().position(|c| c == name)
}

/// the invariants; an error message if one does not hold
pub fn invariants(r: &Response, d: &Details, simple_front_end: bool, notes: &mut Vec<String>) -> Result<(), String> {
    if d.rows.len() != r.rows.len() {
        return Err(format!("{} detail rows for {} rows", d.rows.len(), r.rows.len()));
    }
    let any_x = r.rows.iter().any(|row| row.notes.contains('X'));
    let any_elim = d.rows.iter().flatten().any(|x| x.may_be_eliminated);
    let exec = col(r, "Exec.").ok_or("no Exec. column")?;
    let issued = col(r, "Issued").ok_or("no Issued column")?;
    let first_port = exec + 1;
    let div = col(r, "Div");
    let port_cols = &r.columns[first_port..div.unwrap_or(r.columns.len())];
    // offsets: the alignment offset plus the lengths before
    let mut expected_offset: Option<i64> = None;
    for (k, (row, det)) in r.rows.iter().zip(&d.rows).enumerate() {
        if (row.kind == "instr") != det.is_some() {
            return Err(format!("row {k} ({}): details {}", row.kind, if det.is_some() { "present" } else { "missing" }));
        }
        let Some(det) = det else { continue };
        if let Some(o) = expected_offset {
            if det.offset != o {
                return Err(format!("row {k}: offset {} after the previous instruction's end {o}", det.offset));
            }
        }
        expected_offset = Some(det.offset + det.length);
        if row.notes.contains('X') || det.macro_fused_with_prev {
            continue;
        }
        // the uop list has the uops of portData (the same multiset of port sets); not for some instructions whose tables list
        // more uops than the model builds (as uiCA: e.g. cpuid's store-data uop, ret imm16's second p237 uop)
        let mut a: Vec<Vec<String>> = det.port_data.iter().flat_map(|p| std::iter::repeat_n(p.ports.clone(), p.uops.max(0) as usize)).collect();
        let mut b: Vec<Vec<String>> = det.uop_list.iter().filter_map(|u| u.ports.clone()).collect();
        a.iter_mut().chain(b.iter_mut()).for_each(|s| s.sort());
        a.sort();
        b.sort();
        if a != b {
            notes.push(format!("portData != uopList: {}", row.label.split(' ').next().unwrap_or("")));
        }
        // the row's uops on ports: only the allowed ports of its uops (with the macro-fused next instruction's), and as many
        let uop_ports = |x: &wuica_core::details::InstrDetails| -> Vec<Vec<String>> { x.uop_list.iter().filter_map(|u| u.ports.clone()).collect() };
        let mut list = uop_ports(det);
        if det.macro_fused_with_next {
            if let Some(Some(next)) = d.rows.get(k + 1) {
                // the fused pair is one uop (the branch's)
                let n = uop_ports(next);
                if !n.is_empty() {
                    list.pop();
                    list.extend(n);
                }
            }
        }
        let n_uops = list.len() as i64;
        let allowed: Vec<&String> = list.iter().flatten().collect();
        for (j, name) in port_cols.iter().enumerate() {
            let v = row.values[first_port + j];
            if v > 0.0 && !allowed.contains(&name) {
                return Err(format!("row {k} ({}): {v} uops on {name}, allowed {:?}", row.label, allowed));
            }
        }
        let on_ports = row.values[exec];
        if det.may_be_eliminated {
            if on_ports > n_uops as f64 + 0.011 {
                return Err(format!("row {k} ({}): {on_ports} uops executed, at most {n_uops}", row.label));
            }
        } else if (on_ports - n_uops as f64).abs() > 0.011 {
            return Err(format!("row {k} ({}): {on_ports} uops executed, portData has {n_uops}", row.label));
        }
        if let Some(dc) = div {
            let cycles: i64 = det.uop_list.iter().map(|u| u.div_cycles).sum();
            if (row.values[dc] - cycles as f64).abs() > 0.011 {
                return Err(format!("row {k} ({}): Div {} but the uops' divCycles {cycles}", row.label, row.values[dc]));
            }
        }
    }
    // the port set
    let limit = r.limits.iter().find(|l| l.name == "Ports").map(|l| l.tp);
    match (&d.ports, limit) {
        (None, Some(l)) if l > 0.0 => return Err(format!("a Ports limit {l} without a port set")),
        (Some(ps), _) => {
            let l = limit.unwrap_or(0.0);
            if wuica_core::facile::py_format2(ps.tp) != format!("{l:.2}") {
                return Err(format!("port set {:?}: tp {} but the Ports limit is {l}", ps.ports, ps.tp));
            }
            if ((ps.uops / ps.ports.len() as f64) - ps.tp).abs() > 1e-9 {
                return Err(format!("port set {:?}: {} uops / {} ports != {}", ps.ports, ps.uops, ps.ports.len(), ps.tp));
            }
            let sum: f64 = ps.rows.iter().sum();
            if (sum - ps.uops).abs() > 1e-6 {
                return Err(format!("the rows' uops on the port set ({sum}) are not its uops ({})", ps.uops));
            }
            if !any_x && !any_elim {
                // independently: per row, the uops whose allowed ports are inside the set
                let inside = |ports: &[String]| ports.iter().all(|p| ps.ports.contains(p));
                for (k, det) in d.rows.iter().enumerate() {
                    let n: i64 = match det {
                        Some(det) if !det.macro_fused_with_prev => det.port_data.iter().filter(|p| inside(&p.ports)).map(|p| p.uops).sum(),
                        _ => 0,
                    };
                    if (ps.rows[k] - n as f64).abs() > 1e-9 {
                        return Err(format!("row {k}: {} uops on the port set {:?}, its portData gives {n}", ps.rows[k], ps.ports));
                    }
                }
                // and the set with the most uops per port among the unions of two allowed sets
                let mut sets: Vec<(Vec<String>, i64)> = Vec::new();
                for det in d.rows.iter().flatten().filter(|x| !x.macro_fused_with_prev) {
                    for p in &det.port_data {
                        let mut s = p.ports.clone();
                        s.sort();
                        match sets.iter_mut().find(|(t, _)| *t == s) {
                            Some((_, n)) => *n += p.uops,
                            None => sets.push((s, p.uops)),
                        }
                    }
                }
                let mut best = 0.0f64;
                for (a, _) in &sets {
                    for (b, _) in &sets {
                        let mut u: Vec<String> = a.iter().chain(b).cloned().collect();
                        u.sort();
                        u.dedup();
                        if u.is_empty() {
                            continue;
                        }
                        let n: i64 = sets.iter().filter(|(s, _)| s.iter().all(|p| u.contains(p))).map(|(_, n)| n).sum();
                        best = best.max(n as f64 / u.len() as f64);
                    }
                }
                if (best - ps.tp).abs() > 1e-9 {
                    return Err(format!("port set {:?} gives {}, the best union gives {best}", ps.ports, ps.tp));
                }
            }
        }
        _ => {}
    }
    // the issue log
    if let Some(issue) = &d.issue {
        let s = &issue.slots;
        let it = issue.iterations as f64;
        let total = (s.issued + s.front_end + s.rob + s.rs + s.other) * it;
        let expected = (issue.width * issue.cycles) as f64;
        if (total - expected).abs() > 0.03 * it {
            return Err(format!("issue slots {total} for {} cycles × width {}", issue.cycles, issue.width));
        }
        if issue.issued.len() != issue.cause.len() || issue.issued.len() as i64 > issue.cycles {
            return Err("per-cycle lists".into());
        }
        if issue.issued.len() as i64 == issue.cycles {
            let n: i64 = issue.issued.iter().map(|&x| x as i64).sum();
            if (n as f64 / it - s.issued).abs() > 0.006 {
                return Err(format!("per-cycle issued {n} / {it} != slots.issued {}", s.issued));
            }
            for (c, (&n, cause)) in issue.issued.iter().zip(issue.cause.bytes()).enumerate() {
                if (n as i64 >= issue.width) != (cause == b'.') {
                    return Err(format!("cycle {c}: {n} issued, cause {}", cause as char));
                }
            }
        }
        // the table's issued uops per iteration (rounded to two decimals per row): the window can start and end inside a cycle
        // (not with the simple front end: it issues the unfused uops one by one, the table counts the fused ones, as uiCA)
        let table: f64 = r.rows.iter().map(|row| row.values[issued]).sum();
        let tol = 2.0 * issue.width as f64 / it + 0.01 * r.rows.len() as f64 + 0.01;
        if !simple_front_end && (table - s.issued).abs() > tol {
            return Err(format!("issued per iteration: log {} but the table {table} (tolerance {tol:.3})", s.issued));
        }
        // the window is in the steady state: its cycles per iteration are the throughput (finding D1 of docs/plans/qa-r2.md: issue
        // runs ahead of retirement until the reorder buffer or the scheduler is full, and a simulation of minCycles often ends
        // before; without a trace, a longer simulation gives the log). A note, counted by the caller: with a trace (the log is
        // that of the trace's cycles), or a block whose longer simulation would be too large or is not steady either.
        let cpi = issue.cycles as f64 / it;
        if !wuica_core::details::window_is_steady(issue.cycles, issue.iterations, r.tp) {
            let trace = if r.trace.is_some() { " (with a trace)" } else { "" };
            notes.push(format!("not steady: issue window cycles/iteration {} tp{trace}", if cpi < r.tp { "<" } else { ">" }));
        }
    }
    Ok(())
}

/// the SHA-256 showcase (web/js/showcase.js): 2,949 instructions
fn sha256_hex() -> String {
    let js = std::fs::read_to_string(format!("{}/web/js/showcase.js", fuzz::root())).unwrap();
    let start = js.find("SHA256_BLOCK_HEX = [").unwrap();
    let end = start + js[start..].find("\n]").unwrap();
    js[start..end].split('\'').skip(1).step_by(2).collect()
}

/// Finding D1 (docs/plans/qa-r2.md): the page's pointer-chasing example (mov rax, [rax]; dec rcx; jnz) is latency-bound, but
/// the simulation of 500 cycles ends while issue still runs ahead of retirement (on ADL-P: 48 iterations issued in 16 cycles,
/// "100 % issued"). The issue slots must be those of the steady state: cycles per iteration = the throughput, slots lost.
#[test]
fn issue_slots_are_of_the_steady_state() {
    let engine = fuzz::engine();
    for arch in fuzz::CPUS {
        for hex in ["488b0048ffc975f8", "c4e27da9c2c4e27da9cac4e27da9d2c4e27da9da48ffc975ec"] {
            let mut req = Request::new(arch);
            req.hex = hex.into();
            req.details = true;
            let r = engine.analyze(&req).unwrap();
            let issue = r.details.as_ref().unwrap().issue.as_ref().unwrap();
            let cpi = issue.cycles as f64 / issue.iterations as f64;
            assert!(wuica_core::details::window_is_steady(issue.cycles, issue.iterations, r.tp), "{arch} {hex}: {} cycles / {} iterations = {cpi}, throughput {}", issue.cycles, issue.iterations, r.tp);
            let s = &issue.slots;
            let lost = s.front_end + s.rob + s.rs + s.other;
            assert!((s.issued + lost - issue.width as f64 * r.tp).abs() <= 0.05 * issue.width as f64 * r.tp, "{arch} {hex}: slots {s:?}, tp {}", r.tp);
            // with the trace, the log is that of the trace's cycles (the simulation of the response), and the rest is the same
            req.include_trace = true;
            let t = engine.analyze(&req).unwrap();
            assert_eq!((t.tp, &t.rows), (r.tp, &r.rows), "{arch} {hex}");
            let tl = t.details.as_ref().unwrap().issue.as_ref().unwrap();
            let max_cycle = t.trace.as_ref().unwrap()["cycles"].as_array().unwrap().len() as i64;
            assert!(tl.first + tl.issued.len() as i64 <= max_cycle + 1, "{arch} {hex}: the trace's issue log is beyond its cycles");
        }
    }
    // ADL-P, pointer chasing: 2 fused uops per iteration of 5 cycles × 6 slots: 28 slots lost per iteration
    let mut req = Request::new("ADL-P");
    req.hex = "488b0048ffc975f8".into();
    req.details = true;
    let r = engine.analyze(&req).unwrap();
    let s = &r.details.as_ref().unwrap().issue.as_ref().unwrap().slots;
    let lost = s.front_end + s.rob + s.rs + s.other;
    assert!((s.issued - 2.0).abs() <= 0.05 && (lost - 28.0).abs() <= 0.5, "{s:?}");
}

#[test]
fn details_on_odd_inputs_on_every_cpu() {
    let engine = fuzz::engine();
    let sha = sha256_hex();
    assert!(sha.len() > 20_000, "the showcase's hex: {} digits", sha.len());
    // (hex, minIterations, minCycles, includeTrace)
    let cases: Vec<(String, i64, i64, bool)> = vec![
        (String::new(), 10, 500, false),
        ("ffff".into(), 10, 500, false),
        ("90".into(), 10, 500, false),
        ("4801d8".into(), 1, 0, false),
        ("4801d8".into(), 0, 0, false),
        ("75fe".into(), 10, 500, true),
        ("48f7f1".into(), 10, 500, false),
        ("488b0048ffc975f8".into(), 10, 500, true),
        ("4801d8".repeat(3000), 10, 500, false),
        (sha, 10, 500, false),
    ];
    let mut n = 0;
    for arch in fuzz::CPUS {
        for (hex, it, cycles, trace) in &cases {
            let mut req = Request::new(arch);
            req.hex = hex.clone();
            req.min_iterations = *it;
            req.min_cycles = *cycles;
            req.include_trace = *trace;
            let plain = engine.analyze(&req);
            req.details = true;
            let detailed = engine.analyze(&req);
            let what = format!("{arch} {} digits, minIterations {it}, minCycles {cycles}", hex.len());
            match (plain, detailed) {
                (Ok(plain), Ok(mut detailed)) => {
                    let d = detailed.details.take().unwrap_or_else(|| panic!("{what}: no details"));
                    invariants(&detailed, &d, false, &mut Vec::new()).unwrap_or_else(|e| panic!("{what}: {e}"));
                    assert!(serde_json::to_string(&plain).unwrap() == serde_json::to_string(&detailed).unwrap(), "{what}: the response differs");
                    n += 1;
                }
                (Err(a), Err(b)) => assert_eq!(a, b, "{what}"),
                (a, b) => panic!("{what}: {:?} vs {:?}", a.err(), b.err()),
            }
        }
    }
    println!("{n} odd inputs with details");
}

#[test]
fn details_agree_with_the_response_on_random_blocks() {
    let env = |name: &str, default: u64| std::env::var(name).ok().map_or(default, |s| s.parse().unwrap());
    let (seed, blocks) = (env("WUICA_DETAILS_FUZZ_SEED", 7), env("WUICA_DETAILS_FUZZ_BLOCKS", 3000));
    let engine: Engine = fuzz::engine();
    let encodings = fuzz::encodings();
    let next = AtomicUsize::new(0);
    let checked = AtomicUsize::new(0);
    let failures: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let notes: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed) as u64;
                if i >= blocks {
                    break;
                }
                let mut req: Request = fuzz::case(&encodings, seed, i);
                let t0 = std::time::Instant::now();
                let plain = engine.analyze(&req);
                let t1 = t0.elapsed().as_secs_f64();
                req.details = true;
                let detailed = engine.analyze(&req);
                let t2 = t0.elapsed().as_secs_f64() - t1;
                let name = fuzz::describe(seed, i, &req);
                if t2 > 0.5 && t2 > 4.0 * t1 {
                    notes.lock().unwrap().push(format!("slow details: {t1:.2} s plain, {t2:.2} s with details: {}", &name[..name.len().min(160)]));
                }
                match (plain, detailed) {
                    (Ok(plain), Ok(mut detailed)) => {
                        checked.fetch_add(1, Ordering::Relaxed);
                        let Some(d) = detailed.details.take() else {
                            failures.lock().unwrap().push(format!("{name}: no details"));
                            continue;
                        };
                        let mut n = Vec::new();
                        if let Err(e) = invariants(&detailed, &d, req.simple_front_end, &mut n) {
                            failures.lock().unwrap().push(format!("{name}: {e}"));
                        }
                        notes.lock().unwrap().extend(n);
                        if serde_json::to_string(&plain).unwrap() != serde_json::to_string(&detailed).unwrap() {
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
    println!("seed {seed}: {n} random blocks with details, {} failures", failures.len());
    let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for note in notes.into_inner().unwrap() {
        *counts.entry(note).or_default() += 1;
    }
    for (note, k) in &counts {
        println!("note: {k} × {note}");
    }
    // the issue slots are of the steady state but in at most 1 % of the cases without a trace (before qa-r2: about 25 %)
    let unsteady: usize = counts.iter().filter(|(k, _)| k.starts_with("not steady") && !k.contains("trace")).map(|(_, v)| v).sum();
    assert!(unsteady * 100 <= n, "{unsteady} of {n} cases without a trace have issue slots that are not of the steady state");
    for f in failures.iter().take(std::env::var("WUICA_DETAILS_FUZZ_SHOW").ok().map_or(40, |s| s.parse().unwrap())) {
        println!("{f}");
    }
    assert!(n as u64 > blocks / 2, "only {n} cases");
    assert!(failures.is_empty(), "{} failures", failures.len());
}
