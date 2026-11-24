//! `wuica -compare FILE|-`: the native side of the differential fuzzer (tools/fuzz). Each input line is a case with the
//! reference's result, in the format of the simulation fixtures: `{file, arch, options, hex}` and either `TP` and `stdout` (and
//! `json`, the reference's `-json` output, when it was written), or `error` (an exception of the reference), or `timeout` (the
//! reference did not finish in that many seconds). wuica analyzes each case and prints one JSON line per case, in input order:
//!
//!     {"file", "verdict", "field"?, "detail"?, "wuica"?}
//!
//! verdict: `same` (throughput, report text and trace equal; or the same input error), `differs` (`field`: TP, stdout, json or
//! error), `wuica-error` (the reference has a result, wuica an error), `wuica-panic`, `ref-crash` (an exception that is not
//! an `InputError`), `ref-timeout`. `wuica` says what wuica did where the reference had no result. With `-`, lines are read
//! from stdin and each verdict is printed as soon as it is known (for the minimizer); with a file, the cases run on all cores.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use wuica::{Engine, Request};

fn request(case: &Value) -> Result<Request, String> {
    let o = &case["options"];
    let mut r = Request::new(case["arch"].as_str().ok_or("no arch")?);
    r.hex = case["hex"].as_str().ok_or("no hex")?.to_string();
    r.alignment_offset = o["alignmentOffset"].as_i64().unwrap_or(0);
    r.init_policy = o["initPolicy"].as_str().unwrap_or("diff").to_string();
    r.simple_front_end = o["simpleFrontEnd"].as_bool().unwrap_or(false);
    r.no_micro_fusion = o["noMicroFusion"].as_bool().unwrap_or(false);
    r.no_macro_fusion = o["noMacroFusion"].as_bool().unwrap_or(false);
    r.min_iterations = o["minIterations"].as_i64().unwrap_or(10);
    r.min_cycles = o["minCycles"].as_i64().unwrap_or(500);
    r.include_trace = case.get("json").is_some();
    Ok(r)
}

/// The first line in which two texts differ, for the report.
fn first_text_difference(a: &str, b: &str) -> String {
    let (la, lb): (Vec<&str>, Vec<&str>) = (a.lines().collect(), b.lines().collect());
    for i in 0..la.len().max(lb.len()) {
        let (x, y) = (la.get(i).copied().unwrap_or("<end>"), lb.get(i).copied().unwrap_or("<end>"));
        if x != y {
            return format!("line {}: reference {:?}, wuica {:?}", i + 1, x, y);
        }
    }
    "line endings differ".to_string()
}

/// The verdict for one input line.
pub fn verdict(engine: &Engine, line: &str) -> Value {
    let case: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({"verdict": "bad-input", "detail": e.to_string()}),
    };
    let file = case["file"].clone();
    let req = match request(&case) {
        Ok(r) => r,
        Err(e) => return json!({"file": file, "verdict": "bad-input", "detail": e}),
    };
    let result = match catch_unwind(AssertUnwindSafe(|| engine.analyze(&req))) {
        Ok(r) => r,
        Err(p) => {
            let msg = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default();
            return json!({"file": file, "verdict": "wuica-panic", "detail": msg});
        }
    };
    let outcome = |r: &Result<wuica::Response, String>| match r {
        Ok(r) => json!({"TP": r.tp}),
        Err(e) => json!({"error": e}),
    };
    if let Some(t) = case.get("timeout") {
        return json!({"file": file, "verdict": "ref-timeout", "detail": t, "wuica": outcome(&result)});
    }
    if let Some(error) = case.get("error").and_then(Value::as_str) {
        return match error.strip_prefix("InputError: ") {
            Some(expected) => match &result {
                Err(e) if e == expected => json!({"file": file, "verdict": "same"}),
                _ => json!({"file": file, "verdict": "differs", "field": "error", "detail": format!("reference: {expected:?}"), "wuica": outcome(&result)}),
            },
            None => json!({"file": file, "verdict": "ref-crash", "detail": error, "wuica": outcome(&result)}),
        };
    }
    let r = match result {
        Err(e) => return json!({"file": file, "verdict": "wuica-error", "detail": e}),
        Ok(r) => r,
    };
    let differs = |field: &str, detail: String| json!({"file": file, "verdict": "differs", "field": field, "detail": detail});
    if Some(r.tp) != case["TP"].as_f64() {
        return differs("TP", format!("reference {}, wuica {}", case["TP"], r.tp));
    }
    let stdout = case["stdout"].as_str().unwrap_or_default();
    if r.text_with_hyperlinks != stdout {
        return differs("stdout", first_text_difference(stdout, &r.text_with_hyperlinks));
    }
    if let Some(expected) = case.get("json") {
        match &r.trace {
            None => return differs("json", "wuica has no trace".to_string()),
            Some(trace) => {
                if let Some(d) = wuica_core::jsoncmp::diff(expected, trace) {
                    return differs("json", d);
                }
            }
        }
    }
    json!({"file": file, "verdict": "same"})
}

pub fn run(engine: &Engine, path: &str) -> Result<(), String> {
    // panics are reported as verdicts; their default message would only clutter stderr
    std::panic::set_hook(Box::new(|_| {}));
    if path == "-" {
        let stdout = std::io::stdout();
        for line in std::io::stdin().lock().lines() {
            let line = line.map_err(|e| e.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let mut out = stdout.lock();
            writeln!(out, "{}", verdict(engine, &line)).and_then(|_| out.flush()).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let results: Vec<Mutex<Option<Value>>> = lines.iter().map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    let threads = std::env::var("WUICA_THREADS").ok().and_then(|s| s.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get()));
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(line) = lines.get(i) else { break };
                *results[i].lock().unwrap() = Some(verdict(engine, line));
            });
        }
    });
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for r in results {
        writeln!(out, "{}", r.into_inner().unwrap().unwrap()).map_err(|e| e.to_string())?;
    }
    out.flush().map_err(|e| e.to_string())
}
