//! The binary instruction tables (src/table_bin.rs): for every table in data/arch, the binary form read all at once
//! (ArchData::from_bin) and read on demand (LazyTable: every form, attribute and performance record decoded by itself) give
//! exactly the structures the JSON gives (field by field, in order); forms the table lacks are absent; a wrong header,
//! another format version, a truncated file and trailing bytes are errors.

use wuica_core::data::{ArchData, Tables};
use wuica_core::table_bin::{is_binary_table, LazyTable, VERSION};

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

fn tables() -> Vec<(String, ArchData)> {
    let dir = format!("{}/data/arch", root());
    let mut names: Vec<_> = std::fs::read_dir(&dir).expect("run tools/export_data.py").filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.ends_with(".json")).collect();
    names.sort();
    assert!(names.len() >= 15, "{names:?}");
    names.into_iter().map(|n| { let json = std::fs::read_to_string(format!("{dir}/{n}")).unwrap(); (n, ArchData::from_json(&json).unwrap()) }).collect()
}

#[test]
fn every_table_reads_back_equal() {
    for (name, data) in tables() {
        let bin = data.to_bin();
        assert!(is_binary_table(&bin));
        let back = ArchData::from_bin(&bin).unwrap();
        assert!(back == data, "{name}: the binary form differs");
        // the iteration order of the maps is part of the tables (uiCA iterates them)
        // (the forms come in the order of their names; each form's entries, and every map in a record, keep their order:
        // writing again gives the same bytes)
        assert_eq!(bin, back.to_bin(), "{name}: writing is deterministic");
    }
}

#[test]
fn on_demand_equals_the_eager_load() {
    for (name, data) in tables() {
        let lazy = LazyTable::new(data.to_bin()).unwrap();
        assert_eq!(lazy.decoded(), (0, 0, 0), "{name}: nothing decoded on opening");
        assert_eq!(lazy.len(), data.instr_data.len(), "{name}");
        // one form first: only it and its records are decoded
        let (iform, entries) = data.instr_data.iter().next().unwrap();
        let got = lazy.entries(iform).unwrap();
        assert!(got == entries.as_slice(), "{name}: {iform}");
        assert_eq!(lazy.decoded().0, 1);
        // then every form, attribute record and performance record, each decoded by itself
        for (iform, entries) in &data.instr_data {
            assert!(lazy.entries(iform).unwrap() == entries.as_slice(), "{name}: {iform}");
            for e in entries {
                assert!(lazy.attr(e.attr) == &data.attr_data[e.attr], "{name}: {iform}: attr {}", e.attr);
                assert!(lazy.perf(e.perf_data) == &data.perf_data[e.perf_data], "{name}: {iform}: perf {}", e.perf_data);
                // the same object each time (the builder shares a record's port data)
                assert!(std::ptr::eq(lazy.perf(e.perf_data), lazy.perf(e.perf_data)));
            }
        }
        for k in 0..data.attr_data.len() {
            assert!(lazy.attr(k) == &data.attr_data[k], "{name}: attr {k}");
        }
        for k in 0..data.perf_data.len() {
            assert!(lazy.perf(k) == &data.perf_data[k], "{name}: perf {k}");
        }
        assert!(lazy.entries("NOT_AN_IFORM").is_none() && lazy.entries("").is_none() && lazy.entries("ZZZZ").is_none());
        let mut sorted = lazy.iforms();
        sorted.sort();
        assert_eq!(sorted, lazy.iforms(), "{name}: the index is sorted");
    }
}

#[test]
fn bad_files_are_errors() {
    let json = std::fs::read_to_string(format!("{}/data/arch/SKL.json", root())).unwrap();
    let bin = ArchData::from_json(&json).unwrap().to_bin();
    assert!(ArchData::from_bin(json.as_bytes()).unwrap_err().contains("no WUICATBL header"));
    assert!(LazyTable::new(json.into_bytes()).is_err());
    let mut v = bin.clone();
    v[8..10].copy_from_slice(&(VERSION + 1).to_le_bytes());
    assert!(ArchData::from_bin(&v).unwrap_err().contains("rebuild the tables"));
    assert!(LazyTable::new(v).err().unwrap().contains("rebuild the tables"));
    assert!(ArchData::from_bin(&bin[..bin.len() - 1]).is_err());
    assert!(LazyTable::new(bin[..bin.len() - 1].to_vec()).is_err());
    let mut v = bin.clone();
    v.push(0);
    assert!(ArchData::from_bin(&v).unwrap_err().contains("the header says"));
    assert!(ArchData::from_bin(&bin[..10]).is_err());
}
