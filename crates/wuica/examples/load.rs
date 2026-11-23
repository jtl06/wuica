//! Times the loading of the configurations and of the instruction tables:
//!
//!     cargo run --release -p wuica --example load -- [ITERATIONS] [TABLE...]
//!
//! For `data/uarch.json` and each table (default: all of `data/arch/`): the size and the time of `Engine::load_uarch` /
//! `Engine::load_arch` (the fastest of ITERATIONS runs, default 20).
use std::time::Instant;
use wuica::Engine;

fn best<T>(iters: usize, mut f: impl FnMut() -> T) -> f64 {
    let mut best = f64::INFINITY;
    for _ in 0..iters.max(1) {
        let t = Instant::now();
        std::hint::black_box(f());
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
    }
    best
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let iters: usize = args.first().and_then(|a| a.parse().ok()).unwrap_or(20);
    let mut tables: Vec<String> = args.iter().skip(1).cloned().collect();
    if tables.is_empty() {
        tables = std::fs::read_dir("data/arch")
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
            .collect();
        tables.sort();
    }
    let uarch = std::fs::read_to_string("data/uarch.json").unwrap();
    let mut engine = Engine::new();
    println!("{:>8} {:>9} kB {:>8.2} ms", "uarch", uarch.len() / 1024, best(iters, || engine.load_uarch(&uarch).unwrap()));
    let mut total = 0.0;
    for t in &tables {
        let json = std::fs::read_to_string(format!("data/arch/{t}.json")).unwrap();
        let ms = best(iters, || engine.load_arch(t, &json).unwrap());
        total += ms;
        println!("{t:>8} {:>9} kB {ms:>8.2} ms", json.len() / 1024);
    }
    println!("{:>8} {:>12} {total:>8.2} ms", "total", "");
}
