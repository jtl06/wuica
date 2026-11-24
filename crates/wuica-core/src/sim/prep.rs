//! Static data derived from the instructions before the simulation starts: interned rename keys, uop properties with port
//! indices, the grouping of uops into fused and laminated uops (`computeUopGrouping`), and the string tests of the Python code
//! evaluated once per instruction.
//!
//! The simulation loop reads only this compact form (one small struct of plain integers per uop property and per instruction,
//! with the boolean attributes as bits), never the [`Instr`] objects, which are only used to build it and for the outputs.

use super::{FxHashMap, SFused, SLam, SUop, SimError, NO_PORT, UNSET};
use super::idx;
use crate::config::{UArch, UArchConfig};
use crate::decoded::MemAddr;
use crate::model::{Instr, InstrList, OpId, Operand, TpKey, UopProperties};
use crate::substr::has;
use crate::x64::{canonical_reg, is_gp_reg, mem_width, reg_size};

pub(crate) const NONE: u32 = u32::MAX;

/// Key of the rename dictionaries: a canonical register, a group of flags, or `None` (key 0).
pub(crate) type Key = u32;
pub(crate) const KEY_NONE: Key = 0;

pub(crate) struct KeyInfo {
    /// `key in GPRegs`
    pub is_gpr: bool,
    /// `'MM' in key`
    pub has_mm: bool,
}

pub(crate) struct Keys {
    map: FxHashMap<String, Key>,
    /// register name -> key of its canonical register (memoizes `reg`)
    reg_map: FxHashMap<String, Key>,
    pub info: Vec<KeyInfo>,
}

impl Keys {
    fn new() -> Keys {
        Keys { map: FxHashMap::default(), reg_map: FxHashMap::default(), info: vec![KeyInfo { is_gpr: false, has_mm: false }] }
    }

    fn intern(&mut self, s: &str) -> Key {
        if let Some(&k) = self.map.get(s) {
            return k;
        }
        let k = self.info.len() as Key;
        self.info.push(KeyInfo { is_gpr: is_gp_reg(s), has_mm: has(s, "MM") });
        self.map.insert(s.to_string(), k);
        k
    }

    /// the key of a name, if it has one
    pub fn lookup(&self, s: &str) -> Option<Key> {
        self.map.get(s).copied()
    }

    /// the key of `getCanonicalReg(reg)`
    fn reg(&mut self, reg: &str) -> Key {
        if let Some(&k) = self.reg_map.get(reg) {
            return k;
        }
        let k = self.intern(&canonical_reg(reg));
        self.reg_map.insert(reg.to_string(), k);
        k
    }
}

/// An address expression with the keys of its registers.
#[derive(Clone, Copy, Debug)]
pub(crate) struct MemAddrInfo {
    pub base: Option<Key>,
    pub index: Option<Key>,
    pub scale: Option<i64>,
    pub disp: Option<i64>,
}

/// `possiblePorts == [...]` tests of the port assignment
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PortList {
    Other,
    P23,
    P49,
    P78,
    P015,
}

pub(crate) struct InKey {
    pub op: OpId,
    pub is_pseudo: bool,
    pub key: Key,
}

pub(crate) struct OutKey {
    pub op: OpId,
    pub is_pseudo: bool,
    pub key: Key,
    pub is_reg: bool,
    /// `prop.latencies.get(op, 1)`
    pub lat: i64,
}

/// The attributes of a uop property ([`PropInfo::flags`]); the ones below `HAS_PORTS` are those of `UopProperties`, the
/// others combine them with attributes of the instruction.
pub(crate) mod pf {
    pub const LOAD: u32 = 1 << 0;
    pub const STORE_ADDR: u32 = 1 << 1;
    pub const STORE_DATA: u32 = 1 << 2;
    /// `isFirstUopOfInstr`
    pub const FIRST: u32 = 1 << 3;
    /// `isLastUopOfInstr`
    pub const LAST: u32 = 1 << 4;
    pub const REG_MERGE: u32 = 1 << 5;
    /// the property of a `StackSyncUop`
    pub const STACK_SYNC: u32 = 1 << 6;
    /// `possiblePorts` is not empty
    pub const HAS_PORTS: u32 = 1 << 7;
    /// `instr.isLoadSerializing`
    pub const LOAD_SERIALIZING: u32 = 1 << 8;
    /// `instr.isStoreSerializing`
    pub const STORE_SERIALIZING: u32 = 1 << 9;
    /// `instr.memRenaming`
    pub const MEM_RENAMING: u32 = 1 << 10;
    /// `instr.mayBeEliminated and not isRegMergeUop and not StackSyncUop`
    pub const ELIM_CANDIDATE: u32 = 1 << 11;
    /// `instr.uops or StackSyncUop`: renamed through its operand lists
    pub const RENAMED: u32 = 1 << 12;
    /// `isFirstUopOfInstr and instr.TP is not None`
    pub const FIRST_TP: u32 = 1 << 13;
    /// `isFirstUopOfInstr and instr.isSerializingInstr`
    pub const FIRST_SERIALIZING: u32 = 1 << 14;
    /// `isFirstUopOfInstr and instr.regMergeUopPropertiesList`
    pub const FIRST_MERGE: u32 = 1 << 15;
    /// `isLastUopOfInstr or isRegMergeUop or StackSyncUop`: the end of the renaming of an instruction
    pub const ENDS_INSTR: u32 = 1 << 16;
    /// `'M256' in instr.instrStr`
    pub const M256: u32 = 1 << 17;
    /// `FOLDED_SHIFT_RE.match(instr.instrStr)`: shifts and rotates, see `foldedShiftDelay`
    pub const FOLD_SHIFT: u32 = 1 << 18;
    pub const STORE: u32 = STORE_ADDR | STORE_DATA;
}

/// `UopProperties`, with what the simulation needs to know about its instruction
pub(crate) struct PropInfo {
    /// [`pf`] bits
    pub flags: u32,
    pub instr: u32,
    /// the ports as a mask of port indices
    pub port_mask: u32,
    /// the ports in the order of `possiblePorts` (indices into the list of all ports): `Prep::port_lists[ports_start ..
    /// ports_start + n_ports]`
    pub ports_start: u32,
    pub n_ports: u8,
    /// the first of the ports (if there is one)
    pub port0: u8,
    pub port_list: PortList,
    /// `Prep::in_key_list[in_keys.0 .. in_keys.0 + in_keys.1]`
    pub in_keys: (u32, u32),
    /// `Prep::out_key_list[out_keys.0 .. out_keys.0 + out_keys.1]`
    pub out_keys: (u32, u32),
    /// index into `blockedResources` of `instr.TPKey`
    pub tp_res: u32,
    /// `instr.TP` (if `FIRST_TP`)
    pub tp: f64,
    pub div_cycles: i64,
    pub forward_delay: i64,
    pub forward_fail_delay: i64,
    /// `memAddr`: index into `Prep::mem_addrs` or NONE
    pub mem_addr: u32,
}

impl PropInfo {
    #[inline(always)]
    pub fn has(&self, flag: u32) -> bool {
        self.flags & flag != 0
    }
}

/// `__computeAbstractValue`: what an instruction does to the abstract value of its first input register
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum AvKind {
    Copy,
    Add(i64),
    Sub(i64),
    Inc,
    Dec,
    Fresh,
}

/// The attributes of an instruction ([`InstrInfo::flags`]).
pub(crate) mod inf {
    pub const MACRO_FUSED_PREV: u32 = 1 << 0;
    pub const MACRO_FUSED_NEXT: u32 = 1 << 1;
    pub const BRANCH: u32 = 1 << 2;
    pub const JCC_ERRATUM: u32 = 1 << 3;
    pub const LCP_STALL: u32 = 1 << 4;
    pub const COMPLEX_DECODER: u32 = 1 << 5;
    /// `isLastDecodedInstr()`
    pub const LAST_DECODED: u32 = 1 << 6;
    /// `macroFusibleWith` is not empty
    pub const MACRO_FUSIBLE: u32 = 1 << 7;
    /// `canBeUsedByLSD()`
    pub const CAN_BE_USED_BY_LSD: u32 = 1 << 8;
    /// `getDSBBlocks`: the immediate requires an extra entry
    pub const DSB_EXTRA_ENTRY: u32 = 1 << 9;
    /// the instruction string is in the list of `latReducedDueToFastPtrChasing`
    pub const FAST_PTR_CHASING_SOURCE: u32 = 1 << 10;
    /// `'I64' in instrStr`
    pub const I64: u32 = 1 << 11;
    /// `instr.uops == 0`
    pub const NO_UOPS: u32 = 1 << 12;
    /// `getRegSize(outputRegOperands[0].reg) == 32`
    pub const OUT_REG0_IS_32: u32 = 1 << 13;
    /// an explicit input or address register is RSP
    pub const READS_RSP_EXPLICITLY: u32 = 1 << 14;
    pub const WRITES_RSP: u32 = 1 << 15;
    pub const HAS_INPUT_MEM: u32 = 1 << 16;
    pub const HAS_OUTPUT_MEM: u32 = 1 << 17;
    /// `vectorDomain(instrStr)` (see `domainBypassDelay`): 'int', 'fp' or 'xlane' (none of them: no domain)
    pub const DOMAIN_INT: u32 = 1 << 18;
    pub const DOMAIN_FP: u32 = 1 << 19;
    pub const DOMAIN_XLANE: u32 = 1 << 20;
    pub const DOMAINS: u32 = DOMAIN_INT | DOMAIN_FP | DOMAIN_XLANE;
}

/// `vectorDomain`: the domain of a vector instruction for the bypass delay (`domainBypassDelay`): XLANE for VPERM2I128/VPERM2F128,
/// INT for vector integer instructions (P..., VP...), FP for floating-point operations (...PS/PD/SS/SD, FMA); 0 for others (moves,
/// broadcasts, extracts, inserts, conversions, and instructions without XMM/YMM operands)
pub(crate) fn vector_domain(instr_str: &str) -> u32 {
    if !(has(instr_str, "XMM") || has(instr_str, "YMM")) {
        return 0;
    }
    let m = instr_str.split(' ').next().unwrap_or("");
    let m = m.strip_prefix('V').unwrap_or(m);
    if ["MOV", "BROADCAST", "EXTRACT", "INSERT", "CVT"].iter().any(|p| m.starts_with(p)) {
        0
    } else if m.starts_with("PERM2") {
        inf::DOMAIN_XLANE
    } else if m.starts_with('P') {
        inf::DOMAIN_INT
    } else if ["PS", "PD", "SS", "SD"].iter().any(|s| m.ends_with(s)) || ["FMADD", "FMSUB", "FNMADD", "FNMSUB"].iter().any(|p| m.starts_with(p)) {
        inf::DOMAIN_FP
    } else {
        0
    }
}

pub(crate) struct InstrInfo {
    /// [`inf`] bits
    pub flags: u32,
    /// length in bytes
    pub len: i64,
    pub uops_mite: i64,
    pub uops_ms: i64,
    pub pos_nominal_opcode: i64,
    pub op_cache_fields: i64,
    pub n_available_simple_decoders: Option<i64>,
    pub implicit_rsp_change: i64,
    pub first_prop: u32,
    pub n_props: u32,
    pub first_merge_prop: u32,
    pub n_merge_props: u32,
    pub stack_sync_prop: u32,
    /// the grouping of the uops (`computeUopGrouping`): the numbers of fused-domain uops of the laminated-domain uops are
    /// `Prep::group_lams[grouping.0 .. grouping.0 + grouping.1]`; the numbers of uops of the fused-domain uops are at
    /// `Prep::group_fused[grouping.2 ..]`
    pub grouping: (u32, u32, u32),
    /// the uops, fused uops and laminated uops of a new instance (`Prep::tmpl_*`): start indices and counts
    pub tmpl_uops: (u32, u32),
    pub tmpl_fused: (u32, u32),
    pub tmpl_lams: (u32, u32),
    /// key of `inputRegOperands[0]`
    pub in_reg0: Option<Key>,
    /// (key, `getRegSize`) of `outputRegOperands`: `Prep::out_reg_list[out_regs.0 .. out_regs.0 + out_regs.1]`
    pub out_regs: (u32, u32),
    /// keys of `inputRegOperands`: `Prep::in_reg_list[in_regs.0 .. in_regs.0 + in_regs.1]`
    pub in_regs: (u32, u32),
    pub folded_input_reg: Option<Key>,
    pub mem_width: Option<i64>,
    pub mov_store_width: Option<i64>,
    pub mov_load_width: Option<i64>,
    /// `inputMemOperands[0].memAddr`: index into `Prep::mem_addrs` or NONE
    pub in_mem0: u32,
    pub av_kind: AvKind,
    /// `getDSBBlocks`
    pub dsb_required_entries: i64,
}

impl InstrInfo {
    #[inline(always)]
    pub fn has(&self, flag: u32) -> bool {
        self.flags & flag != 0
    }
}

/// `possiblePorts == [...]` tests
fn port_list_of<S: AsRef<str>>(names: &[S]) -> PortList {
    let eq = |l: &[&str]| names.len() == l.len() && names.iter().zip(l).all(|(a, b)| a.as_ref() == *b);
    if eq(&["2", "3"]) {
        PortList::P23
    } else if eq(&["4", "9"]) {
        PortList::P49
    } else if eq(&["7", "8"]) {
        PortList::P78
    } else if eq(&["0", "1", "5"]) {
        PortList::P015
    } else {
        PortList::Other
    }
}

pub(crate) struct Prep {
    /// see `InstrInfo::grouping`
    pub group_lams: Vec<u32>,
    pub group_fused: Vec<u32>,
    /// the lists of ports, input keys and output keys of the uop properties (see `PropInfo`)
    pub port_lists: Vec<u8>,
    pub in_key_list: Vec<InKey>,
    pub out_key_list: Vec<OutKey>,
    /// see `InstrInfo::out_regs` and `InstrInfo::in_regs`
    pub out_reg_list: Vec<(Key, i64)>,
    pub in_reg_list: Vec<Key>,
    /// the address expressions of the uop properties and instructions
    pub mem_addrs: Vec<MemAddrInfo>,
    pub keys: Keys,
    pub props: Vec<PropInfo>,
    pub info: Vec<InstrInfo>,
    /// the ports as characters
    pub ports: Vec<u8>,
    /// character -> index into `ports`
    pub port_idx: [u8; 256],
    /// `int(port, 16)` (-1 for ports that are not hex digits)
    pub port_hex: Vec<i64>,
    pub n_resources: usize,
    /// templates for the uops of a new instruction instance: indices are relative to the first uop / fused uop / laminated
    /// uop of the instance; `instr_instance` is not set
    pub tmpl_uops: Vec<SUop>,
    pub tmpl_fused: Vec<SFused>,
    pub tmpl_lams: Vec<SLam>,
}

fn mem_addr_info(keys: &mut Keys, m: &MemAddr) -> MemAddrInfo {
    MemAddrInfo {
        base: m.base.as_deref().map(|r| keys.reg(r)),
        index: m.index.as_deref().map(|r| keys.reg(r)),
        scale: m.scale,
        disp: m.disp,
    }
}

fn invalid(msg: impl Into<String>) -> SimError {
    SimError::InvalidInput(msg.into())
}

/// `computeUopGrouping`. The uops of a fused-domain uop and the fused-domain uops of a laminated-domain uop are consecutive, so
/// the grouping is described by sizes: appends the number of uops of each fused-domain uop to `fused_sizes`, and the number of
/// fused-domain uops of each laminated-domain uop to `lam_sizes`.
fn compute_uop_grouping(instr: &Instr, props: &[UopProperties], config: &UArchConfig, fused_sizes: &mut Vec<u32>, lam_sizes: &mut Vec<u32>) {
    let is_fusible = |p: &UopProperties| match &p.possible_ports {
        Some(ports) => ports.iter().any(|p| config.fusible_ports.contains(p.as_str())),
        None => false,
    };
    let n = props.len();
    // the fused-domain uops: (first uop, number of uops)
    let mut fused: Vec<(usize, usize)> = Vec::new();
    let mut next = 0; // the front of `unfusedDomainUops`
    for i in 0..(instr.retire_slots - 1).max(0) {
        if next == n {
            break;
        }
        let uop = next;
        next += 1;
        if is_fusible(&props[uop]) && (n - next) as i64 >= instr.retire_slots - i {
            next += 1;
            fused.push((uop, 2));
        } else {
            fused.push((uop, 1));
        }
    }
    fused.push((next, n - next));

    let n_laminated = (instr.uops_mite + instr.uops_ms).min(fused.len() as i64);
    let mut pos = 0; // the front of `fusedDomainUops`
    for i in 0..(n_laminated - 1).max(0) {
        let f = fused[pos];
        pos += 1;
        if f.1 == 1 && is_fusible(&props[f.0]) && (fused.len() - pos) as i64 >= n_laminated - i {
            pos += 1;
            lam_sizes.push(2);
        } else {
            lam_sizes.push(1);
        }
    }
    lam_sizes.push((fused.len() - pos) as u32);
    fused_sizes.extend(fused.iter().map(|f| f.1 as u32));
}

/// the [`pf`] bits of a property that come from its instruction
fn instr_prop_flags(instr: &Instr, flags: u32) -> u32 {
    let mut f = flags;
    let first = flags & pf::FIRST != 0;
    if instr.is_load_serializing {
        f |= pf::LOAD_SERIALIZING;
    }
    if instr.is_store_serializing {
        f |= pf::STORE_SERIALIZING;
    }
    if instr.mem_renaming {
        f |= pf::MEM_RENAMING;
    }
    if instr.may_be_eliminated && flags & (pf::REG_MERGE | pf::STACK_SYNC) == 0 {
        f |= pf::ELIM_CANDIDATE;
    }
    if instr.uops != 0 || flags & pf::STACK_SYNC != 0 {
        f |= pf::RENAMED;
    }
    if first && instr.tp.is_some() {
        f |= pf::FIRST_TP;
    }
    if first && instr.is_serializing_instr {
        f |= pf::FIRST_SERIALIZING;
    }
    if first && !instr.reg_merge_uop_properties_list.is_empty() {
        f |= pf::FIRST_MERGE;
    }
    if flags & (pf::LAST | pf::REG_MERGE | pf::STACK_SYNC) != 0 {
        f |= pf::ENDS_INSTR;
    }
    if has(&instr.instr_str, "M256") {
        f |= pf::M256;
    }
    if is_folded_shift(&instr.instr_str) {
        f |= pf::FOLD_SHIFT;
    }
    f
}

/// the first word of a uops.info string ends with ' ' or '_' (e.g. 'SHL (R64, I8)', 'SHL_D1 (R64, 1)')
fn mnemonic_is(s: &str, m: &str) -> bool {
    s.strip_prefix(m).map_or(false, |r| r.starts_with(' ') || r.starts_with('_'))
}

/// `re.match(r'^(SHL|SHR|SAR|SAL|ROL|ROR|SHLX|SHRX|SARX|RORX)[ _]', instrStr)`
fn is_folded_shift(s: &str) -> bool {
    ["SHL", "SHR", "SAR", "SAL", "ROL", "ROR", "SHLX", "SHRX", "SARX", "RORX"].iter().any(|m| mnemonic_is(s, m))
}

impl Prep {
    /// a new `Uop(prop, instrI)` (without `instr_instance`)
    pub fn new_uop(&self, prop: u32) -> SUop {
        SUop {
            prop,
            instr_instance: NONE,
            fused_uop: NONE,
            ren: 0,
            store_buffer_entry: NONE,
            n_in: 0,
            n_out: 0,
            actual_port: NO_PORT,
            eliminated: false,
            mem_renaming_blocked: false,
            forward_fails: false,
            lat_reduced_due_to_fast_ptr_chasing: false,
            folded_in: 0,
            ready_for_dispatch: UNSET,
            dispatched: UNSET,
            executed: f64::NAN,
        }
    }

    /// the templates of the uops of an instance (the structure that `InstrInstance.__init__` creates)
    fn build_templates(&mut self) {
        for ii in 0..self.info.len() {
            let (first_prop, n_props) = (self.info[ii].first_prop, self.info[ii].n_props);
            let (u0, f0, l0) = (idx(self.tmpl_uops.len()), idx(self.tmpl_fused.len()), idx(self.tmpl_lams.len()));
            for p in first_prop..first_prop + n_props {
                let u = self.new_uop(p);
                self.tmpl_uops.push(u);
            }
            let mut uop = 0u32;
            let mut n_fused_total = 0u32;
            let mut n_lams = 0u32;
            let (lam_start, n_lam_groups, fused_start) = self.info[ii].grouping;
            let mut next_fused = fused_start as usize;
            for lg in lam_start..lam_start + n_lam_groups {
                let n_fused_in_lam = self.group_lams[lg as usize] as usize;
                let lam_group = &self.group_fused[next_fused..next_fused + n_fused_in_lam];
                next_fused += n_fused_in_lam;
                let lam = n_lams;
                let first_fused = n_fused_total;
                let lam_first_uop = uop;
                for &n in lam_group {
                    let fused = n_fused_total;
                    self.tmpl_fused.push(SFused { first_uop: uop, n_uops: n, laminated_uop: lam, issued: UNSET, retired: UNSET, retire_idx: UNSET });
                    for u in uop..uop + n {
                        self.tmpl_uops[(u0 + u) as usize].fused_uop = fused;
                    }
                    uop += n;
                    n_fused_total += 1;
                }
                self.tmpl_lams.push(SLam {
                    first_fused_uop: first_fused,
                    n_fused_uops: idx(lam_group.len()),
                    first_uop: lam_first_uop,
                    n_uops: uop - lam_first_uop,
                    added_to_idq: UNSET,
                    uop_source: None,
                });
                n_lams += 1;
            }
            let info = &mut self.info[ii];
            info.tmpl_uops = (u0, n_props);
            info.tmpl_fused = (f0, n_fused_total);
            info.tmpl_lams = (l0, n_lams);
        }
    }

    /// (number of uops, number of output operands) of the uops of one round (without merge and stack-sync uops); a hint for
    /// the capacity of arrays
    pub fn props_per_round(&self) -> (usize, usize) {
        let mut n_uops = 0;
        let mut n_ops = 0;
        for info in &self.info {
            n_uops += info.n_props as usize;
            for p in &self.props[info.first_prop as usize..(info.first_prop + info.n_props) as usize] {
                n_ops += (p.out_keys.1 as usize).max(1);
            }
        }
        (n_uops.max(1), n_ops.max(1))
    }

    /// the address expression `i` (an index from `PropInfo::mem_addr` or `InstrInfo::in_mem0`), if it is not NONE
    #[inline]
    pub fn mem_addr(&self, i: u32) -> Option<&MemAddrInfo> {
        self.mem_addrs.get(i as usize)
    }

    pub fn new(list: &InstrList, config: &UArchConfig, uarch: &UArch) -> Result<Prep, SimError> {
        let all_ports = uarch.all_ports.get(&config.name).ok_or_else(|| invalid("no ports for this configuration"))?;
        let alu_ports = uarch.alu_ports.get(&config.name).ok_or_else(|| invalid("no ALU ports for this configuration"))?;
        let mut ports = Vec::new();
        let mut port_idx = [u8::MAX; 256];
        let mut port_hex = Vec::new();
        for (i, p) in all_ports.iter().enumerate() {
            if p.len() != 1 || i >= 32 {
                return Err(invalid("port names must be single characters"));
            }
            let c = p.as_bytes()[0];
            ports.push(c);
            port_idx[c as usize] = i as u8;
            port_hex.push((c as char).to_digit(16).map_or(-1, |d| d as i64));
        }
        let port_of = |p: &str| -> Result<u8, SimError> {
            let i = if p.len() == 1 { port_idx[p.as_bytes()[0] as usize] } else { u8::MAX };
            if i == u8::MAX {
                Err(invalid(format!("unknown port {p}")))
            } else {
                Ok(i)
            }
        };

        let mut keys = Keys::new();
        let rsp = keys.intern("RSP");
        let mut props: Vec<PropInfo> = Vec::new();
        let mut info = Vec::new();
        // blockedResources: 'div', 'port' + p, and the TP keys
        let mut tp_res: FxHashMap<&TpKey, usize> = FxHashMap::default();
        let mut n_resources = 1 + ports.len();

        let mut port_lists: Vec<u8> = Vec::new();
        let mut group_lams: Vec<u32> = Vec::new();
        let mut group_fused: Vec<u32> = Vec::new();
        let mut in_key_list: Vec<InKey> = Vec::new();
        let mut out_key_list: Vec<OutKey> = Vec::new();
        let mut out_reg_list: Vec<(Key, i64)> = Vec::new();
        let mut in_reg_list: Vec<Key> = Vec::new();
        let mut mem_addrs: Vec<MemAddrInfo> = Vec::new();
        #[allow(clippy::too_many_arguments)]
        let convert = |p: &UopProperties,
                       instr: &Instr,
                       ii: u32,
                       res: usize,
                       keys: &mut Keys,
                       port_lists: &mut Vec<u8>,
                       in_key_list: &mut Vec<InKey>,
                       out_key_list: &mut Vec<OutKey>,
                       mem_addrs: &mut Vec<MemAddrInfo>|
         -> Result<PropInfo, SimError> {
            let ports_start = idx(port_lists.len());
            let mut mask = 0u32;
            for port in p.possible_ports.iter().flatten() {
                let i = port_of(port)?;
                port_lists.push(i);
                mask |= 1 << i;
            }
            let n_ports = idx(port_lists.len()) - ports_start;
            if n_ports > u8::MAX as u32 {
                return Err(invalid("too many ports"));
            }
            let port0 = if n_ports > 0 { port_lists[ports_start as usize] } else { 0 };
            let port_list = port_list_of(p.possible_ports.as_deref().unwrap_or(&[]));
            let mut key_of = |op: OpId| -> Result<(bool, Key, bool), SimError> {
                match list.operands.get(op as usize) {
                    Some(Operand::Reg { reg, .. }) => Ok((false, keys.reg(reg), true)),
                    Some(Operand::Flag { flags }) => Ok((false, keys.intern(flags), false)),
                    Some(Operand::Mem { .. }) => Ok((false, KEY_NONE, false)),
                    Some(Operand::Pseudo) => Ok((true, KEY_NONE, false)),
                    None => Err(invalid("operand index out of range")),
                }
            };
            // (the numbers of renamed operands of a uop are stored as u16; a uop of an instruction with many load uops, e.g. WBINVD,
            // has one input operand per load uop, more than 255 on some CPUs; no instruction in the tables has 65535 uops)
            if p.input_operands.len() > u16::MAX as usize || p.output_operands.len() > u16::MAX as usize {
                return Err(invalid("too many operands"));
            }
            let in_start = idx(in_key_list.len());
            for &op in &p.input_operands {
                let (is_pseudo, key, _) = key_of(op)?;
                in_key_list.push(InKey { op, is_pseudo, key });
            }
            let out_start = idx(out_key_list.len());
            for &op in &p.output_operands {
                let (is_pseudo, key, is_reg) = key_of(op)?;
                let lat = p.latencies.iter().find(|(o, _)| *o == op).map_or(1, |(_, l)| *l);
                out_key_list.push(OutKey { op, is_pseudo, key, is_reg, lat });
            }
            let mem_addr = match &p.mem_addr {
                Some(m) => {
                    mem_addrs.push(mem_addr_info(keys, m));
                    idx(mem_addrs.len()) - 1
                }
                None => NONE,
            };
            let mut flags = 0;
            for (b, f) in [
                (p.is_load_uop, pf::LOAD),
                (p.is_store_address_uop, pf::STORE_ADDR),
                (p.is_store_data_uop, pf::STORE_DATA),
                (p.is_first_uop_of_instr, pf::FIRST),
                (p.is_last_uop_of_instr, pf::LAST),
                (p.is_reg_merge_uop, pf::REG_MERGE),
                (n_ports > 0, pf::HAS_PORTS),
            ] {
                if b {
                    flags |= f;
                }
            }
            Ok(PropInfo {
                flags: instr_prop_flags(instr, flags),
                instr: ii,
                port_mask: mask,
                ports_start,
                n_ports: n_ports as u8,
                port0,
                port_list,
                in_keys: (in_start, idx(in_key_list.len()) - in_start),
                out_keys: (out_start, idx(out_key_list.len()) - out_start),
                tp_res: res as u32,
                tp: instr.tp.unwrap_or(0.0),
                div_cycles: p.div_cycles,
                forward_delay: p.forward_delay,
                forward_fail_delay: p.forward_fail_delay,
                mem_addr,
            })
        };

        // the properties of stack-sync uops: UopProperties(instr, ALUPorts, [RSP], [RSP], {RSP: 1}, isFirstUopOfInstr=True)
        let alu_ports_start = idx(port_lists.len());
        let mut alu_mask = 0;
        for p in alu_ports {
            let i = port_of(p)?;
            port_lists.push(i);
            alu_mask |= 1 << i;
        }
        let n_alu_ports = idx(port_lists.len()) - alu_ports_start;
        if n_alu_ports > u8::MAX as u32 {
            return Err(invalid("too many ports"));
        }
        let alu_port0 = if n_alu_ports > 0 { port_lists[alu_ports_start as usize] } else { 0 };
        let alu_port_list = port_list_of(alu_ports);
        let rsp_in = idx(in_key_list.len());
        in_key_list.push(InKey { op: NONE, is_pseudo: false, key: rsp });
        let rsp_out = idx(out_key_list.len());
        out_key_list.push(OutKey { op: NONE, is_pseudo: false, key: rsp, is_reg: true, lat: 1 });

        for (ii, instr) in list.instrs.iter().enumerate() {
            let n = tp_res.len();
            let res = *tp_res.entry(&instr.tp_key).or_insert(1 + ports.len() + n);
            n_resources = n_resources.max(res + 1);

            let first_prop = idx(props.len());
            for p in &instr.uop_properties_list {
                props.push(convert(p, instr, ii as u32, res, &mut keys, &mut port_lists, &mut in_key_list, &mut out_key_list, &mut mem_addrs)?);
            }
            let first_merge_prop = idx(props.len());
            for p in &instr.reg_merge_uop_properties_list {
                props.push(convert(p, instr, ii as u32, res, &mut keys, &mut port_lists, &mut in_key_list, &mut out_key_list, &mut mem_addrs)?);
            }
            let stack_sync_prop = idx(props.len());
            let mut ss_flags = pf::FIRST | pf::STACK_SYNC;
            if n_alu_ports > 0 {
                ss_flags |= pf::HAS_PORTS;
            }
            props.push(PropInfo {
                flags: instr_prop_flags(instr, ss_flags),
                instr: ii as u32,
                port_mask: alu_mask,
                ports_start: alu_ports_start,
                n_ports: n_alu_ports as u8,
                port0: alu_port0,
                port_list: alu_port_list,
                in_keys: (rsp_in, 1),
                out_keys: (rsp_out, 1),
                tp_res: res as u32,
                tp: instr.tp.unwrap_or(0.0),
                div_cycles: 0,
                forward_delay: 0,
                forward_fail_delay: 0,
                mem_addr: NONE,
            });

            let (lam_start, fused_start) = (idx(group_lams.len()), idx(group_fused.len()));
            if !instr.uop_properties_list.is_empty() {
                compute_uop_grouping(instr, &instr.uop_properties_list, config, &mut group_fused, &mut group_lams);
            }
            let grouping = (lam_start, idx(group_lams.len()) - lam_start, fused_start);

            let mut regs = |ops: &[OpId]| -> Result<Vec<(Key, i64, bool, bool)>, SimError> {
                ops.iter()
                    .map(|&op| match list.operands.get(op as usize) {
                        Some(Operand::Reg { reg, is_implicit_stack_operand }) => {
                            let k = keys.reg(reg);
                            Ok((k, reg_size(reg), *is_implicit_stack_operand, crate::x64::is_high8_reg(reg)))
                        }
                        _ => Err(invalid("register operand expected")),
                    })
                    .collect()
            };
            let in_regs = regs(&instr.input_reg_operands)?;
            let out_regs = regs(&instr.output_reg_operands)?;
            let addr_regs = regs(&instr.mem_addr_operands)?;
            let s = instr.instr_str.as_str();
            let av_kind = if has(s, "MOV") && !has(s, "CMOV") {
                AvKind::Copy
            } else if has(s, "ADD") && instr.immediate.is_some() {
                AvKind::Add(instr.immediate.unwrap())
            } else if has(s, "SUB") && instr.immediate.is_some() {
                AvKind::Sub(instr.immediate.unwrap())
            } else if has(s, "INC") {
                AvKind::Inc
            } else if has(s, "DEC") {
                AvKind::Dec
            } else {
                AvKind::Fresh
            };
            // movWidth: re.match(r'MOV \(M(32|64), R(32|64)\)') with equal widths
            let mov_store_width = if s.starts_with("MOV (M32, R32)") {
                Some(32)
            } else if s.starts_with("MOV (M64, R64)") {
                Some(64)
            } else {
                None
            };
            let mov_load_width = if s.starts_with("MOV (R32, M32)") {
                Some(32)
            } else if s.starts_with("MOV (R64, M64)") {
                Some(64)
            } else {
                None
            };
            let in_mem0 = match instr.input_mem_operands.first().map(|&op| list.operands.get(op as usize)) {
                Some(Some(Operand::Mem { mem_addr })) => {
                    mem_addrs.push(mem_addr_info(&mut keys, mem_addr));
                    idx(mem_addrs.len()) - 1
                }
                Some(_) => return Err(invalid("memory operand expected")),
                None => NONE,
            };
            let requires_extra_entry = match instr.immediate {
                Some(imm) => {
                    !(-(1i64 << 31)..(1i64 << 31)).contains(&imm)
                        || (!(-(1i64 << 15)..(1i64 << 15)).contains(&imm) && !instr.mem_addr_operands.is_empty())
                }
                None => false,
            };
            let mut flags = 0;
            for (b, f) in [
                (instr.macro_fused_with_prev_instr, inf::MACRO_FUSED_PREV),
                (instr.macro_fused_with_next_instr, inf::MACRO_FUSED_NEXT),
                (instr.is_branch_instr, inf::BRANCH),
                (instr.cannot_be_in_dsb_due_to_jcc_erratum, inf::JCC_ERRATUM),
                (instr.lcp_stall, inf::LCP_STALL),
                (instr.complex_decoder, inf::COMPLEX_DECODER),
                (instr.is_last_decoded_instr(), inf::LAST_DECODED),
                (!instr.macro_fusible_with.is_empty(), inf::MACRO_FUSIBLE),
                (!(instr.uops_ms != 0 || instr.implicit_rsp_change != 0 || out_regs.iter().any(|r| r.3)), inf::CAN_BE_USED_BY_LSD),
                (requires_extra_entry, inf::DSB_EXTRA_ENTRY),
                (
                    ["MOV (R64, M64)", "MOV (RAX, M64)", "MOV (R32, M32)", "MOV (EAX, M32)", "MOVSXD (R64, M32)", "POP (R64)"].contains(&s),
                    inf::FAST_PTR_CHASING_SOURCE,
                ),
                (has(s, "I64"), inf::I64),
                (instr.uops == 0, inf::NO_UOPS),
                (out_regs.first().is_some_and(|r| r.1 == 32), inf::OUT_REG0_IS_32),
                (in_regs.iter().chain(addr_regs.iter()).any(|r| r.0 == rsp && !r.2), inf::READS_RSP_EXPLICITLY),
                (out_regs.iter().any(|r| r.0 == rsp), inf::WRITES_RSP),
                (!instr.input_mem_operands.is_empty(), inf::HAS_INPUT_MEM),
                (!instr.output_mem_operands.is_empty(), inf::HAS_OUTPUT_MEM),
            ] {
                if b {
                    flags |= f;
                }
            }
            flags |= vector_domain(s);
            let out_regs_start = idx(out_reg_list.len());
            out_reg_list.extend(out_regs.iter().map(|r| (r.0, r.1)));
            let in_regs_start = idx(in_reg_list.len());
            in_reg_list.extend(in_regs.iter().map(|r| r.0));
            info.push(InstrInfo {
                flags,
                len: (instr.opcode.len() / 2) as i64,
                uops_mite: instr.uops_mite,
                uops_ms: instr.uops_ms,
                pos_nominal_opcode: instr.pos_nominal_opcode,
                op_cache_fields: instr.op_cache_fields,
                n_available_simple_decoders: instr.n_available_simple_decoders,
                implicit_rsp_change: instr.implicit_rsp_change,
                first_prop,
                n_props: idx(instr.uop_properties_list.len()),
                first_merge_prop,
                n_merge_props: idx(instr.reg_merge_uop_properties_list.len()),
                stack_sync_prop,
                grouping,
                tmpl_uops: (0, 0),
                tmpl_fused: (0, 0),
                tmpl_lams: (0, 0),
                in_reg0: in_regs.first().map(|r| r.0),
                out_regs: (out_regs_start, idx(out_regs.len())),
                in_regs: (in_regs_start, idx(in_regs.len())),
                folded_input_reg: instr.folded_input_reg.as_deref().map(|r| keys.intern(r)),
                mem_width: mem_width(s),
                mov_store_width,
                mov_load_width,
                in_mem0,
                av_kind,
                dsb_required_entries: instr.uops_mite.max(1),
            });
        }
        let mut prep = Prep {
            group_lams,
            group_fused,
            port_lists,
            in_key_list,
            out_key_list,
            out_reg_list,
            in_reg_list,
            mem_addrs,
            keys,
            props,
            info,
            ports,
            port_idx,
            port_hex,
            n_resources,
            tmpl_uops: Vec::new(),
            tmpl_fused: Vec::new(),
            tmpl_lams: Vec::new(),
        };
        prep.build_templates();
        Ok(prep)
    }
}
