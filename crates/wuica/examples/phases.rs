//! Times the phases of an analysis, averaged over many runs:
//!   cargo run --release -p wuica --example phases -- ARCH REPS HEXFILE...
//! Each HEXFILE contains the machine code of one block as hex.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};
use wuica::{Engine, Request};
use wuica_core::analyze::sim_summary;
use wuica_core::{config::UArch, data::ArchData, facile, instr_builder::build_instructions, sim};

/// counts allocations (and reallocations), to print them per phase
struct CountingAlloc;
static ALLOCS: AtomicU64 = AtomicU64::new(0);
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arch = &args[1];
    let reps: u32 = args[2].parse().unwrap();
    let uarch_json = std::fs::read_to_string("data/uarch.json").unwrap();
    let uarch = UArch::from_json(&uarch_json).unwrap();
    let config = &uarch.configs[arch.as_str()];
    let table_json = std::fs::read_to_string(format!("data/arch/{}.json", config.name)).unwrap();
    let data = ArchData::from_json(&table_json).unwrap();
    let mut engine = Engine::new();
    engine.load_uarch(&uarch_json).unwrap();
    engine.load_arch(&config.name, &table_json).unwrap();
    let names = ["decode", "build", "simulate", "uop table", "dependency limit", "bottleneck report", "analyze() total", "analyze_json() total"];
    let mut t = [Duration::ZERO; 8];
    let mut allocs = [0u64; 8];
    let mut n_blocks = 0;
    for file in &args[3..] {
        let hex = std::fs::read_to_string(file).unwrap().trim().to_string();
        let code = wuica_xed::parse_hex(&hex).unwrap();
        let _ = wuica_xed::decode(&code, &config.xed_name); // XED's tables are initialized on the first call
        let mut request = Request::new(arch);
        request.hex = hex.clone();
        let request_json = format!("{{\"hex\":\"{hex}\",\"arch\":\"{arch}\"}}");
        for _ in 0..reps {
            let a = ALLOCS.load(Relaxed);
            let s = Instant::now();
            let decoded = wuica_xed::decode(&code, &config.xed_name).unwrap();
            t[0] += s.elapsed();
            allocs[0] += ALLOCS.load(Relaxed) - a;
            let a = ALLOCS.load(Relaxed);
            let s = Instant::now();
            let instrs = build_instructions(&decoded.instrs, config, &uarch, &data, 0, false, false);
            t[1] += s.elapsed();
            allocs[1] += ALLOCS.load(Relaxed) - a;
            let a = ALLOCS.load(Relaxed);
            let s = Instant::now();
            let r = sim::simulate(&instrs, config, &uarch, &sim::SimOptions::default()).unwrap();
            t[2] += s.elapsed();
            allocs[2] += ALLOCS.load(Relaxed) - a;
            let a = ALLOCS.load(Relaxed);
            let s = Instant::now();
            std::hint::black_box(r.uops_table());
            t[3] += s.elapsed();
            allocs[3] += ALLOCS.load(Relaxed) - a;
            let a = ALLOCS.load(Relaxed);
            let s = Instant::now();
            let dep = facile::compute_dependency_limit(&instrs, config, "diff");
            t[4] += s.elapsed();
            allocs[4] += ALLOCS.load(Relaxed) - a;
            let a = ALLOCS.load(Relaxed);
            let s = Instant::now();
            std::hint::black_box(facile::bottleneck_report(&instrs, &decoded.instrs, config, 0, dep, &sim_summary(&r)));
            t[5] += s.elapsed();
            allocs[5] += ALLOCS.load(Relaxed) - a;
            let a = ALLOCS.load(Relaxed);
            let s = Instant::now();
            std::hint::black_box(engine.analyze(&request).unwrap());
            t[6] += s.elapsed();
            allocs[6] += ALLOCS.load(Relaxed) - a;
            let a = ALLOCS.load(Relaxed);
            let s = Instant::now();
            std::hint::black_box(engine.analyze_json(&request_json));
            t[7] += s.elapsed();
            allocs[7] += ALLOCS.load(Relaxed) - a;
        }
        n_blocks += 1;
    }
    let total = (n_blocks * reps) as f64;
    for ((name, d), n) in names.iter().zip(t).zip(allocs) {
        println!("{name:>22}: {:8.1} µs per analysis, {:8.0} allocations per analysis", d.as_secs_f64() * 1e6 / total, n as f64 / total);
    }
}
