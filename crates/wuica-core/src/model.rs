//! Instruction objects: what uiCA's `getInstructions`, `adjustLatenciesAndAddMergeUops` and `computeUopProperties` produce, and
//! what the simulator consumes. The JSON form of [`InstrList`] is the format of the instruction fixtures
//! (`tools/export_fixtures.py`), with the names of the Python attributes.
//!
//! Operands are compared by identity in uiCA: two `RegOperand('RAX')` objects are different keys of the latency dicts. Operands
//! are therefore stored once, in [`InstrList::operands`], and referred to by index ([`OpId`]). They are numbered in the order in
//! which a traversal of the instructions first reaches them (the fields of [`Instr`] in declaration order, operands of
//! `latencies` as (input, output), then the uop properties); [`InstrList::renumbered`] establishes this numbering.

use crate::decoded::MemAddr;
use serde::{Deserialize, Serialize};

/// Index into [`InstrList::operands`].
pub type OpId = u32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Operand {
    Reg {
        reg: String,
        #[serde(rename = "isImplicitStackOperand")]
        is_implicit_stack_operand: bool,
    },
    /// a group of flags: "C" or "SPAZO"
    Flag { flags: String },
    Mem {
        #[serde(rename = "memAddr")]
        mem_addr: MemAddr,
    },
    /// a value passed between the uops of an instruction
    Pseudo,
}

/// Instructions with the same key share a throughput limit (`Instr::tp`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TpKey {
    /// the instruction string
    InstrStr(String),
    /// a key of its own: ("narrowStore", index of the instruction)
    Own(String, usize),
}

/// The properties of an (unfused-domain) uop of an instruction (uiCA's `UopProperties`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UopProperties {
    /// `None` for uops that do not need a port
    #[serde(rename = "possiblePorts")]
    pub possible_ports: Option<Vec<String>>,
    #[serde(rename = "inputOperands")]
    pub input_operands: Vec<OpId>,
    #[serde(rename = "outputOperands")]
    pub output_operands: Vec<OpId>,
    /// (output operand, latency), in the order of the Python dict; an output that is not listed has latency 1
    pub latencies: Vec<(OpId, i64)>,
    #[serde(rename = "divCycles")]
    pub div_cycles: i64,
    #[serde(rename = "isLoadUop")]
    pub is_load_uop: bool,
    #[serde(rename = "forwardDelay")]
    pub forward_delay: i64,
    #[serde(rename = "forwardFailDelay")]
    pub forward_fail_delay: i64,
    #[serde(rename = "isStoreAddressUop")]
    pub is_store_address_uop: bool,
    #[serde(rename = "memAddr")]
    pub mem_addr: Option<MemAddr>,
    #[serde(rename = "isStoreDataUop")]
    pub is_store_data_uop: bool,
    #[serde(rename = "isFirstUopOfInstr")]
    pub is_first_uop_of_instr: bool,
    #[serde(rename = "isLastUopOfInstr")]
    pub is_last_uop_of_instr: bool,
    #[serde(rename = "isRegMergeUop")]
    pub is_reg_merge_uop: bool,
}

/// An instruction of the analyzed code (uiCA's `Instr`; `is_unknown` for `UnknownInstr`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Instr {
    #[serde(rename = "isUnknown")]
    pub is_unknown: bool,
    pub asm: String,
    /// the instruction's bytes as uppercase hex
    pub opcode: String,
    #[serde(rename = "posNominalOpcode")]
    pub pos_nominal_opcode: i64,
    /// the uops.info name, e.g. "ADD (R64, R64)"; empty for unknown instructions
    #[serde(rename = "instrStr")]
    pub instr_str: String,
    /// (ports, number of uops), in the order of the Python dict; the ports are one character each
    #[serde(rename = "portData")]
    pub port_data: Vec<(String, i64)>,
    pub uops: i64,
    #[serde(rename = "retireSlots")]
    pub retire_slots: i64,
    #[serde(rename = "uopsMITE")]
    pub uops_mite: i64,
    #[serde(rename = "uopsMS")]
    pub uops_ms: i64,
    #[serde(rename = "divCycles")]
    pub div_cycles: i64,
    #[serde(rename = "inputRegOperands")]
    pub input_reg_operands: Vec<OpId>,
    #[serde(rename = "inputFlagOperands")]
    pub input_flag_operands: Vec<OpId>,
    #[serde(rename = "inputMemOperands")]
    pub input_mem_operands: Vec<OpId>,
    #[serde(rename = "outputRegOperands")]
    pub output_reg_operands: Vec<OpId>,
    #[serde(rename = "outputFlagOperands")]
    pub output_flag_operands: Vec<OpId>,
    #[serde(rename = "outputMemOperands")]
    pub output_mem_operands: Vec<OpId>,
    #[serde(rename = "memAddrOperands")]
    pub mem_addr_operands: Vec<OpId>,
    #[serde(rename = "agenOperands")]
    pub agen_operands: Vec<OpId>,
    /// (input operand, output operand, latency), in the order of the Python dict
    pub latencies: Vec<(OpId, OpId, i64)>,
    /// throughput limit in cycles (can be a fraction)
    #[serde(rename = "TP")]
    pub tp: Option<f64>,
    /// signed immediate
    pub immediate: Option<i64>,
    #[serde(rename = "lcpStall")]
    pub lcp_stall: bool,
    #[serde(rename = "implicitRSPChange")]
    pub implicit_rsp_change: i64,
    #[serde(rename = "mayBeEliminated")]
    pub may_be_eliminated: bool,
    #[serde(rename = "complexDecoder")]
    pub complex_decoder: bool,
    #[serde(rename = "nAvailableSimpleDecoders")]
    pub n_available_simple_decoders: Option<i64>,
    #[serde(rename = "hasLockPrefix")]
    pub has_lock_prefix: bool,
    #[serde(rename = "isBranchInstr")]
    pub is_branch_instr: bool,
    #[serde(rename = "isSerializingInstr")]
    pub is_serializing_instr: bool,
    #[serde(rename = "isLoadSerializing")]
    pub is_load_serializing: bool,
    #[serde(rename = "isStoreSerializing")]
    pub is_store_serializing: bool,
    /// instruction strings (sorted)
    #[serde(rename = "macroFusibleWith")]
    pub macro_fusible_with: Vec<String>,
    #[serde(rename = "macroFusedWithPrevInstr")]
    pub macro_fused_with_prev_instr: bool,
    #[serde(rename = "macroFusedWithNextInstr")]
    pub macro_fused_with_next_instr: bool,
    #[serde(rename = "cannotBeInDSBDueToJCCErratum")]
    pub cannot_be_in_dsb_due_to_jcc_erratum: bool,
    /// canonical register
    #[serde(rename = "foldedInputReg")]
    pub folded_input_reg: Option<String>,
    #[serde(rename = "memRenaming")]
    pub mem_renaming: bool,
    #[serde(rename = "TPKey")]
    pub tp_key: TpKey,
    #[serde(rename = "opCacheFields")]
    pub op_cache_fields: i64,
    /// `splitLoadPattern`: for a load that crosses a 64-byte line in some iterations, whether it does in each iteration of a period
    /// (see `splitLoadCycles`); absent otherwise
    #[serde(rename = "splitLoadPattern", default, skip_serializing_if = "Option::is_none")]
    pub split_load_pattern: Option<Vec<bool>>,
    #[serde(rename = "isNextToLastInstr")]
    pub is_next_to_last_instr: bool,
    #[serde(rename = "isLastInstr")]
    pub is_last_instr: bool,
    #[serde(rename = "UopPropertiesList")]
    pub uop_properties_list: Vec<UopProperties>,
    #[serde(rename = "regMergeUopPropertiesList")]
    pub reg_merge_uop_properties_list: Vec<UopProperties>,
}

impl Instr {
    /// uiCA's `Instr.isLastDecodedInstr`
    pub fn is_last_decoded_instr(&self) -> bool {
        (self.is_next_to_last_instr && self.macro_fused_with_next_instr) || self.is_last_instr
    }
}

/// The instructions of the analyzed code with their operands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstrList {
    pub operands: Vec<Operand>,
    pub instrs: Vec<Instr>,
}

impl InstrList {
    /// Returns the same list with the operands numbered in the canonical order (see the module documentation), without
    /// operands that are not referred to.
    pub fn renumbered(&self) -> InstrList {
        let mut map: Vec<Option<OpId>> = vec![None; self.operands.len()];
        let mut operands = Vec::new();
        let mut id = |old: OpId, operands: &mut Vec<Operand>| -> OpId {
            *map[old as usize].get_or_insert_with(|| {
                operands.push(self.operands[old as usize].clone());
                (operands.len() - 1) as OpId
            })
        };
        let mut instrs = self.instrs.clone();
        for instr in &mut instrs {
            for list in [
                &mut instr.input_reg_operands,
                &mut instr.input_flag_operands,
                &mut instr.input_mem_operands,
                &mut instr.output_reg_operands,
                &mut instr.output_flag_operands,
                &mut instr.output_mem_operands,
                &mut instr.mem_addr_operands,
                &mut instr.agen_operands,
            ] {
                for o in list.iter_mut() {
                    *o = id(*o, &mut operands);
                }
            }
            for (i, o, _) in &mut instr.latencies {
                *i = id(*i, &mut operands);
                *o = id(*o, &mut operands);
            }
            for props in instr.uop_properties_list.iter_mut().chain(instr.reg_merge_uop_properties_list.iter_mut()) {
                for o in props.input_operands.iter_mut().chain(props.output_operands.iter_mut()) {
                    *o = id(*o, &mut operands);
                }
                for (o, _) in &mut props.latencies {
                    *o = id(*o, &mut operands);
                }
            }
        }
        InstrList { operands, instrs }
    }
}
