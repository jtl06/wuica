//! x86-64 decoding with Intel XED, as records that are identical to the dicts of uiCA's Python `xed` module
//! (`xed.disasHex` / `xed.disasFile`), which the rest of uiCA's logic is written against.
//!
//! The decoder is the XED version that uiCA pins (XED-to-XML `c71679ee`): the instruction data from uops.info is keyed by the iform
//! names of this version, and matching an instruction to its data depends on XED's operand names and attributes.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_uint};
use std::sync::Once;

extern "C" {
    fn wuica_xed_init();
    fn wuica_xed_decode(code: *const u8, len: c_uint, chip: *const c_char, out: *mut c_char, cap: c_uint, errors: *mut c_uint) -> c_int;
}

pub use wuica_core::decoded::{DecodedInstr, MemAddr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    UnknownChip(String),
    ZeroLengthInstruction,
    Internal(String),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::UnknownChip(c) => write!(f, "unknown XED chip name: {c}"),
            DecodeError::ZeroLengthInstruction => write!(f, "XED reported an instruction of length 0"),
            DecodeError::Internal(m) => write!(f, "decoder error: {m}"),
        }
    }
}

impl std::error::Error for DecodeError {}

pub struct Decoded {
    pub instrs: Vec<DecodedInstr>,
    /// number of positions at which no valid instruction was found; instructions that are valid but not for the chip are counted
    /// here and are also part of `instrs` (as in the Python module)
    pub errors: u32,
}

/// Decodes machine code as JSON (an array of objects with the fields of [`DecodedInstr`]). `chip` is an XED chip name such as
/// `SKYLAKE` or `ALL`; an empty string disables the chip check.
pub fn decode_json(code: &[u8], chip: &str) -> Result<(String, u32), DecodeError> {
    static INIT: Once = Once::new();
    INIT.call_once(|| unsafe { wuica_xed_init() });

    let chip_c = CString::new(chip).map_err(|_| DecodeError::UnknownChip(chip.to_string()))?;
    // an instruction needs well under 1 kB of JSON; the buffer grows if that is not enough
    let mut cap = 4096 + code.len() * 600;
    loop {
        let mut buf = vec![0u8; cap];
        let mut errors: c_uint = 0;
        let n = unsafe {
            wuica_xed_decode(code.as_ptr(), code.len() as c_uint, chip_c.as_ptr(), buf.as_mut_ptr() as *mut c_char, cap as c_uint, &mut errors)
        };
        match n {
            -1 => cap *= 4,
            -2 => return Err(DecodeError::UnknownChip(chip.to_string())),
            -3 => return Err(DecodeError::ZeroLengthInstruction),
            n if n >= 0 => {
                buf.truncate(n as usize);
                let s = String::from_utf8(buf).map_err(|e| DecodeError::Internal(e.to_string()))?;
                return Ok((s, errors));
            }
            n => return Err(DecodeError::Internal(format!("unexpected return value {n}"))),
        }
    }
}

/// Decodes machine code. See [`decode_json`].
pub fn decode(code: &[u8], chip: &str) -> Result<Decoded, DecodeError> {
    let (json, errors) = decode_json(code, chip)?;
    let instrs = serde_json::from_str(&json).map_err(|e| DecodeError::Internal(e.to_string()))?;
    Ok(Decoded { instrs, errors })
}

/// Parses a string of hex digits (as in the `opcode` field).
pub fn parse_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len() / 2).map(|i| u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok()).collect()
}
