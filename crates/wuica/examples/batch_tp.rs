//! Throughput predictions for many blocks (for scoring a model against measurements):
//!
//!     cargo run --release -p wuica --example batch_tp -- DATA_DIR ARCH < NAMES_AND_HEX
//!
//! Each input line is `NAME HEX`; each output line is `NAME TP` (or `NAME error: ...`). The blocks are analyzed in parallel with the
//! default options of the command-line tool.
use std::io::{BufRead, Write};
use std::sync::Mutex;
use wuica::{Engine, Request};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (data_dir, arch) = (std::path::PathBuf::from(&args[0]), args[1].clone());
    let uarch = std::fs::read_to_string(data_dir.join("uarch.json")).expect("uarch.json");
    let mut probe = Engine::new();
    probe.load_uarch(&uarch).expect("uarch");
    let table = probe.table_name(&arch).expect("unknown arch").to_string();
    let table_json = std::fs::read_to_string(data_dir.join("arch").join(format!("{table}.json"))).expect("table");
    let lines: Vec<(String, String)> = std::io::stdin()
        .lock()
        .lines()
        .map(|l| l.unwrap())
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let mut p = l.split_whitespace();
            (p.next().unwrap().to_string(), p.next().unwrap_or("").to_string())
        })
        .collect();
    let next = Mutex::new(0usize);
    let results: Mutex<Vec<Option<String>>> = Mutex::new(vec![None; lines.len()]);
    let n_threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    std::thread::scope(|s| {
        for _ in 0..n_threads {
            s.spawn(|| {
                let mut engine = Engine::new();
                engine.load_uarch(&uarch).unwrap();
                engine.load_arch(&table, &table_json).unwrap();
                loop {
                    let i = {
                        let mut n = next.lock().unwrap();
                        let i = *n;
                        *n += 1;
                        i
                    };
                    if i >= lines.len() {
                        break;
                    }
                    let mut request = Request::new(&arch);
                    request.hex = lines[i].1.clone();
                    let out = match engine.analyze(&request) {
                        Ok(r) => format!("{:.2}", r.tp),
                        Err(e) => format!("error: {e}"),
                    };
                    results.lock().unwrap()[i] = Some(out);
                }
            });
        }
    });
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for ((name, _), r) in lines.iter().zip(results.into_inner().unwrap()) {
        writeln!(out, "{name} {}", r.unwrap()).unwrap();
    }
}
