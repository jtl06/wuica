//! `decode` reads the binary records of the decoder; `decode_json` its JSON. Both must give the same records: for the code of
//! the decode fixtures (main and extra set) with every chip name used there and without a chip check, and for pseudo-random
//! bytes (invalid encodings, instructions that are invalid for the chip, runs of zero bytes).

use std::io::BufRead;
use wuica_xed::DecodedInstr;

fn via_json(code: &[u8], chip: &str) -> (Vec<DecodedInstr>, u32) {
    let (json, errors) = wuica_xed::decode_json(code, chip).unwrap();
    (serde_json::from_str(&json).unwrap(), errors)
}

fn check(code: &[u8], chip: &str) {
    let d = wuica_xed::decode(code, chip).unwrap();
    let (instrs, errors) = via_json(code, chip);
    assert_eq!(d.errors, errors, "{chip} {code:02X?}");
    assert_eq!(d.instrs, instrs, "{chip} {code:02X?}");
}

#[test]
fn binary_records_equal_json() {
    let mut chips: Vec<String> = vec![String::new()];
    let mut codes: Vec<Vec<u8>> = Vec::new();
    for set in ["decode_fixtures", "decode_fixtures_extra"] {
        let path = format!("{}/../../fixtures/{set}.jsonl.gz", env!("CARGO_MANIFEST_DIR"));
        let reader = wuica_testkit::open(path);
        for line in reader.lines() {
            let case: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
            let chip = case["chip"].as_str().unwrap().to_string();
            let code = wuica_xed::parse_hex(case["hex"].as_str().unwrap()).unwrap();
            check(&code, &chip);
            if !chips.contains(&chip) {
                chips.push(chip);
            }
            codes.push(code);
        }
    }
    // the code of some cases with all chips
    for code in codes.iter().step_by(97) {
        for chip in &chips {
            check(code, chip);
        }
    }
    // pseudo-random bytes (xorshift), some with runs of zeros
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    for i in 0..3000 {
        let len = 1 + (i % 64);
        let code: Vec<u8> = (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                if i % 5 == 0 && x % 3 == 0 {
                    0
                } else {
                    (x >> 24) as u8
                }
            })
            .collect();
        check(&code, &chips[i % chips.len()]);
    }
    // a long run of zero bytes, and long code of one-byte instructions
    check(&[0u8; 100], "SKYLAKE");
    check(&[0x90u8; 5000], "SKYLAKE");
    check(&[0x50u8; 3000], "");
}
