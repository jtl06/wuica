//! Times the phases of an analysis and counts their heap allocations:
//!
//!     cargo run --release -p wuica --example phases -- ARCH ITERATIONS HEXFILE...
//!
//! For each file: the time of each phase (the mean over a batch of ITERATIONS/5 runs, the fastest of 5 batches), and the number of allocations and allocated bytes of one run
//! (deterministic). "assembly" is the rest of `wuica_core::analyze::analyze` (the full analysis without decoding), "json" the
//! serialization of the response, "total" `Engine::analyze_json` (request JSON in, response JSON out), "total-sim" everything but
//! the simulation (the phases of the analysis that are not the simulator; the standalone phases are a breakdown of it, while
//! "assembly" is only meaningful as long as `analyze` calls the standalone functions). The last line is the mean over the files.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::time::Instant;
use wuica::Engine;
use wuica_core::analyze::{sim_summary, Request};
use wuica_core::{config::UArch, data::ArchData, facile, instr_builder::build_instructions, sim};

struct Counting;
static COUNTING: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if COUNTING.load(Relaxed) {
            ALLOCS.fetch_add(1, Relaxed);
            BYTES.fetch_add(layout.size() as u64, Relaxed);
        }
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if COUNTING.load(Relaxed) {
            ALLOCS.fetch_add(1, Relaxed);
            BYTES.fetch_add(layout.size() as u64, Relaxed);
        }
        System.alloc_zeroed(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if COUNTING.load(Relaxed) {
            ALLOCS.fetch_add(1, Relaxed);
            BYTES.fetch_add(new_size as u64, Relaxed);
        }
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

const PHASES: [&str; 12] =
    ["decode", "build", "simulate", "table", "dep", "summary", "report", "analyze", "assembly", "json", "total", "total-sim"];

#[derive(Clone, Copy, Default)]
struct Stat {
    ns: f64,
    allocs: f64,
    bytes: f64,
}

/// mean time (ns) of `f` over `iters` runs, and the allocations of one run
fn measure<T>(iters: usize, mut f: impl FnMut() -> T) -> Stat {
    // a run that counts (also a warm-up)
    let (a0, b0) = (ALLOCS.load(Relaxed), BYTES.load(Relaxed));
    COUNTING.store(true, Relaxed);
    let r = f();
    COUNTING.store(false, Relaxed);
    let (allocs, bytes) = ((ALLOCS.load(Relaxed) - a0) as f64, (BYTES.load(Relaxed) - b0) as f64);
    drop(r);
    // the fastest of 5 batches (the least disturbed by other work on the machine)
    let batch = iters.div_ceil(5).max(1);
    let mut ns = f64::INFINITY;
    for _ in 0..5 {
        let t = Instant::now();
        for _ in 0..batch {
            std::hint::black_box(f());
        }
        ns = ns.min(t.elapsed().as_nanos() as f64 / batch as f64);
    }
    Stat { ns, allocs, bytes }
}

/// [`measure`] if `run`, otherwise nothing (zeros)
fn measure_if<T>(run: bool, iters: usize, f: impl FnMut() -> T) -> Stat {
    if run {
        measure(iters, f)
    } else {
        Stat::default()
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: phases ARCH ITERATIONS HEXFILE...");
        std::process::exit(2);
    }
    let arch = args[1].as_str();
    let iters: usize = args[2].parse().expect("ITERATIONS");
    // PHASES=dep,table (for example) times only these phases (for profiling)
    let only: Option<Vec<String>> = std::env::var("PHASES").ok().map(|s| s.split(',').map(str::to_string).collect());
    let run = |i: usize| only.as_ref().is_none_or(|o| o.iter().any(|p| p == PHASES[i]));
    let uarch_json = std::fs::read_to_string("data/uarch.json").unwrap();
    let uarch = UArch::from_json(&uarch_json).unwrap();
    let config = &uarch.configs[arch];
    let arch_json = std::fs::read_to_string(format!("data/arch/{}.json", config.name)).unwrap();
    let data = ArchData::from_json(&arch_json).unwrap();
    let mut engine = Engine::new();
    engine.load_uarch(&uarch_json).unwrap();
    engine.load_arch(&config.name, &arch_json).unwrap();

    println!("{:>14} {}", "", PHASES.iter().map(|p| format!("{p:>16}")).collect::<String>());
    let mut mean = [Stat::default(); PHASES.len()];
    let files = &args[3..];
    for file in files {
        let hex = std::fs::read_to_string(file).unwrap();
        let hex = hex.trim();
        let code = wuica_xed::parse_hex(hex).unwrap();
        let mut request = Request::new(arch);
        request.hex = hex.to_string();
        let request_json = serde_json::json!({ "hex": hex, "arch": arch }).to_string();

        let decoded = wuica_xed::decode(&code, &config.xed_name).unwrap();
        let instrs = build_instructions(&decoded.instrs, config, &uarch, &data, 0, false, false);
        let r = sim::simulate(&instrs, config, &uarch, &sim::SimOptions::default()).unwrap();
        let summary = sim_summary(&r);
        let dep = facile::compute_dependency_limit(&instrs, config, "diff");
        let response = wuica_core::analyze::analyze(&decoded.instrs, decoded.errors, &request, &uarch, &data).unwrap();

        let mut s = [Stat::default(); PHASES.len()];
        s[0] = measure_if(run(0), iters, || wuica_xed::decode(&code, &config.xed_name).unwrap());
        s[1] = measure_if(run(1), iters, || build_instructions(&decoded.instrs, config, &uarch, &data, 0, false, false));
        s[2] = measure_if(run(2), iters, || sim::simulate(&instrs, config, &uarch, &sim::SimOptions::default()).unwrap());
        s[3] = measure_if(run(3), iters, || r.uops_table());
        s[4] = measure_if(run(4), iters, || facile::compute_dependency_limit(&instrs, config, "diff"));
        s[5] = measure_if(run(5), iters, || sim_summary(&r));
        // the report as `analyze` makes it (from the result of the simulation; "summary" is not part of the analysis)
        s[6] = measure_if(run(6), iters, || facile::format_bottlenecks(&facile::bottleneck_values_for(&instrs, &decoded.instrs, config, 0, dep, &r)));
        let _ = facile::bottleneck_report(&instrs, &decoded.instrs, config, 0, dep, &summary);
        s[7] = measure_if(run(7), iters, || wuica_core::analyze::analyze(&decoded.instrs, decoded.errors, &request, &uarch, &data).unwrap());
        let parts = [1, 2, 3, 4, 6];
        s[8] = Stat {
            ns: s[7].ns - parts.iter().map(|&i| s[i].ns).sum::<f64>(),
            allocs: s[7].allocs - parts.iter().map(|&i| s[i].allocs).sum::<f64>(),
            bytes: s[7].bytes - parts.iter().map(|&i| s[i].bytes).sum::<f64>(),
        };
        s[9] = measure_if(run(9), iters, || serde_json::to_string(&response).unwrap());
        s[10] = measure_if(run(10), iters, || engine.analyze_json(&request_json));
        s[11] = Stat { ns: s[10].ns - s[2].ns, allocs: s[10].allocs - s[2].allocs, bytes: s[10].bytes - s[2].bytes };

        let name = std::path::Path::new(file).file_stem().unwrap().to_string_lossy().to_string();
        print_row(&format!("{name} ({})", instrs.instrs.len()), &s);
        for (m, x) in mean.iter_mut().zip(&s) {
            m.ns += x.ns / files.len() as f64;
            m.allocs += x.allocs / files.len() as f64;
            m.bytes += x.bytes / files.len() as f64;
        }
    }
    print_row("mean", &mean);
}

fn print_row(name: &str, s: &[Stat]) {
    let name: String = name.chars().take(14).collect();
    println!("{name:>14} {}", s.iter().map(|x| format!("{:>9.1}us/{:<6.0}", x.ns / 1000.0, x.allocs)).collect::<String>());
    println!("{:>14} {}", "bytes", s.iter().map(|x| format!("{:>16.0}", x.bytes)).collect::<String>());
}
