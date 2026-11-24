//! Writes the binary form of the instruction tables (`src/table_bin.rs`): `IN/<NAME>.json` -> `OUT/<NAME>.bin`, each checked
//! to read back into the same tables as its JSON. Used by `packages/wuica/build.sh` and `web/build.sh`.
//!
//!     cargo run --release -p wuica-core --example encode_tables -- data/arch OUT_DIR

use wuica_core::data::ArchData;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [input, output] = &args[..] else {
        eprintln!("usage: encode_tables IN_DIR OUT_DIR   (IN_DIR/<NAME>.json -> OUT_DIR/<NAME>.bin)");
        std::process::exit(2);
    };
    std::fs::create_dir_all(output).unwrap_or_else(|e| panic!("{output}: {e}"));
    let mut names: Vec<_> = std::fs::read_dir(input)
        .unwrap_or_else(|e| panic!("{input}: {e}"))
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    if names.is_empty() {
        eprintln!("encode_tables: no .json tables in {input}");
        std::process::exit(1);
    }
    for name in names {
        let path = format!("{input}/{name}");
        let json = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let data = ArchData::from_json(&json).unwrap_or_else(|e| panic!("{path}: {e}"));
        let bin = data.to_bin();
        let back = ArchData::from_bin(&bin).unwrap_or_else(|e| panic!("{path}: reading it back: {e}"));
        assert!(back == data, "{path}: the binary form does not read back into the same tables");
        let out = format!("{output}/{}.bin", name.trim_end_matches(".json"));
        std::fs::write(&out, &bin).unwrap_or_else(|e| panic!("{out}: {e}"));
        println!("{name}: {} -> {} bytes", json.len(), bin.len());
    }
}
