//! The pipeline simulator: a port of the simulation part of uiCA's `uiCA.py` (front end with predecoder, decoders, DSB, LSD,
//! microcode sequencer and op cache; renamer; scheduler; reorder buffer; the main loop and the throughput computation), of the
//! uop table and of the `-json` output. See docs/DESIGN.md.
//!
//! The Python objects are stored in flat arrays ([`SimResult::uops`] etc.) and refer to each other by index. The index of a uop
//! is its `idx` in the reference (the order of creation), which the scheduler uses as the age of a uop.

mod frontend;
mod output;
mod prep;
mod renamer;
mod scheduler;

pub use output::{canonicalize_instr_string, get_terminal_hyperlink, get_url, TableValue};

use crate::config::{UArch, UArchConfig};
use crate::model::{Instr, InstrList};
use prep::{Prep, NONE};
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
}

impl std::fmt::Display for SimError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            SimError::Unsupported(s) => write!(f, "not supported: {s}"),
            SimError::NoInstructions => write!(f, "no instructions found"),
            SimError::ReferenceCrash(s) => write!(f, "the reference implementation fails for this input: {s}"),
            SimError::InvalidInput(s) => write!(f, "invalid input: {s}"),
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
    pub(crate) prop: u32,
    /// index into [`SimResult::instr_instances`]
    pub instr_instance: u32,
    /// index into [`SimResult::fused_uops`]
    pub fused_uop: u32,
    /// index into the ports of the microarchitecture
    pub actual_port: Option<u8>,
    pub eliminated: bool,
    pub(crate) ren_in: (u32, u32),
    pub(crate) ren_out: (u32, u32),
    pub(crate) store_buffer_entry: u32,
    pub(crate) mem_renaming_blocked: bool,
    pub(crate) forward_fails: bool,
    pub(crate) lat_reduced_due_to_fast_ptr_chasing: bool,
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
}

/// Python's `round(x, 2)`
pub(crate) fn round2(x: f64) -> f64 {
    format!("{x:.2}").parse().unwrap()
}

pub(crate) struct Sim<'a> {
    pub cfg: &'a UArchConfig,
    pub instrs: &'a [Instr],
    pub prep: Prep,
    pub n_ports: usize,

    pub uops: Vec<Uop>,
    pub fused: Vec<FusedUop>,
    pub lams: Vec<LaminatedUop>,
    pub insts: Vec<InstrInstance>,
    pub ren_ops: Vec<RenamedOperand>,
    pub ren_lists: Vec<u32>,

    pub idq: VecDeque<u32>,
    pub rob: VecDeque<u32>,
    pub retire_queue: VecDeque<u32>,
    pub fe: frontend::FrontEnd,
    pub rn: renamer::Renamer,
    pub sched: scheduler::Scheduler,
}

impl<'a> Sim<'a> {
    /// `Uop(prop, instrI)`
    pub(crate) fn new_uop(&mut self, prop: u32, inst: u32) -> u32 {
        let p = &self.prep.props[prop as usize];
        self.uops.push(Uop {
            prop,
            instr_instance: inst,
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
        });
        (self.uops.len() - 1) as u32
    }

    /// `LaminatedUop([FusedUop([uop])])`; returns the laminated uop
    pub(crate) fn wrap_uop(&mut self, uop: u32) -> u32 {
        let lam = self.lams.len() as u32;
        let fused = self.fused.len() as u32;
        self.fused.push(FusedUop { first_uop: uop, n_uops: 1, laminated_uop: lam, issued: None, retired: None, retire_idx: None });
        self.uops[uop as usize].fused_uop = fused;
        self.lams.push(LaminatedUop { first_fused_uop: fused, n_fused_uops: 1, first_uop: uop, n_uops: 1, added_to_idq: None, uop_source: None });
        lam
    }

    /// `InstrInstance(instr, address, rnd)`
    pub(crate) fn new_instr_instance(&mut self, instr: usize, address: i64, rnd: i64) -> u32 {
        let inst = self.insts.len() as u32;
        let (first_prop, n_props) = (self.prep.info[instr].first_prop, self.prep.info[instr].n_props);
        let first_uop = self.uops.len() as u32;
        for p in first_prop..first_prop + n_props {
            self.new_uop(p, inst);
        }
        let first_lam = self.lams.len() as u32;
        let mut uop = first_uop;
        let info = &self.prep.info[instr];
        for lam_group in &info.grouping {
            let lam = self.lams.len() as u32;
            let first_fused = self.fused.len() as u32;
            let lam_first_uop = uop;
            for &n in lam_group {
                let fused = self.fused.len() as u32;
                self.fused.push(FusedUop { first_uop: uop, n_uops: n, laminated_uop: lam, issued: None, retired: None, retire_idx: None });
                for u in uop..uop + n {
                    self.uops[u as usize].fused_uop = fused;
                }
                uop += n;
            }
            self.lams.push(LaminatedUop {
                first_fused_uop: first_fused,
                n_fused_uops: lam_group.len() as u32,
                first_uop: lam_first_uop,
                n_uops: uop - lam_first_uop,
                added_to_idq: None,
                uop_source: None,
            });
        }
        self.insts.push(InstrInstance {
            instr: instr as u32,
            address,
            rnd,
            first_uop: first_lam,
            n_uops: self.lams.len() as u32 - first_lam,
            reg_merge_uops: Vec::new(),
            stack_sync_uops: Vec::new(),
            source: None,
            predecoded: None,
            removed_from_iq: None,
        });
        inst
    }

    /// `RenamedOperand.getReadyCycle`
    pub(crate) fn get_ready_cycle(&mut self, ren_op: u32) -> Option<i64> {
        let ro = self.ren_ops[ren_op as usize];
        if ro.ready != READY_UNSET {
            return Some(ro.ready);
        }
        let u = ro.uop as usize;
        let prop = &self.prep.props[self.uops[u].prop as usize];
        let (is_load, forward_delay, forward_fail_delay, instr) = (prop.is_load, prop.forward_delay, prop.forward_fail_delay, prop.instr);
        let sbe = self.uops[u].store_buffer_entry;

        if is_load && sbe != NONE && self.instrs[instr as usize].mem_renaming && !self.uops[u].mem_renaming_blocked {
            // memory renaming: the load gets its value directly from the register that was stored
            let mut any_none = false;
            let mut ready = self.fused[self.uops[u].fused_uop as usize].issued.unwrap_or(0);
            let mut first = true;
            let mut max_ready = 0;
            for i in 0..self.rn.sbes[sbe as usize].uops.len() {
                let su = self.rn.sbes[sbe as usize].uops[i] as usize;
                if self.prep.props[self.uops[su].prop as usize].is_store_data {
                    let (start, n) = self.uops[su].ren_in;
                    for j in start..start + n {
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

        let dispatched = self.uops[u].dispatched?;
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
    let mut sim = Sim {
        cfg: config,
        instrs,
        n_ports,
        uops: Vec::new(),
        fused: Vec::new(),
        lams: Vec::new(),
        insts: Vec::new(),
        ren_ops: Vec::new(),
        ren_lists: Vec::new(),
        idq: VecDeque::new(),
        rob: VecDeque::new(),
        retire_queue: VecDeque::new(),
        fe: frontend::FrontEnd::new(unroll, options.alignment_offset),
        rn: renamer::Renamer::new(options.init_policy, config.load_value_numbering, prep.keys.info.len()),
        sched: scheduler::Scheduler::new(n_ports, prep.n_resources),
        prep,
    };
    sim.front_end_init(simple_front_end)?;

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
    let fused_of = |r: i64| -> Result<&FusedUop, SimError> {
        match last_uop_for_round.get(r as usize) {
            Some(&f) if f != NONE => Ok(&sim.fused[f as usize]),
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
    let retired = |r: i64| -> Result<i64, SimError> { fused_of(r)?.retired.ok_or_else(|| crash("uop not retired")) };
    let tp = if first_relevant_round == last_relevant_round {
        retired(first_relevant_round)? as f64
    } else {
        round2((retired(last_relevant_round)? - retired(first_relevant_round)?) as f64 / (last_relevant_round - first_relevant_round) as f64)
    };

    Ok(output::build_result(sim, tp, first_relevant_round, last_relevant_round, clock - 1))
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
