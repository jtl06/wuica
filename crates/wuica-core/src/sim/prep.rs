//! Static data derived from the instructions before the simulation starts: interned rename keys, uop properties with port
//! indices, the grouping of uops into fused and laminated uops (`computeUopGrouping`), and the string tests of the Python code
//! evaluated once per instruction.

use super::{FusedUop, FxHashMap, LaminatedUop, SimError, Uop};
use crate::config::{UArch, UArchConfig};
use crate::decoded::MemAddr;
use crate::model::{Instr, InstrList, OpId, Operand, TpKey, UopProperties};
use crate::x64::{canonical_reg, is_gp_reg, mem_width, reg_size};
use std::collections::HashMap;

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
        self.info.push(KeyInfo { is_gpr: is_gp_reg(s), has_mm: s.contains("MM") });
        self.map.insert(s.to_string(), k);
        k
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

/// `UopProperties`
pub(crate) struct PropInfo {
    pub instr: u32,
    /// the ports (indices into the list of all ports, in the order of `possiblePorts`): `Prep::port_lists[ports.0 ..
    /// ports.0 + ports.1]`
    pub ports: (u32, u32),
    /// the first of `ports` (if there is one)
    pub port0: u8,
    pub port_mask: u32,
    pub port_list: PortList,
    /// `Prep::in_key_list[in_keys.0 .. in_keys.0 + in_keys.1]`
    pub in_keys: (u32, u32),
    /// `Prep::out_key_list[out_keys.0 .. out_keys.0 + out_keys.1]`
    pub out_keys: (u32, u32),
    pub div_cycles: i64,
    pub is_load: bool,
    pub forward_delay: i64,
    pub forward_fail_delay: i64,
    pub is_store_addr: bool,
    pub mem_addr: Option<MemAddrInfo>,
    pub is_store_data: bool,
    pub is_first: bool,
    pub is_last: bool,
    pub is_reg_merge: bool,
    pub is_stack_sync: bool,
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

pub(crate) struct InstrInfo {
    /// length in bytes
    pub len: i64,
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
    /// (key, `getRegSize`) of `outputRegOperands`
    pub out_regs: Vec<(Key, i64)>,
    /// `getRegSize(outputRegOperands[0].reg) == 32`
    pub out_reg0_is_32: bool,
    /// keys of `inputRegOperands`
    pub in_regs: Vec<Key>,
    pub folded_input_reg: Option<Key>,
    pub mem_width: Option<i64>,
    pub mov_store_width: Option<i64>,
    pub mov_load_width: Option<i64>,
    pub has_input_mem: bool,
    pub has_output_mem: bool,
    /// `inputMemOperands[0].memAddr`
    pub in_mem0: Option<MemAddrInfo>,
    pub av_kind: AvKind,
    /// an explicit input or address register is RSP
    pub reads_rsp_explicitly: bool,
    pub writes_rsp: bool,
    pub can_be_used_by_lsd: bool,
    pub is_last_decoded: bool,
    /// the instruction string is in the list of `latReducedDueToFastPtrChasing`
    pub fast_ptr_chasing_source: bool,
    pub has_m256: bool,
    pub has_i64: bool,
    /// index into `blockedResources` of `TPKey`
    pub tp_res: usize,
    pub has_macro_fusible: bool,
    /// `getDSBBlocks`
    pub dsb_required_entries: i64,
    pub dsb_requires_extra_entry: bool,
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
    pub tmpl_uops: Vec<Uop>,
    pub tmpl_fused: Vec<FusedUop>,
    pub tmpl_lams: Vec<LaminatedUop>,
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

impl Prep {
    /// a new `Uop(prop, instrI)` (without `instr_instance`)
    pub fn new_uop(&self, prop: u32) -> Uop {
        let p = &self.props[prop as usize];
        Uop {
            prop,
            instr_instance: NONE,
            fused_uop: NONE,
            actual_port: None,
            eliminated: false,
            ren_in: (0, 0),
            ren_out: (0, 0),
            store_buffer_entry: NONE,
            mem_renaming_blocked: false,
            forward_fails: false,
            lat_reduced_due_to_fast_ptr_chasing: false,
            ready_for_dispatch: None,
            dispatched: None,
            executed: None,
            div_cycles: p.div_cycles,
            is_stack_sync_uop: p.is_stack_sync,
            is_reg_merge_uop: p.is_reg_merge,
        }
    }

    /// the templates of the uops of an instance (the structure that `InstrInstance.__init__` creates)
    fn build_templates(&mut self) {
        for ii in 0..self.info.len() {
            let (first_prop, n_props) = (self.info[ii].first_prop, self.info[ii].n_props);
            let (u0, f0, l0) = (self.tmpl_uops.len() as u32, self.tmpl_fused.len() as u32, self.tmpl_lams.len() as u32);
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
                    self.tmpl_fused.push(FusedUop { first_uop: uop, n_uops: n, laminated_uop: lam, issued: None, retired: None, retire_idx: None });
                    for u in uop..uop + n {
                        self.tmpl_uops[(u0 + u) as usize].fused_uop = fused;
                    }
                    uop += n;
                    n_fused_total += 1;
                }
                self.tmpl_lams.push(LaminatedUop {
                    first_fused_uop: first_fused,
                    n_fused_uops: lam_group.len() as u32,
                    first_uop: lam_first_uop,
                    n_uops: uop - lam_first_uop,
                    added_to_idq: None,
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
        let mut tp_res: HashMap<&TpKey, usize> = HashMap::new();
        let mut n_resources = 1 + ports.len();

        let mut port_lists: Vec<u8> = Vec::new();
        let mut group_lams: Vec<u32> = Vec::new();
        let mut group_fused: Vec<u32> = Vec::new();
        let mut in_key_list: Vec<InKey> = Vec::new();
        let mut out_key_list: Vec<OutKey> = Vec::new();
        let convert = |p: &UopProperties,
                       instr: u32,
                       keys: &mut Keys,
                       port_lists: &mut Vec<u8>,
                       in_key_list: &mut Vec<InKey>,
                       out_key_list: &mut Vec<OutKey>|
         -> Result<PropInfo, SimError> {
            let ports_start = port_lists.len() as u32;
            let mut mask = 0u32;
            for port in p.possible_ports.iter().flatten() {
                let i = port_of(port)?;
                port_lists.push(i);
                mask |= 1 << i;
            }
            let n_ports = port_lists.len() as u32 - ports_start;
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
            let in_start = in_key_list.len() as u32;
            for &op in &p.input_operands {
                let (is_pseudo, key, _) = key_of(op)?;
                in_key_list.push(InKey { op, is_pseudo, key });
            }
            let out_start = out_key_list.len() as u32;
            for &op in &p.output_operands {
                let (is_pseudo, key, is_reg) = key_of(op)?;
                let lat = p.latencies.iter().find(|(o, _)| *o == op).map_or(1, |(_, l)| *l);
                out_key_list.push(OutKey { op, is_pseudo, key, is_reg, lat });
            }
            Ok(PropInfo {
                instr,
                ports: (ports_start, n_ports),
                port0,
                port_mask: mask,
                port_list,
                in_keys: (in_start, in_key_list.len() as u32 - in_start),
                out_keys: (out_start, out_key_list.len() as u32 - out_start),
                div_cycles: p.div_cycles,
                is_load: p.is_load_uop,
                forward_delay: p.forward_delay,
                forward_fail_delay: p.forward_fail_delay,
                is_store_addr: p.is_store_address_uop,
                mem_addr: p.mem_addr.as_ref().map(|m| mem_addr_info(keys, m)),
                is_store_data: p.is_store_data_uop,
                is_first: p.is_first_uop_of_instr,
                is_last: p.is_last_uop_of_instr,
                is_reg_merge: p.is_reg_merge_uop,
                is_stack_sync: false,
            })
        };

        // the properties of stack-sync uops: UopProperties(instr, ALUPorts, [RSP], [RSP], {RSP: 1}, isFirstUopOfInstr=True)
        let alu_ports_start = port_lists.len() as u32;
        let mut alu_mask = 0;
        for p in alu_ports {
            let i = port_of(p)?;
            port_lists.push(i);
            alu_mask |= 1 << i;
        }
        let n_alu_ports = port_lists.len() as u32 - alu_ports_start;
        let alu_port0 = if n_alu_ports > 0 { port_lists[alu_ports_start as usize] } else { 0 };
        let alu_port_list = port_list_of(alu_ports);
        let rsp_in = in_key_list.len() as u32;
        in_key_list.push(InKey { op: NONE, is_pseudo: false, key: rsp });
        let rsp_out = out_key_list.len() as u32;
        out_key_list.push(OutKey { op: NONE, is_pseudo: false, key: rsp, is_reg: true, lat: 1 });

        for (ii, instr) in list.instrs.iter().enumerate() {
            let first_prop = props.len() as u32;
            for p in &instr.uop_properties_list {
                props.push(convert(p, ii as u32, &mut keys, &mut port_lists, &mut in_key_list, &mut out_key_list)?);
            }
            let first_merge_prop = props.len() as u32;
            for p in &instr.reg_merge_uop_properties_list {
                props.push(convert(p, ii as u32, &mut keys, &mut port_lists, &mut in_key_list, &mut out_key_list)?);
            }
            let stack_sync_prop = props.len() as u32;
            props.push(PropInfo {
                instr: ii as u32,
                ports: (alu_ports_start, n_alu_ports),
                port0: alu_port0,
                port_mask: alu_mask,
                port_list: alu_port_list,
                in_keys: (rsp_in, 1),
                out_keys: (rsp_out, 1),
                div_cycles: 0,
                is_load: false,
                forward_delay: 0,
                forward_fail_delay: 0,
                is_store_addr: false,
                mem_addr: None,
                is_store_data: false,
                is_first: true,
                is_last: false,
                is_reg_merge: false,
                is_stack_sync: true,
            });

            let (lam_start, fused_start) = (group_lams.len() as u32, group_fused.len() as u32);
            if !instr.uop_properties_list.is_empty() {
                compute_uop_grouping(instr, &instr.uop_properties_list, config, &mut group_fused, &mut group_lams);
            }
            let grouping = (lam_start, group_lams.len() as u32 - lam_start, fused_start);

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
            let av_kind = if s.contains("MOV") && !s.contains("CMOV") {
                AvKind::Copy
            } else if s.contains("ADD") && instr.immediate.is_some() {
                AvKind::Add(instr.immediate.unwrap())
            } else if s.contains("SUB") && instr.immediate.is_some() {
                AvKind::Sub(instr.immediate.unwrap())
            } else if s.contains("INC") {
                AvKind::Inc
            } else if s.contains("DEC") {
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
                Some(Some(Operand::Mem { mem_addr })) => Some(mem_addr_info(&mut keys, mem_addr)),
                Some(_) => return Err(invalid("memory operand expected")),
                None => None,
            };
            let n = tp_res.len();
            let res = *tp_res.entry(&instr.tp_key).or_insert(1 + ports.len() + n);
            n_resources = n_resources.max(res + 1);
            let requires_extra_entry = match instr.immediate {
                Some(imm) => {
                    !(-(1i64 << 31)..(1i64 << 31)).contains(&imm)
                        || (!(-(1i64 << 15)..(1i64 << 15)).contains(&imm) && !instr.mem_addr_operands.is_empty())
                }
                None => false,
            };
            info.push(InstrInfo {
                len: (instr.opcode.len() / 2) as i64,
                first_prop,
                n_props: instr.uop_properties_list.len() as u32,
                first_merge_prop,
                n_merge_props: instr.reg_merge_uop_properties_list.len() as u32,
                stack_sync_prop,
                grouping,
                in_reg0: in_regs.first().map(|r| r.0),
                out_reg0_is_32: out_regs.first().is_some_and(|r| r.1 == 32),
                in_regs: in_regs.iter().map(|r| r.0).collect(),
                folded_input_reg: instr.folded_input_reg.as_deref().map(|r| keys.intern(r)),
                mem_width: mem_width(s),
                mov_store_width,
                mov_load_width,
                has_input_mem: !instr.input_mem_operands.is_empty(),
                has_output_mem: !instr.output_mem_operands.is_empty(),
                in_mem0,
                av_kind,
                reads_rsp_explicitly: in_regs.iter().chain(addr_regs.iter()).any(|r| r.0 == rsp && !r.2),
                writes_rsp: out_regs.iter().any(|r| r.0 == rsp),
                can_be_used_by_lsd: !(instr.uops_ms != 0 || instr.implicit_rsp_change != 0 || out_regs.iter().any(|r| r.3)),
                is_last_decoded: instr.is_last_decoded_instr(),
                fast_ptr_chasing_source: [
                    "MOV (R64, M64)",
                    "MOV (RAX, M64)",
                    "MOV (R32, M32)",
                    "MOV (EAX, M32)",
                    "MOVSXD (R64, M32)",
                    "POP (R64)",
                ]
                .contains(&s),
                has_m256: s.contains("M256"),
                has_i64: s.contains("I64"),
                tp_res: res,
                tmpl_uops: (0, 0),
                tmpl_fused: (0, 0),
                tmpl_lams: (0, 0),
                has_macro_fusible: !instr.macro_fusible_with.is_empty(),
                dsb_required_entries: instr.uops_mite.max(1),
                dsb_requires_extra_entry: requires_extra_entry,
                out_regs: out_regs.iter().map(|r| (r.0, r.1)).collect(),
            });
        }
        let mut prep = Prep { group_lams, group_fused, port_lists, in_key_list, out_key_list, keys, props, info, ports, port_idx, port_hex, n_resources, tmpl_uops: Vec::new(), tmpl_fused: Vec::new(), tmpl_lams: Vec::new() };
        prep.build_templates();
        Ok(prep)
    }
}
