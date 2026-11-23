//! x86-64 decoding with Intel XED, as records that are identical to the dicts of uiCA's Python `xed` module
//! (`xed.disasHex` / `xed.disasFile`), which the rest of uiCA's logic is written against.
//!
//! The decoder is the XED version that uiCA pins (XED-to-XML `c71679ee`): the instruction data from uops.info is keyed by the iform
//! names of this version, and matching an instruction to its data depends on XED's operand names and attributes.

use indexmap::IndexMap;
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_uint};
use std::sync::Once;

extern "C" {
    fn wuica_xed_init();
    fn wuica_xed_decode(code: *const u8, len: c_uint, chip: *const c_char, out: *mut c_char, cap: c_uint, errors: *mut c_uint) -> c_int;
    fn wuica_xed_decode_bin(code: *const u8, len: c_uint, chip: *const c_char, out: *mut c_char, cap: c_uint, errors: *mut c_uint) -> c_int;
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

/// Initializes XED's tables, once per process. One `Once` for every entry point: `xed_tables_init` marks itself done before it
/// has built the tables (with a plain flag), so a second caller would decode with tables that are still being written, and
/// `wuica_xed_init` also rewrites the format options that decoding reads.
fn init() {
    static INIT: Once = Once::new();
    INIT.call_once(|| unsafe { wuica_xed_init() });
}

/// Decodes machine code as JSON (an array of objects with the fields of [`DecodedInstr`]). `chip` is an XED chip name such as
/// `SKYLAKE` or `ALL`; an empty string disables the chip check.
pub fn decode_json(code: &[u8], chip: &str) -> Result<(String, u32), DecodeError> {
    init();

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

/// Decodes machine code: the records of [`decode_json`], filled from the compact binary form that the decoder also writes
/// (described in `shim/wuica_xed.c`) instead of from JSON.
pub fn decode(code: &[u8], chip: &str) -> Result<Decoded, DecodeError> {
    init();

    let chip_c = CString::new(chip).map_err(|_| DecodeError::UnknownChip(chip.to_string()))?;
    // a record needs well under 300 bytes; the buffer grows if that is not enough
    let mut cap = 1024 + code.len() * 300;
    loop {
        let mut buf: Vec<u8> = Vec::with_capacity(cap);
        let mut errors: c_uint = 0;
        // the decoder only writes to the buffer (the bytes before the returned length)
        let n = unsafe {
            wuica_xed_decode_bin(code.as_ptr(), code.len() as c_uint, chip_c.as_ptr(), buf.as_mut_ptr() as *mut c_char, cap as c_uint, &mut errors)
        };
        match n {
            -1 => cap *= 4,
            -2 => return Err(DecodeError::UnknownChip(chip.to_string())),
            -3 => return Err(DecodeError::ZeroLengthInstruction),
            n if n >= 0 && n as usize <= cap => {
                unsafe { buf.set_len(n as usize) };
                let instrs = Records { b: &buf, i: 0 }.read_all()?;
                return Ok(Decoded { instrs, errors });
            }
            n => return Err(DecodeError::Internal(format!("unexpected return value {n}"))),
        }
    }
}

/// A reader of the binary records of the decoder.
struct Records<'a> {
    b: &'a [u8],
    i: usize,
}

fn malformed() -> DecodeError {
    DecodeError::Internal("malformed record from the decoder".to_string())
}

impl Records<'_> {
    fn byte(&mut self) -> Result<u8, DecodeError> {
        let c = *self.b.get(self.i).ok_or_else(malformed)?;
        self.i += 1;
        Ok(c)
    }

    fn string(&mut self) -> Result<String, DecodeError> {
        let rest = &self.b[self.i..];
        let len = rest.iter().position(|&c| c == 0).ok_or_else(malformed)?;
        let s = std::str::from_utf8(&rest[..len]).map_err(|e| DecodeError::Internal(e.to_string()))?;
        self.i += len + 1;
        Ok(s.to_string())
    }

    fn i64(&mut self) -> Result<i64, DecodeError> {
        let bytes = self.b.get(self.i..self.i + 8).ok_or_else(malformed)?;
        self.i += 8;
        Ok(i64::from_le_bytes(bytes.try_into().unwrap()))
    }

    /// the entries of a map, until the 0 byte that ends it
    fn map<V>(&mut self, mut value: impl FnMut(&mut Self) -> Result<V, DecodeError>) -> Result<IndexMap<String, V>, DecodeError> {
        let mut map = IndexMap::new();
        while *self.b.get(self.i).ok_or_else(malformed)? != 0 {
            let key = self.string()?;
            let v = value(self)?;
            map.insert(key, v);
        }
        self.i += 1;
        Ok(map)
    }

    fn read_all(mut self) -> Result<Vec<DecodedInstr>, DecodeError> {
        let mut instrs = Vec::new();
        while self.byte()? == 1 {
            instrs.push(self.instr()?);
        }
        if self.i != self.b.len() {
            return Err(malformed());
        }
        Ok(instrs)
    }

    /// the fields in the order of `add_instr` in the decoder (the order of the JSON object)
    fn instr(&mut self) -> Result<DecodedInstr, DecodeError> {
        let opcode = self.string()?;
        let pos_nominal_opcode = u32::try_from(self.i64()?).map_err(|_| malformed())?;
        let addr = u64::try_from(self.i64()?).map_err(|_| malformed())?;
        let iclass = self.string()?;
        let iform = self.string()?;
        let category = self.string()?;
        let extension = self.string()?;
        let isa_set = self.string()?;
        let asm = self.string()?;
        let bcast = self.string()?;
        let eosz = self.string()?;
        let mask = self.string()?;
        let prefix66 = self.string()?;
        let rep = self.string()?;
        let rm = self.string()?;
        let sae = self.string()?;
        let zeroing = self.string()?;
        let agen = self.string()?;
        let high8 = self.string()?;
        let reg_operands = self.map(|r| r.string())?;
        let (imm0, imm_width) = if self.byte()? != 0 {
            (Some(self.i64()?), Some(u32::try_from(self.i64()?).map_err(|_| malformed())?))
        } else {
            (None, None)
        };
        let immzero = self.string()?;
        let imm1 = if self.byte()? != 0 { Some(self.i64()?) } else { None };
        let mem_operands = self.map(|r| {
            let present = r.byte()?;
            Ok(MemAddr {
                base: if present & 1 != 0 { Some(r.string()?) } else { None },
                index: if present & 2 != 0 { Some(r.string()?) } else { None },
                scale: if present & 4 != 0 { Some(r.i64()?) } else { None },
                disp: if present & 8 != 0 { Some(r.i64()?) } else { None },
            })
        })?;
        let rw = self.map(|r| r.string())?;
        Ok(DecodedInstr {
            opcode,
            pos_nominal_opcode,
            addr,
            iclass,
            iform,
            category,
            extension,
            isa_set,
            asm,
            bcast,
            eosz,
            mask,
            prefix66,
            rep,
            rm,
            sae,
            zeroing,
            agen,
            high8,
            reg_operands,
            imm0,
            imm_width,
            immzero,
            imm1,
            mem_operands,
            rw,
        })
    }
}

/// Parses a string of hex digits (as in the `opcode` field).
pub fn parse_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len() / 2).map(|i| u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok()).collect()
}
