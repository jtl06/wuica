//! WebAssembly interface of wuica (docs/WASM-API.md). Only integers and pointers into the module's memory cross the boundary:
//! the caller allocates buffers with `wuica_alloc`, writes its input there, and reads results as (pointer, length) pairs.

use std::cell::RefCell;
use wuica::{error_json, Engine};

#[cfg(all(target_arch = "wasm32", not(target_feature = "atomics")))]
mod alloc;

#[cfg(all(target_arch = "wasm32", not(target_feature = "atomics")))]
#[global_allocator]
static ALLOC: alloc::Alloc = alloc::Alloc::new();

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ENGINE: RefCell<Engine> = RefCell::new(Engine::new());
}

fn set_result(text: String) -> usize {
    RESULT.with(|r| {
        *r.borrow_mut() = text.into_bytes();
        r.borrow().len()
    })
}

fn status(result: Result<(), String>) -> usize {
    set_result(match result {
        Ok(()) => "{\"ok\":true}".to_string(),
        Err(e) => error_json(&e),
    })
}

/// # Safety
/// The pointer must be valid for `len` bytes.
unsafe fn text<'a>(ptr: *const u8, len: usize) -> Result<&'a str, String> {
    std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).map_err(|_| "the input is not UTF-8".to_string())
}

/// Allocates `len` bytes in the module's memory; free them with `wuica_free`.
#[no_mangle]
pub extern "C" fn wuica_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must come from `wuica_alloc(len)`.
#[no_mangle]
pub unsafe extern "C" fn wuica_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// Pointer to the result of the last call (valid until the next call).
#[no_mangle]
pub extern "C" fn wuica_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

/// Decodes machine code for an XED chip name. Result: a JSON array of instructions, or `{"error": ...}`.
///
/// # Safety
/// The pointers must be valid for the given lengths.
#[no_mangle]
pub unsafe extern "C" fn wuica_decode(code: *const u8, code_len: usize, chip: *const u8, chip_len: usize) -> usize {
    let code = std::slice::from_raw_parts(code, code_len);
    let result = text(chip, chip_len).and_then(|chip| wuica_xed::decode_json(code, chip).map_err(|e| e.to_string()));
    set_result(match result {
        Ok((json, _errors)) => json,
        Err(e) => error_json(&e),
    })
}

/// Loads the configurations (the content of `data/uarch.json`). Result: `{"ok": true}` or `{"error": ...}`.
///
/// # Safety
/// The pointer must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn wuica_load_uarch(json: *const u8, len: usize) -> usize {
    status(text(json, len).and_then(|json| ENGINE.with(|e| e.borrow_mut().load_uarch(json))))
}

/// Loads an instruction table. Result: `{"ok": true}` or `{"error": ...}`. The module that ships reads only the binary
/// form (`data/arch/<name>.bin`; a binary table given here is loaded as by `wuica_load_arch_bin`); the JSON form
/// (`data/arch/<name>.json`) only a module built with the feature `json-tables`, else the error says so.
///
/// # Safety
/// The pointers must be valid for the given lengths.
#[no_mangle]
pub unsafe extern "C" fn wuica_load_arch(name: *const u8, name_len: usize, json: *const u8, len: usize) -> usize {
    let bytes = std::slice::from_raw_parts(json, len);
    if bytes.starts_with(b"WUICATBL") {
        return wuica_load_arch_bin(name, name_len, json, len);
    }
    #[cfg(feature = "json-tables")]
    return status(text(name, name_len).and_then(|name| text(json, len).and_then(|json| ENGINE.with(|e| e.borrow_mut().load_arch(name, json)))));
    #[cfg(not(feature = "json-tables"))]
    status(text(name, name_len).and_then(|name| {
        Err(format!("instruction table {name}: this analyzer module reads only binary tables (data/arch/<NAME>.bin, written from the JSON by tools/encode-tables.sh); JSON tables need a module built with the feature json-tables"))
    }))
}

/// Loads the binary form of an instruction table (`data/arch/<name>.bin`, written by `encode_tables` from the JSON; see
/// `wuica_core::table_bin`). Result: `{"ok": true}` or `{"error": ...}` (a file of another format version is an error).
///
/// # Safety
/// The pointers must be valid for the given lengths.
#[no_mangle]
pub unsafe extern "C" fn wuica_load_arch_bin(name: *const u8, name_len: usize, bin: *const u8, len: usize) -> usize {
    let bytes = std::slice::from_raw_parts(bin, len);
    status(text(name, name_len).and_then(|name| ENGINE.with(|e| e.borrow_mut().load_arch_bin(name, bytes))))
}

/// Runs an analysis. The request and the result are JSON (docs/WASM-API.md).
///
/// # Safety
/// The pointer must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn wuica_analyze(request: *const u8, len: usize) -> usize {
    set_result(match text(request, len) {
        Ok(request) => ENGINE.with(|e| e.borrow().analyze_json(request)),
        Err(e) => error_json(&e),
    })
}
