//! Microarchitecture configurations (uiCA's `microArchConfigs.py`), loaded from `data/uarch.json` (made by `tools/export_data.py`).
//! The fields have the meaning of the attributes of uiCA's `MicroArchConfig` with the same (JSON) name.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// The number of move-elimination slots: a number or 'unlimited'.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Slots {
    Limited(i64),
    /// the string "unlimited"
    Unlimited(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UArchConfig {
    #[serde(rename = "name")]
    pub name: String,
    #[serde(rename = "XEDName")]
    pub xed_name: String,
    #[serde(rename = "IQWidth")]
    pub iq_width: i64,
    #[serde(rename = "DSBWidth")]
    pub dsb_width: i64,
    #[serde(rename = "IDQWidth")]
    pub idq_width: i64,
    #[serde(rename = "issueWidth")]
    pub issue_width: i64,
    #[serde(rename = "RBWidth")]
    pub rb_width: i64,
    #[serde(rename = "RSWidth")]
    pub rs_width: i64,
    #[serde(rename = "retireWidth")]
    pub retire_width: i64,
    #[serde(rename = "pop5CRequiresComplexDecoder")]
    pub pop5c_requires_complex_decoder: bool,
    #[serde(rename = "macroFusibleInstrCanBeDecodedAsLastInstr")]
    pub macro_fusible_instr_can_be_decoded_as_last_instr: bool,
    #[serde(rename = "branchCanBeLastInstrInCachedBlock")]
    pub branch_can_be_last_instr_in_cached_block: bool,
    #[serde(rename = "both32ByteBlocksMustBeCacheable")]
    pub both_32byte_blocks_must_be_cacheable: bool,
    #[serde(rename = "nDecoders")]
    pub n_decoders: i64,
    #[serde(rename = "preDecodeWidth")]
    pub pre_decode_width: i64,
    #[serde(rename = "preDecodeBlockSize")]
    pub pre_decode_block_size: i64,
    #[serde(rename = "predecodeDecodeDelay")]
    pub predecode_decode_delay: i64,
    #[serde(rename = "issueDispatchDelay")]
    pub issue_dispatch_delay: i64,
    #[serde(rename = "DSB_MS_Stall")]
    pub dsb_ms_stall: i64,
    #[serde(rename = "pop5CEndsDecodeGroup")]
    pub pop5c_ends_decode_group: bool,
    #[serde(rename = "high8RenamedSeparately")]
    pub high8_renamed_separately: bool,
    #[serde(rename = "movzxHigh8AliasCanBeEliminated")]
    pub movzx_high8_alias_can_be_eliminated: bool,
    #[serde(rename = "moveEliminationPipelineLength")]
    pub move_elimination_pipeline_length: i64,
    #[serde(rename = "moveEliminationGPRSlots")]
    pub move_elimination_gpr_slots: Slots,
    #[serde(rename = "moveEliminationSIMDSlots")]
    pub move_elimination_simd_slots: Slots,
    #[serde(rename = "moveEliminationGPRAllAliasesMustBeOverwritten")]
    pub move_elimination_gpr_all_aliases_must_be_overwritten: bool,
    #[serde(rename = "LSDEnabled")]
    pub lsd_enabled: bool,
    #[serde(rename = "LSDUnrolling")]
    pub lsd_unrolling: IndexMap<String, u32>,
    #[serde(rename = "fastPointerChasing")]
    pub fast_pointer_chasing: bool,
    #[serde(rename = "slow256BitMemAcc")]
    pub slow_256bit_mem_acc: bool,
    #[serde(rename = "DSBBlockSize")]
    pub dsb_block_size: i64,
    #[serde(rename = "simplePortAssignment")]
    pub simple_port_assignment: bool,
    #[serde(rename = "isAMD")]
    pub is_amd: bool,
    #[serde(rename = "loadPorts")]
    pub load_ports: String,
    #[serde(rename = "storeAddrPorts")]
    pub store_addr_ports: String,
    #[serde(rename = "storeDataPorts")]
    pub store_data_ports: String,
    #[serde(rename = "fusiblePorts")]
    pub fusible_ports: String,
    #[serde(rename = "dividerPort")]
    pub divider_port: String,
    #[serde(rename = "loadLatency")]
    pub load_latency: i64,
    #[serde(rename = "portNames")]
    pub port_names: IndexMap<String, String>,
    #[serde(rename = "experimental")]
    pub experimental: bool,
    #[serde(rename = "portAssignment")]
    pub port_assignment: Option<String>,
    #[serde(rename = "renameImmediateFolding")]
    pub rename_immediate_folding: bool,
    #[serde(rename = "takenBranchPort")]
    pub taken_branch_port: Option<String>,
    #[serde(rename = "memoryRenaming")]
    pub memory_renaming: Option<String>,
    #[serde(rename = "memRenamingWidths")]
    pub mem_renaming_widths: Option<Vec<u32>>,
    #[serde(rename = "memRenamingExcluded")]
    pub mem_renaming_excluded: Vec<String>,
    #[serde(rename = "memRenamingFoldedCheck")]
    pub mem_renaming_folded_check: bool,
    #[serde(rename = "storeForwardFailDelay")]
    pub store_forward_fail_delay: i64,
    #[serde(rename = "loadValueNumbering")]
    pub load_value_numbering: bool,
    #[serde(rename = "loadLineSlots")]
    pub load_line_slots: Option<u32>,
    #[serde(rename = "rmwForwardDelayOverride")]
    pub rmw_forward_delay_override: Option<i64>,
    #[serde(rename = "simpleRMWForwardDelay")]
    pub simple_rmw_forward_delay: i64,
    #[serde(rename = "storeForwardDelay")]
    pub store_forward_delay: i64,
    #[serde(rename = "storeLineRestrictedPorts")]
    pub store_line_restricted_ports: String,
    #[serde(rename = "vectorStoreDataPorts")]
    pub vector_store_data_ports: String,
    #[serde(rename = "narrowStorePenalty")]
    pub narrow_store_penalty: i64,
    #[serde(rename = "opCacheEntryOps")]
    pub op_cache_entry_ops: i64,
    #[serde(rename = "opCacheMaxFields")]
    pub op_cache_max_fields: i64,
    #[serde(rename = "opCacheEntryFields")]
    pub op_cache_entry_fields: i64,
    #[serde(rename = "dataFrom")]
    pub data_from: Option<String>,
    #[serde(rename = "sameRegMoveEliminated")]
    pub same_reg_move_eliminated: bool,
    #[serde(rename = "rmwForwardDelay")]
    pub rmw_forward_delay: i64,
    /// AMD op cache: an instruction with more macro-ops than this (if > 0) is microcoded (`microcodeOps`; 0 in data exported
    /// before the field existed)
    #[serde(rename = "microcodeOps", default)]
    pub microcode_ops: i64,
    /// macro-ops that the microcode sequencer delivers per cycle (`microcodeWidth`)
    #[serde(rename = "microcodeWidth", default)]
    pub microcode_width: i64,
    /// AMD op cache: if > 0, the first entry after a microcoded instruction holds at most this many macro-ops
    /// (`microcodeNextEntryOps`; 0 in data exported before the field existed)
    #[serde(rename = "microcodeNextEntryOps", default)]
    pub microcode_next_entry_ops: i64,
    /// `renameImmediateFolding`: additional latency for a shift or rotate that reads a register whose value was computed by the
    /// renamer (`foldedShiftDelay`; 0 in data exported before the field existed)
    #[serde(rename = "foldedShiftDelay", default)]
    pub folded_shift_delay: i64,
    /// store-forwarding delay for the loads of load-op instructions (other uops, no memory output), `loadOpForwardDelay` (None:
    /// `storeForwardDelay`; also in data exported before the field existed)
    #[serde(rename = "loadOpForwardDelay", default)]
    pub load_op_forward_delay: Option<i64>,
    /// store-forwarding delay for the loads of read-modify-write RCL and RCR, `rotateCarryRMWForwardDelay` (None:
    /// `rmwForwardDelay`; also in data exported before the field existed)
    #[serde(rename = "rotateCarryRMWForwardDelay", default)]
    pub rotate_carry_rmw_forward_delay: Option<i64>,
    /// if > 0: a load that crosses a 64-byte line occupies its load port for this many cycles, where the addresses of the loop make the
    /// crossing knowable (`splitLoadCycles`; 0 in data exported before the field existed)
    #[serde(rename = "splitLoadCycles", default)]
    pub split_load_cycles: i64,
    /// AMD: if > 0, at most this many uops for the ports `fpSchedulerPorts` wait in the FP scheduler; younger ones wait in order in the
    /// non-scheduling queue and are not dispatched before they enter it (`fpSchedulerSize`; 0 in data exported before the field existed)
    #[serde(rename = "fpSchedulerSize", default)]
    pub fp_scheduler_size: i64,
    #[serde(rename = "fpSchedulerPorts", default)]
    pub fp_scheduler_ports: String,
    /// if > 0: additional latency when a vector instruction reads a value written by an instruction of another vector domain
    /// (integer, floating point, lane-crossing permutes; `domainBypassDelay`, 0 in data exported before the field existed)
    #[serde(rename = "domainBypassDelay", default)]
    pub domain_bypass_delay: i64,
    /// register files (None: no limit): at most this many fused uops that write a vector register (a name with 'MM') are in
    /// flight, from issue until their registers are free again (`vecRegFileSize`; None in data exported before the field existed)
    #[serde(rename = "vecRegFileSize", default)]
    pub vec_reg_file_size: Option<i64>,
    /// the same for general-purpose registers (`gprRegFileSize`)
    #[serde(rename = "gprRegFileSize", default)]
    pub gpr_reg_file_size: Option<i64>,
    /// a vector register freed at retirement can be allocated again this many cycles later (`vecRegFreeDelay`)
    #[serde(rename = "vecRegFreeDelay", default)]
    pub vec_reg_free_delay: i64,
    /// the same for general-purpose registers (`gprRegFreeDelay`)
    #[serde(rename = "gprRegFreeDelay", default)]
    pub gpr_reg_free_delay: i64,
    /// if true: a load whose first byte lies inside an older store with the same base, index and scale but another displacement
    /// reads from that store (a forwarding failure if it is wider than the rest of the store); otherwise such a load is independent
    /// of the store (`storeForwardOverlap`; false in data exported before the field existed)
    #[serde(rename = "storeForwardOverlap", default)]
    pub store_forward_overlap: bool,
    /// (xmm, ymm): additional forwarding delay when the load's instruction writes a vector register of at most 128 bits, or a 256-
    /// or 512-bit one (`vectorStoreForwardDelay`; a tuple in the reference, None: no delay)
    #[serde(rename = "vectorStoreForwardDelay", default)]
    pub vector_store_forward_delay: Option<Vec<i64>>,
    /// if > 0: the value of a load whose forwarding fails is ready no earlier than this many cycles after that of the previous such
    /// load (`storeForwardFailInterval`)
    #[serde(rename = "storeForwardFailInterval", default)]
    pub store_forward_fail_interval: i64,
    /// if set: the ports of conditional and unconditional branches (their uops without a memory port), replacing those of the
    /// instruction data (`branchPorts`)
    #[serde(rename = "branchPorts", default)]
    pub branch_ports: Option<String>,
    /// AMD: if set, a fused pair whose first instruction writes a general-purpose register executes on these ports instead of the
    /// branch's (`fusedALUBranchPorts`)
    #[serde(rename = "fusedALUBranchPorts", default)]
    pub fused_alu_branch_ports: Option<String>,
    /// AMD: the branch-fusion rules for instructions with a memory operand (fusible unless RIP-relative, with an immediate and a
    /// displacement, or longer than 15 bytes with the branch; INC/DEC not with branches on CF); if false, instructions with a memory
    /// operand are not fused (`amdBranchFusionRules`)
    #[serde(rename = "amdBranchFusionRules", default)]
    pub amd_branch_fusion_rules: bool,
    /// positions in the issue (rename) group, counted from 0, in which an eliminable move is not eliminated
    /// (`moveElimBlockedSlots`; empty in data exported before the field existed)
    #[serde(rename = "moveElimBlockedSlots", default)]
    pub move_elim_blocked_slots: Vec<i64>,
    /// if true: the loop stream detector delivers a loop at most one 64-byte line per cycle: the next delivery is no earlier than one
    /// cycle per line that the bytes of the previous one touched (`lsdLineDelivery`)
    #[serde(rename = "lsdLineDelivery", default)]
    pub lsd_line_delivery: bool,
    /// scheduler queues: (ports, size); a uop that waits in the scheduler counts toward the first queue whose ports contain the port
    /// it was assigned at issue, and issue stops when a queue has no room for a full issue group (`schedulerQueues`)
    #[serde(rename = "schedulerQueues", default)]
    pub scheduler_queues: Vec<(String, i64)>,
}

impl UArchConfig {
    /// The ports of this microarchitecture (one character each), from `allPorts` in `uarch.json`.
    pub fn ports<'a>(&self, uarch: &'a UArch) -> &'a [String] {
        &uarch.all_ports[&self.name]
    }
}

/// The content of `data/uarch.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UArch {
    /// name of the instruction table (`UArchConfig::name`) -> ports
    #[serde(rename = "allPorts")]
    pub all_ports: IndexMap<String, Vec<String>>,
    /// name of the instruction table -> ports of the ALUs
    #[serde(rename = "ALUPorts")]
    pub alu_ports: IndexMap<String, Vec<String>>,
    /// configuration key (the value of `-arch`, e.g. `SKL` or `CLX_noLSD`) -> configuration; several configurations can share
    /// an instruction table (`name`)
    pub configs: IndexMap<String, UArchConfig>,
}

impl UArch {
    pub fn from_json(json: &str) -> Result<UArch, serde_json::Error> {
        serde_json::from_str(json)
    }
}
