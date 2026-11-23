//! Writes the response JSON of every simulation fixture case (all sets and option variants) to OUTFILE, one line per case, to
//! check that a change keeps every response identical: cargo run --release -p wuica --example golden -- OUTFILE
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use wuica::Engine;

fn main() {
    let out_path = std::env::args().nth(1).expect("OUTFILE");
    let mut engine = Engine::new();
    engine.load_uarch(&std::fs::read_to_string("data/uarch.json").unwrap()).unwrap();
    for entry in std::fs::read_dir("data/arch").unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_stem().unwrap().to_str().unwrap().to_string();
        engine.load_arch(&name, &std::fs::read_to_string(&path).unwrap()).unwrap();
    }
    let mut lines: Vec<String> = Vec::new();
    for set in ["sim_fixtures", "extra_sim_fixtures", "more_sim_fixtures"] {
        let Ok(file) = std::fs::File::open(format!("fixtures/generated/{set}.jsonl.gz")) else { continue };
        lines.extend(BufReader::with_capacity(1 << 20, flate2::read::GzDecoder::new(file)).lines().map(|l| l.unwrap()));
    }
    let next = AtomicUsize::new(0);
    let results: Vec<std::sync::Mutex<String>> = (0..lines.len()).map(|_| Default::default()).collect();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(line) = lines.get(i) else { break };
                let c: serde_json::Value = serde_json::from_str(line).unwrap();
                let mut req = c["options"].as_object().cloned().unwrap_or_default();
                req.insert("hex".into(), c["hex"].clone());
                req.insert("arch".into(), c["arch"].clone());
                let out = engine.analyze_json(&serde_json::Value::Object(req).to_string());
                *results[i].lock().unwrap() = format!("{} {} {} {}", c["file"], c["arch"], c["options"], out);
            });
        }
    });
    let mut f = std::io::BufWriter::new(std::fs::File::create(out_path).unwrap());
    for r in results {
        writeln!(f, "{}", r.into_inner().unwrap()).unwrap();
    }
    println!("{} cases", lines.len());
}
