//! Decoded instructions, as produced by the decoder (`wuica-xed`). The records are identical to the dicts of uiCA's Python `xed`
//! module (`xed.disasHex`), which the instruction builder is written against.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// An address expression. `MEM1` operands only have a base.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MemAddr {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disp: Option<i64>,
}

/// One decoded instruction. The fields, their names (as JSON) and their order are those of the Python module; the maps keep XED's
/// operand order, which uiCA's logic iterates over. Values that are compared with XML attributes are strings, as in Python.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodedInstr {
    /// the instruction's bytes as uppercase hex
    pub opcode: String,
    pub pos_nominal_opcode: u32,
    /// offset in the decoded code
    pub addr: u64,
    pub iclass: String,
    pub iform: String,
    pub category: String,
    pub extension: String,
    #[serde(rename = "isa-set")]
    pub isa_set: String,
    /// Intel syntax, as printed by XED
    pub asm: String,
    pub bcast: String,
    pub eosz: String,
    pub mask: String,
    pub prefix66: String,
    pub rep: String,
    pub rm: String,
    pub sae: String,
    pub zeroing: String,
    pub agen: String,
    /// comma-separated names of the operands that are high-8 registers (AH, BH, CH, DH)
    pub high8: String,
    /// operand name (REG0..REG9) -> register
    #[serde(rename = "regOperands")]
    pub reg_operands: IndexMap<String, String>,
    #[serde(rename = "IMM0", default, skip_serializing_if = "Option::is_none")]
    pub imm0: Option<i64>,
    #[serde(rename = "IMM_WIDTH", default, skip_serializing_if = "Option::is_none")]
    pub imm_width: Option<u32>,
    pub immzero: String,
    #[serde(rename = "IMM1", default, skip_serializing_if = "Option::is_none")]
    pub imm1: Option<i64>,
    /// operand name (MEM0, AGEN, MEM1) -> address expression
    #[serde(rename = "memOperands")]
    pub mem_operands: IndexMap<String, MemAddr>,
    /// operand name -> XED operand action (R, W, RW, CR, CW, RCW, ...)
    pub rw: IndexMap<String, String>,
}
