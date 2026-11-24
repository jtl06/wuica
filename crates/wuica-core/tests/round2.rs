//! The rounding helper against Python's `round(x, 2)` for every quotient `k / n`, `1 <= n <= 1000`, `0 <= k <= 3n`
//! (fixtures/round2.bin.gz, written by tools/export_round2_fixture.py with CPython: the format is described there).
//! uiCA rounds throughputs and limits, quotients of counts, with `round(x, 2)`; the fixture corpus only checks the
//! quotients its blocks happen to produce. `sim::round2` calls `facile::py_round2`.
use std::io::Read;
use wuica_core::facile::py_round2;

#[test]
fn round2_is_pythons_for_every_quotient() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/round2.bin.gz");
    let mut deltas = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).expect("fixtures/round2.bin.gz"))
        .read_to_end(&mut deltas)
        .expect("gzip");
    let mut at = 0usize;
    let (mut checked, mut wrong) = (0usize, Vec::new());
    for n in 1u32..=1000 {
        let mut cents = 0u32;
        for k in 0..=3 * n {
            cents += u32::from(deltas[at]);
            at += 1;
            let want = f64::from(cents) / 100.0; // the double nearest to cents / 100: Python's result
            let got = py_round2(f64::from(k) / f64::from(n));
            checked += 1;
            if got.to_bits() != want.to_bits() && wrong.len() < 10 {
                wrong.push(format!("round({k} / {n}, 2): Python {want}, wuica {got}"));
            }
        }
    }
    assert_eq!(at, deltas.len(), "the fixture has exactly the values of n <= 1000, k <= 3n");
    assert_eq!(checked, 1_502_500);
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
