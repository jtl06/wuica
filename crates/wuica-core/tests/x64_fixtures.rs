//! Compares the register helpers and `mem_width` with the Python reference (fixtures/x64_helpers.txt.gz: lines
//! "REG canonicalReg regSize" for registers, and "S instrStr | memWidth" for all instruction strings of the ADL-P table).

use std::io::{BufRead, BufReader};
use wuica_core::x64;

#[test]
fn helpers_match_python_reference() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/x64_helpers.txt.gz");
    let reader = BufReader::new(flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap()));
    let (mut regs, mut strings) = (0, 0);
    for line in reader.lines() {
        let line = line.unwrap();
        if let Some(rest) = line.strip_prefix("S ") {
            let (s, w) = rest.rsplit_once(" | ").unwrap();
            let expected = if w == "None" { None } else { Some(w.parse::<i64>().unwrap()) };
            assert_eq!(x64::mem_width(s), expected, "{s}");
            strings += 1;
        } else {
            let f: Vec<&str> = line.split(' ').collect();
            assert_eq!(x64::canonical_reg(f[0]), f[1], "{}", f[0]);
            assert_eq!(x64::reg_size(f[0]), f[2].parse::<i64>().unwrap(), "{}", f[0]);
            regs += 1;
        }
    }
    assert!(regs > 70 && strings > 10000, "{regs} {strings}");
}
