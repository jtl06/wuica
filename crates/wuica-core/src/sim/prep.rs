//! Static data derived from the instructions before the simulation starts: interned rename keys, uop properties with port
//! indices, the grouping of uops into fused and laminated uops (`computeUopGrouping`), and the string tests of the Python code
//! evaluated once per instruction.

use super::SimError;
use crate::config::{UArch, UArchConfig};
use crate::decoded::MemAddr;
use crate::model::{Instr, InstrList, OpId, Operand, TpKey, UopProperties};
use crate::x64::{canonical_reg, is_gp_reg, mem_width, reg_size};
use std::collections::{HashMap, VecDeque};

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
    map: HashMap<String, Key>,
    pub info: Vec<KeyInfo>,
}

impl Keys {
    fn new() -> Keys {
        Keys { map: HashMap::new(), info: vec![KeyInfo { is_gpr: false, has_mm: false }] }
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
        self.intern(&canonical_reg(reg))
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
    /// indices into the list of all ports, in the order of `possiblePorts`
    pub ports: Vec<u8>,
    pub port_mask: u32,
    pub port_list: PortList,
    pub in_keys: Vec<InKey>,
    pub out_keys: Vec<OutKey>,
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
    /// laminated uops -> sizes of their fused uops
    pub grouping: Vec<Vec<u32>>,
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

pub(crate) struct Prep {
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

/// `computeUopGrouping`: a list (laminated-domain uops) of lists (fused-domain uops) of lists of indices of uop properties
fn compute_uop_grouping(instr: &Instr, props: &[UopProperties], config: &UArchConfig) -> Vec<Vec<Vec<usize>>> {
    let is_fusible = |p: &UopProperties| match &p.possible_ports {
        Some(ports) => ports.iter().any(|p| config.fusible_ports.contains(p.as_str())),
        None => false,
    };
    let mut unfused: VecDeque<usize> = (0..props.len()).collect();
    let mut fused: VecDeque<Vec<usize>> = VecDeque::new();
    for i in 0..(instr.retire_slots - 1).max(0) {
        let Some(uop) = unfused.pop_front() else { break };
        if is_fusible(&props[uop]) && unfused.len() as i64 >= instr.retire_slots - i {
            let second = unfused.pop_front().unwrap();
            fused.push_back(vec![uop, second]);
        } else {
            fused.push_back(vec![uop]);
        }
    }
    fused.push_back(unfused.into_iter().collect());

    let mut laminated = Vec::new();
    let n_laminated = (instr.uops_mite + instr.uops_ms).min(fused.len() as i64);
    for i in 0..(n_laminated - 1).max(0) {
        let f = fused.pop_front().unwrap();
        if f.len() == 1 && is_fusible(&props[f[0]]) && fused.len() as i64 >= n_laminated - i {
            let second = fused.pop_front().unwrap();
            laminated.push(vec![f, second]);
        } else {
            laminated.push(vec![f]);
        }
    }
    laminated.push(fused.into_iter().collect());
    laminated
}

impl Prep {
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

        let convert = |p: &UopProperties, instr: u32, keys: &mut Keys| -> Result<PropInfo, SimError> {
            let mut pl = Vec::new();
            let mut mask = 0u32;
            for port in p.possible_ports.iter().flatten() {
                let i = port_of(port)?;
                pl.push(i);
                mask |= 1 << i;
            }
            let names: Vec<&str> = p.possible_ports.iter().flatten().map(|s| s.as_str()).collect();
            let port_list = match names.as_slice() {
                ["2", "3"] => PortList::P23,
                ["4", "9"] => PortList::P49,
                ["7", "8"] => PortList::P78,
                ["0", "1", "5"] => PortList::P015,
                _ => PortList::Other,
            };
            let mut key_of = |op: OpId| -> Result<(bool, Key, bool), SimError> {
                match list.operands.get(op as usize) {
                    Some(Operand::Reg { reg, .. }) => Ok((false, keys.reg(reg), true)),
                    Some(Operand::Flag { flags }) => Ok((false, keys.intern(flags), false)),
                    Some(Operand::Mem { .. }) => Ok((false, KEY_NONE, false)),
                    Some(Operand::Pseudo) => Ok((true, KEY_NONE, false)),
                    None => Err(invalid("operand index out of range")),
                }
            };
            let mut in_keys = Vec::new();
            for &op in &p.input_operands {
                let (is_pseudo, key, _) = key_of(op)?;
                in_keys.push(InKey { op, is_pseudo, key });
            }
            let mut out_keys = Vec::new();
            for &op in &p.output_operands {
                let (is_pseudo, key, is_reg) = key_of(op)?;
                let lat = p.latencies.iter().find(|(o, _)| *o == op).map_or(1, |(_, l)| *l);
                out_keys.push(OutKey { op, is_pseudo, key, is_reg, lat });
            }
            Ok(PropInfo {
                instr,
                ports: pl,
                port_mask: mask,
                port_list,
                in_keys,
                out_keys,
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

        for (ii, instr) in list.instrs.iter().enumerate() {
            let first_prop = props.len() as u32;
            for p in &instr.uop_properties_list {
                props.push(convert(p, ii as u32, &mut keys)?);
            }
            let first_merge_prop = props.len() as u32;
            for p in &instr.reg_merge_uop_properties_list {
                props.push(convert(p, ii as u32, &mut keys)?);
            }
            // StackSyncUop: UopProperties(instr, ALUPorts, [RSP], [RSP], {RSP: 1}, isFirstUopOfInstr=True)
            let stack_sync_prop = props.len() as u32;
            let mut pl = Vec::new();
            let mut mask = 0;
            for p in alu_ports {
                let i = port_of(p)?;
                pl.push(i);
                mask |= 1 << i;
            }
            let names: Vec<&str> = alu_ports.iter().map(|s| s.as_str()).collect();
            props.push(PropInfo {
                instr: ii as u32,
                ports: pl,
                port_mask: mask,
                port_list: match names.as_slice() {
                    ["2", "3"] => PortList::P23,
                    ["4", "9"] => PortList::P49,
                    ["7", "8"] => PortList::P78,
                    ["0", "1", "5"] => PortList::P015,
                    _ => PortList::Other,
                },
                in_keys: vec![InKey { op: NONE, is_pseudo: false, key: rsp }],
                out_keys: vec![OutKey { op: NONE, is_pseudo: false, key: rsp, is_reg: true, lat: 1 }],
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

            let grouping = if instr.uop_properties_list.is_empty() {
                Vec::new()
            } else {
                let g = compute_uop_grouping(instr, &instr.uop_properties_list, config);
                // the uops of a fused uop and the fused uops of a laminated uop are consecutive
                let mut next = 0;
                for lam in &g {
                    for fused in lam {
                        for &u in fused {
                            if u != next {
                                return Err(invalid("uop grouping is not consecutive"));
                            }
                            next += 1;
                        }
                    }
                }
                g.iter().map(|lam| lam.iter().map(|f| f.len() as u32).collect()).collect()
            };

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
                has_macro_fusible: !instr.macro_fusible_with.is_empty(),
                dsb_required_entries: instr.uops_mite.max(1),
                dsb_requires_extra_entry: requires_extra_entry,
                out_regs: out_regs.iter().map(|r| (r.0, r.1)).collect(),
            });
        }
        Ok(Prep { keys, props, info, ports, port_idx, port_hex, n_resources })
    }
}
