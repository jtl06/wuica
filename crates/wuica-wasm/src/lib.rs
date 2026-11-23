//! WebAssembly interface of wuica. Only integers and pointers into the module's memory cross the boundary:
//! the caller allocates a buffer with `wuica_alloc`, writes its input there, and reads results as (pointer, length) pairs.

use std::cell::RefCell;

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_result(bytes: Vec<u8>) -> usize {
    RESULT.with(|r| {
        *r.borrow_mut() = bytes;
        r.borrow().len()
    })
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

/// Decodes `code_len` bytes of machine code for the XED chip name at `chip` (UTF-8, `chip_len` bytes). The result is a JSON array of
/// instructions; on an error, it is a JSON object with an "error" field. Returns the length of the result.
///
/// # Safety
/// The pointers must be valid for the given lengths.
#[no_mangle]
pub unsafe extern "C" fn wuica_decode(code: *const u8, code_len: usize, chip: *const u8, chip_len: usize) -> usize {
    let code = std::slice::from_raw_parts(code, code_len);
    let chip = std::str::from_utf8(std::slice::from_raw_parts(chip, chip_len)).unwrap_or("");
    match wuica_xed::decode_json(code, chip) {
        Ok((json, _errors)) => set_result(json.into_bytes()),
        Err(e) => set_result(format!("{{\"error\":{:?}}}", e.to_string()).into_bytes()),
    }
}
