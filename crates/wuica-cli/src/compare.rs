//! `wuica -compare FILE|-`: the native side of the differential fuzzer (tools/fuzz). Each input line is a case with the
//! reference's result, in the format of the simulation fixtures: `{file, arch, options, hex}` and either `TP` and `stdout` (and
//! `json`, the reference's `-json` output, when it was written), or `error` (an exception of the reference), or `timeout` (the
//! reference did not finish in that many seconds). wuica analyzes each case and prints one JSON line per case, in input order:
//!
//!     {"file", "verdict", "field"?, "detail"?, "wuica"?, "ms"}
//!
//! verdict: `same` (throughput, report text and trace equal; or the same input error), `differs` (`field`: TP, stdout, json or
//! error), `wuica-error` (the reference has a result, wuica an error), `wuica-panic`, `ref-crash` (an exception that is not
//! an `InputError`), `ref-timeout`. `wuica` says what wuica did where the reference had no result; `ms` is the time of the
//! analysis and the comparison. With `-`, lines are read
//! from stdin and each verdict is printed as soon as it is known (for the minimizer); with a file, the cases run on all cores.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;
use wuica::{Engine, Request};

fn request(case: &Value, trace: bool) -> Result<Request, String> {
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
    r.include_trace = trace;
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
    let t0 = std::time::Instant::now();
    let mut v = verdict_of(engine, line, true);
    v["ms"] = json!((t0.elapsed().as_secs_f64() * 1e4).round() / 10.0);
    v
}

/// A value as Python's `json.dumps(value, sort_keys=True)` writes it (what the reference's `-json` output is), for comparing a
/// trace with the reference's text before parsing it (a trace can have tens of MB).
fn python_json(v: &Value, out: &mut String) {
    use std::fmt::Write;
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) if n.is_i64() || n.is_u64() => write!(out, "{n}").unwrap(),
        Value::Number(n) => python_float(n.as_f64().unwrap(), out),
        Value::String(s) => {
            out.push('"');
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    '\u{8}' => out.push_str("\\b"),
                    '\u{c}' => out.push_str("\\f"),
                    c if (c as u32) < 0x20 || (c as u32) > 0x7f => {
                        let mut buf = [0u16; 2];
                        for u in c.encode_utf16(&mut buf) {
                            write!(out, "\\u{:04x}", u).unwrap();
                        }
                    }
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                python_json(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                python_json(&Value::String(k.clone()), out);
                out.push_str(": ");
                python_json(&o[k], out);
            }
            out.push('}');
        }
    }
}

/// `repr(float)` of Python.
fn python_float(f: f64, out: &mut String) {
    if f.is_nan() {
        return out.push_str("NaN");
    }
    if f.is_infinite() {
        return out.push_str(if f > 0.0 { "Infinity" } else { "-Infinity" });
    }
    if f == 0.0 {
        return out.push_str(if f.is_sign_negative() { "-0.0" } else { "0.0" });
    }
    let e = format!("{:e}", f.abs()); // shortest digits, e.g. 1.5e-7
    let (mantissa, exp) = e.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    if f < 0.0 {
        out.push('-');
    }
    if (-4..16).contains(&exp) {
        if exp >= 0 {
            let int_len = exp as usize + 1;
            if digits.len() <= int_len {
                out.push_str(&digits);
                out.push_str(&"0".repeat(int_len - digits.len()));
                out.push_str(".0");
            } else {
                out.push_str(&digits[..int_len]);
                out.push('.');
                out.push_str(&digits[int_len..]);
            }
        } else {
            out.push_str("0.");
            out.push_str(&"0".repeat((-exp - 1) as usize));
            out.push_str(&digits);
        }
    } else {
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push_str(&format!("e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs()));
    }
}

fn verdict_of(engine: &Engine, line: &str, split: bool) -> Value {
    // The reference's -json output is the last field of the fuzzer's lines (a string value cannot contain this sequence: its
    // quotes would be escaped), and is kept as text; otherwise it is taken from the parsed line.
    let line = line.trim_end();
    let mut parsed_trace = None;
    let (case, raw_trace): (Value, Option<&str>) = match line.find(", \"json\": ").filter(|_| split && line.ends_with('}')) {
        Some(k) => match serde_json::from_str::<Value>(&format!("{}}}", &line[..k])) {
            // a line with the -json output has a result
            Ok(v) if v.get("TP").is_some() && v.get("error").is_none() => (v, Some(&line[k + 10..line.len() - 1])),
            _ => return verdict_of(engine, line, false),
        },
        None => match serde_json::from_str::<Value>(line) {
            Ok(mut v) => {
                parsed_trace = v.as_object_mut().and_then(|o| o.remove("json")).map(|t| {
                    let mut text = String::new();
                    python_json(&t, &mut text);
                    text
                });
                (v, None)
            }
            Err(e) => return json!({"verdict": "bad-input", "detail": e.to_string()}),
        },
    };
    let raw_trace = raw_trace.or(parsed_trace.as_deref());
    let file = case["file"].clone();
    let req = match request(&case, raw_trace.is_some()) {
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
    if let Some(raw) = raw_trace {
        match &r.trace {
            None => return differs("json", "wuica has no trace".to_string()),
            Some(trace) => {
                let mut text = String::with_capacity(raw.len() + 16);
                python_json(trace, &mut text);
                if text != raw {
                    // not the same text: compare the values (numbers by value, key order ignored)
                    let expected: Value = match serde_json::from_str(raw) {
                        Ok(v) => v,
                        // the field was not the last one after all
                        Err(_) if split => return verdict_of(engine, line, false),
                        Err(e) => return json!({"file": file, "verdict": "bad-input", "detail": e.to_string()}),
                    };
                    if let Some(d) = wuica_core::jsoncmp::diff(&expected, trace) {
                        return differs("json", d);
                    }
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
    // the lines are read as the threads need them: a file of cases with traces can have GBs
    let file = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let threads = std::env::var("WUICA_THREADS").ok().and_then(|s| s.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get()));
    let (tx, rx) = std::sync::mpsc::sync_channel::<(usize, String)>(threads);
    let rx = Mutex::new(rx);
    let results: Mutex<Vec<(usize, Value)>> = Mutex::new(Vec::new());
    let read_error: Mutex<Option<String>> = Mutex::new(None);
    std::thread::scope(|s| {
        s.spawn(|| {
            let mut reader = std::io::BufReader::new(file);
            let mut i = 0;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) if line.trim().is_empty() => continue,
                    Ok(_) => {
                        if tx.send((i, line)).is_err() {
                            break;
                        }
                        i += 1;
                    }
                    Err(e) => {
                        *read_error.lock().unwrap() = Some(e.to_string());
                        break;
                    }
                }
            }
            drop(tx);
        });
        for _ in 0..threads {
            s.spawn(|| loop {
                let next = rx.lock().unwrap().recv();
                let Ok((i, line)) = next else { break };
                let v = verdict(engine, &line);
                results.lock().unwrap().push((i, v));
            });
        }
    });
    if let Some(e) = read_error.into_inner().unwrap() {
        return Err(format!("{path}: {e}"));
    }
    let mut results = results.into_inner().unwrap();
    results.sort_by_key(|r| r.0);
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for (_, v) in results {
        writeln!(out, "{v}").map_err(|e| e.to_string())?;
    }
    out.flush().map_err(|e| e.to_string())
}
