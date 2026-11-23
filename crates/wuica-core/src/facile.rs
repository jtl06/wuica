//! Bottleneck analysis: the analytical throughput limits and the latency graph of uiCA's `facile.py` (the functions that
//! `uiCA.py` uses), and the text of `printBottlenecks` (`uiCA.py`).
//!
//! Every function is a literal port of the Python function named in its documentation: same operations in the same order, also
//! where the reference looks wrong (see "Quirks" below). The limits are returned as `f64`; where Python returns an `int`, the
//! value is the same number (all integers involved are small).
//!
//! The parts that need results of the simulation ([`compute_port_usage_limit`] for instructions that may be eliminated, and
//! [`bottleneck_report`]) take them as a [`SimSummary`], a plain description of the instruction instances of the relevant rounds.
//!
//! Quirks of the reference that are ported as they are:
//! - `computeDSBLimit` uses 6 uops per cycle and 32-byte blocks for every microarchitecture, and its code length is the length
//!   of all instructions but the last one (also if the last two are macro-fused).
//! - `computePredecLimit` uses 16-byte blocks and 5 instructions per cycle for every microarchitecture, and the block before
//!   the first one is the last one (`L[bi-1]` with `bi == 0`), also for code that is not a loop.
//! - `generateLatencyGraph` looks up the base and index registers of a memory operand by their names as written (`EAX` is not
//!   found, the keys are canonical names), and its test for the implicit change of RSP,
//!   `prevInOp in instr.inputRegOperands+instr.memAddrOperands`, compares an operand of the *producing* instruction with the
//!   operands of the *consuming* instruction by identity, so it can only hold if both are the same instruction.
//! - `computePortUsageLimit` adds the average number of non-eliminated uops of an instruction that may be eliminated once for
//!   *each* entry of its `portData`.
//! - `printBottlenecks` reports "Divider" if `divUsage / nRounds >= .99 * TP`, which also holds for a throughput of 0.
//! - Python (3.12) adds floats in `sum()` with compensated summation; [`compute_port_usage_limit`] does the same.

use crate::config::UArchConfig;
use crate::decoded::{DecodedInstr, MemAddr};
use crate::model::{Instr, InstrList, OpId, Operand};
use crate::fasthash::FastMap;
use crate::substr::has;
use crate::x64::{canonical_reg_cow, reg_size};
use indexmap::IndexMap;
use std::borrow::Cow;

// ---------------------------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------------------------

/// Python's `round(x, 2)`: the double that is nearest to the correctly rounded (half to even, on the exact binary value)
/// two-digit decimal. Rust's `{:.2}` rounds in the same way.
pub fn py_round2(x: f64) -> f64 {
    format!("{x:.2}").parse().expect("a number")
}

/// Python's `'{:.2f}'.format(x)`.
pub fn py_format2(x: f64) -> String {
    format!("{x:.2}")
}

/// A Python number that is an `int` or a `float` (only where the difference matters: `sum()`).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Num {
    Int(i64),
    Float(f64),
}

impl Num {
    fn as_f64(self) -> f64 {
        match self {
            Num::Int(i) => i as f64,
            Num::Float(f) => f,
        }
    }

    /// `self + other`
    fn add(self, other: Num) -> Num {
        match (self, other) {
            (Num::Int(a), Num::Int(b)) => Num::Int(a + b),
            (a, b) => Num::Float(a.as_f64() + b.as_f64()),
        }
    }
}

/// Python's `sum()` (CPython 3.12): integers are added exactly; from the first float on, floats are added with Neumaier's
/// compensated summation (integers without compensation).
fn py_sum(items: impl IntoIterator<Item = Num>) -> Num {
    let mut items = items.into_iter();
    let mut i_result: i64 = 0;
    let mut f_result;
    loop {
        match items.next() {
            None => return Num::Int(i_result),
            Some(Num::Int(v)) => i_result += v,
            Some(Num::Float(x)) => {
                f_result = i_result as f64 + x;
                break;
            }
        }
    }
    let mut c = 0.0f64;
    for item in items {
        match item {
            Num::Float(x) => {
                let t = f_result + x;
                if f_result.abs() >= x.abs() {
                    c += (f_result - t) + x;
                } else {
                    c += (x - t) + f_result;
                }
                f_result = t;
            }
            Num::Int(v) => f_result += v as f64,
        }
    }
    if c != 0.0 && c.is_finite() {
        f_result += c;
    }
    Num::Float(f_result)
}

/// `math.ceil(a / b)` for non-negative `a` and positive `b` (Python divides as floats; the values are small integers).
fn ceil_div(a: i64, b: i64) -> i64 {
    (a as f64 / b as f64).ceil() as i64
}

fn gcd(mut a: i64, mut b: i64) -> i64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a.abs()
}

// ---------------------------------------------------------------------------------------------------------------------------
// Results of the simulation that the analysis reads
// ---------------------------------------------------------------------------------------------------------------------------

/// `InstrInstance.source`: where the uops of an instruction instance came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstrSource {
    /// `'MITE'`
    Mite,
    /// `'DSB'`
    Dsb,
    /// `'LSD'`
    Lsd,
}

/// An unfused-domain uop of an instruction instance (uiCA's `Uop`), reduced to what the analysis reads.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UopSummary {
    /// `uop.actualPort`: the port the uop was dispatched to (`None`: no port)
    pub actual_port: Option<String>,
    /// `uop.eliminated`
    pub eliminated: bool,
    /// `uop.prop.divCycles`
    pub div_cycles: i64,
}

/// An instruction instance (uiCA's `InstrInstance`), reduced to what the analysis reads.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct InstrInstanceSummary {
    /// `instrI.source` (`None` with the simple front end)
    pub source: Option<InstrSource>,
    /// `[uop for lamUop in instrI.uops for uop in lamUop.getUnfusedUops()]`
    pub uops: Vec<UopSummary>,
    /// `[uop for lamUop in instrI.regMergeUops + instrI.stackSyncUops for uop in lamUop.getUnfusedUops()]`
    pub other_uops: Vec<UopSummary>,
}

/// The results of the simulation that `printBottlenecks` and `computePortUsageLimit` read (the names are those of
/// `_runSimulation` in `uiCA.py`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SimSummary {
    /// `TP`: the throughput that the simulation returns
    pub tp: f64,
    /// `not frontEnd.unroll`, i.e. `instructions[-1].isBranchInstr`
    pub is_loop: bool,
    /// `lastRelevantRound - firstRelevantRound + 1`
    pub n_rounds: i64,
    /// `relevantInstrInstancesForInstr`: for each instruction (same index as `InstrList::instrs`), its instances `instrI` in
    /// `frontEnd.allGeneratedInstrInstances` with `firstRelevantRound <= instrI.rnd <= lastRelevantRound`, in that order
    pub instances: Vec<Vec<InstrInstanceSummary>>,
}

/// What the bottleneck analysis reads from a simulation: the questions it asks of a [`SimSummary`]. The analysis
/// ([`bottleneck_values_for`]) is written against this trait, so that it can also read the result of a simulation directly,
/// without first making a [`SimSummary`] (which has a `String` for each uop).
pub trait SimView {
    /// `TP`
    fn tp(&self) -> f64;
    /// `loop`
    fn is_loop(&self) -> bool;
    /// `nRounds`
    fn n_rounds(&self) -> i64;
    /// the number of instances of instruction `instr` in the relevant rounds (0 for an instruction without an entry)
    fn n_instances(&self, instr: usize) -> usize;
    /// the number of uops (`InstrInstanceSummary::uops`, not the other uops) of the instances of `instr` that are not eliminated
    fn not_eliminated_uops(&self, instr: usize) -> i64;
    /// whether an instance of an instruction came from `source` (an instruction whose first instance did)
    fn any_instr_from(&self, source: InstrSource) -> bool;
    /// over the unfused uops of all instances (`uops` and `other_uops`): (`max(Counter(uop.actualPort for uop in allUnfusedUops
    /// if uop.actualPort).values())`, `None` if no uop has a port; the sum of their `divCycles`)
    fn port_and_div_usage(&self) -> (Option<i64>, i64);
}

impl SimView for SimSummary {
    fn tp(&self) -> f64 {
        self.tp
    }
    fn is_loop(&self) -> bool {
        self.is_loop
    }
    fn n_rounds(&self) -> i64 {
        self.n_rounds
    }
    fn n_instances(&self, instr: usize) -> usize {
        self.instances.get(instr).map_or(0, |l| l.len())
    }
    fn not_eliminated_uops(&self, instr: usize) -> i64 {
        let list: &[InstrInstanceSummary] = self.instances.get(instr).map(|l| l.as_slice()).unwrap_or(&[]);
        list.iter().map(|ii| ii.uops.iter().filter(|u| !u.eliminated).count() as i64).sum()
    }
    fn any_instr_from(&self, source: InstrSource) -> bool {
        self.instances.iter().any(|ii_list| ii_list.first().is_some_and(|ii| ii.source == Some(source)))
    }
    fn port_and_div_usage(&self) -> (Option<i64>, i64) {
        let all_unfused_uops = || self.instances.iter().flatten().flat_map(|ii| ii.uops.iter().chain(&ii.other_uops));
        let mut port_usage_c: IndexMap<&str, i64> = IndexMap::new();
        for uop in all_unfused_uops() {
            if let Some(port) = uop.actual_port.as_deref().filter(|p| !p.is_empty()) {
                *port_usage_c.entry(port).or_insert(0) += 1;
            }
        }
        (port_usage_c.values().copied().max(), all_unfused_uops().map(|uop| uop.div_cycles).sum())
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------------------------------

/// `computePortUsageLimit(instructions, instrInstancesForInstr)`. `instances` is [`SimSummary::instances`]; `None` is Python's
/// default `{}` (instructions that may be eliminated are then left out).
pub fn compute_port_usage_limit(instrs: &InstrList, instances: Option<&[Vec<InstrInstanceSummary>]>) -> f64 {
    port_usage_limit(instrs, |idx| {
        let list: &[InstrInstanceSummary] = instances.and_then(|i| i.get(idx)).map(|l| l.as_slice()).unwrap_or(&[]);
        let not_eliminated: i64 = list.iter().map(|ii| ii.uops.iter().filter(|u| !u.eliminated).count() as i64).sum();
        (list.len(), not_eliminated)
    })
}

/// [`compute_port_usage_limit`]; `instances(idx)` is (number of instances of the instruction, number of their uops that are
/// not eliminated), which is only asked for instructions that may be eliminated
fn port_usage_limit(instrs: &InstrList, instances: impl Fn(usize) -> (usize, i64)) -> f64 {
    // frozenset(ports) -> number of uops, in the order of insertion; a set of ports is a bit set of the characters
    let mut port_usage: Vec<(u128, Num)> = Vec::new();
    for (idx, instr) in instrs.instrs.iter().enumerate() {
        if instr.macro_fused_with_prev_instr {
            continue;
        }
        for (ports, n_uops) in &instr.port_data {
            let mut n_uops = Num::Int(*n_uops);
            if instr.may_be_eliminated {
                let (n_instances, not_eliminated) = instances(idx);
                if n_instances == 0 {
                    continue;
                }
                n_uops = Num::Float(not_eliminated as f64 / n_instances as f64);
            }
            let set = port_set(ports);
            match port_usage.iter_mut().find(|(s, _)| *s == set) {
                Some((_, n)) => *n = n.add(n_uops),
                None => port_usage.push((set, Num::Int(0).add(n_uops))),
            }
        }
    }

    let mut unions: Vec<u128> = Vec::new();
    for (pc, _) in &port_usage {
        for (pc2, _) in &port_usage {
            if !unions.contains(&(pc | pc2)) {
                unions.push(pc | pc2);
            }
        }
    }
    let mut tp = 0.0f64;
    for pc in unions {
        let uops = py_sum(port_usage.iter().filter(|(pc2, _)| pc2 & !pc == 0).map(|(_, u)| *u));
        assert!(pc != 0, "ZeroDivisionError: portData with an empty set of ports");
        let v = uops.as_f64() / pc.count_ones() as f64;
        // max(TP, v)
        if v > tp {
            tp = v;
        }
    }
    tp
}

/// `frozenset(ports)`: the ports are the characters of the string.
fn port_set(ports: &str) -> u128 {
    ports.chars().fold(0, |set, c| {
        assert!(c.is_ascii(), "port names are ASCII characters");
        set | 1u128 << (c as u32)
    })
}

/// `computeIssueLimit(instructions, uArchConfig)`
pub fn compute_issue_limit(instrs: &InstrList, config: &UArchConfig) -> f64 {
    let slots: i64 = instrs.instrs.iter().filter(|i| !i.macro_fused_with_prev_instr).map(|i| i.retire_slots).sum();
    slots as f64 / config.issue_width as f64
}

/// `hasLCP(instrD)`: the instruction has a length-changing prefix.
pub fn has_lcp(d: &DecodedInstr) -> bool {
    d.prefix66 != "0" && d.imm_width.unwrap_or(0) == 16
}

/// `computePredecLimit(disas, loop, alignmentOffset)`
pub fn compute_predec_limit(disas: &[DecodedInstr], is_loop: bool, alignment_offset: i64) -> f64 {
    let code_length: i64 = disas.iter().map(|d| d.opcode.len() as i64).sum::<i64>() / 2;
    let unroll = if is_loop { 1 } else { 16 / gcd(code_length, 16) };
    let n_b16_blocks = ceil_div(unroll * code_length, 16);
    let n = n_b16_blocks as usize;
    let mut l = vec![0i64; n]; // number of instr. instances whose last byte is in the given block
    let mut o = vec![0i64; n]; // ... whose nominal opcode starts in the given block but whose last byte is in the next block
    let mut lcp = vec![0i64; n]; // ... whose nominal opcode starts in the given block, and which have a length-changing prefix
    let alignment_offset = alignment_offset.rem_euclid(16);
    let mut cur_addr = if alignment_offset != 0 { -16 + alignment_offset } else { 0 };
    if !disas.is_empty() {
        for d in disas.iter().cycle() {
            if cur_addr >= unroll * code_length {
                break;
            }
            let next_addr = cur_addr + (d.opcode.len() as i64) / 2;
            let end_block = (next_addr - 1).div_euclid(16); // 16-byte block in which the last byte of the instruction is stored
            let nominal_opcode_block = (cur_addr + d.pos_nominal_opcode as i64).div_euclid(16);
            cur_addr = next_addr;

            if 0 <= end_block && end_block < n_b16_blocks {
                l[end_block as usize] += 1;
            }
            if 0 <= nominal_opcode_block && nominal_opcode_block < n_b16_blocks {
                if nominal_opcode_block != end_block {
                    o[nominal_opcode_block as usize] += 1;
                }
                if has_lcp(d) {
                    lcp[nominal_opcode_block as usize] += 1;
                }
            }
        }
    }

    let mut cycles: i64 = 0;
    for bi in 0..n {
        let prev = if bi == 0 { n - 1 } else { bi - 1 }; // L[bi-1]: the index -1 is the last block
        cycles += ceil_div(l[bi] + o[bi], 5);
        cycles += (3 * lcp[bi] - (ceil_div(l[prev] + o[prev], 5) - 1)).max(0);
    }
    cycles as f64 / unroll as f64
}

/// `computeDecLimit(instructions, uArchConfig)`
pub fn compute_dec_limit(instrs: &InstrList, config: &UArchConfig) -> f64 {
    let instructions: Vec<&Instr> = instrs.instrs.iter().filter(|i| !i.macro_fused_with_prev_instr).collect();
    assert!(!instructions.is_empty(), "computeDecLimit: no instructions (the reference does not terminate)");
    let mut first_instr_on_dec_in_round: Vec<(i64, usize)> = Vec::new(); // decoder -> round
    let mut n_avail_simple_dec: Option<i64> = Some(0);
    let mut cur_dec = config.n_decoders - 1;
    let mut n_complex_dec_in_round: Vec<i64> = Vec::new();
    let mut round = 0usize;
    loop {
        n_complex_dec_in_round.push(0);
        for (ii, instr) in instructions.iter().enumerate() {
            if instr.complex_decoder {
                cur_dec = 0;
                n_avail_simple_dec = instr.n_available_simple_decoders;
            } else if n_avail_simple_dec == Some(0)
                || (cur_dec + 1 == config.n_decoders - 1
                    && !instr.macro_fusible_with.is_empty()
                    && !config.macro_fusible_instr_can_be_decoded_as_last_instr)
            {
                cur_dec = 0;
                n_avail_simple_dec = Some(config.n_decoders - 1);
            } else {
                cur_dec += 1;
                n_avail_simple_dec = Some(n_avail_simple_dec.expect("TypeError: nAvailableSimpleDecoders is None") - 1);
            }
            if instr.is_branch_instr || instr.macro_fused_with_next_instr {
                n_avail_simple_dec = Some(0);
            }

            if cur_dec == 0 {
                n_complex_dec_in_round[round] += 1;
            }

            if ii == 0 {
                if let Some((_, first_round)) = first_instr_on_dec_in_round.iter().find(|(dec, _)| *dec == cur_dec) {
                    let sum: i64 = n_complex_dec_in_round[*first_round..round].iter().sum();
                    return sum as f64 / (round - first_round) as f64;
                }
                first_instr_on_dec_in_round.push((cur_dec, round));
            }
        }
        round += 1;
    }
}

/// `computeLSDLimit(instructions, uArchConfig)`
pub fn compute_lsd_limit(instrs: &InstrList, config: &UArchConfig) -> f64 {
    let n_uops: i64 = instrs.instrs.iter().filter(|i| !i.macro_fused_with_prev_instr).map(|i| i.uops_mite + i.uops_ms).sum();
    let lsd_unroll_count = config.lsd_unrolling.get(&n_uops.to_string()).map_or(1, |c| *c as i64);
    ceil_div(n_uops * lsd_unroll_count, config.issue_width) as f64 / lsd_unroll_count as f64
}

/// `computeDSBLimit(instructions, alignmentOffset)`
pub fn compute_dsb_limit(instrs: &InstrList, alignment_offset: i64) -> f64 {
    let n_uops: i64 = instrs.instrs.iter().filter(|i| !i.macro_fused_with_prev_instr).map(|i| i.uops_mite).sum();
    let all_but_last = &instrs.instrs[..instrs.instrs.len().saturating_sub(1)];
    let code_length: i64 = all_but_last.iter().map(|i| i.opcode.len() as i64 / 2).sum();
    if (code_length + alignment_offset).div_euclid(32) == alignment_offset.div_euclid(32) {
        ceil_div(n_uops, 6) as f64
    } else {
        n_uops as f64 / 6.0
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Abstract values (utils.py)
// ---------------------------------------------------------------------------------------------------------------------------

/// `AbstractValue(base, offset)`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct AbstractValue {
    base: u64,
    offset: i128,
}

/// `AbstractValueGenerator(initPolicy)` of `utils.py`, without `loadValueNumbering` (which `facile.py` does not use). The keys
/// (register names) are the numbers of [`Names`].
struct AbstractValueGenerator {
    /// `initPolicy == 'diff'`
    diff: bool,
    next_base: u64,
    init_value: AbstractValue,
    /// canonical register -> value (only looked up), indexed by name
    abstract_value_dict: Vec<Option<AbstractValue>>,
    /// in the order of the Python dict
    cur_instr_rnd_abstract_value_dict: Vec<(NameId, AbstractValue)>,
}

impl AbstractValueGenerator {
    fn new(init_policy: &str, names: &Names) -> Self {
        let mut g = AbstractValueGenerator {
            diff: init_policy == "diff",
            next_base: 0,
            init_value: AbstractValue { base: 0, offset: 0 },
            abstract_value_dict: vec![None; names.len()],
            cur_instr_rnd_abstract_value_dict: Vec::new(),
        };
        g.init_value = g.generate_fresh_abstract_value();
        if init_policy == "stack" {
            let v = g.generate_fresh_abstract_value();
            g.abstract_value_dict[names.rsp as usize] = Some(v);
            let v = g.generate_fresh_abstract_value();
            g.abstract_value_dict[names.rbp as usize] = Some(v);
        }
        g
    }

    fn generate_fresh_abstract_value(&mut self) -> AbstractValue {
        let v = AbstractValue { base: self.next_base, offset: 0 };
        self.next_base += 1;
        v
    }

    /// `getAbstractValueForReg(reg)`, for the name of the canonical register of `reg` (`None`: `reg` is None)
    fn get_abstract_value_for_reg(&mut self, canonical: Option<NameId>) -> Option<AbstractValue> {
        Some(self.get_abstract_value_for_canonical_reg(canonical?))
    }

    /// `getAbstractValueForReg(reg)`, for the canonical register of `reg`
    fn get_abstract_value_for_canonical_reg(&mut self, key: NameId) -> AbstractValue {
        if let Some(v) = self.abstract_value_dict[key as usize] {
            return v;
        }
        let v = if self.diff { self.generate_fresh_abstract_value() } else { self.init_value };
        self.abstract_value_dict[key as usize] = Some(v);
        v
    }

    /// `setAbstractValueForCurInstr(key, instr)`
    fn set_abstract_value_for_cur_instr(&mut self, key: NameId, instr: &Instr, canon: &CanonicalRegs) {
        let v = self.compute_abstract_value(instr, canon);
        match self.cur_instr_rnd_abstract_value_dict.iter_mut().find(|(k, _)| *k == key) {
            Some((_, value)) => *value = v,
            None => self.cur_instr_rnd_abstract_value_dict.push((key, v)),
        }
    }

    /// `finishCurInstr()`
    fn finish_cur_instr(&mut self) {
        for (k, v) in self.cur_instr_rnd_abstract_value_dict.drain(..) {
            self.abstract_value_dict[k as usize] = Some(v);
        }
    }

    /// `__computeAbstractValue(instr)`
    fn compute_abstract_value(&mut self, instr: &Instr, canon: &CanonicalRegs) -> AbstractValue {
        if let Some(&first) = instr.input_reg_operands.first() {
            let abs_val = self.get_abstract_value_for_canonical_reg(canon.reg(first));
            let s = instr.instr_str.as_str();
            if has(s, "MOV") && !has(s, "CMOV") {
                abs_val
            } else if has(s, "ADD") && instr.immediate.is_some() {
                AbstractValue { base: abs_val.base, offset: abs_val.offset + instr.immediate.unwrap() as i128 }
            } else if has(s, "SUB") && instr.immediate.is_some() {
                AbstractValue { base: abs_val.base, offset: abs_val.offset - instr.immediate.unwrap() as i128 }
            } else if has(s, "INC") {
                AbstractValue { base: abs_val.base, offset: abs_val.offset + 1 }
            } else if has(s, "DEC") {
                AbstractValue { base: abs_val.base, offset: abs_val.offset - 1 }
            } else {
                self.generate_fresh_abstract_value()
            }
        } else {
            self.generate_fresh_abstract_value()
        }
    }
}

/// The number of a string that the latency graph uses as a key (a register name, canonical or as written, or the flags of a flag
/// operand): equal strings have equal numbers.
type NameId = u32;
const NO_NAME: NameId = u32::MAX;

/// The strings of [`NameId`].
struct Names<'a> {
    ids: FastMap<Cow<'a, str>, NameId>,
    /// the numbers of "RSP" and "RBP"
    rsp: NameId,
    rbp: NameId,
}

impl<'a> Names<'a> {
    fn new() -> Self {
        let mut names = Names { ids: FastMap::default(), rsp: 0, rbp: 0 };
        names.rsp = names.id(Cow::Borrowed("RSP"));
        names.rbp = names.id(Cow::Borrowed("RBP"));
        names
    }

    fn id(&mut self, s: Cow<'a, str>) -> NameId {
        let next = self.ids.len() as NameId;
        *self.ids.entry(s).or_insert(next)
    }

    fn len(&self) -> usize {
        self.ids.len()
    }
}

/// The keys of the operands, computed once: for a register operand the name of its canonical register
/// (`getCanonicalReg(op.reg)`), for a flag operand the name of its flags, and for a memory operand the names of the canonical
/// registers of its base and index and of the base and index as written.
struct CanonicalRegs<'a> {
    operands: &'a [Operand],
    /// the name of each register or flag operand (NO_NAME for the others)
    name: Vec<NameId>,
    /// for each memory operand: canonical base, canonical index, base as written, index as written (NO_NAME: none)
    mem: Vec<[NameId; 4]>,
}

impl<'a> CanonicalRegs<'a> {
    fn new(operands: &'a [Operand], names: &mut Names<'a>) -> Self {
        let mut name = Vec::with_capacity(operands.len());
        let mut mem = Vec::with_capacity(operands.len());
        for o in operands {
            let (n, m) = match o {
                Operand::Reg { reg, .. } => (names.id(canonical_reg_cow(reg)), [NO_NAME; 4]),
                Operand::Flag { flags } => (names.id(Cow::Borrowed(flags)), [NO_NAME; 4]),
                Operand::Mem { mem_addr } => {
                    let mut id = |r: &'a Option<String>, canonical: bool| match r {
                        Some(r) => names.id(if canonical { canonical_reg_cow(r) } else { Cow::Borrowed(r.as_str()) }),
                        None => NO_NAME,
                    };
                    let m = [id(&mem_addr.base, true), id(&mem_addr.index, true), id(&mem_addr.base, false), id(&mem_addr.index, false)];
                    (NO_NAME, m)
                }
                Operand::Pseudo => (NO_NAME, [NO_NAME; 4]),
            };
            name.push(n);
            mem.push(m);
        }
        CanonicalRegs { operands, name, mem }
    }

    /// `getCanonicalReg(op.reg)`; Python raises an `AttributeError` for operands that are not registers (see [`reg_of`])
    fn reg(&self, op: OpId) -> NameId {
        if !matches!(self.operands[op as usize], Operand::Reg { .. }) {
            reg_of(self.operands, op);
        }
        self.name[op as usize]
    }
}

/// `Some(id)` unless `id` is NO_NAME
fn some_name(id: NameId) -> Option<NameId> {
    (id != NO_NAME).then_some(id)
}

/// `op.reg`: Python raises an `AttributeError` for operands that are not registers.
fn reg_of(operands: &[Operand], op: OpId) -> &str {
    match &operands[op as usize] {
        Operand::Reg { reg, .. } => reg,
        other => panic!("AttributeError: operand {other:?} has no attribute 'reg'"),
    }
}

fn mem_addr_of(operands: &[Operand], op: OpId) -> &MemAddr {
    match &operands[op as usize] {
        Operand::Mem { mem_addr } => mem_addr,
        other => panic!("AttributeError: operand {other:?} has no attribute 'memAddr'"),
    }
}

/// `latReducedDueToFastPtrChasing(uArchConfig, memAddr, lastWriteBase, lastWriteIndex, baseRenamedByElim32BitMove)` of `utils.py`
fn lat_reduced_due_to_fast_ptr_chasing(
    config: &UArchConfig,
    mem_addr: &MemAddr,
    last_write_base: Option<&Instr>,
    last_write_index: Option<&Instr>,
    base_renamed_by_elim_32bit_move: bool,
) -> bool {
    const LOADS: [&str; 6] =
        ["MOV (R64, M64)", "MOV (RAX, M64)", "MOV (R32, M32)", "MOV (EAX, M32)", "MOVSXD (R64, M32)", "POP (R64)"];
    let disp = mem_addr.disp.unwrap_or(0);
    config.fast_pointer_chasing
        && (0..2048).contains(&disp)
        && !base_renamed_by_elim_32bit_move
        && last_write_base.is_some_and(|i| LOADS.contains(&i.instr_str.as_str()))
        && (mem_addr.index.is_none() || last_write_index.is_some_and(|i| i.uops == 0))
}

// ---------------------------------------------------------------------------------------------------------------------------
// Latency graph
// ---------------------------------------------------------------------------------------------------------------------------

/// `LatGraphEdge(source, target, cost, time)`: the value of the input operand `source` of an instruction is needed, `cost`
/// cycles later, for the input operand `target` of an instruction; `time` is 1 if that instruction is in the next iteration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LatGraphEdge {
    pub source: OpId,
    pub target: OpId,
    pub cost: i64,
    pub time: i64,
}

/// The result of `generateLatencyGraph`: `(nodesForInstr, edgesForNode)`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LatencyGraph {
    /// for each instruction (same index as `InstrList::instrs`), its nodes: its input operands
    pub nodes_for_instr: Vec<Vec<OpId>>,
    /// the edges that leave a node, in the order in which they were added
    pub edges_for_node: IndexMap<OpId, Vec<LatGraphEdge>>,
}

impl LatencyGraph {
    fn edges(&self, node: OpId) -> &[LatGraphEdge] {
        self.edges_for_node.get(&node).map_or(&[], |e| e.as_slice())
    }
}

/// What `generateLatencyGraph` produces, as it produces it: the nodes of each instruction and the edges, in order.
trait GraphSink {
    /// the nodes that follow are those of the next instruction
    fn begin_instr(&mut self);
    fn node(&mut self, op: OpId);
    fn edge(&mut self, edge: LatGraphEdge);
}

impl GraphSink for LatencyGraph {
    fn begin_instr(&mut self) {
        self.nodes_for_instr.push(Vec::new());
    }
    fn node(&mut self, op: OpId) {
        self.nodes_for_instr.last_mut().expect("begin_instr").push(op);
    }
    fn edge(&mut self, edge: LatGraphEdge) {
        self.edges_for_node.entry(edge.source).or_default().push(edge);
    }
}

/// The latency graph in a compact form: the nodes of all instructions in order, and the edges grouped by their source (each
/// group in the order in which its edges were added).
struct DenseGraph {
    nodes: Vec<OpId>,
    /// the nodes of instruction `i` are `nodes[instr_start[i]..]` (up to the start of the next one)
    instr_start: Vec<u32>,
    /// the edges in the order in which they were added; after [`DenseGraph::finish`], grouped by their source
    edges: Vec<LatGraphEdge>,
    /// after [`DenseGraph::finish`]: the edges of node `n` are `edges[start[n]..start[n + 1]]`
    start: Vec<u32>,
}

impl GraphSink for DenseGraph {
    fn begin_instr(&mut self) {
        self.instr_start.push(self.nodes.len() as u32);
    }
    fn node(&mut self, op: OpId) {
        self.nodes.push(op);
    }
    fn edge(&mut self, edge: LatGraphEdge) {
        self.edges.push(edge);
    }
}

impl DenseGraph {
    /// groups the edges by their source (a stable counting sort)
    fn finish(&mut self, n_operands: usize) {
        let mut start = vec![0u32; n_operands + 1];
        for e in &self.edges {
            start[e.source as usize + 1] += 1;
        }
        for i in 0..n_operands {
            start[i + 1] += start[i];
        }
        let mut next = start.clone();
        let mut sorted = vec![LatGraphEdge { source: 0, target: 0, cost: 0, time: 0 }; self.edges.len()];
        for e in &self.edges {
            let slot = &mut next[e.source as usize];
            sorted[*slot as usize] = *e;
            *slot += 1;
        }
        self.edges = sorted;
        self.start = start;
    }

    fn edges(&self, node: OpId) -> &[LatGraphEdge] {
        &self.edges[self.start[node as usize] as usize..self.start[node as usize + 1] as usize]
    }
}

/// The value of `getOpKey(op)`: the canonical register of a register operand or the flags of a flag operand (both strings in
/// Python), the abstract address of a memory operand, and `None` for other operands. The strings are borrowed from the operands
/// where possible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum OpKey {
    /// a string (see [`Names`])
    Str(NameId),
    Mem(Option<AbstractValue>, Option<AbstractValue>, Option<i64>, Option<i64>),
    None,
}

/// A value of `prevWriteToKey`: (instr, outOp, fastPtrChasing, iteration)
#[derive(Debug, Clone, Copy)]
struct PrevWrite {
    instr: usize,
    out_op: OpId,
    fast_ptr_chasing: bool,
    iteration: i64,
}

struct LatencyGraphBuilder<'a> {
    instrs: &'a InstrList,
    config: &'a UArchConfig,
    /// move -> the last non-eliminated instruction on the chain of writes that leads to its input
    prev_non_eliminated_write_for_move: Vec<Option<usize>>,
    output_of_move_renamed_by_32bit_move: Vec<bool>,
    /// only looked up
    prev_write_to_key: FastMap<OpKey, PrevWrite>,
    abs_val_gen: AbstractValueGenerator,
    rsp_implicitly_changed: bool,
    canon: CanonicalRegs<'a>,
    /// the number of "RSP"
    rsp: NameId,
}

impl<'a> LatencyGraphBuilder<'a> {
    fn get_op_key(&mut self, op: OpId) -> OpKey {
        let instrs = self.instrs;
        match &instrs.operands[op as usize] {
            Operand::Reg { .. } | Operand::Flag { .. } => OpKey::Str(self.canon.name[op as usize]),
            Operand::Mem { mem_addr } => {
                let [base, index, _, _] = self.canon.mem[op as usize];
                let base = self.abs_val_gen.get_abstract_value_for_reg(some_name(base));
                let index = self.abs_val_gen.get_abstract_value_for_reg(some_name(index));
                OpKey::Mem(base, index, mem_addr.scale, mem_addr.disp)
            }
            Operand::Pseudo => OpKey::None,
        }
    }

    /// The instruction that last wrote the register `reg` of an address (looked up by its name as written), with eliminated
    /// moves replaced by the instruction they copy from, and whether it is a move whose output was renamed by a 32-bit move.
    fn writer_of_addr_reg(&self, reg: NameId) -> (Option<usize>, bool) {
        let key = match some_name(reg) {
            Some(r) => OpKey::Str(r),
            None => OpKey::None,
        };
        match self.prev_write_to_key.get(&key) {
            Some(w) => {
                let instr =
                    if self.instrs.instrs[w.instr].may_be_eliminated { self.prev_non_eliminated_write_for_move[w.instr] } else { Some(w.instr) };
                (instr, self.output_of_move_renamed_by_32bit_move[w.instr])
            }
            None => (None, false),
        }
    }

    fn process_instr_outputs(&mut self, idx: usize, iteration: i64) {
        let instrs = self.instrs;
        let instr = &instrs.instrs[idx];
        let mut fast_ptr_chasing = false;
        if self.config.fast_pointer_chasing && !instr.input_mem_operands.is_empty() {
            let mem_op = instr.input_mem_operands[0];
            let mem_addr = mem_addr_of(&instrs.operands, mem_op);
            let [_, _, base_as_written, index_as_written] = self.canon.mem[mem_op as usize];
            let (base_instr, base_renamed_by_32bit_move) = self.writer_of_addr_reg(base_as_written);
            let (index_instr, _) = self.writer_of_addr_reg(index_as_written);
            fast_ptr_chasing = lat_reduced_due_to_fast_ptr_chasing(
                self.config,
                mem_addr,
                base_instr.map(|i| &instrs.instrs[i]),
                index_instr.map(|i| &instrs.instrs[i]),
                base_renamed_by_32bit_move,
            );
        }

        if instr.implicit_rsp_change != 0 {
            self.rsp_implicitly_changed = true;
        } else if instr
            .input_reg_operands
            .iter()
            .chain(&instr.mem_addr_operands)
            .chain(&instr.output_reg_operands)
            .any(|&op| self.canon.reg(op) == self.rsp)
        {
            self.rsp_implicitly_changed = false;
        }

        for &out_op in instr.output_reg_operands.iter().chain(&instr.output_flag_operands).chain(&instr.output_mem_operands) {
            let key = self.get_op_key(out_op);
            let write = PrevWrite { instr: idx, out_op, fast_ptr_chasing, iteration };
            if let (Operand::Reg { .. }, OpKey::Str(reg)) = (&instrs.operands[out_op as usize], key) {
                self.prev_write_to_key.insert(key, write);
                self.abs_val_gen.set_abstract_value_for_cur_instr(reg, instr, &self.canon);
            } else {
                self.prev_write_to_key.insert(key, write);
            }
        }

        self.abs_val_gen.finish_cur_instr();
    }
}

/// The nodes of an instruction: `instr.inputRegOperands + instr.memAddrOperands + instr.inputFlagOperands + instr.inputMemOperands`
fn input_operands(instr: &Instr) -> impl Iterator<Item = OpId> + '_ {
    instr
        .input_reg_operands
        .iter()
        .chain(&instr.mem_addr_operands)
        .chain(&instr.input_flag_operands)
        .chain(&instr.input_mem_operands)
        .copied()
}

/// `generateLatencyGraph(instructions, uArchConfig, initPolicy)`
pub fn generate_latency_graph(instrs: &InstrList, config: &UArchConfig, init_policy: &str) -> LatencyGraph {
    let mut graph = LatencyGraph { nodes_for_instr: Vec::with_capacity(instrs.instrs.len()), edges_for_node: IndexMap::new() };
    build_latency_graph(instrs, config, init_policy, &mut graph);
    graph
}

/// `generateLatencyGraph(instructions, uArchConfig, initPolicy)`, with the graph given to `graph` as it is made
fn build_latency_graph(instrs: &InstrList, config: &UArchConfig, init_policy: &str, graph: &mut impl GraphSink) {
    let n = instrs.instrs.len();
    let ops = &instrs.operands;
    let mut prev_write_for_move: Vec<Option<usize>> = vec![None; n];
    let mut prev_non_eliminated_write_for_move: Vec<Option<usize>> = vec![None; n];
    let mut output_of_move_renamed_by_32bit_move = vec![false; n];

    let mut names = Names::new();
    let canon = CanonicalRegs::new(ops, &mut names);
    // canonical register -> instruction (usize::MAX: none)
    let mut prev_write_to_reg: Vec<usize> = vec![usize::MAX; names.len()];
    for _ in 0..2 {
        for (idx, instr) in instrs.instrs.iter().enumerate() {
            if instr.may_be_eliminated {
                let w = prev_write_to_reg[canon.reg(instr.input_reg_operands[0]) as usize];
                prev_write_for_move[idx] = (w != usize::MAX).then_some(w);
            }
            for &out_op in &instr.output_reg_operands {
                prev_write_to_reg[canon.reg(out_op) as usize] = idx;
            }
        }
    }

    let mut moves_on_path = vec![false; n];
    // the elements of moves_on_path that are set (reset before the next move: not all n of them)
    let mut on_path: Vec<usize> = Vec::new();
    for mv in (0..n).filter(|&i| instrs.instrs[i].may_be_eliminated) {
        for i in on_path.drain(..) {
            moves_on_path[i] = false;
        }
        let mut cur_instr = Some(mv);
        while let Some(cur) = cur_instr {
            if moves_on_path[cur] {
                break;
            }
            let instr = &instrs.instrs[cur];
            if instr.may_be_eliminated && reg_size(reg_of(ops, instr.output_reg_operands[0])) == 32 {
                output_of_move_renamed_by_32bit_move[mv] = true;
            }
            if !instr.may_be_eliminated {
                prev_non_eliminated_write_for_move[mv] = Some(cur);
                break;
            }
            moves_on_path[cur] = true;
            on_path.push(cur);
            cur_instr = prev_write_for_move[cur];
        }
    }

    let mut b = LatencyGraphBuilder {
        instrs,
        config,
        prev_non_eliminated_write_for_move,
        output_of_move_renamed_by_32bit_move,
        prev_write_to_key: FastMap::default(),
        abs_val_gen: AbstractValueGenerator::new(init_policy, &names),
        rsp_implicitly_changed: false,
        canon,
        rsp: names.rsp,
    };

    for _ in 0..2 {
        for idx in 0..n {
            b.process_instr_outputs(idx, 0);
        }
    }

    for (idx, instr) in instrs.instrs.iter().enumerate() {
        graph.begin_instr();
        for op in input_operands(instr) {
            graph.node(op);

            let key = b.get_op_key(op);
            if let Some(&PrevWrite { instr: prev_idx, out_op: prev_out_op, fast_ptr_chasing, iteration: prev_it }) = b.prev_write_to_key.get(&key) {
                let prev_instr = &instrs.instrs[prev_idx];
                let op_is_mem = matches!(ops[op as usize], Operand::Mem { .. });
                for prev_in_op in input_operands(prev_instr) {
                    let prev_in_op_is_mem = matches!(ops[prev_in_op as usize], Operand::Mem { .. });
                    let lat_in_table =
                        || prev_instr.latencies.iter().find(|(i, o, _)| *i == prev_in_op && *o == prev_out_op).map_or(0, |(_, _, l)| *l);
                    let lat;
                    if prev_instr.may_be_eliminated {
                        lat = 0;
                    } else if !prev_in_op_is_mem && op_is_mem {
                        lat = 0; // ToDo
                    } else if lat_in_table() > 0 {
                        let mut l = lat_in_table();
                        if fast_ptr_chasing && prev_instr.mem_addr_operands.contains(&prev_in_op) && !prev_instr.input_mem_operands.is_empty() {
                            l -= 1;
                        } else if b.rsp_implicitly_changed
                            && instr.input_reg_operands.iter().chain(&instr.mem_addr_operands).any(|&o| o == prev_in_op)
                            && b.canon.reg(prev_in_op) == b.rsp
                            && !matches!(ops[prev_in_op as usize], Operand::Reg { is_implicit_stack_operand: true, .. })
                        {
                            l += 1;
                        }
                        lat = l;
                    } else {
                        continue;
                    }

                    graph.edge(LatGraphEdge { source: prev_in_op, target: op, cost: lat, time: if prev_it != 0 { 0 } else { 1 } });
                }
            }
        }

        b.process_instr_outputs(idx, 1);
    }
}

/// The result of `computeMaximumLatencyForGraph`: `(maxCycleRatio, edgesOnMaxCycle, components)`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MaximumLatency {
    /// the maximum, over the cycles of the graph, of latency per iteration (0 if there is no cycle)
    pub max_cycle_ratio: f64,
    pub edges_on_max_cycle: Vec<LatGraphEdge>,
    /// the strongly connected components
    pub components: Vec<Vec<OpId>>,
}

/// `findStronglyConnectedComponents(nodesForInstr, edgesForNode)` (in `computeMaximumLatencyForGraph`): calls `component` for
/// each strongly connected component, in the order of the reference. `nodes` are the nodes of all instructions in order.
fn find_strongly_connected_components<'g>(
    n_operands: usize,
    nodes: impl Iterator<Item = OpId>,
    edges_of: impl Fn(OpId) -> &'g [LatGraphEdge],
    mut component: impl FnMut(&[OpId]),
) {
    let mut index_dict: Vec<Option<usize>> = vec![None; n_operands];
    let mut n_indexed = 0usize;
    let mut lowlink_dict: Vec<usize> = vec![0; n_operands];
    let mut on_stack_set = vec![false; n_operands];
    let mut s: Vec<OpId> = Vec::new();
    let mut comp: Vec<OpId> = Vec::new();
    let mut call_stack: Vec<(OpId, usize)> = Vec::new();

    for n in nodes {
        if index_dict[n as usize].is_some() {
            continue;
        }
        call_stack.clear();
        call_stack.push((n, 0));

        while let Some((v, mut pi)) = call_stack.pop() {
            let vi = v as usize;
            let edges = edges_of(v);
            if pi == 0 {
                let index = n_indexed;
                n_indexed += 1;
                lowlink_dict[vi] = index;
                index_dict[vi] = Some(index);
                s.push(v);
                on_stack_set[vi] = true;
            } else {
                let prev = edges[pi - 1].target as usize;
                lowlink_dict[vi] = lowlink_dict[vi].min(lowlink_dict[prev]);
            }

            while pi < edges.len() && index_dict[edges[pi].target as usize].is_some() {
                let w = edges[pi].target as usize;
                if on_stack_set[w] {
                    lowlink_dict[vi] = lowlink_dict[vi].min(index_dict[w].unwrap());
                }
                pi += 1;
            }

            if pi < edges.len() {
                let w = edges[pi].target;
                call_stack.push((v, pi + 1));
                call_stack.push((w, 0));
                continue;
            }

            if Some(lowlink_dict[vi]) == index_dict[vi] {
                comp.clear();
                loop {
                    let w = s.pop().expect("IndexError: pop from empty list");
                    on_stack_set[w as usize] = false;
                    comp.push(w);
                    if v == w {
                        break;
                    }
                }
                component(&comp);
            }
        }
    }
}

/// Buffers of [`maximum_cycle_ratio`], reused for the components of a graph: `local` has an element per operand, the others an
/// element per node or edge of the current component.
struct CycleRatioBuffers {
    /// operand -> its index in the component (the position in `nodes`); only set for the nodes of the component
    local: Vec<u32>,
    d: Vec<f64>,
    /// the edge (index into `edges`) of each node: `p[u]` of the reference; NONE: None
    p: Vec<u32>,
    /// NONE or the node at which the walk that visited the node started
    visited: Vec<u32>,
    /// for each edge: local source, local target, cost and time (as in `edges`)
    e_source: Vec<u32>,
    e_target: Vec<u32>,
    e_cost: Vec<i64>,
    e_time: Vec<i64>,
}

const NO_EDGE: u32 = u32::MAX;

impl CycleRatioBuffers {
    fn new(n_operands: usize) -> Self {
        CycleRatioBuffers {
            local: vec![0; n_operands],
            d: Vec::new(),
            p: Vec::new(),
            visited: Vec::new(),
            e_source: Vec::new(),
            e_target: Vec::new(),
            e_cost: Vec::new(),
            e_time: Vec::new(),
        }
    }
}

/// `maximumCycleRatio(nodes, edges)` (in `computeMaximumLatencyForGraph`), based on the "VAL" algorithm described in
/// <https://doi.org/10.1145/1027084.1027085>. Every node must have an edge that leaves it (in the reference, the code fails
/// otherwise); `d` then never keeps its initial value `sys.maxsize`, and all its values are floats or small integers.
///
/// The nodes are numbered by their position in `nodes` (the sources and targets of `edges` are nodes), so that the arrays of
/// the iterations are small and dense; every loop visits the nodes and the edges in the order of the reference and computes
/// the same floating-point expressions.
fn maximum_cycle_ratio(buf: &mut CycleRatioBuffers, nodes: &[OpId], edges: &[LatGraphEdge]) -> (f64, Vec<LatGraphEdge>) {
    const SYS_MAXSIZE: f64 = i64::MAX as f64;
    let eps = 0.01;
    let mut r = SYS_MAXSIZE;

    let CycleRatioBuffers { local, d, p, visited, e_source, e_target, e_cost, e_time } = buf;
    for (i, &v) in nodes.iter().enumerate() {
        local[v as usize] = i as u32;
    }
    let n = nodes.len();
    d.clear();
    d.resize(n, SYS_MAXSIZE);
    p.clear();
    p.resize(n, NO_EDGE);
    visited.clear();
    visited.resize(n, NO_EDGE);
    e_source.clear();
    e_target.clear();
    e_cost.clear();
    e_time.clear();
    for e in edges {
        e_source.push(local[e.source as usize]);
        e_target.push(local[e.target as usize]);
        e_cost.push(e.cost);
        e_time.push(e.time);
    }
    for (k, e) in edges.iter().enumerate() {
        let s = e_source[k] as usize;
        if ((-e.cost) as f64) < d[s] {
            d[s] = (-e.cost) as f64;
            p[s] = k as u32;
        }
    }
    // p[u] of a node without an edge is None in the reference, and `p[u].target` raises an AttributeError
    assert!(!p.contains(&NO_EDGE), "AttributeError: a node of a strongly connected component has no edge");

    let mut edges_on_max_cycle = Vec::new();
    loop {
        // findRatio: the walks from each node along p
        visited.fill(NO_EDGE);
        let mut handle = NO_EDGE;
        for v in 0..n as u32 {
            if visited[v as usize] != NO_EDGE {
                continue;
            }
            let mut u = v;
            loop {
                visited[u as usize] = v;
                u = e_target[p[u as usize] as usize];
                if visited[u as usize] != NO_EDGE {
                    break;
                }
            }
            if visited[u as usize] != v {
                continue;
            }
            let x = u;
            let mut sum: i64 = 0;
            let mut len: i64 = 0;
            loop {
                let pe = p[u as usize] as usize;
                sum -= e_cost[pe];
                len += e_time[pe];
                u = e_target[pe];
                if x == u {
                    break;
                }
            }
            assert!(len != 0, "ZeroDivisionError: a cycle of the latency graph within one iteration");
            let ratio = sum as f64 / len as f64;
            if r > ratio {
                r = ratio;
                handle = u;
            }
        }
        if handle != NO_EDGE {
            edges_on_max_cycle.clear();
            let mut u = handle;
            loop {
                let pe = p[u as usize] as usize;
                edges_on_max_cycle.push(edges[pe]);
                u = e_target[pe];
                if u == handle {
                    break;
                }
            }
        }

        let mut changed = false;
        for k in 0..edges.len() {
            let (source, target) = (e_source[k] as usize, e_target[k] as usize);
            let (cost, time) = (e_cost[k], e_time[k]);
            if d[source] > d[target] - cost as f64 - r * time as f64 + eps {
                d[source] = d[target] - cost as f64 - r * time as f64;
                p[source] = k as u32;
                changed = true;
            }
        }
        if !changed {
            return (-r, edges_on_max_cycle);
        }
    }
}

/// `computeMaximumLatencyForGraph(instructions, nodesForInstr, edgesForNode)`
pub fn compute_maximum_latency_for_graph(instrs: &InstrList, graph: &LatencyGraph) -> MaximumLatency {
    let mut components = Vec::new();
    let (max_cycle_ratio, edges_on_max_cycle) = maximum_latency(
        instrs.operands.len(),
        graph.nodes_for_instr.iter().flatten().copied(),
        |n| graph.edges(n),
        |comp| components.push(comp.to_vec()),
    );
    MaximumLatency { max_cycle_ratio, edges_on_max_cycle, components }
}

/// [`compute_maximum_latency_for_graph`] for a graph given by its nodes and the edges of each node; `component` is called for
/// each strongly connected component
fn maximum_latency<'g>(
    n_operands: usize,
    nodes: impl Iterator<Item = OpId>,
    edges_of: impl Fn(OpId) -> &'g [LatGraphEdge] + Copy,
    mut component: impl FnMut(&[OpId]),
) -> (f64, Vec<LatGraphEdge>) {
    let mut max_cycle_ratio = 0.0;
    let mut edges_on_max_cycle = Vec::new();
    let mut in_comp = vec![false; n_operands];
    let mut buf: Option<CycleRatioBuffers> = None;
    let mut edges_for_comp: Vec<LatGraphEdge> = Vec::new();
    find_strongly_connected_components(n_operands, nodes, edges_of, |comp| {
        for &n in comp {
            in_comp[n as usize] = true;
        }
        edges_for_comp.clear();
        edges_for_comp.extend(comp.iter().flat_map(|&n| edges_of(n)).filter(|e| in_comp[e.target as usize]).copied());
        if !edges_for_comp.is_empty() {
            let buf = buf.get_or_insert_with(|| CycleRatioBuffers::new(n_operands));
            let (cur_max_cycle_ratio, cur_edges_on_max_cycle) = maximum_cycle_ratio(buf, comp, &edges_for_comp);
            if cur_max_cycle_ratio > max_cycle_ratio {
                max_cycle_ratio = cur_max_cycle_ratio;
                edges_on_max_cycle = cur_edges_on_max_cycle;
            }
        }
        for &n in comp {
            in_comp[n as usize] = false;
        }
        component(comp);
    });
    (max_cycle_ratio, edges_on_max_cycle)
}

/// The limit that `_runSimulation` passes to `printBottlenecks` as `depLimit`:
/// `computeMaximumLatencyForGraph(instructions, *generateLatencyGraph(instructions, uArchConfig, initPolicy))[0]`
pub fn compute_dependency_limit(instrs: &InstrList, config: &UArchConfig, init_policy: &str) -> f64 {
    dense_dependency_cycle(instrs, config, init_policy).0
}

/// The dense graph and the result of `computeMaximumLatencyForGraph` for it: (maxCycleRatio, edgesOnMaxCycle)
fn dense_dependency_cycle(instrs: &InstrList, config: &UArchConfig, init_policy: &str) -> (f64, Vec<LatGraphEdge>, DenseGraph) {
    let n_operands = instrs.operands.len();
    let mut graph = DenseGraph { nodes: Vec::new(), instr_start: Vec::new(), edges: Vec::new(), start: Vec::new() };
    build_latency_graph(instrs, config, init_policy, &mut graph);
    graph.finish(n_operands);
    let (ratio, edges) = maximum_latency(n_operands, graph.nodes.iter().copied(), |n| graph.edges(n), |_| {});
    (ratio, edges, graph)
}

/// The loop-carried dependency cycle with the maximum latency per iteration, from the compact graph of
/// [`compute_dependency_limit`] (in the same time): `max_cycle_ratio` and `edges_on_max_cycle` are those of
/// [`compute_dependency_cycle`].
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DependencyCycle {
    /// the Dependencies limit (`maxCycleRatio`)
    pub max_cycle_ratio: f64,
    pub edges_on_max_cycle: Vec<LatGraphEdge>,
    /// for each operand, the first instruction whose nodes (`nodesForInstr`) contain it
    pub instr_of_node: Vec<Option<u32>>,
}

/// [`compute_dependency_limit`] with the cycle that gives the limit (see [`DependencyCycle`])
pub fn compute_dependency_limit_with_cycle(instrs: &InstrList, config: &UArchConfig, init_policy: &str) -> DependencyCycle {
    let (max_cycle_ratio, edges_on_max_cycle, graph) = dense_dependency_cycle(instrs, config, init_policy);
    let mut instr_of_node: Vec<Option<u32>> = vec![None; instrs.operands.len()];
    let n = graph.instr_start.len();
    for i in 0..n {
        let end = if i + 1 < n { graph.instr_start[i + 1] as usize } else { graph.nodes.len() };
        for &op in &graph.nodes[graph.instr_start[i] as usize..end] {
            instr_of_node[op as usize].get_or_insert(i as u32);
        }
    }
    DependencyCycle { max_cycle_ratio, edges_on_max_cycle, instr_of_node }
}

/// As [`compute_dependency_limit`] (`maximum.max_cycle_ratio` is that limit), with the cycle that gives it and the graph, whose
/// `nodes_for_instr` map the operands on the cycle back to their instructions.
pub fn compute_dependency_cycle(instrs: &InstrList, config: &UArchConfig, init_policy: &str) -> (MaximumLatency, LatencyGraph) {
    let graph = generate_latency_graph(instrs, config, init_policy);
    (compute_maximum_latency_for_graph(instrs, &graph), graph)
}

// ---------------------------------------------------------------------------------------------------------------------------
// printBottlenecks
// ---------------------------------------------------------------------------------------------------------------------------

/// The numbers that the text of `printBottlenecks` is made of. The limits are not rounded. A front-end limit is `None` where
/// `printBottlenecks` does not compute it (no instruction came from that part of the front end in the relevant rounds).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BottleneckValues {
    /// `TP`
    pub tp: f64,
    /// `computePredecLimit(disas, loop, alignmentOffset)`, if there are instructions from the MITE and none from the DSB or LSD
    pub predec_limit: Option<f64>,
    /// `computeDecLimit(instructions, uArchConfig)`, if there are instructions from the MITE
    pub dec_limit: Option<f64>,
    /// `computeDSBLimit(instructions, alignmentOffset)`, if there are instructions from the DSB
    pub dsb_limit: Option<f64>,
    /// `computeLSDLimit(instructions, uArchConfig)`, if there are instructions from the LSD
    pub lsd_limit: Option<f64>,
    /// `computeIssueLimit(instructions, uArchConfig)`
    pub issue_limit: f64,
    /// `computePortUsageLimit(instructions, instrInstancesForInstr)`
    pub port_usage_limit: f64,
    /// `max(portUsageC.values())`: the number of uops of the relevant rounds on the port with the most uops; `None` if no uop
    /// has a port (the reference then fails if it needs the value)
    pub max_port_usage: Option<i64>,
    /// `divUsage`: the sum of the `divCycles` of the uops of the relevant rounds
    pub div_usage: i64,
    /// `nRounds`
    pub n_rounds: i64,
    /// `depLimit`
    pub dep_limit: f64,
}

/// The text that `printBottlenecks` prints for the given numbers (each line with its newline).
pub fn format_bottlenecks(v: &BottleneckValues) -> String {
    format_bottlenecks_with_limits(v).text
}

/// The text of `printBottlenecks` (see [`format_bottlenecks`]) and what it lists.
#[derive(Debug, Clone, PartialEq)]
pub struct BottleneckText {
    /// the text, each line with its newline
    pub text: String,
    /// the bottlenecks (sorted; empty for "unknown")
    pub bottlenecks: Vec<&'static str>,
    /// the listed limits: (name, the number as printed)
    pub limits: Vec<(&'static str, f64)>,
}

/// [`format_bottlenecks`], with the bottlenecks and the limits that the text lists
pub fn format_bottlenecks_with_limits(v: &BottleneckValues) -> BottleneckText {
    let tp = v.tp;
    let mut text = String::new();
    let mut output = String::new();
    let mut limits: Vec<(&'static str, f64)> = Vec::new();
    let mut bottlenecks: Vec<&'static str> = Vec::new();

    // a line "  - name: value" of the list (the lines are joined with "\n")
    let mut list_entry = |name: &'static str, limit: f64| {
        use std::fmt::Write;
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str("  - ");
        output.push_str(name);
        output.push_str(": ");
        let start = output.len();
        write!(output, "{limit:.2}").unwrap();
        // the number as printed, read back
        if let Ok(value) = output[start..].parse() {
            limits.push((name, value));
        }
    };

    // Front End, Issue: round(limit, 2); listed if it is not 0
    let mut rounded_limit = |name: &'static str, limit: Option<f64>, list_entry: &mut dyn FnMut(&'static str, f64)| {
        if let Some(limit) = limit {
            let limit = py_round2(limit);
            if limit != 0.0 {
                list_entry(name, limit);
                if limit >= 0.98 * tp {
                    bottlenecks.push(name);
                }
            }
        }
    };
    rounded_limit("Predecoder", v.predec_limit, &mut list_entry);
    rounded_limit("Decoder", v.dec_limit, &mut list_entry);
    rounded_limit("DSB", v.dsb_limit, &mut list_entry);
    rounded_limit("LSD", v.lsd_limit, &mut list_entry);
    rounded_limit("Issue", Some(v.issue_limit), &mut list_entry);

    // Port Usage
    let port_usage_limit = py_round2(v.port_usage_limit);
    if port_usage_limit != 0.0 {
        list_entry("Ports", port_usage_limit);
        if port_usage_limit >= 0.98 * tp {
            bottlenecks.push("Ports");
        } else {
            let max_port_usage = v.max_port_usage.expect("ValueError: max() arg is an empty sequence (no uop has a port)");
            if max_port_usage as f64 / v.n_rounds as f64 >= 0.98 * tp {
                bottlenecks.push("Scheduling");
            }
        }
    }

    // Divider
    if v.div_usage as f64 / v.n_rounds as f64 >= 0.99 * tp {
        bottlenecks.push("Divider");
    }

    // Dependencies
    if v.dep_limit != 0.0 {
        list_entry("Dependencies", v.dep_limit);
        if v.dep_limit >= 0.98 * tp {
            bottlenecks.push("Dependencies");
        }
    }

    bottlenecks.sort();
    text.push_str(if bottlenecks.len() > 1 { "Bottlenecks: " } else { "Bottleneck: " });
    if bottlenecks.is_empty() {
        text.push_str("unknown");
    } else {
        for (i, b) in bottlenecks.iter().enumerate() {
            if i > 0 {
                text.push_str(", ");
            }
            text.push_str(b);
        }
    }
    text.push('\n');
    if !output.is_empty() {
        text.push_str("\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n");
        text.push_str(&output);
        text.push('\n');
    }
    BottleneckText { text, bottlenecks, limits }
}

/// The numbers of `printBottlenecks(TP, instructions, instrInstancesForInstr, disas, alignmentOffset, loop, depLimit,
/// uArchConfig, nRounds)`; `TP`, `instrInstancesForInstr`, `loop` and `nRounds` are in `summary`.
pub fn bottleneck_values(
    instrs: &InstrList,
    disas: &[DecodedInstr],
    config: &UArchConfig,
    alignment_offset: i64,
    dep_limit: f64,
    summary: &SimSummary,
) -> BottleneckValues {
    bottleneck_values_for(instrs, disas, config, alignment_offset, dep_limit, summary)
}

/// [`bottleneck_values`] for any description of the simulation.
pub fn bottleneck_values_for(
    instrs: &InstrList,
    disas: &[DecodedInstr],
    config: &UArchConfig,
    alignment_offset: i64,
    dep_limit: f64,
    sim: &(impl SimView + ?Sized),
) -> BottleneckValues {
    // Front End
    let mite_instrs = sim.any_instr_from(InstrSource::Mite);
    let dsb_instrs = sim.any_instr_from(InstrSource::Dsb);
    let lsd_instrs = sim.any_instr_from(InstrSource::Lsd);

    let (max_port_usage, div_usage) = sim.port_and_div_usage();

    BottleneckValues {
        tp: sim.tp(),
        predec_limit: (mite_instrs && !dsb_instrs && !lsd_instrs).then(|| compute_predec_limit(disas, sim.is_loop(), alignment_offset)),
        dec_limit: mite_instrs.then(|| compute_dec_limit(instrs, config)),
        dsb_limit: dsb_instrs.then(|| compute_dsb_limit(instrs, alignment_offset)),
        lsd_limit: lsd_instrs.then(|| compute_lsd_limit(instrs, config)),
        issue_limit: compute_issue_limit(instrs, config),
        port_usage_limit: port_usage_limit(instrs, |idx| (sim.n_instances(idx), sim.not_eliminated_uops(idx))),
        max_port_usage,
        div_usage,
        n_rounds: sim.n_rounds(),
        dep_limit,
    }
}

/// The text that `printBottlenecks(TP, instructions, instrInstancesForInstr, disas, alignmentOffset, loop, depLimit,
/// uArchConfig, nRounds)` prints (each line with its newline); `TP`, `instrInstancesForInstr`, `loop` and `nRounds` are in
/// `summary`, and `dep_limit` is [`compute_dependency_limit`] (with the `initPolicy` of the simulation).
pub fn bottleneck_report(
    instrs: &InstrList,
    disas: &[DecodedInstr],
    config: &UArchConfig,
    alignment_offset: i64,
    dep_limit: f64,
    summary: &SimSummary,
) -> String {
    format_bottlenecks(&bottleneck_values(instrs, disas, config, alignment_offset, dep_limit, summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_is_pythons() {
        // exact ties are rounded to even, as round(x, 2) and '{:.2f}' do
        assert_eq!(py_format2(7.625), "7.62");
        assert_eq!(py_format2(0.125), "0.12");
        assert_eq!(py_format2(0.375), "0.38");
        assert_eq!(py_format2(2.5 / 6.0 * 6.0), "2.50");
        // not ties in binary: round(2.675, 2) == 2.67, round(1.005, 2) == 1.0
        assert_eq!(py_format2(2.675), "2.67");
        assert_eq!(py_format2(1.005), "1.00");
        assert_eq!(py_round2(2.675), 2.67);
        assert_eq!(py_round2(0.004), 0.0);
        assert_eq!(py_round2(0.005), 0.01); // 0.005 is slightly more than 5/1000 in binary
        assert_eq!(py_round2(16.0 / 6.0), 2.67);
    }

    #[test]
    fn bottleneck_text() {
        const LIST: &str = "\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n";
        // nothing to report
        let none = BottleneckValues { tp: 1.0, n_rounds: 10, ..Default::default() };
        assert_eq!(format_bottlenecks(&none), "Bottleneck: unknown\n");
        // 196 uops on one port in 100 rounds: 1.96 >= .98 * 2.0, and the Ports limit is below that
        let v = BottleneckValues {
            tp: 2.0,
            lsd_limit: Some(1.25),
            issue_limit: 1.25,
            port_usage_limit: 1.0,
            max_port_usage: Some(196),
            n_rounds: 100,
            dep_limit: 1.0,
            ..Default::default()
        };
        let entries = "  - LSD: 1.25\n  - Issue: 1.25\n  - Ports: 1.00\n  - Dependencies: 1.00\n";
        assert_eq!(format_bottlenecks(&v), format!("Bottleneck: Scheduling\n{LIST}{entries}"));
        let v195 = BottleneckValues { max_port_usage: Some(195), ..v.clone() };
        assert_eq!(format_bottlenecks(&v195), format!("Bottleneck: unknown\n{LIST}{entries}"));
        // the divider is busy for 198 cycles in 100 rounds: 1.98 >= .99 * 2.0; the names are sorted
        let div = BottleneckValues { div_usage: 198, ..v.clone() };
        assert_eq!(format_bottlenecks(&div), format!("Bottlenecks: Divider, Scheduling\n{LIST}{entries}"));
        let div197 = BottleneckValues { div_usage: 197, ..v.clone() };
        assert_eq!(format_bottlenecks(&div197), format!("Bottleneck: Scheduling\n{LIST}{entries}"));
        // limits are rounded before they are compared (1.9551 -> 1.96 >= 1.96; 7.625 -> 7.62), but not the dependency limit
        let rounded = BottleneckValues {
            tp: 2.0,
            predec_limit: Some(7.625),
            dec_limit: Some(0.004),
            dsb_limit: Some(1.9551),
            issue_limit: 1.9549,
            port_usage_limit: 1.9551,
            n_rounds: 1,
            dep_limit: 1.9599,
            ..Default::default()
        };
        assert_eq!(
            format_bottlenecks(&rounded),
            format!("Bottlenecks: DSB, Ports, Predecoder\n{LIST}  - Predecoder: 7.62\n  - DSB: 1.96\n  - Issue: 1.95\n  - Ports: 1.96\n  - Dependencies: 1.96\n")
        );
    }

    #[test]
    fn sum_is_pythons() {
        // sum([0.1]*10) == 1.0 in Python 3.12 (0.9999999999999999 without compensation)
        assert_eq!(py_sum(std::iter::repeat(Num::Float(0.1)).take(10)), Num::Float(1.0));
        assert_eq!(py_sum([Num::Int(1), Num::Int(2)]), Num::Int(3));
        // sum([1, 0.1, 0.2, 0.3, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]) == 2.3000000000000003
        let l = [1.0, 0.1, 0.2, 0.3, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
        let items = l.iter().enumerate().map(|(i, &x)| if i == 0 { Num::Int(1) } else { Num::Float(x) });
        assert_eq!(py_sum(items), Num::Float(2.3000000000000003));
    }
}
