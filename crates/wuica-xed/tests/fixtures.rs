//! Compares the decoder with the Python reference (fixtures/decode_fixtures.jsonl.gz, made by tools/export_decode_fixtures.py).

use std::io::{BufRead, BufReader};

#[test]
fn decoder_matches_python_reference() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/decode_fixtures.jsonl.gz");
    let reader = BufReader::new(flate2::read::GzDecoder::new(std::fs::File::open(path).expect("fixtures")));
    let (mut cases, mut instrs) = (0, 0);
    for line in reader.lines() {
        let case: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let (file, chip) = (case["file"].as_str().unwrap(), case["chip"].as_str().unwrap());
        let code = wuica_xed::parse_hex(case["hex"].as_str().unwrap()).unwrap();

        // the reference without the 'ast' field, which wuica does not produce (uiCA does not use it)
        let mut expected = case["instrs"].clone();
        for i in expected.as_array_mut().unwrap() {
            i.as_object_mut().unwrap().shift_remove("ast");
        }

        // 1. the raw JSON is the same, including the order of all keys
        let (json, _) = wuica_xed::decode_json(&code, chip).unwrap();
        let got: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&expected).unwrap(), "{file} {chip}");

        // 2. the typed records contain everything: serializing them gives the same JSON again
        let decoded = wuica_xed::decode(&code, chip).unwrap();
        assert_eq!(serde_json::to_string(&decoded.instrs).unwrap(), serde_json::to_string(&expected).unwrap(), "{file} {chip} (typed)");

        cases += 1;
        instrs += decoded.instrs.len();
    }
    assert!(cases > 3000, "only {cases} cases");
    println!("{cases} cases, {instrs} instructions");
}

#[test]
fn unknown_chip_is_an_error() {
    assert!(matches!(wuica_xed::decode(&[0x90], "NO_SUCH_CHIP"), Err(wuica_xed::DecodeError::UnknownChip(_))));
}
