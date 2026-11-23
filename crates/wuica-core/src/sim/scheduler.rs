//! `Scheduler`: port assignment, dispatch, and the tracking of when uops become ready and finish.

use super::prep::{pf, PortList, Prep, NONE};
use super::{crash, opt, Sim, SimError, NO_PORT};
use crate::config::UArchConfig;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

/// index of 'div' in `blockedResources`; 'port' + p is at 1 + (index of p)
const RES_DIV: usize = 0;

/// the rule of `addNewUops` for uops with more than one port
#[derive(Clone, Copy, PartialEq, Eq)]
enum PortAssignment {
    /// `isAMD`: the least-loaded port, ties broken by `portLastAssigned`
    Amd,
    /// `portAssignment == 'ICL'` (or 10 ports)
    Icl,
    /// 8 ports
    Eight,
    /// the other microarchitectures
    Other,
}

/// The ports that the rules of the scheduler refer to by name, as indices (`NO_PORT` if there is no such port), and the
/// orders of the tie-break rules.
struct PortNames {
    p2: u8,
    p3: u8,
    p4: u8,
    p7: u8,
    p8: u8,
    p9: u8,
    /// `dividerPort`
    divider: u8,
    /// '0', '1', '5'
    p0: u8,
    p1: u8,
    p5: u8,
    /// rank of each port in the order of the key `-int(port, 16)` (then the port order); `(usage, rank)` sorts like
    /// `(usage, -int(port, 16))`
    rank_neg_hex: [u8; 32],
    /// rank of each port in the order of `int(port, 16)`
    rank_hex: [u8; 32],
}


pub(crate) struct Scheduler {
    /// `len(self.uops)`
    n_uops: i64,
    port_usage: Vec<i64>,
    /// `portUsageAtStartOfCycle` of the previous and of the current cycle
    port_usage_prev_cycle: Vec<i64>,
    port_usage_cur_cycle: Vec<i64>,
    /// (indices of the ports)
    next_p23_port: u8,
    next_p49_port: u8,
    next_p78_port: u8,
    assignment: PortAssignment,
    names: PortNames,
    /// the port usage counter is decreased one cycle after uops are dispatched
    uops_dispatched_in_prev_cycle: Vec<u32>,
    /// heaps of uop indices
    ready_queue: Vec<BinaryHeap<Reverse<u32>>>,
    ready_div_uops: BinaryHeap<Reverse<u32>>,
    /// used as a tie-breaker on AMD CPUs
    port_last_assigned: Vec<i64>,
    n_ports_assigned: i64,
    uops_ready_in_cycle: CycleBuckets,
    /// uops not yet added to uopsReadyInCycle (in order)
    non_ready_uops: Vec<u32>,
    /// reused buffers
    non_ready_uops_spare: Vec<u32>,
    pending_uops_spare: Vec<u32>,
    uops_dispatched_spare: Vec<u32>,
    port_combinations_buf: Vec<(u32, usize)>,
    dispatched_sorted_buf: Vec<u32>,
    /// dispatched, but not finished uops (sorted)
    pending_uops: Vec<u32>,
    pending_store_fence_uops: VecDeque<u32>,
    store_uops_since_last_store_fence: Vec<u32>,
    pending_load_fence_uops: VecDeque<u32>,
    load_uops_since_last_load_fence: Vec<u32>,
    /// for how many remaining cycles a resource will be blocked
    blocked_resources: Vec<f64>,
    /// the resources that may be non-zero (each once): the others stay 0 in updateBlockedResources
    blocked_active: Vec<u32>,
    blocked_is_active: Vec<bool>,
    /// uops that have an operand that is written by a non-executed uop: producer uop -> uops (in insertion order), as linked
    /// lists in `dep_nodes`: (first node, last node) for each producer
    dep_lists: Vec<(u32, u32)>,
    /// (uop, next node)
    dep_nodes: Vec<(u32, u32)>,
}

/// `uopsReadyInCycle`: cycle -> uops, for the cycles after the current one. A ring of buckets indexed by `cycle & mask`; it
/// grows when a uop becomes ready further in the future than it covers. Every bucket holds the uops of exactly one cycle in
/// `clock + 1 ..= clock + len`, because the scheduler takes the bucket of each cycle in that cycle. A bucket is a linked list
/// (in insertion order) of nodes in one arena, whose freed nodes are reused: no allocation per bucket.
struct CycleBuckets {
    /// (first node, last node) of each bucket, NONE if empty
    slots: Vec<(u32, u32)>,
    /// (uop, next node)
    nodes: Vec<(u32, u32)>,
    /// list of free nodes
    free: u32,
}

impl CycleBuckets {
    fn new() -> CycleBuckets {
        CycleBuckets { slots: vec![(NONE, NONE); 64], nodes: Vec::new(), free: NONE }
    }

    /// adds `u` to the bucket of `cycle` (`clock < cycle`)
    fn push(&mut self, clock: i64, cycle: i64, u: u32) {
        debug_assert!(cycle > clock);
        let mut len = self.slots.len() as i64;
        if cycle - clock > len {
            // grow: move every bucket to its position in the larger ring
            while cycle - clock > len {
                len *= 2;
            }
            let old = std::mem::replace(&mut self.slots, vec![(NONE, NONE); len as usize]);
            let old_mask = old.len() as i64 - 1;
            for (i, v) in old.into_iter().enumerate() {
                if v.0 == NONE {
                    continue;
                }
                // the cycle of this bucket: the one in clock+1 ..= clock+old_len with (c & old_mask) == i
                let c = clock + 1 + (i as i64 - (clock + 1)).rem_euclid(old_mask + 1);
                self.slots[(c & (len - 1)) as usize] = v;
            }
        }
        let node = if self.free != NONE {
            let n = self.free;
            self.free = self.nodes[n as usize].1;
            self.nodes[n as usize] = (u, NONE);
            n
        } else {
            self.nodes.push((u, NONE));
            self.nodes.len() as u32 - 1
        };
        let mask = self.slots.len() as i64 - 1;
        let slot = &mut self.slots[(cycle & mask) as usize];
        if slot.0 == NONE {
            *slot = (node, node);
        } else {
            let last = slot.1;
            slot.1 = node;
            self.nodes[last as usize].1 = node;
        }
    }

    /// takes the bucket of `cycle`: returns its first node (walk it with `next`)
    fn take(&mut self, cycle: i64) -> u32 {
        let mask = self.slots.len() as i64 - 1;
        std::mem::replace(&mut self.slots[(cycle & mask) as usize], (NONE, NONE)).0
    }

    /// (uop, next node) of a node of a taken bucket, which is freed
    #[inline]
    fn next(&mut self, node: u32) -> (u32, u32) {
        let (u, next) = self.nodes[node as usize];
        self.nodes[node as usize].1 = self.free;
        self.free = node;
        (u, next)
    }
}

impl Scheduler {
    pub fn new(prep: &Prep, cfg: &UArchConfig) -> Scheduler {
        let n_ports = prep.ports.len();
        let n_resources = prep.n_resources;
        let idx = |c: u8| prep.port_idx[c as usize];
        let mut rank_neg_hex = [0u8; 32];
        let mut rank_hex = [0u8; 32];
        let mut order: Vec<usize> = (0..n_ports).collect();
        order.sort_by_key(|&p| (-prep.port_hex[p], p));
        for (r, &p) in order.iter().enumerate() {
            rank_neg_hex[p] = r as u8;
        }
        order.sort_by_key(|&p| (prep.port_hex[p], p));
        for (r, &p) in order.iter().enumerate() {
            rank_hex[p] = r as u8;
        }
        let names = PortNames {
            p2: idx(b'2'),
            p3: idx(b'3'),
            p4: idx(b'4'),
            p7: idx(b'7'),
            p8: idx(b'8'),
            p9: idx(b'9'),
            divider: if cfg.divider_port.len() == 1 { idx(cfg.divider_port.as_bytes()[0]) } else { NO_PORT },
            p0: idx(b'0'),
            p1: idx(b'1'),
            p5: idx(b'5'),
            rank_neg_hex,
            rank_hex,
        };
        let assignment = if cfg.is_amd {
            PortAssignment::Amd
        } else if cfg.port_assignment.as_deref() == Some("ICL") || (cfg.port_assignment.is_none() && n_ports == 10) {
            PortAssignment::Icl
        } else if n_ports == 8 {
            PortAssignment::Eight
        } else {
            PortAssignment::Other
        };
        Scheduler {
            n_uops: 0,
            port_usage: vec![0; n_ports],
            port_usage_prev_cycle: vec![0; n_ports],
            port_usage_cur_cycle: vec![0; n_ports],
            // (only used for uops whose ports are these two, which then exist)
            next_p23_port: names.p2,
            next_p49_port: names.p4,
            next_p78_port: names.p7,
            assignment,
            names,
            uops_dispatched_in_prev_cycle: Vec::new(),
            ready_queue: (0..n_ports).map(|_| BinaryHeap::new()).collect(),
            ready_div_uops: BinaryHeap::new(),
            port_last_assigned: vec![-1; n_ports],
            n_ports_assigned: 0,
            uops_ready_in_cycle: CycleBuckets::new(),
            non_ready_uops: Vec::new(),
            non_ready_uops_spare: Vec::new(),
            pending_uops_spare: Vec::new(),
            uops_dispatched_spare: Vec::new(),
            port_combinations_buf: Vec::new(),
            dispatched_sorted_buf: Vec::new(),
            pending_uops: Vec::new(),
            pending_store_fence_uops: VecDeque::new(),
            store_uops_since_last_store_fence: Vec::new(),
            pending_load_fence_uops: VecDeque::new(),
            load_uops_since_last_load_fence: Vec::new(),
            blocked_resources: vec![0.0; n_resources],
            blocked_active: Vec::new(),
            blocked_is_active: vec![false; n_resources],
            dep_lists: Vec::new(),
            dep_nodes: Vec::new(),
        }
    }
}

impl Scheduler {
    /// `blockedResources[r]` may now be non-zero
    #[inline]
    fn mark_blocked(&mut self, r: usize) {
        if !self.blocked_is_active[r] {
            self.blocked_is_active[r] = true;
            self.blocked_active.push(r as u32);
        }
    }

    /// reserves space for about `n_uops` uops
    pub fn reserve(&mut self, n_uops: usize) {
        self.dep_lists.reserve(n_uops);
        self.dep_nodes.reserve(n_uops);
    }
}

impl<'a> Sim<'a> {
    /// `Scheduler.isFull`
    pub(crate) fn scheduler_is_full(&self) -> bool {
        self.sched.n_uops + self.cfg.issue_width > self.cfg.rs_width
    }

    /// `Scheduler.cycle`
    pub(crate) fn scheduler_cycle(&mut self, clock: i64, new_uops: &[u32]) -> Result<(), SimError> {
        {
            let mut node = self.sched.uops_ready_in_cycle.take(clock);
            while node != NONE {
                let (u, next) = self.sched.uops_ready_in_cycle.next(node);
                node = next;
                let uop = &self.uops[u as usize];
                if self.prep.props[uop.prop as usize].div_cycles != 0 {
                    self.sched.ready_div_uops.push(Reverse(u));
                } else {
                    let port = uop.actual_port;
                    if port == NO_PORT {
                        // unreachable: only uops that addNewUops assigned a port reach the ready queues
                        return Err(crash("KeyError: None (readyQueue)"));
                    }
                    self.sched.ready_queue[port as usize].push(Reverse(u));
                }
            }
        }
        self.add_new_uops(clock, new_uops)?;
        self.dispatch_uops(clock)?;
        self.process_pending_uops()?;
        self.process_non_ready_uops(clock)?;
        self.process_pending_fences(clock);
        // updateBlockedResources (max(0, r - 1) leaves the resources that are 0 unchanged)
        let s = &mut self.sched;
        let mut i = 0;
        while i < s.blocked_active.len() {
            let r = s.blocked_active[i] as usize;
            let v = s.blocked_resources[r] - 1.0;
            let v = if v > 0.0 { v } else { 0.0 };
            s.blocked_resources[r] = v;
            if v == 0.0 {
                s.blocked_is_active[r] = false;
                s.blocked_active.swap_remove(i);
            } else {
                i += 1;
            }
        }
        Ok(())
    }

    /// `Scheduler.dispatchUops`
    fn dispatch_uops(&mut self, clock: i64) -> Result<(), SimError> {
        let cfg = self.cfg;
        // the applicable ports (a mask of port indices)
        let mut applicable = u32::MAX;
        let (p2, p3, p4, p9) = (self.sched.names.p2, self.sched.names.p3, self.sched.names.p4, self.sched.names.p9);

        if p4 != NO_PORT && p9 != NO_PORT {
            let (p4, p9) = (p4 as usize, p9 as usize);
            if let (Some(&Reverse(uop4)), Some(&Reverse(uop9))) = (self.sched.ready_queue[p4].peek(), self.sched.ready_queue[p9].peek()) {
                // two stores can be executed in the same cycle if they access the same cache line
                let sbe4 = self.uops[uop4 as usize].store_buffer_entry;
                let sbe9 = self.uops[uop9 as usize].store_buffer_entry;
                if sbe4 == NONE || sbe9 == NONE {
                    // unreachable: only store-data uops can use ports 4 and 9 (tables), and every store-data uop has a store
                    // buffer entry
                    return Err(crash("AttributeError: 'NoneType' object has no attribute 'abstractAddress'"));
                }
                let addrs = &self.rn.addrs.values;
                if let (Some(addr4), Some(addr9)) =
                    (addrs[self.rn.sbes[sbe4 as usize].abstract_address as usize], addrs[self.rn.sbes[sbe9 as usize].abstract_address as usize])
                {
                    let different = if addr4.0 != addr9.0 || addr4.1 != addr9.1 || addr4.2 != addr9.2 {
                        true
                    } else {
                        // an address without a displacement (e.g. the stack slot of PUSH m) has displacement 0 (fork fix; upstream:
                        // TypeError for None - None)
                        (addr4.3.unwrap_or(0) - addr9.3.unwrap_or(0)).abs() >= 64
                    };
                    if different {
                        if uop4 <= uop9 {
                            applicable &= !(1 << p9);
                        } else {
                            applicable &= !(1 << p4);
                        }
                    }
                }
            }
        }

        if cfg.slow_256bit_mem_acc {
            if p2 == NO_PORT || p3 == NO_PORT {
                // unreachable: slow256BitMemAcc is only set for SNB and IVB, which have ports 2 and 3
                return Err(crash("KeyError: '2'"));
            }
            let (p2, p3) = (p2 as usize, p3 as usize);
            if let (Some(&Reverse(uop2)), Some(&Reverse(uop3))) = (self.sched.ready_queue[p2].peek(), self.sched.ready_queue[p3].peek()) {
                let is_load = |u: u32| self.prep.props[self.uops[u as usize].prop as usize].has(pf::LOAD);
                let m256 = |u: u32| self.prep.props[self.uops[u as usize].prop as usize].has(pf::M256);
                if is_load(uop2) && is_load(uop3) && (m256(uop2) || m256(uop3)) {
                    applicable &= !(1 << if uop2 < uop3 { p3 } else { p2 });
                }
            }
        }

        let divider_port = self.sched.names.divider as usize;
        let port4 = p4 as usize;
        let mut uops_dispatched = std::mem::take(&mut self.sched.uops_dispatched_spare);
        uops_dispatched.clear();
        for port in 0..self.n_ports {
            if applicable & (1 << port) == 0 {
                continue;
            }
            let s = &mut self.sched;
            let mut use_div_queue = false;
            if port == divider_port && s.blocked_resources[RES_DIV] == 0.0 {
                if let Some(&Reverse(div)) = s.ready_div_uops.peek() {
                    if s.ready_queue[port].peek().map_or(true, |&Reverse(u)| div < u) {
                        use_div_queue = true;
                    }
                }
            }
            // (a port is only blocked with slow256BitMemAcc)
            if cfg.slow_256bit_mem_acc && s.blocked_resources[1 + port] != 0.0 {
                continue;
            }
            let queue = if use_div_queue { &mut s.ready_div_uops } else { &mut s.ready_queue[port] };
            let Some(Reverse(u)) = queue.pop() else { continue };

            self.uops[u as usize].dispatched = clock;
            s.n_uops -= 1;
            // also added to pendingUops (in processPendingUops)
            uops_dispatched.push(u);

            let div_cycles = self.prep.props[self.uops[u as usize].prop as usize].div_cycles;
            if div_cycles != 0 {
                s.blocked_resources[RES_DIV] += div_cycles as f64;
                s.mark_blocked(RES_DIV);
            }
            if cfg.slow_256bit_mem_acc
                && port == port4
                && self.prep.props[self.uops[u as usize].prop as usize].has(pf::M256)
            {
                s.blocked_resources[1 + port] = 2.0;
                s.mark_blocked(1 + port);
            }
        }

        for i in 0..self.sched.uops_dispatched_in_prev_cycle.len() {
            let u = self.sched.uops_dispatched_in_prev_cycle[i];
            let port = self.uops[u as usize].actual_port;
            if port == NO_PORT {
                // unreachable: dispatched uops come from the ready queues, which only hold uops with a port
                return Err(crash("KeyError: None (portUsage)"));
            }
            self.sched.port_usage[port as usize] -= 1;
        }
        self.sched.uops_dispatched_spare = std::mem::replace(&mut self.sched.uops_dispatched_in_prev_cycle, uops_dispatched);
        Ok(())
    }

    /// `Scheduler.processPendingUops`
    fn process_pending_uops(&mut self) -> Result<(), SimError> {
        // program order: the pending uops and the uops dispatched in this cycle, sorted
        let mut pending = std::mem::take(&mut self.sched.pending_uops_spare);
        let mut still_pending = std::mem::take(&mut self.sched.pending_uops);
        {
            let mut new = std::mem::take(&mut self.sched.dispatched_sorted_buf);
            new.clear();
            new.extend_from_slice(&self.sched.uops_dispatched_in_prev_cycle);
            new.sort_unstable();
            pending.clear();
            let (mut i, mut j) = (0, 0);
            while i < still_pending.len() && j < new.len() {
                if still_pending[i] < new[j] {
                    pending.push(still_pending[i]);
                    i += 1;
                } else {
                    pending.push(new[j]);
                    j += 1;
                }
            }
            pending.extend_from_slice(&still_pending[i..]);
            pending.extend_from_slice(&new[j..]);
            self.sched.dispatched_sorted_buf = new;
        }
        still_pending.clear();
        for &u in &pending {
            let prop = &self.prep.props[self.uops[u as usize].prop as usize];
            let (flags, tp) = (prop.flags, prop.tp);
            let (is_store_addr, is_store_data) = (flags & pf::STORE_ADDR != 0, flags & pf::STORE_DATA != 0);
            let dispatched = opt(self.uops[u as usize].dispatched).unwrap();
            let mut finish_time = (dispatched + 2) as f64;
            if flags & pf::FIRST_TP != 0 {
                let t = dispatched as f64 + tp;
                if t > finish_time {
                    finish_time = t;
                }
            }

            let mut not_finished = false;
            for j in self.uops[u as usize].ren_out() {
                let r = self.ren_lists[j as usize];
                match self.get_ready_cycle(r) {
                    None => {
                        not_finished = true;
                        break;
                    }
                    Some(ready_cycle) => {
                        if ready_cycle as f64 > finish_time {
                            finish_time = ready_cycle as f64;
                        }
                    }
                }
            }
            if not_finished {
                still_pending.push(u);
                continue;
            }

            if is_store_addr || is_store_data {
                let sbe = self.uops[u as usize].store_buffer_entry;
                if sbe == NONE {
                    // unreachable: store uops get a store buffer entry in the renamer (instructions with ports have uops != 0
                    // in the tables)
                    return Err(crash("AttributeError: 'NoneType' object has no attribute 'addressReadyCycle'"));
                }
                if is_store_addr {
                    let addr_ready = dispatched + 5;
                    self.rn.sbes[sbe as usize].address_ready_cycle = Some(addr_ready);
                    if addr_ready as f64 > finish_time {
                        finish_time = addr_ready as f64;
                    }
                }
                if is_store_data {
                    let data_ready = dispatched + 1;
                    self.rn.sbes[sbe as usize].data_ready_cycle = Some(data_ready);
                    if data_ready as f64 > finish_time {
                        finish_time = data_ready as f64;
                    }
                }
            }

            // dependentUops.pop(uop): uops that are added to the list of this uop while it is processed are in a new list
            if let Some(list) = self.sched.dep_lists.get_mut(u as usize) {
                let mut node = list.0;
                *list = (NONE, NONE);
                while node != NONE {
                    let (dep_uop, next) = self.sched.dep_nodes[node as usize];
                    self.check_depending_uops_executed(dep_uop);
                    node = next;
                }
            }

            self.uops[u as usize].executed = finish_time;
        }
        self.sched.pending_uops = still_pending;
        self.sched.pending_uops_spare = pending;
        Ok(())
    }

    /// `Scheduler.processPendingFences`
    fn process_pending_fences(&mut self, clock: i64) {
        if let Some(&u) = self.sched.pending_load_fence_uops.front() {
            if self.uops[u as usize].executed_by(clock) {
                self.sched.pending_load_fence_uops.pop_front();
                self.sched.load_uops_since_last_load_fence.clear();
            }
        }
        if let Some(&u) = self.sched.pending_store_fence_uops.front() {
            if self.uops[u as usize].executed_by(clock) {
                self.sched.pending_store_fence_uops.pop_front();
                self.sched.store_uops_since_last_store_fence.clear();
            }
        }
    }

    /// `Scheduler.processNonReadyUops`
    fn process_non_ready_uops(&mut self, clock: i64) -> Result<(), SimError> {
        let non_ready = std::mem::take(&mut self.sched.non_ready_uops);
        let mut remaining = std::mem::take(&mut self.sched.non_ready_uops_spare);
        remaining.clear();
        for &u in &non_ready {
            if !self.check_uop_ready(clock, u)? {
                remaining.push(u);
            }
        }
        // checkUopReady does not add uops to nonReadyUops
        debug_assert!(self.sched.non_ready_uops.is_empty());
        self.sched.non_ready_uops = remaining;
        self.sched.non_ready_uops_spare = non_ready;
        Ok(())
    }

    /// `Scheduler.checkUopReady`: adds ready uops to uopsReadyInCycle
    fn check_uop_ready(&mut self, clock: i64, u: u32) -> Result<bool, SimError> {
        if self.uops[u as usize].ready_for_dispatch != super::UNSET {
            return Ok(true);
        }
        let prop = &self.prep.props[self.uops[u as usize].prop as usize];
        let (flags, tp_res, tp) = (prop.flags, prop.tp_res as usize, prop.tp);
        let (is_first, is_load, is_store) = (flags & pf::FIRST != 0, flags & pf::LOAD != 0, flags & pf::STORE != 0);
        let not_executed = |sim: &Sim, uops: &[u32]| uops.iter().any(|&u2| !sim.uops[u2 as usize].executed_by(clock));

        if flags & pf::LOAD_SERIALIZING != 0 {
            if is_first {
                let Some(&front) = self.sched.pending_load_fence_uops.front() else {
                    // unreachable: addNewUops queues the first uop of a fence before checkUopReady sees it, and it leaves the
                    // queue only after it has executed
                    return Err(crash("IndexError: deque index out of range (pendingLoadFenceUops)"));
                };
                if front != u || not_executed(self, &self.sched.load_uops_since_last_load_fence) {
                    return Ok(false);
                }
            }
        } else if flags & pf::STORE_SERIALIZING != 0 {
            if is_first {
                let Some(&front) = self.sched.pending_store_fence_uops.front() else {
                    // unreachable: addNewUops queues the first uop of a fence before checkUopReady sees it, and it leaves the
                    // queue only after it has executed
                    return Err(crash("IndexError: deque index out of range (pendingStoreFenceUops)"));
                };
                if front != u || not_executed(self, &self.sched.store_uops_since_last_store_fence) {
                    return Ok(false);
                }
            }
        } else {
            if is_load && self.sched.pending_load_fence_uops.front().is_some_and(|&f| f < u) {
                return Ok(false);
            }
            if is_store && self.sched.pending_store_fence_uops.front().is_some_and(|&f| f < u) {
                return Ok(false);
            }
        }

        // the limit may be a fraction of a cycle; for integers, this is the same as checking for '> 0'
        if is_first && self.sched.blocked_resources[tp_res] >= 1.0 {
            return Ok(false);
        }

        let Some(ready_for_dispatch_cycle) = self.get_ready_for_dispatch_cycle(clock, u)? else { return Ok(false) };

        self.uops[u as usize].ready_for_dispatch = ready_for_dispatch_cycle;
        self.sched.uops_ready_in_cycle.push(clock, ready_for_dispatch_cycle, u);

        if flags & pf::FIRST_TP != 0 {
            self.sched.blocked_resources[tp_res] += tp;
            self.sched.mark_blocked(tp_res);
        }
        if is_load {
            self.sched.load_uops_since_last_load_fence.push(u);
        }
        if is_store {
            self.sched.store_uops_since_last_store_fence.push(u);
        }
        Ok(true)
    }

    /// `Scheduler.addNewUops`
    fn add_new_uops(&mut self, clock: i64, new_uops: &[u32]) -> Result<(), SimError> {
        // portUsageAtStartOfCycle[clock] = dict(self.portUsage)
        if clock > 0 {
            std::mem::swap(&mut self.sched.port_usage_prev_cycle, &mut self.sched.port_usage_cur_cycle);
        }
        self.sched.port_usage_cur_cycle.copy_from_slice(&self.sched.port_usage);
        if clock == 0 {
            self.sched.port_usage_prev_cycle.copy_from_slice(&self.sched.port_usage);
        }
        // frozenset(possiblePorts) -> count
        let mut port_combinations_in_cur_cycle = std::mem::take(&mut self.sched.port_combinations_buf);
        port_combinations_in_cur_cycle.clear();

        for (issue_slot, &fused) in new_uops.iter().enumerate() {
            for u in self.fused[fused as usize].unfused_uops() {
                let prop = &self.prep.props[self.uops[u as usize].prop as usize];
                if !prop.has(pf::HAS_PORTS) || self.uops[u as usize].eliminated {
                    continue;
                }
                let port = if prop.n_ports == 1 {
                    prop.port0 as usize
                } else {
                    let (mask, port_list, ports_start, n) = (prop.port_mask, prop.port_list, prop.ports_start as usize, prop.n_ports as usize);
                    self.assign_port(issue_slot, mask, port_list, ports_start, n, &mut port_combinations_in_cur_cycle)?
                };

                self.uops[u as usize].actual_port = port as u8;
                self.sched.port_usage[port] += 1;
                self.sched.n_uops += 1;

                self.check_depending_uops_executed(u);

                let flags = self.prep.props[self.uops[u as usize].prop as usize].flags;
                if flags & pf::FIRST != 0 {
                    if flags & pf::STORE_SERIALIZING != 0 {
                        self.sched.pending_store_fence_uops.push_back(u);
                    }
                    if flags & pf::LOAD_SERIALIZING != 0 {
                        self.sched.pending_load_fence_uops.push_back(u);
                    }
                }
            }
        }
        self.sched.port_combinations_buf = port_combinations_in_cur_cycle;
        Ok(())
    }

    /// the port of a uop with more than one possible port (`mask`; in the order of `possiblePorts`:
    /// `port_lists[ports_start .. ports_start + n]`)
    fn assign_port(
        &mut self,
        issue_slot: usize,
        mask: u32,
        port_list: PortList,
        ports_start: usize,
        n: usize,
        port_combinations_in_cur_cycle: &mut Vec<(u32, usize)>,
    ) -> Result<usize, SimError> {
        let s = &mut self.sched;
        // alternates between two ports (which exist: they are the possible ports of the uop)
        let alternate = |next: &mut u8, a: u8, b: u8| -> usize {
            let p = *next;
            *next = if p == a { b } else { a };
            p as usize
        };
        // the set bits of `mask` in increasing order (the order of `portUsageAtStartOfCycle`)
        let bits = |mut m: u32| {
            std::iter::from_fn(move || {
                if m == 0 {
                    return None;
                }
                let p = m.trailing_zeros() as usize;
                m &= m - 1;
                Some(p)
            })
        };
        match s.assignment {
            PortAssignment::Amd => {
                // least-loaded applicable port; ties are broken in favor of the port that was not used for the longest time
                // (min returns the first of equal keys, in the order of possiblePorts)
                let list = &self.prep.port_lists[ports_start..ports_start + n];
                let mut best = list[0] as usize;
                for &p in &list[1..] {
                    let p = p as usize;
                    if (s.port_usage[p], s.port_last_assigned[p]) < (s.port_usage[best], s.port_last_assigned[best]) {
                        best = p;
                    }
                }
                s.n_ports_assigned += 1;
                s.port_last_assigned[best] = s.n_ports_assigned;
                Ok(best)
            }
            PortAssignment::Icl => {
                let n_pc = match port_combinations_in_cur_cycle.iter_mut().find(|e| e.0 == mask) {
                    Some(e) => {
                        e.1 += 1;
                        e.1 - 1
                    }
                    None => {
                        port_combinations_in_cur_cycle.push((mask, 1));
                        0
                    }
                };
                let names = &s.names;
                match port_list {
                    PortList::P23 => return Ok(alternate(&mut s.next_p23_port, names.p2, names.p3)),
                    PortList::P49 => return Ok(alternate(&mut s.next_p49_port, names.p4, names.p9)),
                    PortList::P78 => return Ok(alternate(&mut s.next_p78_port, names.p7, names.p8)),
                    _ => {}
                }
                // sorted((usage, -int(port, 16))): (usage, rank) are unique keys; insertion sort of the (few) ports
                let mut sorted = [(0i64, 0u8, 0u8); 32];
                let mut len = 0;
                for p in bits(mask) {
                    let k = (s.port_usage_prev_cycle[p], names.rank_neg_hex[p], p as u8);
                    let mut i = len;
                    while i > 0 && (sorted[i - 1].0, sorted[i - 1].1) > (k.0, k.1) {
                        sorted[i] = sorted[i - 1];
                        i -= 1;
                    }
                    sorted[i] = k;
                    len += 1;
                }
                let min_port_usage = sorted[0].0;
                // sortedPorts: the prefix with usage < min + 5
                let n_sorted = sorted[..len].iter().take_while(|x| x.0 < min_port_usage + 5).count();
                let i = if issue_slot == 4 {
                    0
                } else if issue_slot == 3 && n_pc == 0 && n_sorted > 1 {
                    1
                } else {
                    n_pc % n_sorted
                };
                Ok(sorted[i].2 as usize)
            }
            PortAssignment::Eight => {
                let names = &s.names;
                // the applicable ports by (usage, -int(port, 16)); the keys are unique
                let key = |p: usize| (s.port_usage_cur_cycle[p], names.rank_neg_hex[p]);
                let min_excluding = |excluded: usize| -> Option<usize> {
                    let mut m: Option<usize> = None;
                    for p in bits(mask) {
                        if p != excluded && m.map_or(true, |m| key(p) < key(m)) {
                            m = Some(p);
                        }
                    }
                    m
                };
                // port with minimum usage so far
                let min_port = min_excluding(usize::MAX).unwrap();
                if port_list == PortList::P23 {
                    let (p2, p3) = (names.p2, names.p3);
                    Ok(alternate(&mut s.next_p23_port, p2, p3))
                } else if issue_slot % 2 == 0 {
                    Ok(min_port)
                } else {
                    // port with second smallest usage so far
                    let Some(min2_port) = min_excluding(min_port) else {
                        // unreachable: no port combination in the tables repeats a port, so a uop with several ports has at
                        // least two distinct ones
                        return Err(crash("ValueError: min() arg is an empty sequence"));
                    };
                    Ok(if s.port_usage_cur_cycle[min2_port] >= s.port_usage_cur_cycle[min_port] + 3 { min_port } else { min2_port })
                }
            }
            PortAssignment::Other => {
                let names = &s.names;
                // the applicable ports by (usage, int(port, 16)); the keys are unique
                let key = |p: usize| (s.port_usage_cur_cycle[p], names.rank_hex[p]);
                let mut min_port = usize::MAX;
                let mut max_port = usize::MAX;
                for p in bits(mask) {
                    if min_port == usize::MAX || key(p) < key(min_port) {
                        min_port = p;
                    }
                    if max_port == usize::MAX || key(p) > key(max_port) {
                        max_port = p;
                    }
                }
                let (max_usage, min_usage) = (s.port_usage_cur_cycle[max_port], s.port_usage_cur_cycle[min_port]);
                if port_list == PortList::P23 {
                    let (p2, p3) = (names.p2, names.p3);
                    Ok(alternate(&mut s.next_p23_port, p2, p3))
                } else if max_usage - min_usage >= 3 {
                    Ok(min_port)
                } else if port_list == PortList::P015 {
                    let (p0, p1, p5) = (names.p0, names.p1, names.p5);
                    let order: [u8; 4] = if min_port == p0 as usize {
                        [p0, p5, p1, p0]
                    } else if min_port == p1 as usize {
                        [p1, p5, p0, p1]
                    } else {
                        [p5, p1, p0, p5]
                    };
                    // unreachable: only SNB and IVB (issue width 4) use this rule, and only register-merge uops (ports 1, 5)
                    // are issued beyond the issue width
                    let Some(&p) = order.get(issue_slot) else { return Err(crash("IndexError: list index out of range (issueSlot)")) };
                    Ok(p as usize)
                } else if issue_slot % 2 == 0 {
                    Ok(min_port)
                } else {
                    Ok(max_port)
                }
            }
        }
    }

    /// `Scheduler.checkDependingUopsExecuted`: checks if the uop depends on a uop for which the finish time has not been determined
    /// yet; in this case, it is added to dependentUops for this uop; otherwise, it is added to nonReadyUops
    fn check_depending_uops_executed(&mut self, u: u32) {
        for j in self.uops[u as usize].ren_in() {
            let r = self.ren_lists[j as usize];
            if self.get_ready_cycle(r).is_none() {
                let producer = self.ren_ops[r as usize].uop;
                if producer != NONE && self.uops[producer as usize].executed.is_nan() {
                    let s = &mut self.sched;
                    if s.dep_lists.len() <= producer as usize {
                        s.dep_lists.resize(self.uops.len().max(producer as usize + 1), (NONE, NONE));
                    }
                    let node = s.dep_nodes.len() as u32;
                    s.dep_nodes.push((u, NONE));
                    let list = &mut s.dep_lists[producer as usize];
                    if list.0 == NONE {
                        *list = (node, node);
                    } else {
                        let last = list.1;
                        list.1 = node;
                        s.dep_nodes[last as usize].1 = node;
                    }
                    return;
                }
            }
        }
        self.sched.non_ready_uops.push(u);
    }

    /// `Scheduler.getReadyForDispatchCycle`
    fn get_ready_for_dispatch_cycle(&mut self, clock: i64, u: u32) -> Result<Option<i64>, SimError> {
        let mut op_ready_cycle = -1;
        let folded_in = self.uops[u as usize].folded_in;
        // (only shifts and rotates have folded inputs)
        let fold_delay = self.cfg.folded_shift_delay;
        let ren_start = self.uops[u as usize].ren;
        for j in self.uops[u as usize].ren_in() {
            let r = self.ren_lists[j as usize];
            match self.get_ready_cycle(r) {
                None => return Ok(None),
                Some(mut c) => {
                    if folded_in & (1u32.checked_shl(j - ren_start).unwrap_or(0)) != 0 {
                        c += fold_delay;
                    }
                    if c > op_ready_cycle {
                        op_ready_cycle = c;
                    }
                }
            }
        }
        // unreachable: uops reach checkUopReady only after addNewUops, which gets the uops issued in this cycle
        let issued = opt(self.fused[self.uops[u as usize].fused_uop as usize].issued).ok_or_else(|| crash("TypeError: issued is None"))?;
        let d = issued + self.cfg.issue_dispatch_delay;
        let mut ready_cycle = op_ready_cycle;
        if op_ready_cycle < d {
            ready_cycle = d;
        } else if op_ready_cycle == d || op_ready_cycle == d + 1 {
            ready_cycle = op_ready_cycle + 1;
        }
        Ok(Some(ready_cycle.max(clock + 1)))
    }
}
