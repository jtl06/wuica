//! Details of an analysis (not in the reference; `"details": true` in the request, docs/WASM-API.md): per row of the uop table
//! the instruction's static data (allowed ports and latencies per uop, uop counts, front-end facts), the set of ports behind the
//! "Ports" limit, and the issue log of the simulation summarized per cause. Everything is read from the instruction objects and
//! the result of the simulation; nothing here changes them, so the rest of the response is the same with and without details.

use crate::config::UArchConfig;
use crate::model::{Instr, InstrList, OpId, Operand};
use crate::sim::issue::{self as issue_cause, IssueLog};
use crate::sim::SimResult;
use crate::facile::{py_sum, Num, SimView};
use serde::Serialize;

/// The details of an analysis.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Details {
    /// one entry per row of the uop table; `None` for the extra uops (register merge, stack sync)
    pub rows: Vec<Option<InstrDetails>>,
    /// the ports behind the "Ports" limit; `None` if no uop needs a port
    pub ports: Option<PortSet>,
    /// the issue slots of the steady state, per cause
    pub issue: Option<IssueSummary>,
}

/// The static data of an instruction (uops.info's tables as the model uses them) and its place in the code.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstrDetails {
    /// the index of the instruction (in the order of the code)
    pub index: usize,
    /// (allowed ports, number of uops), e.g. [(["Port 0", "Port 1", "Port 5", "Port 6"], 1)]: uops.info's `1*p0156`; the ports
    /// are named as the columns of the uop table
    #[serde(rename = "portData")]
    pub port_data: Vec<PortUops>,
    /// the unfused-domain uops: their allowed ports and the latency from their inputs to their outputs
    #[serde(rename = "uopList")]
    pub uop_list: Vec<UopDetails>,
    /// latency per (input, output) operand pair of the instruction, in cycles
    pub latencies: Vec<Latency>,
    /// unfused-domain uops (uops.info's "uops")
    pub uops: i64,
    /// fused-domain uops (issue and retire slots)
    #[serde(rename = "retireSlots")]
    pub retire_slots: i64,
    /// uops from the legacy decoders and from the microcode sequencer
    #[serde(rename = "uopsMITE")]
    pub uops_mite: i64,
    #[serde(rename = "uopsMS")]
    pub uops_ms: i64,
    /// reciprocal throughput from the tables (cycles), if it limits the instruction
    #[serde(rename = "tpTable")]
    pub tp: Option<f64>,
    #[serde(rename = "divCycles")]
    pub div_cycles: i64,
    /// length in bytes
    pub length: i64,
    /// offset of the first byte from the 64-byte boundary before the block's first iteration (alignment offset + position)
    pub offset: i64,
    /// the boundaries (16, 32, 64) that the instruction crosses at its offset
    pub crosses: Vec<i64>,
    /// a length-changing prefix (a predecoder stall)
    pub lcp: bool,
    /// uops from the microcode sequencer
    pub microcoded: bool,
    #[serde(rename = "complexDecoder")]
    pub complex_decoder: bool,
    #[serde(rename = "macroFusedWithPrev")]
    pub macro_fused_with_prev: bool,
    #[serde(rename = "macroFusedWithNext")]
    pub macro_fused_with_next: bool,
    #[serde(rename = "mayBeEliminated")]
    pub may_be_eliminated: bool,
    pub branch: bool,
    pub serializing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PortUops {
    pub ports: Vec<String>,
    pub uops: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UopDetails {
    /// `None` for a uop without a port
    pub ports: Option<Vec<String>>,
    pub inputs: Vec<String>,
    /// (output, latency in cycles)
    pub outputs: Vec<(String, i64)>,
    #[serde(rename = "divCycles")]
    pub div_cycles: i64,
    pub load: bool,
    #[serde(rename = "storeAddress")]
    pub store_address: bool,
    #[serde(rename = "storeData")]
    pub store_data: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Latency {
    pub from: String,
    pub to: String,
    pub cycles: i64,
}

/// The set of ports whose uops give the "Ports" limit (Facile's port model: the union of allowed port sets with the most uops per
/// port), and the uops of each row that can only use these ports.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PortSet {
    /// named as the columns of the uop table
    pub ports: Vec<String>,
    /// uops per iteration that can only use these ports
    pub uops: f64,
    /// uops / number of ports: the "Ports" limit before rounding
    pub tp: f64,
    /// per row of the uop table: its uops on the set (0 for rows without)
    pub rows: Vec<f64>,
}

/// The issue slots (issue width × cycles) of the steady state, per iteration: used, and lost per cause.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IssueSummary {
    pub width: i64,
    /// the steady-state window: cycles and iterations
    pub cycles: i64,
    pub iterations: i64,
    /// slots per iteration: issued uops, and the lost slots by cause (front end: the IDQ ran empty; rob, rs: the reorder buffer or
    /// the scheduler was full; other: the next uop did not fit, serialization, merge uops)
    pub slots: IssueSlots,
    /// the first cycle of the window
    pub first: i64,
    /// per cycle of the window (at most `MAX_CYCLES`): the number of issued uops
    pub issued: Vec<u8>,
    /// per cycle of the window: "." (the full width was issued), "F", "R", "S" or "O" (as in `slots`)
    pub cause: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct IssueSlots {
    pub issued: f64,
    #[serde(rename = "frontEnd")]
    pub front_end: f64,
    pub rob: f64,
    pub rs: f64,
    pub other: f64,
}

/// the most cycles of the window listed one by one
pub const MAX_CYCLES: usize = 4096;

fn port_name(config: &UArchConfig, p: char) -> String {
    let p = p.to_string();
    config.port_names.get(&p).cloned().unwrap_or_else(|| format!("Port {p}"))
}

fn ports_of(config: &UArchConfig, ports: &str) -> Vec<String> {
    ports.chars().map(|c| port_name(config, c)).collect()
}

/// the name of an operand as the details show it: a register ("RAX"), "flags (C)", "mem", "[RSI]" for an address register
fn operand_name(instrs: &InstrList, instr: &Instr, op: OpId) -> String {
    match &instrs.operands[op as usize] {
        Operand::Reg { reg, .. } => {
            if instr.mem_addr_operands.contains(&op) || instr.agen_operands.contains(&op) {
                format!("[{reg}]")
            } else {
                reg.clone()
            }
        }
        Operand::Flag { flags } => format!("flags ({flags})"),
        Operand::Mem { .. } => "mem".to_string(),
        Operand::Pseudo => "pseudo".to_string(),
    }
}

fn instr_details(instrs: &InstrList, config: &UArchConfig, index: usize, offset: i64) -> InstrDetails {
    let instr = &instrs.instrs[index];
    let length = instr.opcode.len() as i64 / 2;
    let crosses = [16, 32, 64].into_iter().filter(|&b| length > 0 && offset.div_euclid(b) != (offset + length - 1).div_euclid(b)).collect();
    let name = |op: OpId| operand_name(instrs, instr, op);
    InstrDetails {
        index,
        port_data: instr.port_data.iter().map(|(p, n)| PortUops { ports: ports_of(config, p), uops: *n }).collect(),
        uop_list: instr
            .uop_properties_list
            .iter()
            .map(|u| UopDetails {
                ports: u.possible_ports.as_ref().map(|ps| ps.iter().flat_map(|p| ports_of(config, p)).collect()),
                inputs: u.input_operands.iter().map(|&o| name(o)).collect(),
                outputs: u.output_operands.iter().map(|&o| (name(o), u.latencies.iter().find(|(x, _)| *x == o).map_or(1, |(_, l)| *l))).collect(),
                div_cycles: u.div_cycles,
                load: u.is_load_uop,
                store_address: u.is_store_address_uop,
                store_data: u.is_store_data_uop,
            })
            .collect(),
        latencies: instr.latencies.iter().map(|&(i, o, l)| Latency { from: name(i), to: name(o), cycles: l }).collect(),
        uops: instr.uops,
        retire_slots: instr.retire_slots,
        uops_mite: instr.uops_mite,
        uops_ms: instr.uops_ms,
        tp: instr.tp,
        div_cycles: instr.div_cycles,
        length,
        offset,
        crosses,
        lcp: instr.lcp_stall,
        microcoded: instr.uops_ms > 0,
        complex_decoder: instr.complex_decoder,
        macro_fused_with_prev: instr.macro_fused_with_prev_instr,
        macro_fused_with_next: instr.macro_fused_with_next_instr,
        may_be_eliminated: instr.may_be_eliminated,
        branch: instr.is_branch_instr,
        serializing: instr.is_serializing_instr,
    }
}

/// a set of port characters as a bit set (as `facile::port_set`)
fn port_bits(ports: &str) -> u128 {
    ports.chars().fold(0, |set, c| if c.is_ascii() { set | 1u128 << (c as u32) } else { set })
}

/// The port set of `computePortUsageLimit` (facile.rs `port_usage_limit`: the same unions in the same order, the first with the
/// largest value), and the uops of each instruction on it.
fn port_set(instrs: &InstrList, sim: &SimResult) -> Option<(u128, f64, f64, Vec<f64>)> {
    // per instruction: (set, uops) as the limit counts them
    // (the same arithmetic as facile.rs: integer counts, Python's sum)
    let mut per_instr: Vec<Vec<(u128, Num)>> = vec![Vec::new(); instrs.instrs.len()];
    let mut usage: Vec<(u128, Num)> = Vec::new();
    for (idx, instr) in instrs.instrs.iter().enumerate() {
        if instr.macro_fused_with_prev_instr {
            continue;
        }
        for (ports, n) in &instr.port_data {
            let mut n = Num::Int(*n);
            if instr.may_be_eliminated {
                let k = sim.n_instances(idx);
                if k == 0 {
                    continue;
                }
                n = Num::Float(sim.not_eliminated_uops(idx) as f64 / k as f64);
            }
            let set = port_bits(ports);
            per_instr[idx].push((set, n));
            match usage.iter_mut().find(|(s, _)| *s == set) {
                Some((_, m)) => *m = m.add(n),
                None => usage.push((set, Num::Int(0).add(n))),
            }
        }
    }
    let mut unions: Vec<u128> = Vec::new();
    for (a, _) in &usage {
        for (b, _) in &usage {
            if !unions.contains(&(a | b)) {
                unions.push(a | b);
            }
        }
    }
    // max(TP, v) from TP = 0: the first union with the largest positive value; none if no uop needs a port
    let mut best: Option<(u128, f64, f64)> = None;
    for pc in unions {
        if pc == 0 {
            continue;
        }
        let uops = py_sum(usage.iter().filter(|(s, _)| s & !pc == 0).map(|(_, u)| *u)).as_f64();
        let v = uops / pc.count_ones() as f64;
        if v > best.map_or(0.0, |(_, _, tp)| tp) {
            best = Some((pc, uops, v));
        }
    }
    let (pc, uops, tp) = best?;
    let per_row: Vec<f64> = per_instr.iter().map(|l| py_sum(l.iter().filter(|(s, _)| s & !pc == 0).map(|(_, n)| *n)).as_f64()).collect();
    Some((pc, uops, tp, per_row))
}

fn issue_summary(log: &IssueLog) -> Option<IssueSummary> {
    let (first, last) = (log.first_cycle, log.last_cycle);
    let iterations = log.last_round - log.first_round;
    if iterations <= 0 || last <= first || last as usize >= log.issued.len() {
        return None;
    }
    let mut slots = IssueSlots::default();
    let range = (first + 1) as usize..=last as usize;
    for c in range.clone() {
        let n = log.issued[c] as f64;
        slots.issued += n;
        let lost = (log.width as f64 - n).max(0.0);
        match log.cause[c] {
            issue_cause::FRONT_END => slots.front_end += lost,
            issue_cause::ROB_FULL => slots.rob += lost,
            issue_cause::RS_FULL => slots.rs += lost,
            issue_cause::OTHER => slots.other += lost,
            _ => {}
        }
    }
    let per = |x: f64| (x / iterations as f64 * 100.0).round() / 100.0;
    let slots = IssueSlots { issued: per(slots.issued), front_end: per(slots.front_end), rob: per(slots.rob), rs: per(slots.rs), other: per(slots.other) };
    let (start, end) = (*range.start(), (*range.start() + MAX_CYCLES - 1).min(*range.end()));
    Some(IssueSummary {
        width: log.width,
        cycles: last - first,
        iterations,
        slots,
        first: first + 1,
        issued: log.issued[start..=end].to_vec(),
        cause: String::from_utf8_lossy(&log.cause[start..=end]).into_owned(),
    })
}

/// Whether the issue log's window is in the steady state: its cycles per iteration are the throughput (measured at retirement
/// over the same rounds). Issue runs ahead of retirement until the reorder buffer or the scheduler is full; a simulation of
/// minCycles often ends before (about a quarter of random blocks), and then the window is warm-up (docs/plans/qa-r2.md, D1).
pub fn issue_log_is_steady(log: &IssueLog, tp: f64) -> bool {
    window_is_steady(log.last_cycle - log.first_cycle, log.last_round - log.first_round, tp)
}

/// the same for a window of `cycles` and `iterations` (IssueSummary): within 3 % of the throughput and two cycles (the window
/// starts and ends at the cycles that issued the ends of rounds)
pub fn window_is_steady(cycles: i64, iterations: i64, tp: f64) -> bool {
    if iterations <= 0 || !(tp > 0.0) {
        return true;
    }
    let cpi = cycles as f64 / iterations as f64;
    (cpi - tp).abs() <= 0.03 * tp + 2.0 / iterations as f64
}

/// the most instructions (instructions × iterations) a longer simulation for the issue log may simulate (a few tens of ms natively; the first result is kept meanwhile, so it also bounds the memory)
const STEADY_BUDGET: f64 = 2.5e5;

/// With details (and no trace, whose cycles the issue log must match): if the issue log of `sim` is not in the steady state, the
/// log of a longer simulation (8 and 64 times minCycles) that is; the main result is not changed (`sim` keeps its throughput
/// and table; only its `issue_log` is replaced). Nothing is replaced if the longer simulations fail, are not steady either, or
/// would be too large.
pub fn steady_issue_log(instrs: &InstrList, config: &UArchConfig, uarch: &crate::config::UArch, options: &crate::sim::SimOptions, sim: &mut SimResult) {
    let Some(log) = sim.issue_log.as_ref() else { return };
    if issue_log_is_steady(log, sim.tp) {
        return;
    }
    // how far the window's cycles per iteration are from the throughput, relative
    let off = |l: &IssueLog, tp: f64| {
        let it = (l.last_round - l.first_round).max(1) as f64;
        ((l.last_cycle - l.first_cycle) as f64 / it - tp).abs() / tp.max(1e-9)
    };
    let mut best = off(log, sim.tp);
    let n = instrs.instrs.len().max(1) as f64;
    let base = options.min_cycles.max(500);
    // the cycles simulated already (the simulation also runs until minIterations are done)
    let simulated = log.issued.len() as i64;
    for factor in [8, 64] {
        let min_cycles = base * factor;
        if min_cycles <= simulated {
            continue; // the same simulation again
        }
        // the instructions a simulation of min_cycles runs: at least minIterations iterations, else (min_cycles / tp), of n
        let iterations = (options.min_iterations.max(1) as f64).max(min_cycles as f64 / sim.tp.max(0.25));
        if n * iterations > STEADY_BUDGET {
            return;
        }
        let longer = crate::sim::SimOptions { min_cycles, ..options.clone() };
        let Ok(r) = crate::sim::simulate_with_issue_log(instrs, config, uarch, &longer) else { return };
        if let Some(l) = r.issue_log {
            // against the response's throughput (that of the longer simulation can differ a little)
            let steady = issue_log_is_steady(&l, sim.tp);
            let d = off(&l, sim.tp);
            if steady || d < best {
                best = d;
                sim.issue_log = Some(l);
            }
            if steady {
                return;
            }
        }
    }
}

/// The details of an analysis. `row_of_instr`: the row of the uop table of each instruction; `n_rows`: the number of rows.
pub fn details(instrs: &InstrList, config: &UArchConfig, sim: &SimResult, alignment_offset: i64, row_of_instr: &[usize], n_rows: usize) -> Details {
    let mut rows: Vec<Option<InstrDetails>> = vec![None; n_rows];
    let mut offset = alignment_offset;
    for (i, instr) in instrs.instrs.iter().enumerate() {
        if let Some(&r) = row_of_instr.get(i) {
            if r < n_rows {
                rows[r] = Some(instr_details(instrs, config, i, offset));
            }
        }
        offset += instr.opcode.len() as i64 / 2;
    }
    let ports = port_set(instrs, sim).map(|(pc, uops, tp, per_instr)| {
        let mut per_row = vec![0.0; n_rows];
        for (i, n) in per_instr.into_iter().enumerate() {
            if let Some(&r) = row_of_instr.get(i) {
                if r < n_rows {
                    per_row[r] = n;
                }
            }
        }
        let names = (0..128u32).filter(|b| pc & (1u128 << b) != 0).map(|b| port_name(config, char::from_u32(b).unwrap_or('?'))).collect();
        PortSet { ports: names, uops, tp, rows: per_row }
    });
    Details { rows, ports, issue: sim.issue_log.as_ref().and_then(issue_summary) }
}
