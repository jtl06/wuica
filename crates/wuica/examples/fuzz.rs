//! The fuzzer (tests/fuzz/mod.rs) for long runs:
//!
//!     cargo run --release -p wuica --example fuzz -- SEED START COUNT [THREADS]   runs cases START..START+COUNT of SEED
//!     cargo run --release -p wuica --example fuzz -- --case SEED:INDEX            one case: the request and the outcome
//!     cargo run --release -p wuica --example fuzz -- --request JSON                the same for a request (docs/WASM-API.md)
//!     cargo run --release -p wuica --example fuzz -- --dump SEED START COUNT      the cases as JSONL in the format of the
//!         simulation fixtures (file, arch, options, hex), to run them on the reference; without the cases with includeTrace
//!         and those that wuica takes more than 0.5 s for or rejects as too large (the reference needs minutes to hours for them)
//!
//!     cargo run --release -p wuica --example fuzz -- --chunked SEED START COUNT THREADS CHUNK   the same in child processes of
//!         CHUNK cases each; a case that kills its process (out of memory) or hangs is found and listed, and the run goes on
//!
//! Exit status 1 if there is a finding (a panic or "the reference implementation fails"), 3 on a case that hangs.
#[path = "../tests/fuzz/mod.rs"]
mod fuzz;

use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let encodings = fuzz::encodings();
    let num = |s: &str| s.parse::<u64>().expect("a number");
    if matches!(args.first().map(String::as_str), Some("--case" | "--request")) {
        let req = if args[0] == "--case" {
            let (seed, index) = args[1].split_once(':').expect("SEED:INDEX");
            let (seed, index) = (num(seed), num(index));
            let req = fuzz::case(&encodings, seed, index);
            println!("{}", fuzz::describe(seed, index, &req));
            req
        } else {
            serde_json::from_str::<wuica::Request>(&args[1]).expect("a request")
        };
        let engine = fuzz::engine();
        match fuzz::run(&engine, &req) {
            fuzz::Outcome::Ok { .. } => {
                let r = engine.analyze(&req).unwrap();
                println!("result: TP {} ({}, {} decode errors)\n{}", r.tp, r.mode, r.decode_errors, r.text);
            }
            fuzz::Outcome::InputError(e) => println!("input error: {e}"),
            fuzz::Outcome::ReferenceCrash(e) => println!("FINDING: {e}"),
            fuzz::Outcome::Panic(e) => println!("FINDING: panic: {e}"),
        }
        return;
    }
    if args.first().map(String::as_str) == Some("--dump") {
        let (seed, start, count) = (num(&args[1]), num(&args[2]), num(&args[3]));
        let engine = fuzz::engine();
        for i in start..start + count {
            let req = fuzz::case(&encodings, seed, i);
            if req.include_trace {
                continue;
            }
            let t = std::time::Instant::now();
            let r = engine.analyze(&req);
            if t.elapsed().as_secs_f64() > 0.5 || r.is_err_and(|e| e.contains("too many")) {
                continue;
            }
            let line = serde_json::json!({"file": format!("fuzz_{seed}_{i}"), "arch": req.arch, "options": fuzz::options_json(&req), "hex": req.hex});
            println!("{line}");
        }
        return;
    }
    if args.first().map(String::as_str) == Some("--chunked") {
        chunked(&args[1..], &encodings);
        return;
    }
    let json = args.first().map(String::as_str) == Some("--json");
    let args = if json { &args[1..] } else { &args[..] };
    let seed = num(args.first().expect("SEED START COUNT [THREADS]"));
    let (start, count) = (num(&args[1]), num(&args[2]));
    let threads = args.get(3).map_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get()), |t| num(t) as usize);
    let engine = fuzz::engine();
    let t0 = std::time::Instant::now();
    let totals = fuzz::run_range(&engine, &encodings, seed, start, start + count, threads, if json { 0 } else { 60 }, Duration::from_secs(10),
                                 Duration::from_secs(900));
    if json {
        println!("TOTALS {}", totals.to_json());
        return;
    }
    println!("seed {seed}, cases {start}..{}, {threads} threads, {:.0} s", start + count, t0.elapsed().as_secs_f64());
    print!("{}", totals.report());
    std::process::exit(if totals.n_findings() > 0 { 1 } else { 0 });
}

/// `--chunked SEED START COUNT THREADS CHUNK`: runs the cases in chunks of CHUNK cases, each in a child process. A chunk whose
/// process dies (e.g. killed for running out of memory) or hangs is split until the case that does it is found; that case is
/// listed ("process ended") and the run continues.
fn chunked(args: &[String], encodings: &[Vec<u8>]) {
    let num = |s: &str| s.parse::<u64>().expect("a number");
    let (seed, start, count, threads, chunk) = (num(&args[0]), num(&args[1]), num(&args[2]), num(&args[3]), num(&args[4]));
    let exe = std::env::current_exe().unwrap();
    let mut totals = fuzz::Totals::default();
    let mut ended: Vec<String> = Vec::new();
    let t0 = std::time::Instant::now();
    let mut pending: Vec<(u64, u64)> = (start..start + count).step_by(chunk as usize).map(|s| (s, chunk.min(start + count - s))).collect();
    pending.reverse();
    while let Some((s, n)) = pending.pop() {
        let running_file = std::env::temp_dir().join(format!("wuica-fuzz-running-{}", std::process::id()));
        let _ = std::fs::remove_file(&running_file);
        let out = std::process::Command::new(&exe)
            .args(["--json", &seed.to_string(), &s.to_string(), &n.to_string(), &threads.to_string()])
            .env("WUICA_FUZZ_RUNNING", &running_file)
            .stderr(std::process::Stdio::inherit())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let line = stdout.lines().find_map(|l| l.strip_prefix("TOTALS ").map(str::to_string));
        let hang = stdout.lines().find_map(|l| l.strip_prefix("HANGCASE ").map(num));
        match (out.status.success(), line) {
            (true, Some(l)) => totals.add(fuzz::Totals::from_json(&serde_json::from_str(&l).unwrap())),
            _ if hang.is_some_and(|h| (s..s + n).contains(&h)) => {
                // the case that hangs is known: list it and run the others again
                let h = hang.unwrap();
                let req = fuzz::case(encodings, seed, h);
                ended.push(format!("hangs: {}", fuzz::describe(seed, h, &req)));
                totals.blocks += 1;
                if h + 1 < s + n {
                    pending.push((h + 1, s + n - h - 1));
                }
                if h > s {
                    pending.push((s, h - s));
                }
            }
            _ if n == 1 => {
                let req = fuzz::case(encodings, seed, s);
                eprintln!("process ended ({}): {}", out.status, fuzz::describe(seed, s, &req));
                ended.push(format!("{}: {}", out.status, fuzz::describe(seed, s, &req)));
                totals.blocks += 1;
            }
            _ => {
                // the cases that were running for more than a second when the process ended are run alone, the others again in
                // ranges; without such cases, the range is split in two
                let suspects: Vec<u64> = std::fs::read_to_string(&running_file)
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|l| l.parse().ok())
                    .filter(|i| (s..s + n).contains(i))
                    .collect();
                if suspects.is_empty() {
                    pending.push((s + n / 2, n - n / 2));
                    pending.push((s, n / 2));
                } else {
                    let mut ranges = Vec::new();
                    let mut from = s;
                    for &x in &suspects {
                        if x > from {
                            ranges.push((from, x - from));
                        }
                        ranges.push((x, 1));
                        from = x + 1;
                    }
                    if from < s + n {
                        ranges.push((from, s + n - from));
                    }
                    pending.extend(ranges.into_iter().rev());
                }
            }
        }
        eprintln!("[{:.0} s] {} of {count} cases done, {} findings, {} ended processes", t0.elapsed().as_secs_f64(), totals.blocks, totals.n_findings(),
                  ended.len());
    }
    println!("seed {seed}, cases {start}..{}, {threads} threads, chunks of {chunk}, {:.0} s", start + count, t0.elapsed().as_secs_f64());
    print!("{}", totals.report());
    for e in &ended {
        println!("  process ended: {e}");
    }
    std::process::exit(if totals.n_findings() > 0 { 1 } else { 0 });
}
