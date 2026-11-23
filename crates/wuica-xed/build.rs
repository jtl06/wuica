// Builds the vendored XED decoder (third_party/xed, see its README for the provenance) and the C shim.
use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let xed = root.join("../../third_party/xed");
    let shim = root.join("shim");
    let target = std::env::var("TARGET").unwrap();

    let mut build = cc::Build::new();
    build
        .include(xed.join("include"))
        .include(xed.join("include/xed"))
        .include(xed.join("include-private"))
        .warnings(false)
        .file(shim.join("wuica_xed.c"));
    // the defines of XED's own build (obj/wkit/include/xed/xed-build-defines.h); the private sources need them on the command line
    for d in [
        "XED_AMD_ENABLED", "XED_AVX", "XED_CET", "XED_DECODER", "XED_MPX", "XED_SUPPORTS_AVX512", "XED_SUPPORTS_LZCNT_TZCNT",
        "XED_SUPPORTS_SHA", "XED_SUPPORTS_WBNOINVD", "XED_VIA_ENABLED",
    ] {
        build.define(d, None);
    }
    build.define("XED_GIT_VERSION", "\"v10.0-1167-gc71679ee\"");

    let mut sources: Vec<_> = std::fs::read_dir(xed.join("src"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "c"))
        .collect();
    sources.sort();
    build.files(&sources);

    if target.starts_with("wasm32") && !target.contains("wasi") && !target.contains("emscripten") {
        // no libc: XED needs only a handful of functions
        build
            .file(shim.join("libc_min.c"))
            .flag("-ffreestanding")
            .flag("-fno-builtin")
            .flag("-isystem")
            .flag(shim.join("wasm-include").to_str().unwrap());
    }
    build.compile("wuica_xed");

    println!("cargo:rerun-if-changed=shim");
    println!("cargo:rerun-if-changed=../../third_party/xed/src");
}
