//! A short run of the fuzzer (tests/fuzz/mod.rs; long runs: the example `fuzz`): random blocks with random options on all 15
//! CPUs; no case may panic or fail with "the reference implementation fails". `WUICA_FUZZ_SEED` and `WUICA_FUZZ_BLOCKS` change
//! the seed (default: a fixed one) and the number of blocks (default 20000).
mod fuzz;

use std::time::Duration;

#[test]
fn random_blocks_neither_panic_nor_fail() {
    let env = |name: &str, default: u64| std::env::var(name).ok().map_or(default, |s| s.parse().unwrap());
    let (seed, blocks) = (env("WUICA_FUZZ_SEED", 1), env("WUICA_FUZZ_BLOCKS", 20_000));
    let engine = fuzz::engine();
    let encodings = fuzz::encodings();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let totals = fuzz::run_range(&engine, &encodings, seed, 0, blocks, threads, 0, Duration::from_secs(30), Duration::from_secs(300));
    print!("seed {seed}: {}", totals.report());
    assert_eq!(totals.n_findings(), 0, "replay a case with: cargo run --release -p wuica --example fuzz -- --case SEED:INDEX");
}
