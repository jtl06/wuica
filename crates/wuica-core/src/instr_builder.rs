//! The instruction builder: from decoded instructions to instruction objects. A port of, in this order, `getInstructions`
//! (uiCA's `instructions.py`) with `xed.matchXMLAttributes`, and `adjustLatenciesAndAddMergeUops` and `computeUopProperties`
//! (`uiCA.py`). The statements follow the Python code, including its quirks; see "Rules for an exact port" in docs/DESIGN.md.
//!
//! Two properties of the Python code shape this port:
//!
//! - Operands are objects that are compared by identity. Here an operand is created (it gets a new [`OpId`]) exactly where Python
//!   constructs an object.
//! - `portData` of an instruction is, to begin with, the dict *object* of the instruction table. One rule (for code that uses ZMM
//!   registers) modifies this dict in place, which changes the port usage of all instructions that share the table entry,
//!   earlier and later ones; other rules copy the dict first. [`PortDicts`] models the dict objects of one call (one call
//!   corresponds to one run of the Python tool: nothing is carried over to the next call).

use crate::config::{UArch, UArchConfig};
use crate::data::{AttrData, InstrEntry, LatData, LatKind, PerfData, PortData, Tables};
use crate::decoded::{DecodedInstr, MemAddr};
use crate::model::{Instr, InstrList, OpId, Operand, TpKey, UopProperties};
use crate::fasthash::FastMap;
use crate::substr::has;
use crate::x64::{canonical_reg, canonical_reg_cow, gp_reg_index, is_gp_reg, is_high8_reg, mem_width, reg_size};
use std::borrow::Cow;
use std::collections::{BTreeMap, VecDeque};

/// Builds the instruction objects for decoded code: `getInstructions`, `adjustLatenciesAndAddMergeUops` and
/// `computeUopProperties`. `data` must be the instruction table of `config` (`config.name`).
///
/// # Panics
///
/// Where the Python code raises an exception (which needs table data or decoded records that do not occur in practice), e.g. a
/// macro-fused branch without port data, or an instruction without retire slots and uops.
pub fn build_instructions(
    decoded: &[DecodedInstr],
    config: &UArchConfig,
    uarch: &UArch,
    data: &dyn Tables,
    alignment_offset: i64,
    no_micro_fusion: bool,
    no_macro_fusion: bool,
) -> InstrList {
    let mut operands = Vec::new();
    let mut instrs = get_instructions(decoded, config, uarch, data, alignment_offset, no_micro_fusion, no_macro_fusion, &mut operands);
    adjust_latencies_and_add_merge_uops(&mut instrs, &mut operands, config);
    compute_uop_properties(&mut instrs, &mut operands, config);
    InstrList { operands, instrs }
}

/// `xed.matchXMLAttributes(instrD, attrDict)` (C code in uiCA's XED module): false if an attribute that both have differs;
/// `rm` matches if the XML value contains the decoded value.
fn match_xml_attributes(d: &DecodedInstr, attr: &AttrData) -> bool {
    let differs = |xml: &Option<String>, decoded: &str| xml.as_deref().is_some_and(|x| x != decoded);
    if differs(&attr.agen, &d.agen)
        || differs(&attr.bcast, &d.bcast)
        || differs(&attr.eosz, &d.eosz)
        || differs(&attr.high8, &d.high8)
        || differs(&attr.iform, &d.iform)
        || differs(&attr.immzero, &d.immzero)
        || differs(&attr.mask, &d.mask)
        || differs(&attr.rep, &d.rep)
        || differs(&attr.sae, &d.sae)
        || differs(&attr.zeroing, &d.zeroing)
    {
        return false;
    }
    match &attr.rm {
        Some(rm) => rm.contains(d.rm.as_str()),
        None => true,
    }
}

fn new_operand(operands: &mut Vec<Operand>, op: Operand) -> OpId {
    operands.push(op);
    (operands.len() - 1) as OpId
}

fn new_reg(operands: &mut Vec<Operand>, reg: &str) -> OpId {
    new_operand(operands, Operand::Reg { reg: reg.to_string(), is_implicit_stack_operand: false })
}

/// `int(s)` for the decoder's numeric strings
fn py_int(s: &str) -> i64 {
    s.trim().parse().unwrap_or_else(|_| panic!("ValueError: invalid literal for int(): {s:?}"))
}

/// `instrD['rw'][name]`
fn rw<'a>(d: &'a DecodedInstr, name: &str) -> &'a str {
    // a search of the few entries instead of a lookup by hash (the keys are unique)
    d.rw.iter()
        .find(|(k, _)| k.as_str() == name)
        .map(|(_, v)| v.as_str())
        .unwrap_or_else(|| panic!("KeyError: no rw entry for operand {name} of {:?}", d.asm))
}

/// `iform.split('_')[0]`
fn iclass_of_iform(iform: &str) -> &str {
    iform.split('_').next().unwrap_or("")
}

/// A `portData` dict of one call: (ports, number of uops) in the order of the Python dict. The operations of the dict are
/// [`dict_shift_remove`], [`dict_insert`] and [`port_add`].
type Dict = Vec<(String, i64)>;

/// `del d[key]` (`IndexMap::shift_remove`: the other items keep their order)
fn dict_shift_remove(dict: &mut Dict, key: &str) {
    if let Some(i) = dict.iter().position(|(k, _)| k == key) {
        dict.remove(i);
    }
}

/// `d[key] = value`: an existing key keeps its position
fn dict_insert(dict: &mut Dict, key: String, value: i64) {
    match dict.iter_mut().find(|(k, _)| *k == key) {
        Some((_, v)) => *v = value,
        None => dict.push((key, value)),
    }
}

/// A dict object: one of the instruction table (as long as it is not changed: it is copied when it is first changed, so that
/// changes stay within this call), or one of this call.
enum Slot<'a> {
    Table(&'a PortData),
    Own(Dict),
}

/// The dict objects that the `portData` attributes refer to during the main loop of `getInstructions`: those of the instruction
/// table and those created by the code.
struct PortDicts<'a> {
    data: &'a dyn Tables,
    dicts: Vec<Slot<'a>>,
    /// (index of the perfData element, variant) -> index in `dicts`
    table: FastMap<(usize, PortVariant), usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum PortVariant {
    Base,
    SameReg,
    Indexed,
}

impl<'a> PortDicts<'a> {
    /// the dict object `perfData[key]` of the table, if the key exists
    fn table_dict(&mut self, perf_idx: usize, variant: PortVariant) -> Option<usize> {
        if let Some(&id) = self.table.get(&(perf_idx, variant)) {
            return Some(id);
        }
        let data = self.data;
        let perf = data.perf(perf_idx);
        let dict = match variant {
            PortVariant::Base => perf.ports.as_ref(),
            PortVariant::SameReg => perf.ports_sr.as_ref(),
            PortVariant::Indexed => perf.ports_i.as_ref(),
        }?;
        self.dicts.push(Slot::Table(dict));
        let id = self.dicts.len() - 1;
        self.table.insert((perf_idx, variant), id);
        Some(id)
    }

    fn new_dict(&mut self, dict: Dict) -> usize {
        self.dicts.push(Slot::Own(dict));
        self.dicts.len() - 1
    }

    /// a copy of the items of a dict object
    fn items(&self, id: usize) -> Dict {
        match &self.dicts[id] {
            Slot::Table(d) => d.iter().map(|(p, n)| (p.clone(), *n)).collect(),
            Slot::Own(d) => d.clone(),
        }
    }

    /// `dict(d)`
    fn copy(&mut self, id: usize) -> usize {
        let dict = self.items(id);
        self.new_dict(dict)
    }

    /// the first key of a dict object
    fn first_key(&self, id: usize) -> Option<&str> {
        match &self.dicts[id] {
            Slot::Table(d) => d.keys().next().map(|k| k.as_str()),
            Slot::Own(d) => d.first().map(|(k, _)| k.as_str()),
        }
    }

    fn is_empty(&self, id: usize) -> bool {
        match &self.dicts[id] {
            Slot::Table(d) => d.is_empty(),
            Slot::Own(d) => d.is_empty(),
        }
    }

    /// the dict object, to be changed
    fn get_mut(&mut self, id: usize) -> &mut Dict {
        if let Slot::Table(_) = self.dicts[id] {
            let items = self.items(id);
            self.dicts[id] = Slot::Own(items);
        }
        match &mut self.dicts[id] {
            Slot::Own(d) => d,
            Slot::Table(_) => unreachable!(),
        }
    }
}

/// `d[key] = d.get(key, 0) + n`
fn port_add(dict: &mut Dict, key: &str, n: i64) {
    match dict.iter_mut().find(|(k, _)| k == key) {
        Some((_, v)) => *v += n,
        None => dict.push((key.to_string(), n)),
    }
}

/// (base, index, scale, disp // 64): the cache line of an address expression, as far as it can be told from the code
type Line = (Option<String>, Option<String>, Option<i64>, i64);

fn line_of(m: &MemAddr) -> Line {
    (m.base.clone(), m.index.clone(), m.scale, m.disp.unwrap_or(0).div_euclid(64))
}

fn reg_of(operands: &[Operand], id: OpId) -> &str {
    match &operands[id as usize] {
        Operand::Reg { reg, .. } => reg,
        other => panic!("not a register operand: {other:?}"),
    }
}

/// `affineDelta(instr, reg)`: the constant that the instruction adds to the 32- or 64-bit general-purpose register `reg` (index of
/// [`gp_reg_index`]), or `None` if it changes it otherwise
fn affine_delta(instr: &Instr, operands: &[Operand], reg: usize) -> Option<i64> {
    let mnemonic = instr.instr_str.split(' ').next().unwrap_or("");
    if !instr.output_reg_operands.iter().any(|&op| {
        let r = reg_of(operands, op);
        gp_reg_index(r) == Some(reg) && matches!(reg_size(r), 32 | 64)
    }) {
        return None;
    }
    if (mnemonic == "ADD" || mnemonic == "SUB")
        && instr.immediate.is_some()
        && instr.input_reg_operands.first().is_some_and(|&op| gp_reg_index(reg_of(operands, op)) == Some(reg))
        && instr.input_mem_operands.is_empty()
    {
        let imm = instr.immediate.expect("checked");
        return Some(if mnemonic == "ADD" { imm } else { -imm });
    }
    if (mnemonic == "INC" || mnemonic == "DEC") && instr.input_mem_operands.is_empty() && instr.output_mem_operands.is_empty() {
        return Some(if mnemonic == "INC" { 1 } else { -1 });
    }
    None
}

/// (version, offset) of each general-purpose register (index of [`gp_reg_index`]), relative to the start of an iteration
type RegState = [(i64, i64); 16];

/// `registerVersions`: the values of the general-purpose registers in one iteration, relative to their values at its start, as
/// (version, offset): adding an immediate (ADD, SUB, INC, DEC) changes the offset, any other write gives a new version. Returns the
/// state before each instruction and the state at the end of the iteration.
fn register_versions(instructions: &[Instr], operands: &[Operand]) -> (Vec<RegState>, RegState) {
    let mut state: RegState = [(0, 0); 16];
    let mut before = Vec::with_capacity(instructions.len());
    let mut n_versions = 0;
    for instr in instructions {
        before.push(state);
        for &op in &instr.output_reg_operands {
            let Some(reg) = gp_reg_index(reg_of(operands, op)) else { continue };
            match affine_delta(instr, operands, reg) {
                Some(d) => state[reg].1 += d,
                None => {
                    n_versions += 1;
                    state[reg] = (n_versions, 0);
                }
            }
        }
    }
    (before, state)
}

/// `addressLineKey`: (registers with their versions, scale, cache line of the offset) of an address
type LineKey = (Option<String>, Option<i64>, Option<String>, Option<i64>, Option<i64>, i64);

fn address_line_key(m: &MemAddr, state: &RegState) -> LineKey {
    // getCanonicalReg; registers that are not general-purpose registers (RIP) have the state (0, 0)
    let reg_state = |r: &str| gp_reg_index(r).map_or((0, 0), |i| state[i]);
    let (vb, ob) = m.base.as_deref().map_or((None, 0), |b| {
        let (v, o) = reg_state(b);
        (Some(v), o)
    });
    let (vi, oi) = m.index.as_deref().map_or((None, 0), |x| {
        let (v, o) = reg_state(x);
        (Some(v), o)
    });
    (
        m.base.as_deref().map(canonical_reg),
        vb,
        m.index.as_deref().map(canonical_reg),
        vi,
        m.scale,
        (ob + m.scale.unwrap_or(0) * oi + m.disp.unwrap_or(0)).div_euclid(64),
    )
}

/// `splitLoadPatterns`: sets `split_load_pattern` of the loads that cross a 64-byte line in some iterations. Loads are grouped by their
/// address registers; a group's registers must be changed only by adding immediates (register_versions), which gives the offset of each
/// load from the group's unknown start address and the stride per iteration. The start address is assumed to have the alignment (mod
/// 64) with the fewest crossing loads.
fn split_load_patterns(instructions: &mut [Instr], operands: &[Operand], before: &[RegState], end: &RegState) {
    fn gcd(a: i64, b: i64) -> i64 {
        if b == 0 { a } else { gcd(b, a % b) }
    }
    // (sorted (register, coefficient) pairs, [(instruction, offset, size, stride)]) in the order of the first load of each group
    let mut groups: Vec<(Vec<(String, i64)>, Vec<(usize, i64, i64, i64)>)> = Vec::new();
    for (i, instr) in instructions.iter().enumerate() {
        for &op in &instr.input_mem_operands {
            let m = mem_addr_of(operands, op);
            let size = mem_width(&instr.instr_str).unwrap_or(0).div_euclid(8);
            if size < 2 || ["PUSH", "POP", "LEA", "PREFETCH", "NOP"].iter().any(|p| instr.instr_str.starts_with(p)) {
                continue;
            }
            let mut regs: Vec<(String, i64)> = Vec::new();
            if let Some(b) = m.base.as_deref().filter(|b| !b.is_empty()) {
                regs.push((canonical_reg(b), 1));
            }
            if let Some(x) = m.index.as_deref().filter(|x| !x.is_empty()) {
                regs.push((canonical_reg(x), m.scale.filter(|&s| s != 0).unwrap_or(1)));
            }
            let mut ok = true;
            let (mut offset, mut stride) = (m.disp.unwrap_or(0), 0);
            for (r, c) in &regs {
                match gp_reg_index(r) {
                    Some(k) if before[i][k].0 == 0 && end[k].0 == 0 => {
                        offset += c * before[i][k].1;
                        stride += c * end[k].1;
                    }
                    _ => ok = false,
                }
            }
            if !ok {
                continue;
            }
            regs.sort();
            match groups.iter_mut().find(|(k, _)| *k == regs) {
                Some((_, loads)) => loads.push((i, offset, size, stride)),
                None => groups.push((regs, vec![(i, offset, size, stride)])),
            }
        }
    }
    for (_, loads) in &groups {
        let stride = loads[0].3.rem_euclid(64);
        let period = 64 / gcd(stride, 64);
        let crossings = |r: i64| -> Vec<Vec<bool>> {
            loads.iter().map(|&(_, off, size, _)| (0..period).map(|k| (r + off + stride * k).rem_euclid(64) + size > 64).collect()).collect()
        };
        let count = |r: i64| crossings(r).iter().map(|p| p.iter().filter(|&&b| b).count()).sum::<usize>();
        // min(range(64), key=...): the first minimum
        let best = (0..64).min_by_key(|&r| count(r)).expect("non-empty range");
        for (&(i, _, _, _), pattern) in loads.iter().zip(crossings(best)) {
            if pattern.iter().any(|&b| b) {
                let instr = &mut instructions[i];
                instr.split_load_pattern = Some(match instr.split_load_pattern.take() {
                    None => pattern,
                    Some(old) => old.iter().zip(&pattern).map(|(&a, &b)| a || b).collect(),
                });
            }
        }
    }
}

fn mem_addr_of(operands: &[Operand], id: OpId) -> &MemAddr {
    match &operands[id as usize] {
        Operand::Mem { mem_addr } => mem_addr,
        other => panic!("not a memory operand: {other:?}"),
    }
}

/// `re.search(r'\(M(8|16)\b', instrStr)`
fn has_narrow_mem_operand(instr_str: &str) -> bool {
    let b = instr_str.as_bytes();
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut start = 0;
    while let Some(pos) = instr_str[start..].find("(M") {
        let rest = &b[start + pos + 2..];
        for width in [&b"8"[..], &b"16"[..]] {
            if rest.starts_with(width) && rest.get(width.len()).is_none_or(|&c| !is_word(c)) {
                return true;
            }
        }
        start += pos + 2;
    }
    false
}

fn unknown_instr(d: &DecodedInstr) -> Instr {
    Instr {
        is_unknown: true,
        asm: d.asm.clone(),
        opcode: d.opcode.clone(),
        pos_nominal_opcode: d.pos_nominal_opcode as i64,
        instr_str: String::new(),
        port_data: Vec::new(),
        uops: 0,
        retire_slots: 1,
        uops_mite: 1,
        uops_ms: 0,
        div_cycles: 0,
        input_reg_operands: Vec::new(),
        input_flag_operands: Vec::new(),
        input_mem_operands: Vec::new(),
        output_reg_operands: Vec::new(),
        output_flag_operands: Vec::new(),
        output_mem_operands: Vec::new(),
        mem_addr_operands: Vec::new(),
        agen_operands: Vec::new(),
        latencies: Vec::new(),
        tp: None,
        immediate: Some(0),
        lcp_stall: false,
        implicit_rsp_change: 0,
        may_be_eliminated: false,
        complex_decoder: false,
        n_available_simple_decoders: None,
        has_lock_prefix: false,
        is_branch_instr: false,
        is_serializing_instr: false,
        is_load_serializing: false,
        is_store_serializing: false,
        macro_fusible_with: Vec::new(),
        macro_fused_with_prev_instr: false,
        macro_fused_with_next_instr: false,
        cannot_be_in_dsb_due_to_jcc_erratum: false,
        folded_input_reg: None,
        mem_renaming: false,
        tp_key: TpKey::InstrStr(String::new()),
        op_cache_fields: 0,
        split_load_pattern: None,
        is_next_to_last_instr: false,
        is_last_instr: false,
        uop_properties_list: Vec::new(),
        reg_merge_uop_properties_list: Vec::new(),
    }
}

const SERIALIZING_IFORMS: &[&str] = &[
    "LFENCE",
    "CPUID",
    "IRET",
    "IRETD",
    "RSM",
    "INVD",
    "INVEPT_GPR64_MEMdq",
    "INVLPG_MEMb",
    "INVVPID_GPR64_MEMdq",
    "LGDT_MEMs64",
    "LIDT_MEMs64",
    "LLDT_MEMw",
    "LLDT_GPR16",
    "LTR_MEMw",
    "LTR_GPR16",
    "MOV_CR_CR_GPR64",
    "MOV_DR_DR_GPR64",
    "WBINVD",
    "WRMSR",
];

/// The values that `getInstructions` computes from the decoded record alone, before it looks at the table.
struct Decoded<'a> {
    d: &'a DecodedInstr,
    same_reg: bool,
    uses_indexed_addr: bool,
    lcp_stall: bool,
    implicit_rsp_change: i64,
    is_branch_instr: bool,
    zmm_rule_applies: bool,
}

/// `getInstructions`. The operands are added to `operands`.
#[allow(clippy::too_many_arguments)]
fn get_instructions(
    disas: &[DecodedInstr],
    config: &UArchConfig,
    uarch: &UArch,
    data: &dyn Tables,
    alignment_offset: i64,
    no_micro_fusion: bool,
    no_macro_fusion: bool,
    operands: &mut Vec<Operand>,
) -> Vec<Instr> {
    let mut instructions: Vec<Instr> = Vec::with_capacity(disas.len());
    // port_refs[i]: the dict object that instructions[i].portData refers to
    let mut port_refs: Vec<usize> = Vec::with_capacity(disas.len());
    let mut dicts = PortDicts { data, dicts: Vec::new(), table: FastMap::default() };

    let zmm_registers_in_use = disas.iter().any(|d| d.reg_operands.values().any(|reg| has(reg, "ZMM")));
    let mut next_addr = alignment_offset;
    for d in disas {
        let addr = next_addr;
        next_addr += (d.opcode.len() / 2) as i64;
        // usedRegs = [getCanonicalReg(r) for r in regOperands.values() if r in GPRegs or 'MM' in r]
        // sameReg = len(usedRegs) > 1 and all(r == usedRegs[0] for r in usedRegs)
        let mut used_regs = d.reg_operands.values().filter(|r| is_gp_reg(r) || has(r, "MM")).map(|r| canonical_reg_cow(r));
        let same_reg = match used_regs.next() {
            Some(first) => {
                let (mut n, mut all_same) = (1, true);
                for r in used_regs {
                    n += 1;
                    all_same &= r == first;
                }
                n > 1 && all_same
            }
            None => false,
        };
        let uses_indexed_addr = d.mem_operands.values().any(|m| m.index.is_some());
        let immediate_width = d.imm_width.unwrap_or(0);
        let lcp_stall = py_int(&d.prefix66) != 0 && immediate_width == 16;
        let mut implicit_rsp_change = 0;
        if d.reg_operands.values().any(|r| has(r, "STACKPOP")) {
            implicit_rsp_change = 1i64 << py_int(&d.eosz);
        }
        if d.reg_operands.values().any(|r| has(r, "STACKPUSH")) {
            implicit_rsp_change = -(1i64 << py_int(&d.eosz));
        }
        let is_branch_instr = d.reg_operands.iter().any(|(n, r)| has(r, "IP") && rw(d, n).contains('W'));
        let dec = Decoded {
            d,
            same_reg,
            uses_indexed_addr,
            lcp_stall,
            implicit_rsp_change,
            is_branch_instr,
            zmm_rule_applies: zmm_registers_in_use && d.reg_operands.values().any(|reg| has(reg, "MM")),
        };

        let mut built = None;
        if let Some(entries) = data.entries(&d.iform) {
            for entry in entries {
                if match_xml_attributes(d, data.attr(entry.attr)) {
                    built = Some(known_instr(&dec, entry, config, uarch, &mut dicts, no_micro_fusion, no_macro_fusion, operands));
                    break;
                }
            }
        }
        let (mut instruction, port_ref) = match built {
            Some(b) => b,
            None => (unknown_instr(d), dicts.new_dict(Dict::new())),
        };

        // Macro-fusion
        if let Some(prev) = instructions.len().checked_sub(1) {
            // Macrofusion does not happen when the jump is at the beginning of a 64 byte cache line
            if instructions[prev].macro_fusible_with.contains(&instruction.instr_str) && addr.rem_euclid(64) != 0 {
                instruction.macro_fused_with_prev_instr = true;
                let prev_instr = &mut instructions[prev];
                prev_instr.macro_fused_with_next_instr = true;
                let instr_ports = dicts
                    .first_key(port_ref)
                    .unwrap_or_else(|| panic!("IndexError: macro-fused instruction {:?} has no port data", instruction.asm))
                    .to_string();
                if prev_instr.uops == 0 {
                    prev_instr.uops = instruction.uops;
                    port_refs[prev] = port_ref;
                } else if config.is_amd {
                    // the fused uop is executed by a branch unit
                    port_refs[prev] = dicts.copy(port_refs[prev]);
                    let dict = dicts.get_mut(port_refs[prev]);
                    // the loop ends at the first item that is changed: the items before it are unchanged
                    let found = dict
                        .iter()
                        .position(|(p, _)| !p.chars().any(|port| config.load_ports.contains(port) || config.store_data_ports.contains(port)));
                    if let Some(i) = found {
                        let (p, u) = dict.remove(i);
                        if u > 1 {
                            dict_insert(dict, p, u - 1);
                        }
                        port_add(dict, &instr_ports, 1);
                    }
                } else {
                    // a copy, so that the port usage of other instructions of the same type is not modified
                    port_refs[prev] = dicts.copy(port_refs[prev]);
                    let dict = dicts.get_mut(port_refs[prev]);
                    if let Some(i) = dict.iter().position(|(p, _)| instr_ports.chars().all(|c| p.contains(c))) {
                        let (_, u) = dict.remove(i);
                        dict_insert(dict, instr_ports, u);
                    }
                }
            }
        }

        // JCC erratum
        if !config.branch_can_be_last_instr_in_cached_block {
            if instruction.is_branch_instr && addr.div_euclid(32) != next_addr.div_euclid(32) {
                instruction.cannot_be_in_dsb_due_to_jcc_erratum = true;
            }
            if instruction.macro_fused_with_prev_instr {
                let prev_instr = instructions.last_mut().expect("a macro-fused instruction has a predecessor");
                let prev_addr = addr - (prev_instr.opcode.len() / 2) as i64;
                if prev_addr.div_euclid(32) != next_addr.div_euclid(32) {
                    prev_instr.cannot_be_in_dsb_due_to_jcc_erratum = true;
                }
            }
        }

        // immediate and displacement fields (zero displacements are not encoded, except with RBP/R13 as base)
        instruction.op_cache_fields = i64::from(immediate_width != 0)
            + d.mem_operands
                .values()
                .filter(|m| m.disp.unwrap_or(0) != 0 || matches!(m.base.as_deref(), Some("RBP") | Some("R13")))
                .count() as i64;
        instructions.push(instruction);
        port_refs.push(port_ref);
    }

    // From here on, every change of a portData dict is made on a copy: each instruction gets its own dict.
    let mut port_data: Vec<Dict> = port_refs.iter().map(|&r| dicts.items(r)).collect();

    if let Some(load_line_slots) = config.load_line_slots.filter(|&n| n != 0) {
        // (instruction, line, displacement) for each load
        let loads: Vec<(usize, Line, i64)> = instructions
            .iter()
            .enumerate()
            .flat_map(|(i, instr)| instr.input_mem_operands.iter().map(move |&op| (i, op)))
            .map(|(i, op)| {
                let m = mem_addr_of(operands, op);
                (i, line_of(m), m.disp.unwrap_or(0))
            })
            .collect();
        let restricted_ports: String = config.load_ports.chars().skip(load_line_slots as usize).collect();
        for (i, line, offset) in &loads {
            if loads.iter().any(|(i2, l, o)| i2 != i && l == line && o != offset) {
                continue;
            }
            let dict = &mut port_data[*i];
            let applies = |pc: &str| config.load_ports.chars().all(|p| pc.contains(p));
            if !dict.iter().any(|(pc, _)| applies(pc)) {
                continue;
            }
            let items: Dict = dict.clone();
            for (pc, n) in items {
                if applies(&pc) {
                    dict_shift_remove(dict, &pc);
                    let new_pc: String = pc.chars().filter(|&p| !restricted_ports.contains(p)).collect();
                    port_add(dict, &new_pc, n);
                }
            }
        }
    }

    let mut reg_before: Option<Vec<RegState>> = None;
    if !config.store_line_restricted_ports.is_empty() {
        // two stores of an iteration write the same line if their address registers hold the same values (register versions, see
        // register_versions; e.g., 'inc [rsp+rdx*4]' twice with 'movzx edx, al' between them: different lines)
        let before = &*reg_before.insert(register_versions(&instructions, operands).0);
        let stores: Vec<(usize, LineKey)> = instructions
            .iter()
            .enumerate()
            .flat_map(|(i, instr)| instr.output_mem_operands.iter().map(move |&op| (i, op)))
            .map(|(i, op)| (i, address_line_key(mem_addr_of(operands, op), &before[i])))
            .collect();
        for (i, line) in &stores {
            if stores.iter().any(|(i2, l)| i2 != i && l == line) {
                continue;
            }
            let dict = &mut port_data[*i];
            let applies = |pc: &str| pc.chars().all(|p| config.store_data_ports.contains(p));
            if !dict.iter().any(|(pc, _)| applies(pc)) {
                continue;
            }
            let items: Dict = dict.clone();
            for (pc, n) in items {
                if applies(&pc) {
                    // also vector stores
                    dict_shift_remove(dict, &pc);
                    let new_pc: String = config
                        .store_data_ports
                        .chars()
                        .filter(|&p| !config.store_line_restricted_ports.contains(p) && !config.vector_store_data_ports.contains(p))
                        .collect();
                    port_add(dict, &new_pc, n);
                }
            }
        }
    }

    if config.split_load_cycles != 0 {
        let (before, end) = register_versions(&instructions, operands);
        let before = reg_before.get_or_insert(before);
        split_load_patterns(&mut instructions, operands, before, &end);
    }

    if config.narrow_store_penalty != 0 {
        let mut lines: Vec<Line> = Vec::new();
        for instr in &instructions {
            for &op in &instr.output_mem_operands {
                let line = line_of(mem_addr_of(operands, op));
                if !lines.contains(&line) {
                    lines.push(line);
                }
            }
        }
        let narrow = instructions.iter().position(|instr| !instr.output_mem_operands.is_empty() && has_narrow_mem_operand(&instr.instr_str));
        if let (Some(narrow), true) = (narrow, lines.len() >= 2) {
            // modeled as a throughput limit for one of the narrow stores (with its own key, see Scheduler)
            let instr = &mut instructions[narrow];
            let old = instr.tp.unwrap_or(0.0);
            let limit = (lines.len() as i64 + config.narrow_store_penalty) as f64;
            instr.tp = Some(if limit > old { limit } else { old });
            instr.tp_key = TpKey::Own("narrowStore".to_string(), narrow);
        }
    }

    if let Some(last) = instructions.len().checked_sub(1) {
        instructions[last].is_last_instr = true;
        if let Some(taken_branch_port) = config.taken_branch_port.as_deref().filter(|p| !p.is_empty()) {
            if instructions[last].is_branch_instr {
                // the uop of a macro-fused branch belongs to the previous instruction
                let branch_uop_instr = if instructions[last].macro_fused_with_prev_instr && instructions.len() > 1 { last - 1 } else { last };
                // ''.join(list(instructions[-1].portData.keys())[:1])
                let first_ports_of_last = port_data[last].first().map(|(p, _)| p.clone()).unwrap_or_default();
                let dict = &mut port_data[branch_uop_instr];
                // the loop ends at the first item that is changed: the items before it are unchanged
                let found =
                    dict.iter().position(|(p, _)| p.contains(taken_branch_port) && (*p == first_ports_of_last || branch_uop_instr == last));
                if let Some(i) = found {
                    let (p, u) = dict.remove(i);
                    if u > 1 {
                        dict_insert(dict, p, u - 1);
                    }
                    port_add(dict, taken_branch_port, 1);
                }
            }
        }
    }
    if instructions.len() > 1 {
        let i = instructions.len() - 2;
        instructions[i].is_next_to_last_instr = true;
    }

    for (instr, dict) in instructions.iter_mut().zip(port_data) {
        instr.port_data = dict;
    }
    instructions
}

/// The body of the loop over the table entries in `getInstructions`, for the entry that matches: returns the instruction and
/// the dict object of its `portData`.
#[allow(clippy::too_many_arguments)]
fn known_instr(
    dec: &Decoded,
    entry: &InstrEntry,
    config: &UArchConfig,
    uarch: &UArch,
    dicts: &mut PortDicts,
    no_micro_fusion: bool,
    no_macro_fusion: bool,
    operands: &mut Vec<Operand>,
) -> (Instr, usize) {
    /// `portData`: a dict object of the table, or a new one
    enum Ports {
        Dict(usize),
        New(Dict),
    }

    let d = dec.d;
    let same_reg = dec.same_reg;
    let perf_idx = entry.perf_data;
    let data = dicts.data;
    let perf: &PerfData = data.perf(perf_idx);
    let empty_lat = LatData::default();

    let mut uops = perf.uops.unwrap_or(0);
    let mut retire_slots = perf.ret_slots.unwrap_or(1);
    let mut uops_mite = perf.uops_mite.unwrap_or(1);
    let mut uops_ms = perf.uops_ms.unwrap_or(0);
    let mut lat_data: Cow<LatData> = Cow::Borrowed(perf.lat.as_ref().unwrap_or(&empty_lat));
    let mut port_data = match dicts.table_dict(perf_idx, PortVariant::Base) {
        Some(id) => Ports::Dict(id),
        None => Ports::New(Dict::new()),
    };
    let mut div_cycles = perf.div_c.unwrap_or(0);
    let mut complex_decoder = perf.compl_dec.unwrap_or(0) != 0;
    let mut n_available_simple_decoders = perf.s_dec.unwrap_or(config.n_decoders);
    let has_lock_prefix = entry.has_lock_prefix();
    let mut tp = perf.tp;
    if config.experimental {
        if let Some(tp_ms) = perf.tp_ms.filter(|&t| t != 0.0) {
            // max(TP or 0, perfData['TP_MS'])
            let old = tp.unwrap_or(0.0);
            tp = Some(if tp_ms > old { tp_ms } else { old });
        }
    }
    if same_reg {
        uops = perf.uops_sr.unwrap_or(uops);
        retire_slots = perf.ret_slots_sr.unwrap_or(retire_slots);
        uops_mite = perf.uops_mite_sr.unwrap_or(uops_mite);
        uops_ms = perf.uops_ms_sr.unwrap_or(uops_ms);
        if let Some(l) = &perf.lat_sr {
            lat_data = Cow::Borrowed(l);
        }
        if let Some(id) = dicts.table_dict(perf_idx, PortVariant::SameReg) {
            port_data = Ports::Dict(id);
        }
        div_cycles = perf.div_c_sr.unwrap_or(div_cycles);
        if let Some(c) = perf.compl_dec_sr {
            complex_decoder = c != 0;
        }
        n_available_simple_decoders = perf.s_dec_sr.unwrap_or(n_available_simple_decoders);
        tp = perf.tp_sr.or(tp);
    }
    if dec.uses_indexed_addr {
        uops = perf.uops_i.unwrap_or(uops);
        retire_slots = perf.ret_slots_i.unwrap_or(retire_slots);
        uops_mite = perf.uops_mite_i.unwrap_or(uops_mite);
        uops_ms = perf.uops_ms_i.unwrap_or(uops_ms);
        if let Some(id) = dicts.table_dict(perf_idx, PortVariant::Indexed) {
            port_data = Ports::Dict(id);
        }
        div_cycles = perf.div_c_i.unwrap_or(div_cycles);
        if let Some(c) = perf.compl_dec_i {
            complex_decoder = c != 0;
        }
        n_available_simple_decoders = perf.s_dec_i.unwrap_or(n_available_simple_decoders);
        tp = perf.tp_i.or(tp);
    }

    let special_reg = |r: &str| has(r, "IP") || has(r, "STACK") || has(r, "RFLAGS");
    let instr_input_reg_operands: Vec<(&str, &str)> = d
        .reg_operands
        .iter()
        .filter(|(n, r)| {
            !special_reg(r)
                && (*r != "K0" || has(&d.asm, "k0")) // otherwise, K0 indicates unmasked operations
                && (rw(d, n).contains('R') || lat_data.has_input(n))
        })
        .map(|(n, r)| (n.as_str(), r.as_str()))
        .collect();
    let instr_input_mem_operands: Vec<(&str, &MemAddr)> = d
        .mem_operands
        .iter()
        .filter(|(n, _)| rw(d, n).contains('R') || has(rw(d, n), "CW"))
        .map(|(n, m)| (n.as_str(), m))
        .collect();

    let instr_output_reg_operands: Vec<(&str, &str)> = d
        .reg_operands
        .iter()
        .filter(|(n, r)| !special_reg(r) && rw(d, n).contains('W'))
        .map(|(n, r)| (n.as_str(), r.as_str()))
        .collect();
    let instr_output_mem_operands: Vec<(&str, &MemAddr)> =
        d.mem_operands.iter().filter(|(n, _)| rw(d, n).contains('W')).map(|(n, m)| (n.as_str(), m)).collect();

    let mut instr_flag_operand: Option<&str> = d.reg_operands.iter().find(|(_, r)| *r == "RFLAGS").map(|(n, _)| n.as_str());

    let movzx_special_case = !config.movzx_high8_alias_can_be_eliminated
        && matches!(entry.string.as_str(), "MOVZX (R64, R8l)" | "MOVZX (R32, R8l)")
        && matches!(instr_input_reg_operands[0].1, "SPL" | "BPL" | "SIL" | "DIL" | "R12B" | "R13B" | "R14B" | "R15B");
    let mut may_be_eliminated = has(&entry.string, "MOV")
        && !movzx_special_case
        && uops == 0
        && instr_input_reg_operands.len() == 1
        && instr_output_reg_operands.len() == 1;
    if may_be_eliminated || movzx_special_case {
        uops = perf.uops_sr.unwrap_or(uops);
        if let Some(id) = dicts.table_dict(perf_idx, PortVariant::SameReg) {
            port_data = Ports::Dict(id);
        }
        if let Some(l) = &perf.lat_sr {
            lat_data = Cow::Borrowed(l);
        }
    }

    let is_reg_move = has(&entry.string, "MOV")
        && instr_input_reg_operands.len() == 1
        && instr_output_reg_operands.len() == 1
        && d.mem_operands.is_empty();
    if config.experimental
        && is_reg_move
        && !same_reg
        && uops != 0
        && lat_data.get(instr_input_reg_operands[0].0, instr_output_reg_operands[0].0, None).unwrap_or(1) == 0
    {
        // e.g., movzx on Golden Cove: uops.info measured a latency of 0, i.e., the instruction is eliminated at rename
        may_be_eliminated = true;
    }
    if config.experimental && is_reg_move && same_reg && config.same_reg_move_eliminated && iclass_of_iform(&d.iform) == "MOV" {
        // e.g., 'mov eax, eax' on Zen 3
        may_be_eliminated = true;
        uops = 0;
        port_data = Ports::New(Dict::new());
        lat_data = Cow::Owned(LatData::default());
    } else if config.experimental && is_reg_move && same_reg {
        // A move whose source and destination are the same register (e.g., 'mov eax, eax', 'movzx ebx, bl') is not eliminated;
        // for the experimental configurations, the instruction data does not always contain its same-register variant.
        may_be_eliminated = false;
        uops = uops.max(1);
        let is_empty = match &port_data {
            Ports::Dict(id) => dicts.is_empty(*id),
            Ports::New(dict) => dict.is_empty(),
        };
        if is_empty {
            let alu_ports: String = uarch.alu_ports[&config.name].concat();
            port_data = Ports::New(vec![(alu_ports, 1)]);
        }
        let (inp, out) = (instr_input_reg_operands[0].0, instr_output_reg_operands[0].0);
        let lat = lat_data.get(inp, out, None).unwrap_or(1).max(1);
        lat_data.to_mut().set(inp, out, None, lat);
    }
    let lat_data: &LatData = &lat_data;

    let mut input_reg_operands = Vec::new();
    let mut input_flag_operands = Vec::new();
    let mut input_mem_operands = Vec::new();
    let mut output_reg_operands = Vec::new();
    let mut output_flag_operands = Vec::new();
    let mut output_mem_operands = Vec::new();
    let mut mem_addr_operands = Vec::new();
    let mut agen_operands = Vec::new();

    // outputOperandsDict: operand name -> its operands (the register or memory operand, or the flag operands), in the order of
    // the Python dict; `None` stands for the flag operands (output_flag_operands)
    let mut output_operands_dict: Vec<(&str, Option<OpId>)> = Vec::new();
    fn dict_set<'n>(dict: &mut Vec<(&'n str, Option<OpId>)>, name: &'n str, ops: Option<OpId>) {
        match dict.iter_mut().find(|(n, _)| *n == name) {
            Some((_, v)) => *v = ops,
            None => dict.push((name, ops)),
        }
    }
    for &(n, r) in &instr_output_reg_operands {
        let reg_op = new_reg(operands, r);
        output_reg_operands.push(reg_op);
        dict_set(&mut output_operands_dict, n, Some(reg_op));
    }
    if let Some(flag_operand) = instr_flag_operand {
        let flags_w: &[String] = entry.flags_w.as_deref().unwrap_or(&[]);
        if flags_w.iter().any(|f| f == "C") {
            output_flag_operands.push(new_operand(operands, Operand::Flag { flags: "C".to_string() }));
        }
        if "SPAZO".chars().any(|flag| flags_w.iter().any(|f| f.chars().eq([flag]))) {
            output_flag_operands.push(new_operand(operands, Operand::Flag { flags: "SPAZO".to_string() }));
        }
        if !output_flag_operands.is_empty() {
            dict_set(&mut output_operands_dict, flag_operand, None);
        }
    }
    for &(n, m) in &instr_output_mem_operands {
        let mem_op = new_operand(operands, Operand::Mem { mem_addr: m.clone() });
        output_mem_operands.push(mem_op);
        dict_set(&mut output_operands_dict, n, Some(mem_op));
    }
    let output_operands_dict: Vec<(&str, &[OpId])> = output_operands_dict
        .iter()
        .map(|(n, op)| (*n, op.as_ref().map_or(output_flag_operands.as_slice(), std::slice::from_ref)))
        .collect();

    // latencies: (input operand, output operand) -> latency, in the order of the Python dict
    let mut latencies: Vec<(OpId, OpId, i64)> = Vec::new();
    fn lat_set(latencies: &mut Vec<(OpId, OpId, i64)>, key: (OpId, OpId), lat: i64) {
        match latencies.iter_mut().find(|(i, o, _)| (*i, *o) == key) {
            Some((_, _, l)) => *l = lat,
            None => latencies.push((key.0, key.1, lat)),
        }
    }
    for &(inp_n, inp_r) in &instr_input_reg_operands {
        // e.g., zero idioms; for the experimental configurations, only for instructions whose operands are the same register
        // (with different registers, a latency of 0 means that the output is available as soon as the input is)
        if !may_be_eliminated
            && (same_reg || !config.experimental)
            && output_operands_dict.iter().all(|&(o, _)| lat_data.get(inp_n, o, None).unwrap_or(1) == 0)
        {
            continue;
        }
        let reg_op = new_reg(operands, inp_r);
        input_reg_operands.push(reg_op);
        for &(out_n, out_ops) in &output_operands_dict {
            for &out_op in out_ops {
                lat_set(&mut latencies, (reg_op, out_op), lat_data.get(inp_n, out_n, None).unwrap_or(1));
            }
        }
    }

    // experimental configurations: if uops.info measured a latency of 0 from the flags to all register outputs (shifts and
    // rotates by CL), the flags are not an input
    if let Some(flag_operand) = instr_flag_operand {
        if config.experimental
            && !instr_output_reg_operands.is_empty()
            && instr_output_reg_operands.iter().all(|(out_n, _)| lat_data.get(flag_operand, out_n, None).unwrap_or(1) == 0)
        {
            instr_flag_operand = None;
        }
    }
    if let Some(flag_operand) = instr_flag_operand {
        let flags_r: &[String] = entry.flags_r.as_deref().unwrap_or(&[]);
        if flags_r.iter().any(|f| f == "C") {
            input_flag_operands.push(new_operand(operands, Operand::Flag { flags: "C".to_string() }));
        }
        if "SPAZO".chars().any(|flag| flags_r.iter().any(|f| f.chars().eq([flag]))) {
            input_flag_operands.push(new_operand(operands, Operand::Flag { flags: "SPAZO".to_string() }));
        }
        for &flag_op in &input_flag_operands {
            for &(out_n, out_ops) in &output_operands_dict {
                for &out_op in out_ops {
                    lat_set(&mut latencies, (flag_op, out_op), lat_data.get(flag_operand, out_n, None).unwrap_or(1));
                }
            }
        }
    }

    for &(inp_n, inp_m) in &instr_input_mem_operands {
        let mem_op = new_operand(operands, Operand::Mem { mem_addr: inp_m.clone() });
        if has(inp_n, "AGEN") {
            agen_operands.push(mem_op);
        } else {
            input_mem_operands.push(mem_op);
            for &(out_n, out_ops) in &output_operands_dict {
                for &out_op in out_ops {
                    lat_set(&mut latencies, (mem_op, out_op), lat_data.get(inp_n, out_n, Some(LatKind::Mem)).unwrap_or(1));
                }
            }
        }
    }

    let n_mem_operands = d.mem_operands.len();
    for (inp_n, inp_m) in &d.mem_operands {
        for (reg, addr_type) in [(&inp_m.base, LatKind::Addr), (&inp_m.index, LatKind::AddrI)] {
            let Some(reg) = reg else { continue };
            let is_implicit_stack_operand =
                reg == "RSP" && dec.implicit_rsp_change != 0 && (n_mem_operands == 1 || inp_n == "MEM1");
            let reg_op = new_operand(operands, Operand::Reg { reg: reg.clone(), is_implicit_stack_operand });
            if has(inp_n, "AGEN") {
                input_reg_operands.push(reg_op);
            } else {
                mem_addr_operands.push(reg_op);
            }
            for &(out_n, out_ops) in &output_operands_dict {
                for &out_op in out_ops {
                    lat_set(&mut latencies, (reg_op, out_op), lat_data.get(inp_n, out_n, Some(addr_type)).unwrap_or(1));
                }
            }
        }
    }

    if !complex_decoder && (uops_ms != 0 || uops_mite + uops_ms > 1) {
        complex_decoder = true;
    }

    if matches!(entry.string.as_str(), "POP (R16)" | "POP (R64)") && d.opcode.ends_with("5C") {
        complex_decoder |= config.pop5c_requires_complex_decoder;
        if config.pop5c_ends_decode_group {
            n_available_simple_decoders = 0;
        }
    }

    let port_ref = match port_data {
        Ports::Dict(id) => id,
        Ports::New(dict) => dicts.new_dict(dict),
    };
    if dec.zmm_rule_applies {
        // if an instruction uses zmm registers, port 1 is not available for other vector instructions
        // (this changes the dict object in place: if it is the table's, for all instructions that use it)
        let applies = |p: &str| p.contains('1') && p != "1";
        let any = match &dicts.dicts[port_ref] {
            Slot::Table(d) => d.keys().any(|p| applies(p)),
            Slot::Own(d) => d.iter().any(|(p, _)| applies(p)),
        };
        if any {
            let dict = dicts.get_mut(port_ref);
            let items: Dict = dict.clone();
            for (p, u) in items {
                if applies(&p) {
                    dict_shift_remove(dict, &p);
                    port_add(dict, &p.replace('1', ""), u);
                }
            }
        }
    }

    if no_micro_fusion {
        retire_slots = uops.max(uops_mite + uops_ms);
        uops_mite = retire_slots - uops_ms;
        if uops_mite > 4 {
            uops_ms += uops_mite - 4;
            uops_mite = 4;
        }
        if uops_mite > 1 {
            complex_decoder = true;
            n_available_simple_decoders = (5 - uops_mite).min(n_available_simple_decoders).min(if uops_ms != 0 { 0 } else { 3 });
        }
    }

    let macro_fusible_with: Vec<String> = if no_macro_fusion { Vec::new() } else { entry.macro_fusible.clone().unwrap_or_default() };

    let mut instruction = Instr {
        is_unknown: false,
        asm: d.asm.clone(),
        opcode: d.opcode.clone(),
        pos_nominal_opcode: d.pos_nominal_opcode as i64,
        instr_str: entry.string.clone(),
        port_data: Vec::new(), // set at the end of get_instructions
        uops,
        retire_slots,
        uops_mite,
        uops_ms,
        div_cycles,
        input_reg_operands,
        input_flag_operands,
        input_mem_operands,
        output_reg_operands,
        output_flag_operands,
        output_mem_operands,
        mem_addr_operands,
        agen_operands,
        latencies,
        tp,
        immediate: d.imm0,
        lcp_stall: dec.lcp_stall,
        implicit_rsp_change: dec.implicit_rsp_change,
        may_be_eliminated,
        complex_decoder,
        n_available_simple_decoders: Some(n_available_simple_decoders),
        has_lock_prefix,
        is_branch_instr: dec.is_branch_instr,
        is_serializing_instr: SERIALIZING_IFORMS.contains(&d.iform.as_str()),
        is_load_serializing: matches!(d.iform.as_str(), "MFENCE" | "LFENCE"),
        is_store_serializing: matches!(d.iform.as_str(), "MFENCE" | "SFENCE"),
        macro_fusible_with,
        macro_fused_with_prev_instr: false,
        macro_fused_with_next_instr: false,
        cannot_be_in_dsb_due_to_jcc_erratum: false,
        folded_input_reg: None,
        mem_renaming: false,
        tp_key: TpKey::InstrStr(entry.string.clone()),
        op_cache_fields: 0,
        split_load_pattern: None,
        is_next_to_last_instr: false,
        is_last_instr: false,
        uop_properties_list: Vec::new(),
        reg_merge_uop_properties_list: Vec::new(),
    };

    let iclass = iclass_of_iform(&d.iform);
    if config.rename_immediate_folding && uops == 0 && !may_be_eliminated && !same_reg && !instr_output_reg_operands.is_empty() {
        if matches!(iclass, "ADD" | "SUB" | "INC" | "DEC") {
            instruction.folded_input_reg = Some(canonical_reg(instr_output_reg_operands[0].1));
        } else if iclass == "LEA" {
            let base_reg = d.mem_operands.values().filter_map(|m| m.base.as_deref()).find(|b| !b.is_empty());
            if let Some(base_reg) = base_reg {
                instruction.folded_input_reg = Some(canonical_reg(base_reg));
            }
        }
    }
    match config.memory_renaming.as_deref() {
        Some("data") => instruction.mem_renaming = perf.mem_rename.unwrap_or(0) != 0,
        Some("latency") => {
            let min_mem_lat = lat_data.entries.iter().filter(|e| e.kind == Some(LatKind::Mem) && e.inp == e.out).map(|e| e.lat).min();
            // loads into general-purpose registers are renamed as well
            let is_gpr_load = !instr_input_mem_operands.is_empty()
                && instr_output_mem_operands.is_empty()
                && !instr_output_reg_operands.is_empty()
                && instr_output_reg_operands.iter().all(|(_, r)| is_gp_reg(&canonical_reg_cow(r)));
            instruction.mem_renaming = min_mem_lat.is_some_and(|l| l <= 1) || is_gpr_load;
        }
        _ => {}
    }
    if instruction.mem_renaming && !instr_input_mem_operands.is_empty() && instr_output_mem_operands.is_empty() {
        let width_excluded = config.mem_renaming_widths.as_ref().filter(|w| !w.is_empty()).is_some_and(|widths| {
            // memWidth(instrStr) not in memRenamingWidths
            !mem_width(&instruction.instr_str).is_some_and(|w| widths.iter().any(|&x| i64::from(x) == w))
        });
        if width_excluded || config.mem_renaming_excluded.iter().any(|x| x == iclass) {
            instruction.mem_renaming = false;
        }
    }
    (instruction, port_ref)
}

/// `adjustLatenciesAndAddMergeUops`
fn adjust_latencies_and_add_merge_uops(instructions: &mut [Instr], operands: &mut Vec<Operand>, config: &UArchConfig) {
    if !config.high8_renamed_separately {
        return;
    }
    const REGS: [&str; 4] = ["RAX", "RBX", "RCX", "RDX"];
    /// the index in REGS of `getCanonicalReg(reg)` (RAX, RBX, RCX, RDX are the first four 64-bit registers of
    /// `gp_reg_index`; the canonical register of any other register is none of them)
    fn abcd(reg: &str) -> Option<usize> {
        gp_reg_index(reg).filter(|&i| i < REGS.len())
    }
    fn reg_of(operands: &[Operand], op: OpId) -> Option<&str> {
        match &operands[op as usize] {
            Operand::Reg { reg, .. } => Some(reg),
            _ => None,
        }
    }
    let mut high8_reg_clean = [true; 4];

    fn process_instr_reg_outputs(instr: &Instr, operands: &[Operand], high8_reg_clean: &mut [bool; 4]) {
        for &op in instr.input_reg_operands.iter().chain(&instr.mem_addr_operands).chain(&instr.output_reg_operands) {
            let reg = reg_of(operands, op).expect("register operand");
            match abcd(reg) {
                Some(i) if reg_size(reg) > 8 => high8_reg_clean[i] = true,
                _ => {
                    if is_high8_reg(reg) && instr.output_reg_operands.contains(&op) {
                        let i = abcd(reg).expect("high-8 register");
                        high8_reg_clean[i] = false;
                    }
                }
            }
        }
    }

    for instr in instructions.iter() {
        process_instr_reg_outputs(instr, operands, &mut high8_reg_clean);
    }
    for instr in instructions.iter_mut() {
        for (in_op, _, lat) in instr.latencies.iter_mut() {
            if let Some(reg) = reg_of(operands, *in_op) {
                if is_high8_reg(reg) && high8_reg_clean[abcd(reg).expect("high-8 register")] {
                    *lat += 1;
                }
            }
        }

        // instr.inputRegOperands + instr.memAddrOperands
        let n_in = instr.input_reg_operands.len() + instr.mem_addr_operands.len();
        for k in 0..n_in {
            let in_op = if k < instr.input_reg_operands.len() {
                instr.input_reg_operands[k]
            } else {
                instr.mem_addr_operands[k - instr.input_reg_operands.len()]
            };
            let reg = reg_of(operands, in_op).expect("register operand");
            if let Some(i) = abcd(reg) {
                if reg_size(reg) > 8 && !high8_reg_clean[i] {
                    // the canonical register is REGS[i]
                    let canonical_in_op = new_reg(operands, REGS[i]);
                    let canonical_out_op = new_reg(operands, REGS[i]);
                    let mut props = uop_properties(Some(vec!["1".to_string(), "5".to_string()]), vec![canonical_in_op], vec![canonical_out_op]);
                    props.latencies = vec![(canonical_out_op, 1)];
                    props.is_reg_merge_uop = true;
                    instr.reg_merge_uop_properties_list.push(props);
                }
            }
        }

        process_instr_reg_outputs(instr, operands, &mut high8_reg_clean);
    }
}

/// `UopProperties(instr, possiblePorts, inputOperands, outputOperands, {})` with the defaults of the other attributes
fn uop_properties(possible_ports: Option<Vec<String>>, input_operands: Vec<OpId>, output_operands: Vec<OpId>) -> UopProperties {
    UopProperties {
        possible_ports,
        input_operands,
        output_operands,
        latencies: Vec::new(),
        div_cycles: 0,
        is_load_uop: false,
        forward_delay: 0,
        forward_fail_delay: 0,
        is_store_address_uop: false,
        mem_addr: None,
        is_store_data_uop: false,
        is_first_uop_of_instr: false,
        is_last_uop_of_instr: false,
        is_reg_merge_uop: false,
    }
}

/// `computeUopProperties`
fn compute_uop_properties(instructions: &mut [Instr], operands: &mut Vec<Operand>, config: &UArchConfig) {
    for instr in instructions.iter_mut() {
        if instr.macro_fused_with_prev_instr {
            continue;
        }

        let mut load_pcs: Vec<&str> = Vec::new();
        let mut store_address_pcs: Vec<&str> = Vec::new();
        let mut store_data_pcs: Vec<&str> = Vec::new();
        let mut non_mem_pcs: Vec<&str> = Vec::new();
        for (pc, n) in &instr.port_data {
            let uses_any = |config_ports: &str| config_ports.chars().any(|p| pc.contains(p));
            let list = if uses_any(&config.store_addr_ports) {
                &mut store_address_pcs
            } else if uses_any(&config.load_ports) {
                &mut load_pcs
            } else if uses_any(&config.store_data_ports) {
                &mut store_data_pcs
            } else {
                &mut non_mem_pcs
            };
            for _ in 0..*n {
                list.push(pc.as_str());
            }
        }
        // the possible ports of a uop: the ports of `pc`, one character each
        let ports = |pc: &str| -> Option<Vec<String>> { Some(pc.chars().map(String::from).collect()) };

        while store_data_pcs.len() > store_address_pcs.len() {
            if let Some(pc) = load_pcs.pop() {
                store_address_pcs.push(pc);
            } else {
                store_data_pcs.pop();
            }
        }

        // latencies.get((i, o)); the keys of instr.latencies are unique
        let lat = |i: OpId, o: OpId| instr.latencies.iter().find(|&&(a, b, _)| a == i && b == o).map(|&(_, _, l)| l);
        let reg_and_flag = |regs: &[OpId], flags: &[OpId]| -> Vec<OpId> { regs.iter().chain(flags).copied().collect() };

        let mut load_uop_props: Vec<UopProperties> = Vec::new();
        let mut store_uop_props: Vec<UopProperties> = Vec::new();
        let mut non_mem_uop_props: VecDeque<UopProperties> = VecDeque::new();
        let mut load_pseudo_ops: Vec<OpId> = Vec::new();
        let mut store_pseudo_ops: Vec<OpId> = Vec::new();

        for (i, pc) in load_pcs.iter().enumerate() {
            let output_operands = if !non_mem_pcs.is_empty() {
                let out_op = new_operand(operands, Operand::Pseudo);
                load_pseudo_ops.push(out_op);
                vec![out_op]
            } else {
                instr.output_reg_operands.clone()
            };
            let mem_addr = (!instr.input_mem_operands.is_empty()).then(|| {
                let op = instr.input_mem_operands[i.min(instr.input_mem_operands.len() - 1)];
                mem_addr_of(operands, op).clone()
            });
            let mut uop_latencies: Vec<(OpId, i64)> = output_operands.iter().map(|&o| (o, config.load_latency)).collect(); // ToDo: actual latencies
            if config.is_amd && non_mem_pcs.is_empty() {
                // e.g., vector loads have a higher latency than integer loads
                for (out_op, l) in uop_latencies.iter_mut() {
                    // max(...) of the latencies from the address registers; the first of equal elements, which are equal numbers
                    *l = instr.mem_addr_operands.iter().filter_map(|&a| lat(a, *out_op)).max().unwrap_or(config.load_latency);
                }
            }
            let mut props = uop_properties(ports(pc), instr.mem_addr_operands.clone(), output_operands);
            props.latencies = uop_latencies;
            props.is_load_uop = true;
            props.mem_addr = mem_addr;
            props.forward_delay = config.store_forward_delay;
            props.forward_fail_delay = config.store_forward_fail_delay;
            if let Some(d) = config.load_op_forward_delay {
                if !non_mem_pcs.is_empty() && instr.output_mem_operands.is_empty() {
                    props.forward_delay = d;
                }
            }
            if !instr.output_mem_operands.is_empty() {
                props.forward_delay = config.rmw_forward_delay;
                if non_mem_pcs.len() == 1 && !instr.mem_renaming {
                    props.forward_delay += config.simple_rmw_forward_delay;
                }
                if let Some(d) = config.rotate_carry_rmw_forward_delay {
                    // `ROTATE_CARRY_RMW_RE.match(instr.instrStr)`: r'^(RCL|RCR)[ _]'
                    if ["RCL", "RCR"]
                        .iter()
                        .any(|m| instr.instr_str.strip_prefix(m).map_or(false, |r| r.starts_with(' ') || r.starts_with('_')))
                    {
                        props.forward_delay = d;
                    }
                }
            }
            load_uop_props.push(props);
        }

        for (i, (st_a_pc, st_d_pc)) in store_address_pcs.iter().zip(&store_data_pcs).enumerate() {
            let mem_addr = (!instr.output_mem_operands.is_empty()).then(|| {
                let op = instr.output_mem_operands[i.min(instr.output_mem_operands.len() - 1)];
                mem_addr_of(operands, op).clone()
            });
            // storeAddress uop needs to be added before storeData uop (the order is important for the renamer)
            let mut props = uop_properties(ports(st_a_pc), instr.mem_addr_operands.clone(), Vec::new());
            props.is_store_address_uop = true;
            props.mem_addr = mem_addr;
            store_uop_props.push(props);

            let st_d_input_operands = if !non_mem_pcs.is_empty() {
                let input_operand = new_operand(operands, Operand::Pseudo);
                store_pseudo_ops.push(input_operand);
                vec![input_operand]
            } else {
                reg_and_flag(&instr.input_reg_operands, &instr.input_flag_operands)
            };
            let mut props = uop_properties(ports(st_d_pc), st_d_input_operands, Vec::new());
            props.is_store_data_uop = true;
            store_uop_props.push(props);
        }

        if !non_mem_pcs.is_empty() {
            let all = |ins: &[OpId], outs: &[OpId], value: i64| ins.iter().all(|&i| outs.iter().all(|&o| lat(i, o) == Some(value)));
            if instr.mem_addr_operands.is_empty()
                && non_mem_pcs.len() == 3
                && !instr.input_reg_operands.is_empty()
                && !instr.output_reg_operands.is_empty()
                && !instr.input_flag_operands.is_empty()
                && !instr.output_flag_operands.is_empty()
                && all(&instr.input_reg_operands, &instr.output_reg_operands, 1)
                && all(&instr.input_reg_operands, &instr.output_flag_operands, 2)
                && all(&instr.input_flag_operands, &instr.output_reg_operands, 0)
                && all(&instr.input_flag_operands, &instr.output_flag_operands, 2)
            {
                // special case for, e.g., SHL (R64, CL)
                let r_pseudo_op = new_operand(operands, Operand::Pseudo);
                let mut r_output_operands = instr.output_reg_operands.clone();
                r_output_operands.push(r_pseudo_op);
                let mut props = uop_properties(ports(non_mem_pcs[0]), instr.input_reg_operands.clone(), r_output_operands.clone());
                props.latencies = r_output_operands.iter().map(|&op| (op, 1)).collect();
                non_mem_uop_props.push_back(props);
                let f_pseudo_op = new_operand(operands, Operand::Pseudo);
                let mut props = uop_properties(ports(non_mem_pcs[1]), instr.input_flag_operands.clone(), vec![f_pseudo_op]);
                props.latencies = vec![(f_pseudo_op, 1)];
                non_mem_uop_props.push_back(props);
                let mut props =
                    uop_properties(ports(non_mem_pcs[2]), vec![r_pseudo_op, f_pseudo_op], instr.output_flag_operands.clone());
                props.latencies = instr.output_flag_operands.iter().map(|&op| (op, 1)).collect();
                non_mem_uop_props.push_back(props);
            } else {
                let has_agen = !instr.agen_operands.is_empty();
                // inputRegOperands + inputFlagOperands + (memAddrOperands if agenOperands else [])
                let mut arch_input_operands = reg_and_flag(&instr.input_reg_operands, &instr.input_flag_operands);
                if has_agen {
                    arch_input_operands.extend(&instr.mem_addr_operands);
                }
                let arch_output_operands = reg_and_flag(&instr.output_reg_operands, &instr.output_flag_operands);
                let mut non_mem_input_operands = arch_input_operands.clone();
                non_mem_input_operands.extend(&load_pseudo_ops);
                let mut non_mem_output_operands = arch_output_operands.clone();
                non_mem_output_operands.extend(&store_pseudo_ops);

                // latencies between nonMemInputOperands and nonMemOutputOperands
                let mut adjusted_latencies: Vec<((OpId, OpId), i64)> = Vec::new();
                let set = |adjusted_latencies: &mut Vec<((OpId, OpId), i64)>, key: (OpId, OpId), l: i64| match adjusted_latencies.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, v)) => *v = l,
                    None => adjusted_latencies.push((key, l)),
                };
                // max([max(1, latencies.get((inOp, outMemOp), 1) - x) for outMemOp in outputMemOperands] or [1])
                let lat_to_mem = |in_op: OpId, x: i64| -> i64 {
                    instr.output_mem_operands.iter().map(|&m| (lat(in_op, m).unwrap_or(1) - x).max(1)).max().unwrap_or(1)
                };
                for &in_op in &arch_input_operands {
                    for &out_op in &arch_output_operands {
                        set(&mut adjusted_latencies, (in_op, out_op), lat(in_op, out_op).unwrap_or(1));
                    }
                    for &store_pseudo_op in &store_pseudo_ops {
                        set(&mut adjusted_latencies, (in_op, store_pseudo_op), lat_to_mem(in_op, 4)); // ToDo
                    }
                }
                if !has_agen {
                    for &in_mem_addr_op in &instr.mem_addr_operands {
                        for &load_pseudo_op in &load_pseudo_ops {
                            for &out_op in &arch_output_operands {
                                let l = (lat(in_mem_addr_op, out_op).unwrap_or(1) - config.load_latency).max(1); // ToDo
                                set(&mut adjusted_latencies, (load_pseudo_op, out_op), l);
                            }
                        }
                    }
                }
                for &in_mem_op in &instr.input_mem_operands {
                    for &load_pseudo_op in &load_pseudo_ops {
                        for &store_pseudo_op in &store_pseudo_ops {
                            // with memory renaming, only the latency of the operation itself remains on the path through memory
                            let l = if instr.mem_renaming { 1 } else { lat_to_mem(in_mem_op, config.load_latency) }; // ToDo
                            set(&mut adjusted_latencies, (load_pseudo_op, store_pseudo_op), l);
                        }
                    }
                }
                let adjusted = |i: OpId, o: OpId| adjusted_latencies.iter().find(|(k, _)| *k == (i, o)).map_or(1, |(_, l)| *l);

                // maps latencies to inputs with these latencies
                let mut lat_classes: BTreeMap<i64, Vec<OpId>> = BTreeMap::new();
                for &in_op in &non_mem_input_operands {
                    let min_lat = non_mem_output_operands.iter().map(|&out_op| adjusted(in_op, out_op)).max().unwrap_or(1);
                    lat_classes.entry(min_lat).or_default().push(in_op);
                }

                let mut remaining_lat_class_levels: VecDeque<i64> = lat_classes.keys().copied().collect();
                let min_lat_level = remaining_lat_class_levels.pop_front().unwrap_or(1);
                // the list object minLatClass is the inputOperands of the base uop, which is extended below
                let mut base_input_operands: Vec<OpId> = lat_classes.get(&min_lat_level).cloned().unwrap_or_default();
                let base_uop_latencies: Vec<(OpId, i64)> = non_mem_output_operands
                    .iter()
                    .map(|&out_op| (out_op, base_input_operands.iter().map(|&in_op| adjusted(in_op, out_op)).max().unwrap_or(1)))
                    .collect();

                // the uops before (appendleft) and after (append) the base uop
                let mut before: Vec<UopProperties> = Vec::new();
                let mut after: Vec<UopProperties> = Vec::new();
                for pc in &non_mem_pcs[1..] {
                    if let Some(lat_level) = remaining_lat_class_levels.pop_front() {
                        let pseudo_op = new_operand(operands, Operand::Pseudo);
                        base_input_operands.push(pseudo_op);
                        let mut props = uop_properties(ports(pc), lat_classes[&lat_level].clone(), vec![pseudo_op]);
                        props.latencies = vec![(pseudo_op, lat_level - min_lat_level)];
                        before.push(props);
                    } else {
                        after.push(uop_properties(ports(pc), non_mem_input_operands.clone(), Vec::new()));
                    }
                }

                for lat_level in &remaining_lat_class_levels {
                    // nonMemUopProps[-1].inputOperands.extend(...): the base uop, or the list that the uops after it share
                    if after.is_empty() {
                        base_input_operands.extend(&lat_classes[lat_level]);
                    } else {
                        for props in after.iter_mut() {
                            props.input_operands.extend(&lat_classes[lat_level]);
                        }
                    }
                }

                let mut base_uop_prop = uop_properties(ports(non_mem_pcs[0]), base_input_operands, non_mem_output_operands);
                base_uop_prop.latencies = base_uop_latencies;
                base_uop_prop.div_cycles = instr.div_cycles;
                non_mem_uop_props.extend(before.into_iter().rev());
                non_mem_uop_props.push_back(base_uop_prop);
                non_mem_uop_props.extend(after);
            }
        }

        // nonMemUopProps need to come after loadUopProps, and storeUopProps after nonMemUopProps because of PseudoOps and micro-fusion
        let mut list = load_uop_props;
        list.extend(non_mem_uop_props);
        list.extend(store_uop_props);

        for _ in 0..(instr.retire_slots - list.len() as i64) {
            list.push(uop_properties(None, Vec::new(), Vec::new()));
        }

        let Some(last) = list.len().checked_sub(1) else {
            panic!("IndexError: instruction {:?} has no uops and no retire slots", instr.asm);
        };
        list[0].is_first_uop_of_instr = true;
        list[last].is_last_uop_of_instr = true;
        instr.uop_properties_list = list;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn narrow_mem_operands() {
        assert!(has_narrow_mem_operand("MOV (M8, R8l)"));
        assert!(has_narrow_mem_operand("MOV (M16, R16)"));
        assert!(has_narrow_mem_operand("ADD (M8, I8)"));
        assert!(has_narrow_mem_operand("SETZ (M8)"));
        assert!(!has_narrow_mem_operand("FSTP (M80)"));
        assert!(!has_narrow_mem_operand("MOV (M64, R64)"));
        assert!(!has_narrow_mem_operand("MOVZX (R32, M8)"));
        assert!(!has_narrow_mem_operand("MOVDQA (M128, XMM)"));
    }
}
