//! The binary instruction tables (src/table_bin.rs): for every table in data/arch, the binary form reads back into exactly
//! the structures the JSON gives (field by field, in order, PartialEq of ArchData); a wrong header, another format
//! version, a truncated file and trailing bytes are errors.

use wuica_core::data::ArchData;
use wuica_core::table_bin::{is_binary_table, VERSION};

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

#[test]
fn every_table_reads_back_equal() {
    let dir = format!("{}/data/arch", root());
    let mut names: Vec<_> = std::fs::read_dir(&dir).expect("run tools/export_data.py").filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.ends_with(".json")).collect();
    names.sort();
    assert!(names.len() >= 15, "{names:?}");
    for name in &names {
        let json = std::fs::read_to_string(format!("{dir}/{name}")).unwrap();
        let data = ArchData::from_json(&json).unwrap();
        let bin = data.to_bin();
        assert!(is_binary_table(&bin));
        let back = ArchData::from_bin(&bin).unwrap();
        assert!(back == data, "{name}: the binary form differs");
        // the iteration order of the maps is part of the tables (uiCA iterates them)
        assert!(back.instr_data.keys().eq(data.instr_data.keys()), "{name}: the order of the iforms");
        assert_eq!(bin, back.to_bin(), "{name}: writing is deterministic");
    }
}

#[test]
fn bad_files_are_errors() {
    let json = std::fs::read_to_string(format!("{}/data/arch/SKL.json", root())).unwrap();
    let bin = ArchData::from_json(&json).unwrap().to_bin();
    assert!(ArchData::from_bin(json.as_bytes()).unwrap_err().contains("no WUICATBL header"));
    let mut v = bin.clone();
    v[8..10].copy_from_slice(&(VERSION + 1).to_le_bytes());
    assert!(ArchData::from_bin(&v).unwrap_err().contains("rebuild the tables"));
    assert!(ArchData::from_bin(&bin[..bin.len() - 1]).is_err());
    let mut v = bin.clone();
    v.push(0);
    assert!(ArchData::from_bin(&v).unwrap_err().contains("trailing bytes"));
    assert!(ArchData::from_bin(&bin[..10]).is_err());
}
