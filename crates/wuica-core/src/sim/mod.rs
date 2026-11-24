//! The pipeline simulator: a port of the simulation part of uiCA's `uiCA.py` (front end with predecoder, decoders, DSB, LSD,
//! microcode sequencer and op cache; renamer; scheduler; reorder buffer; the main loop and the throughput computation), of the
//! uop table and of the `-json` output. See docs/DESIGN.md.
//!
//! The Python objects are stored in flat arrays ([`SimResult::uops`] etc.) and refer to each other by index. The index of a uop
//! is its `idx` in the reference (the order of creation), which the scheduler uses as the age of a uop.

mod frontend;
pub mod issue;
mod output;
mod prep;
mod renamer;
mod scheduler;

pub use issue::IssueLog;
pub use output::{canonicalize_instr_string, get_terminal_hyperlink, get_url, TableValue};

use crate::config::{UArch, UArchConfig};
use crate::model::{Instr, InstrList};
use prep::{pf, Prep, NONE};
use std::collections::VecDeque;

/// `-initPolicy`: the initial values of the registers
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitPolicy {
    /// all registers have different values
    Diff,
    /// all registers have the same value
    Same,
    /// all registers have the same value, except for the stack and base pointers
    Stack,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SimOptions {
    pub alignment_offset: i64,
    pub init_policy: InitPolicy,
    pub simple_front_end: bool,
    pub min_iterations: i64,
    pub min_cycles: i64,
}

impl Default for SimOptions {
    fn default() -> SimOptions {
        SimOptions { alignment_offset: 0, init_policy: InitPolicy::Diff, simple_front_end: false, min_iterations: 10, min_cycles: 500 }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SimError {
    /// not ported (configurations with `simplePortAssignment`)
    Unsupported(String),
    /// the list of instructions is empty
    NoInstructions,
    /// the reference raises an exception for this input
    ReferenceCrash(String),
    /// the input is not what the instruction builder produces
    InvalidInput(String),
    /// an input (code or options) that cannot be analyzed; the reference raises `InputError` with the same message
    InputError(String),
}

impl std::fmt::Display for SimError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            SimError::Unsupported(s) => write!(f, "not supported: {s}"),
            SimError::NoInstructions => write!(f, "no instructions found"),
            SimError::ReferenceCrash(s) => write!(f, "the reference implementation fails for this input: {s}"),
            SimError::InvalidInput(s) => write!(f, "invalid input: {s}"),
            SimError::InputError(s) => write!(f, "{s}"),
        }
    }
}

impl std::error::Error for SimError {}

pub(crate) fn crash(msg: &str) -> SimError {
    SimError::ReferenceCrash(msg.to_string())
}

/// Where a uop or an instruction instance came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UopSource {
    Mite,
    Dsb,
    Ms,
    Lsd,
    /// stack engine (stack sync uops)
    Se,
}

impl UopSource {
    pub fn as_str(self) -> &'static str {
        match self {
            UopSource::Mite => "MITE",
            UopSource::Dsb => "DSB",
            UopSource::Ms => "MS",
            UopSource::Lsd => "LSD",
            UopSource::Se => "SE",
        }
    }
}

/// An unfused-domain uop (`Uop`). Its index in [`SimResult::uops`] is the `idx` of the reference.
#[derive(Debug, Clone)]
pub struct Uop {
    /// index into [`SimResult::instr_instances`]
    pub instr_instance: u32,
    /// index into [`SimResult::fused_uops`]
    pub fused_uop: u32,
    /// index into the ports of the microarchitecture
    pub actual_port: Option<u8>,
    pub eliminated: bool,
    /// the renamed input operands (`ren_lists[ren_in.0 .. ren_in.0 + ren_in.1]`)
    pub(crate) ren_in: (u32, u32),
    pub ready_for_dispatch: Option<i64>,
    pub dispatched: Option<i64>,
    /// can be a fraction (throughput limits)
    pub executed: Option<f64>,
    /// `prop.divCycles`
    pub div_cycles: i64,
    pub is_stack_sync_uop: bool,
    pub is_reg_merge_uop: bool,
}

/// A fused-domain uop (`FusedUop`).
#[derive(Debug, Clone)]
pub struct FusedUop {
    /// its unfused uops: `first_uop .. first_uop + n_uops`
    pub first_uop: u32,
    pub n_uops: u32,
    /// index into [`SimResult::laminated_uops`]
    pub laminated_uop: u32,
    pub issued: Option<i64>,
    pub retired: Option<i64>,
    pub retire_idx: Option<i64>,
}

impl FusedUop {
    pub fn unfused_uops(&self) -> std::ops::Range<u32> {
        self.first_uop..self.first_uop + self.n_uops
    }
}

/// A laminated-domain uop (`LaminatedUop`).
#[derive(Debug, Clone)]
pub struct LaminatedUop {
    /// its fused uops: `first_fused_uop .. first_fused_uop + n_fused_uops`
    pub first_fused_uop: u32,
    pub n_fused_uops: u32,
    /// its unfused uops: `first_uop .. first_uop + n_uops`
    pub first_uop: u32,
    pub n_uops: u32,
    pub added_to_idq: Option<i64>,
    pub uop_source: Option<UopSource>,
}

impl LaminatedUop {
    pub fn fused_uops(&self) -> std::ops::Range<u32> {
        self.first_fused_uop..self.first_fused_uop + self.n_fused_uops
    }

    pub fn unfused_uops(&self) -> std::ops::Range<u32> {
        self.first_uop..self.first_uop + self.n_uops
    }
}

/// An instance of an instruction in one iteration (`InstrInstance`).
#[derive(Debug, Clone)]
pub struct InstrInstance {
    /// index of the instruction
    pub instr: u32,
    pub address: i64,
    pub rnd: i64,
    /// its laminated uops (`uops`): `first_uop .. first_uop + n_uops` in [`SimResult::laminated_uops`]
    pub first_uop: u32,
    pub n_uops: u32,
    /// laminated uops
    pub reg_merge_uops: Vec<u32>,
    /// laminated uops
    pub stack_sync_uops: Vec<u32>,
    /// MITE, DSB or LSD
    pub source: Option<UopSource>,
    pub predecoded: Option<i64>,
    pub removed_from_iq: Option<i64>,
}

impl InstrInstance {
    /// the laminated uops of the instruction (`uops`)
    pub fn uops(&self) -> std::ops::Range<u32> {
        self.first_uop..self.first_uop + self.n_uops
    }
}

const READY_UNSET: i64 = i64::MIN;

/// "not set" (`None`) for the cycle numbers of the internal entities (cycles are never negative)
pub(crate) const UNSET: i64 = i64::MIN;
/// "no port" (`None`) for [`SUop::actual_port`]
pub(crate) const NO_PORT: u8 = u8::MAX;

/// `Option<i64>` of an internal cycle number
#[inline]
pub(crate) fn opt(c: i64) -> Option<i64> {
    (c != UNSET).then_some(c)
}

/// The simulation state of a uop (`Uop`); the public [`Uop`] is made from it at the end.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SUop {
    pub prop: u32,
    /// index into `Sim::insts`
    pub instr_instance: u32,
    /// index into `Sim::fused`
    pub fused_uop: u32,
    /// the renamed input operands are `ren_lists[ren .. ren + n_in]`, the renamed output operands follow them
    pub ren: u32,
    pub store_buffer_entry: u32,
    pub n_in: u16,
    pub n_out: u16,
    /// index into the ports of the microarchitecture, or NO_PORT
    pub actual_port: u8,
    pub eliminated: bool,
    pub mem_renaming_blocked: bool,
    pub forward_fails: bool,
    pub lat_reduced_due_to_fast_ptr_chasing: bool,
    /// `foldedInputs`: bit i is set if renamed input operand i holds a value computed by the renamer (`renameImmediateFolding`) and the
    /// instruction gets it later (`foldedShiftDelay`)
    pub folded_in: u32,
    /// UNSET or a cycle
    pub ready_for_dispatch: i64,
    /// UNSET or a cycle
    pub dispatched: i64,
    /// NaN (not executed) or a cycle (can be a fraction); the comparisons `executed <= c` of the reference are false for NaN,
    /// as they are for `None`
    pub executed: f64,
}

impl SUop {
    #[inline(always)]
    pub fn ren_in(&self) -> std::ops::Range<u32> {
        self.ren..self.ren + self.n_in as u32
    }

    #[inline(always)]
    pub fn ren_out(&self) -> std::ops::Range<u32> {
        let s = self.ren + self.n_in as u32;
        s..s + self.n_out as u32
    }

    /// `executed is not None and executed <= clock`
    #[inline(always)]
    pub fn executed_by(&self, clock: i64) -> bool {
        self.executed <= clock as f64
    }
}

/// The simulation state of a fused-domain uop (`FusedUop`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct SFused {
    pub first_uop: u32,
    pub n_uops: u32,
    pub laminated_uop: u32,
    /// UNSET or a cycle
    pub issued: i64,
    pub retired: i64,
    pub retire_idx: i64,
}

impl SFused {
    #[inline(always)]
    pub fn unfused_uops(&self) -> std::ops::Range<u32> {
        self.first_uop..self.first_uop + self.n_uops
    }
}

/// The simulation state of a laminated-domain uop (`LaminatedUop`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct SLam {
    pub first_fused_uop: u32,
    pub n_fused_uops: u32,
    pub first_uop: u32,
    pub n_uops: u32,
    /// UNSET or a cycle
    pub added_to_idq: i64,
    pub uop_source: Option<UopSource>,
}

impl SLam {
    #[inline(always)]
    pub fn fused_uops(&self) -> std::ops::Range<u32> {
        self.first_fused_uop..self.first_fused_uop + self.n_fused_uops
    }

    #[inline(always)]
    pub fn unfused_uops(&self) -> std::ops::Range<u32> {
        self.first_uop..self.first_uop + self.n_uops
    }
}

/// The simulation state of an instruction instance (`InstrInstance`). Its register merge and stack sync uops are in
/// `Sim::reg_merge_uops` and `Sim::stack_sync_uops`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SInst {
    pub instr: u32,
    /// its laminated uops: `first_uop .. first_uop + n_uops`
    pub first_uop: u32,
    pub n_uops: u32,
    pub source: Option<UopSource>,
    pub address: i64,
    pub rnd: i64,
    /// UNSET or a cycle
    pub predecoded: i64,
    pub removed_from_iq: i64,
}

impl SInst {
    #[inline(always)]
    pub fn uops(&self) -> std::ops::Range<u32> {
        self.first_uop..self.first_uop + self.n_uops
    }
}

/// `RenamedOperand`
#[derive(Debug, Clone, Copy)]
pub(crate) struct RenamedOperand {
    /// the uop that writes this operand
    pub uop: u32,
    /// cycle in which the operand becomes ready
    pub ready: i64,
    /// `uop.prop.latencies.get(nonRenamedOperand, 1)`
    pub lat: i64,
}

/// What the outputs need to know about an instruction.
#[derive(Debug, Clone)]
pub(crate) struct InstrSummary {
    pub asm: String,
    pub opcode: String,
    pub instr_str: String,
    pub is_unknown: bool,
    pub macro_fused_with_prev_instr: bool,
    pub macro_fused_with_next_instr: bool,
    pub cannot_be_in_dsb_due_to_jcc_erratum: bool,
}

/// The result of a simulation.
#[derive(Debug, Clone)]
pub struct SimResult {
    /// the throughput in cycles per iteration, as returned by `runSimulation`
    pub tp: f64,
    pub first_relevant_round: i64,
    pub last_relevant_round: i64,
    /// the code was simulated as unrolled (it does not end with a branch); `frontEnd.unroll`
    pub unroll: bool,
    /// the last cycle of the simulation that the outputs cover
    pub max_cycle: i64,
    pub uops: Vec<Uop>,
    pub fused_uops: Vec<FusedUop>,
    pub laminated_uops: Vec<LaminatedUop>,
    pub instr_instances: Vec<InstrInstance>,
    /// `frontEnd.allGeneratedInstrInstances`
    pub all_generated_instr_instances: Vec<u32>,
    /// instruction -> its instances in the relevant rounds (`relevantInstrInstancesForInstr`)
    pub relevant_instr_instances_for_instr: Vec<Vec<u32>>,
    /// the names of the ports
    pub ports: Vec<String>,
    pub(crate) port_columns: Vec<String>,
    pub(crate) instrs: Vec<InstrSummary>,
    pub(crate) ren_ops: Vec<RenamedOperand>,
    pub(crate) ren_lists: Vec<u32>,
    pub(crate) parameters: serde_json::Value,
    /// the issue log; only from [`simulate_with_issue_log`]
    pub issue_log: Option<IssueLog>,
}

/// A fast non-cryptographic hasher (FxHash) for the maps of the simulator that are never iterated (iteration order does not
/// matter for them, see docs/DESIGN.md).
#[derive(Default, Clone, Copy)]
pub(crate) struct FxHasher {
    hash: u64,
}

impl FxHasher {
    #[inline]
    fn add(&mut self, w: u64) {
        self.hash = (self.hash.rotate_left(5) ^ w).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

impl std::hash::Hasher for FxHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let mut chunks = bytes.chunks_exact(8);
        for c in &mut chunks {
            self.add(u64::from_le_bytes(c.try_into().unwrap()));
        }
        for &b in chunks.remainder() {
            self.add(b as u64);
        }
    }
    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.add(i as u64);
    }
    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.add(i as u64);
    }
    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.add(i);
    }
    #[inline]
    fn write_i64(&mut self, i: i64) {
        self.add(i as u64);
    }
    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.add(i as u64);
    }
    #[inline]
    fn finish(&self) -> u64 {
        self.hash
    }
}

pub(crate) type FxBuild = std::hash::BuildHasherDefault<FxHasher>;
/// a lookup-only map with [`FxHasher`] (it cannot be iterated: crate::fasthash::LookupMap)
pub(crate) type FxHashMap<K, V> = crate::fasthash::LookupMap<K, V, FxBuild>;
/// a lookup-only set with [`FxHasher`] (crate::fasthash::LookupSet)
pub(crate) type FxHashSet<K> = crate::fasthash::LookupSet<K, FxBuild>;

/// The index of the next entity of an array (uops, fused and laminated uops, instruction instances, renamer lists, ...): the
/// arrays are indexed with `u32` (half the memory of `usize` per link). A simulation that would need more than 2^32 of one
/// kind fails (a panic: an error natively, a trap in WebAssembly) instead of wrapping. Unreachable in WebAssembly (4 GiB of
/// memory holds far fewer entities) and with the work budget (`analyze.rs`) and the 10^8-cycle limit for any realistic
/// native memory; Python's unbounded ints never wrap.
#[inline]
pub(crate) fn idx(len: usize) -> u32 {
    u32::try_from(len).unwrap_or_else(|_| panic!("more than 2^32 simulation entities of one kind"))
}

/// Python's `round(x, 2)` (the one implementation: [`crate::facile::py_round2`], checked against Python for every
/// `k / n`, `n <= 1000`, `k <= 3n`, in tests/round2.rs)
pub(crate) fn round2(x: f64) -> f64 {
    crate::facile::py_round2(x)
}

pub(crate) struct Sim<'a> {
    pub cfg: &'a UArchConfig,
    pub instrs: &'a [Instr],
    pub prep: Prep,
    pub n_ports: usize,

    pub uops: Vec<SUop>,
    pub fused: Vec<SFused>,
    pub lams: Vec<SLam>,
    pub insts: Vec<SInst>,
    /// (instruction instance, laminated uop): `InstrInstance.regMergeUops` and `InstrInstance.stackSyncUops`, in the order in
    /// which they were created
    pub reg_merge_uops: Vec<(u32, u32)>,
    pub stack_sync_uops: Vec<(u32, u32)>,
    pub ren_ops: Vec<RenamedOperand>,
    pub ren_lists: Vec<u32>,

    pub idq: VecDeque<u32>,
    pub rob: VecDeque<u32>,
    pub retire_queue: VecDeque<u32>,
    pub fe: frontend::FrontEnd,
    pub rn: renamer::Renamer,
    pub sched: scheduler::Scheduler,
    /// recorded only by [`simulate_with_issue_log`]
    pub issue_log: Option<IssueLog>,
}

impl<'a> Sim<'a> {
    /// `Uop(prop, instrI)`
    pub(crate) fn new_uop(&mut self, prop: u32, inst: u32) -> u32 {
        let mut u = self.prep.new_uop(prop);
        u.instr_instance = inst;
        self.uops.push(u);
        (self.uops.len() - 1) as u32
    }

    /// `LaminatedUop([FusedUop([uop])])`; returns the laminated uop
    pub(crate) fn wrap_uop(&mut self, uop: u32) -> u32 {
        let lam = idx(self.lams.len());
        let fused = idx(self.fused.len());
        self.fused.push(SFused { first_uop: uop, n_uops: 1, laminated_uop: lam, issued: UNSET, retired: UNSET, retire_idx: UNSET });
        self.uops[uop as usize].fused_uop = fused;
        self.lams.push(SLam { first_fused_uop: fused, n_fused_uops: 1, first_uop: uop, n_uops: 1, added_to_idq: UNSET, uop_source: None });
        lam
    }

    /// `InstrInstance(instr, address, rnd)`
    pub(crate) fn new_instr_instance(&mut self, instr: usize, address: i64, rnd: i64) -> u32 {
        let inst = idx(self.insts.len());
        let info = &self.prep.info[instr];
        let (u_base, f_base, l_base) = (idx(self.uops.len()), idx(self.fused.len()), idx(self.lams.len()));
        let (s, n) = info.tmpl_uops;
        self.uops.extend(self.prep.tmpl_uops[s as usize..(s + n) as usize].iter().map(|t| {
            let mut u = *t;
            u.instr_instance = inst;
            u.fused_uop += f_base;
            u
        }));
        let (s, n) = info.tmpl_fused;
        self.fused.extend(self.prep.tmpl_fused[s as usize..(s + n) as usize].iter().map(|t| {
            let mut f = *t;
            f.first_uop += u_base;
            f.laminated_uop += l_base;
            f
        }));
        let (s, n_lams) = info.tmpl_lams;
        self.lams.extend(self.prep.tmpl_lams[s as usize..(s + n_lams) as usize].iter().map(|t| {
            let mut l = *t;
            l.first_fused_uop += f_base;
            l.first_uop += u_base;
            l
        }));
        self.insts.push(SInst {
            instr: instr as u32,
            address,
            rnd,
            first_uop: l_base,
            n_uops: n_lams,
            source: None,
            predecoded: UNSET,
            removed_from_iq: UNSET,
        });
        inst
    }

    /// `RenamedOperand.getReadyCycle`
    #[inline]
    pub(crate) fn get_ready_cycle(&mut self, ren_op: u32) -> Option<i64> {
        let ready = self.ren_ops[ren_op as usize].ready;
        if ready != READY_UNSET {
            return Some(ready);
        }
        self.compute_ready_cycle(ren_op)
    }

    /// `RenamedOperand.getReadyCycle` for an operand whose ready cycle is not known yet
    #[inline(never)]
    fn compute_ready_cycle(&mut self, ren_op: u32) -> Option<i64> {
        let ro = self.ren_ops[ren_op as usize];
        let u = ro.uop as usize;
        let prop = &self.prep.props[self.uops[u].prop as usize];
        let (is_load, forward_delay, forward_fail_delay, mem_renaming) =
            (prop.has(pf::LOAD), prop.forward_delay, prop.forward_fail_delay, prop.has(pf::MEM_RENAMING));
        let sbe = self.uops[u].store_buffer_entry;

        if is_load && sbe != NONE && mem_renaming && !self.uops[u].mem_renaming_blocked {
            // memory renaming: the load gets its value directly from the register that was stored
            let mut any_none = false;
            let issued = self.fused[self.uops[u].fused_uop as usize].issued;
            let mut ready = if issued == UNSET { 0 } else { issued };
            let mut first = true;
            let mut max_ready = 0;
            for i in 0..self.rn.sbes[sbe as usize].uops.len() {
                let su = self.rn.sbes[sbe as usize].uops.get(i) as usize;
                if self.prep.props[self.uops[su].prop as usize].has(pf::STORE_DATA) {
                    for j in self.uops[su].ren_in() {
                        let r = self.ren_lists[j as usize];
                        match self.get_ready_cycle(r) {
                            None => any_none = true,
                            Some(c) => {
                                if first || c > max_ready {
                                    max_ready = c;
                                    first = false;
                                }
                            }
                        }
                    }
                }
            }
            if any_none {
                return None;
            }
            if !first && max_ready > ready {
                ready = max_ready;
            }
            self.ren_ops[ren_op as usize].ready = ready;
            return Some(ready);
        }

        let dispatched = opt(self.uops[u].dispatched)?;
        let mut lat = ro.lat;
        if self.uops[u].lat_reduced_due_to_fast_ptr_chasing {
            lat -= 1;
        }
        let ready;
        if is_load && sbe != NONE {
            let sb = &self.rn.sbes[sbe as usize];
            let (Some(a), Some(d)) = (sb.address_ready_cycle, sb.data_ready_cycle) else { return None };
            let mut mem_ready = a.max(d) + forward_delay;
            if self.uops[u].forward_fails {
                mem_ready += forward_fail_delay;
            }
            ready = (dispatched + lat).max(mem_ready);
        } else {
            ready = dispatched + lat;
        }
        self.ren_ops[ren_op as usize].ready = ready;
        Some(ready)
    }
}

/// Simulates the instructions (`runSimulation` without `getInstructions`, `adjustLatenciesAndAddMergeUops` and
/// `computeUopProperties`, whose result is `list`).
pub fn simulate(list: &InstrList, config: &UArchConfig, uarch: &UArch, options: &SimOptions) -> Result<SimResult, SimError> {
    simulate_impl(list, config, uarch, options, false)
}

/// [`simulate`], also recording the issue log ([`SimResult::issue_log`]); the result is otherwise the same.
pub fn simulate_with_issue_log(list: &InstrList, config: &UArchConfig, uarch: &UArch, options: &SimOptions) -> Result<SimResult, SimError> {
    simulate_impl(list, config, uarch, options, true)
}

fn simulate_impl(list: &InstrList, config: &UArchConfig, uarch: &UArch, options: &SimOptions, log_issue: bool) -> Result<SimResult, SimError> {
    if config.simple_port_assignment {
        return Err(SimError::Unsupported("configurations with simplePortAssignment".to_string()));
    }
    let instrs = &list.instrs[..];
    if instrs.is_empty() {
        return Err(SimError::NoInstructions);
    }
    // there is no front-end model for AMD CPUs
    let simple_front_end = options.simple_front_end || config.is_amd;

    let prep = Prep::new(list, config, uarch)?;
    let n_ports = prep.ports.len();
    let unroll = !instrs[instrs.len() - 1].is_branch_instr;
    // An estimate of the sizes of the entity arrays (only a capacity, to avoid reallocating large arrays): the simulation runs
    // for at least minCycles cycles and minIterations rounds; at most issueWidth fused uops are issued per cycle; the front end
    // creates instances ahead of the issue (a quarter and 16 rounds more).
    let (n_uops_per_round, n_ren_per_round) = prep.props_per_round();
    let n_fused_per_round = instrs.iter().map(|i| i.retire_slots.max(1) as usize).sum::<usize>().max(1);
    let est_rounds = ((options.min_cycles.clamp(0, 1 << 30) as u64 * config.issue_width.clamp(1, 1 << 10) as u64) / n_fused_per_round as u64)
        .max(options.min_iterations.clamp(0, 1 << 30) as u64);
    let est_rounds = (est_rounds + est_rounds / 4).saturating_add(16).min(1 << 20) as usize;
    // (bounded, so that options like a large minCycles do not reserve much memory up front, e.g. in WebAssembly)
    let cap = |per_round: usize| per_round.saturating_mul(est_rounds).min(1 << 16);
    let mut sim = Sim {
        cfg: config,
        instrs,
        n_ports,
        uops: Vec::with_capacity(cap(n_uops_per_round)),
        fused: Vec::with_capacity(cap(n_uops_per_round)),
        lams: Vec::with_capacity(cap(n_uops_per_round)),
        insts: Vec::with_capacity(cap(instrs.len())),
        reg_merge_uops: Vec::new(),
        stack_sync_uops: Vec::new(),
        ren_ops: Vec::with_capacity(cap(n_ren_per_round)),
        ren_lists: Vec::with_capacity(cap(n_ren_per_round * 2)),
        idq: VecDeque::new(),
        rob: VecDeque::new(),
        retire_queue: VecDeque::new(),
        fe: frontend::FrontEnd::new(unroll, options.alignment_offset, prep.info.iter().map(|i| i.len).sum()),
        rn: renamer::Renamer::new(options.init_policy, config.load_value_numbering, prep.keys.info.len(), config.move_elimination_pipeline_length, prep.mem_addrs.len()),
        sched: scheduler::Scheduler::new(&prep, config),
        prep,
        issue_log: log_issue.then(|| IssueLog { width: config.issue_width, ..IssueLog::default() }),
    };
    if options.init_policy == InitPolicy::Stack {
        let (rsp, rbp) = (sim.prep.keys.lookup("RSP"), sim.prep.keys.lookup("RBP"));
        sim.rn.seed_stack_registers(rsp, rbp);
    }
    sim.fe.all_generated_instr_instances.reserve(cap(instrs.len()));
    sim.sched.reserve(cap(n_uops_per_round));
    sim.front_end_init(simple_front_end)?;

    // unreachable: the list is not empty (checked above) and getInstructions marks its last instruction isLastInstr
    let last_applicable_instr = instrs.iter().position(|i| i.is_last_decoded_instr()).ok_or_else(|| crash("StopIteration: no last instruction"))?;

    let mut clock: i64 = 0;
    let mut rnd: i64 = 0;
    // uopsForRound[rnd][lastApplicableInstr][-1]
    let mut last_uop_for_round: Vec<u32> = Vec::new();
    loop {
        sim.front_end_cycle(clock)?;
        while let Some(fused) = sim.retire_queue.pop_front() {
            let f = &sim.fused[fused as usize];
            if f.n_uops > 0 {
                let uop = &sim.uops[f.first_uop as usize];
                let instr = sim.prep.props[uop.prop as usize].instr as usize;
                rnd = sim.insts[uop.instr_instance as usize].rnd;
                if rnd >= last_uop_for_round.len() as i64 {
                    last_uop_for_round.push(NONE);
                }
                if rnd < 0 || rnd >= last_uop_for_round.len() as i64 {
                    // unreachable: uops retire in program order and every round delivers uops, so a round is at most one more
                    // than the last; a round that is read is complete (an incomplete first round is the InputError below)
                    return Err(crash("IndexError: list index out of range (uopsForRound)"));
                }
                if instr == last_applicable_instr {
                    last_uop_for_round[rnd as usize] = fused;
                }
            }
        }
        if rnd >= options.min_iterations && clock > options.min_cycles {
            break;
        }
        clock += 1;
        if clock > 100_000_000 {
            return Err(SimError::InvalidInput("the simulation does not terminate".to_string()));
        }
    }

    let n_rounds = last_uop_for_round.len() as i64;
    let mut last_relevant_round = (n_rounds - 2).max(0); // the last round may be incomplete
    let first_relevant_round = last_relevant_round.min(n_rounds / 2);
    if last_uop_for_round.get(first_relevant_round as usize).is_none_or(|&f| f == NONE) {
        // only possible with minIterations < 1: the simulation stopped before the first iteration was complete (fork: InputError;
        // upstream: IndexError)
        return Err(SimError::InputError("no iteration was completed (minIterations must be at least 1, or minCycles larger)".to_string()));
    }
    let fused_of = |r: i64| -> Result<&SFused, SimError> {
        match last_uop_for_round.get(r as usize) {
            Some(&f) if f != NONE => Ok(&sim.fused[f as usize]),
            // unreachable: uops retire in program order, so a round that is read is complete (an incomplete first round is the
            // InputError above)
            _ => Err(crash("IndexError: list index out of range (uopsForRound)")),
        }
    };
    if last_relevant_round - first_relevant_round > 10 {
        let mut r = last_relevant_round;
        while r > last_relevant_round - 5 {
            if fused_of(first_relevant_round)?.retire_idx == fused_of(r)?.retire_idx {
                last_relevant_round = r;
                break;
            }
            r -= 1;
        }
    }
    // unreachable: only retired fused uops are recorded (the ROB sets retired before it queues them)
    let retired = |r: i64| -> Result<i64, SimError> { opt(fused_of(r)?.retired).ok_or_else(|| crash("uop not retired")) };
    let tp = if first_relevant_round == last_relevant_round {
        retired(first_relevant_round)? as f64
    } else {
        round2((retired(last_relevant_round)? - retired(first_relevant_round)?) as f64 / (last_relevant_round - first_relevant_round) as f64)
    };

    let issue_log = match sim.issue_log.take() {
        Some(mut log) => {
            // the steady state: from the cycle that issued the end of the first relevant round to the one that issued the end of
            // the last one
            let issued = |r: i64| fused_of(r).ok().and_then(|f| opt(f.issued));
            log.first_round = first_relevant_round;
            log.last_round = last_relevant_round;
            log.first_cycle = issued(first_relevant_round).unwrap_or(0);
            log.last_cycle = issued(last_relevant_round).unwrap_or(log.first_cycle);
            Some(log)
        }
        None => None,
    };
    let mut result = output::build_result(sim, tp, first_relevant_round, last_relevant_round, clock - 1);
    result.issue_log = issue_log;
    Ok(result)
}

#[cfg(test)]
mod tests {
    #[test]
    fn round2_rounds_like_python() {
        // exact ties are rounded to even
        assert_eq!(super::round2(0.125), 0.12);
        assert_eq!(super::round2(0.375), 0.38);
        assert_eq!(super::round2(2.625), 2.62);
        assert_eq!(super::round2(2.675), 2.67); // below the tie in binary
        assert_eq!(super::round2(1.0 / 3.0), 0.33);
        assert_eq!(super::round2(14.0 / 3.0), 4.67);
        assert_eq!(format!("{:.2}", 0.125), "0.12");
        assert_eq!(format!("{:.2}", 0.375), "0.38");
    }
}
