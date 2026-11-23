//! `Scheduler`: port assignment, dispatch, and the tracking of when uops become ready and finish.

use super::prep::{PortList, NONE};
use super::{crash, Sim, SimError};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

/// index of 'div' in `blockedResources`; 'port' + p is at 1 + (index of p)
const RES_DIV: usize = 0;

pub(crate) struct Scheduler {
    /// `len(self.uops)`
    n_uops: i64,
    port_usage: Vec<i64>,
    /// `portUsageAtStartOfCycle` of the previous and of the current cycle
    port_usage_prev_cycle: Vec<i64>,
    port_usage_cur_cycle: Vec<i64>,
    next_p23_port: u8,
    next_p49_port: u8,
    next_p78_port: u8,
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
    ready_bucket_spare: Vec<u32>,
    port_combinations_buf: Vec<(u32, usize)>,
    dispatched_sorted_buf: Vec<u32>,
    sorted_port_usages_buf: Vec<(i64, i64, usize)>,
    sorted_ports_buf: Vec<usize>,
    /// dispatched, but not finished uops (sorted)
    pending_uops: Vec<u32>,
    pending_store_fence_uops: VecDeque<u32>,
    store_uops_since_last_store_fence: Vec<u32>,
    pending_load_fence_uops: VecDeque<u32>,
    load_uops_since_last_load_fence: Vec<u32>,
    /// for how many remaining cycles a resource will be blocked
    blocked_resources: Vec<f64>,
    /// uops that have an operand that is written by a non-executed uop: producer uop -> uops (in insertion order), as linked
    /// lists in `dep_nodes`: (first node, last node) for each producer
    dep_lists: Vec<(u32, u32)>,
    /// (uop, next node)
    dep_nodes: Vec<(u32, u32)>,
}

/// `uopsReadyInCycle`: cycle -> uops, for the cycles after the current one. A ring of buckets indexed by `cycle & mask`; it
/// grows when a uop becomes ready further in the future than it covers. Every bucket holds the uops of exactly one cycle in
/// `clock + 1 ..= clock + len`, because the scheduler takes the bucket of each cycle in that cycle.
struct CycleBuckets {
    slots: Vec<Vec<u32>>,
}

impl CycleBuckets {
    fn new() -> CycleBuckets {
        CycleBuckets { slots: (0..64).map(|_| Vec::new()).collect() }
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
            let old = std::mem::take(&mut self.slots);
            let old_mask = old.len() as i64 - 1;
            self.slots = (0..len).map(|_| Vec::new()).collect();
            for (i, v) in old.into_iter().enumerate() {
                if v.is_empty() {
                    continue;
                }
                // the cycle of this bucket: the one in clock+1 ..= clock+old_len with (c & old_mask) == i
                let c = clock + 1 + (i as i64 - (clock + 1)).rem_euclid(old_mask + 1);
                self.slots[(c & (len - 1)) as usize] = v;
            }
        }
        let mask = self.slots.len() as i64 - 1;
        self.slots[(cycle & mask) as usize].push(u);
    }

    /// takes the bucket of `cycle` (leaves an empty bucket with the capacity of `spare`)
    fn take(&mut self, cycle: i64, spare: Vec<u32>) -> Vec<u32> {
        let mask = self.slots.len() as i64 - 1;
        std::mem::replace(&mut self.slots[(cycle & mask) as usize], spare)
    }
}

impl Scheduler {
    pub fn new(n_ports: usize, n_resources: usize) -> Scheduler {
        Scheduler {
            n_uops: 0,
            port_usage: vec![0; n_ports],
            port_usage_prev_cycle: vec![0; n_ports],
            port_usage_cur_cycle: vec![0; n_ports],
            next_p23_port: b'2',
            next_p49_port: b'4',
            next_p78_port: b'7',
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
            ready_bucket_spare: Vec::new(),
            port_combinations_buf: Vec::new(),
            dispatched_sorted_buf: Vec::new(),
            sorted_port_usages_buf: Vec::new(),
            sorted_ports_buf: Vec::new(),
            pending_uops: Vec::new(),
            pending_store_fence_uops: VecDeque::new(),
            store_uops_since_last_store_fence: Vec::new(),
            pending_load_fence_uops: VecDeque::new(),
            load_uops_since_last_load_fence: Vec::new(),
            blocked_resources: vec![0.0; n_resources],
            dep_lists: Vec::new(),
            dep_nodes: Vec::new(),
        }
    }
}

impl Scheduler {
    /// reserves space for about `n_uops` uops
    pub fn reserve(&mut self, n_uops: usize) {
        self.dep_lists.reserve(n_uops);
        self.dep_nodes.reserve(n_uops);
    }
}

impl<'a> Sim<'a> {
    fn port(&self, c: u8) -> Option<usize> {
        let i = self.prep.port_idx[c as usize];
        (i != u8::MAX).then_some(i as usize)
    }

    /// `Scheduler.isFull`
    pub(crate) fn scheduler_is_full(&self) -> bool {
        self.sched.n_uops + self.cfg.issue_width > self.cfg.rs_width
    }

    /// `Scheduler.cycle`
    pub(crate) fn scheduler_cycle(&mut self, clock: i64, new_uops: &[u32]) -> Result<(), SimError> {
        {
            let spare = std::mem::take(&mut self.sched.ready_bucket_spare);
            let mut ready = self.sched.uops_ready_in_cycle.take(clock, spare);
            for &u in &ready {
                let uop = &self.uops[u as usize];
                if uop.div_cycles != 0 {
                    self.sched.ready_div_uops.push(Reverse(u));
                } else {
                    let port = uop.actual_port.ok_or_else(|| crash("KeyError: None (readyQueue)"))?;
                    self.sched.ready_queue[port as usize].push(Reverse(u));
                }
            }
            ready.clear();
            self.sched.ready_bucket_spare = ready;
        }
        self.add_new_uops(clock, new_uops)?;
        self.dispatch_uops(clock)?;
        self.process_pending_uops()?;
        self.process_non_ready_uops(clock)?;
        self.process_pending_fences(clock);
        // updateBlockedResources
        for r in self.sched.blocked_resources.iter_mut() {
            let v = *r - 1.0;
            *r = if v > 0.0 { v } else { 0.0 };
        }
        Ok(())
    }

    /// `Scheduler.dispatchUops`
    fn dispatch_uops(&mut self, clock: i64) -> Result<(), SimError> {
        let cfg = self.cfg;
        let mut applicable = [true; 32];

        if let (Some(p4), Some(p9)) = (self.port(b'4'), self.port(b'9')) {
            if let (Some(&Reverse(uop4)), Some(&Reverse(uop9))) = (self.sched.ready_queue[p4].peek(), self.sched.ready_queue[p9].peek()) {
                // two stores can be executed in the same cycle if they access the same cache line
                let sbe4 = self.uops[uop4 as usize].store_buffer_entry;
                let sbe9 = self.uops[uop9 as usize].store_buffer_entry;
                if sbe4 == NONE || sbe9 == NONE {
                    return Err(crash("AttributeError: 'NoneType' object has no attribute 'abstractAddress'"));
                }
                if let (Some(addr4), Some(addr9)) = (self.rn.sbes[sbe4 as usize].abstract_address, self.rn.sbes[sbe9 as usize].abstract_address) {
                    let different = if addr4.0 != addr9.0 || addr4.1 != addr9.1 || addr4.2 != addr9.2 {
                        true
                    } else {
                        match (addr4.3, addr9.3) {
                            (Some(d4), Some(d9)) => (d4 - d9).abs() >= 64,
                            _ => return Err(crash("TypeError: unsupported operand type(s) for -: 'NoneType'")),
                        }
                    };
                    if different {
                        if uop4 <= uop9 {
                            applicable[p9] = false;
                        } else {
                            applicable[p4] = false;
                        }
                    }
                }
            }
        }

        if cfg.slow_256bit_mem_acc {
            let (Some(p2), Some(p3)) = (self.port(b'2'), self.port(b'3')) else { return Err(crash("KeyError: '2'")) };
            if let (Some(&Reverse(uop2)), Some(&Reverse(uop3))) = (self.sched.ready_queue[p2].peek(), self.sched.ready_queue[p3].peek()) {
                let is_load = |u: u32| self.prep.props[self.uops[u as usize].prop as usize].is_load;
                let m256 = |u: u32| self.prep.info[self.insts[self.uops[u as usize].instr_instance as usize].instr as usize].has_m256;
                if is_load(uop2) && is_load(uop3) && (m256(uop2) || m256(uop3)) {
                    applicable[if uop2 < uop3 { p3 } else { p2 }] = false;
                }
            }
        }

        let divider_port = if cfg.divider_port.len() == 1 { self.port(cfg.divider_port.as_bytes()[0]) } else { None };
        let port4 = self.port(b'4');
        let mut uops_dispatched = std::mem::take(&mut self.sched.uops_dispatched_spare);
        uops_dispatched.clear();
        for port in 0..self.n_ports {
            if !applicable[port] {
                continue;
            }
            let s = &mut self.sched;
            let mut use_div_queue = false;
            if Some(port) == divider_port && s.blocked_resources[RES_DIV] == 0.0 {
                if let Some(&Reverse(div)) = s.ready_div_uops.peek() {
                    if s.ready_queue[port].peek().map_or(true, |&Reverse(u)| div < u) {
                        use_div_queue = true;
                    }
                }
            }
            if s.blocked_resources[1 + port] != 0.0 {
                continue;
            }
            let queue = if use_div_queue { &mut s.ready_div_uops } else { &mut s.ready_queue[port] };
            let Some(Reverse(u)) = queue.pop() else { continue };

            self.uops[u as usize].dispatched = Some(clock);
            s.n_uops -= 1;
            // also added to pendingUops (in processPendingUops)
            uops_dispatched.push(u);

            s.blocked_resources[RES_DIV] += self.uops[u as usize].div_cycles as f64;
            if cfg.slow_256bit_mem_acc
                && Some(port) == port4
                && self.prep.info[self.insts[self.uops[u as usize].instr_instance as usize].instr as usize].has_m256
            {
                s.blocked_resources[1 + port] = 2.0;
            }
        }

        for i in 0..self.sched.uops_dispatched_in_prev_cycle.len() {
            let u = self.sched.uops_dispatched_in_prev_cycle[i];
            let port = self.uops[u as usize].actual_port.ok_or_else(|| crash("KeyError: None (portUsage)"))?;
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
            let (is_first, is_store_addr, is_store_data, ii) = (prop.is_first, prop.is_store_addr, prop.is_store_data, prop.instr as usize);
            let dispatched = self.uops[u as usize].dispatched.unwrap();
            let mut finish_time = (dispatched + 2) as f64;
            if is_first {
                if let Some(tp) = self.instrs[ii].tp {
                    let t = dispatched as f64 + tp;
                    if t > finish_time {
                        finish_time = t;
                    }
                }
            }

            let mut not_finished = false;
            let (start, n) = self.uops[u as usize].ren_out;
            for j in start..start + n {
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

            self.uops[u as usize].executed = Some(finish_time);
        }
        self.sched.pending_uops = still_pending;
        self.sched.pending_uops_spare = pending;
        Ok(())
    }

    /// `Scheduler.processPendingFences`
    fn process_pending_fences(&mut self, clock: i64) {
        if let Some(&u) = self.sched.pending_load_fence_uops.front() {
            if self.uops[u as usize].executed.is_some_and(|e| e <= clock as f64) {
                self.sched.pending_load_fence_uops.pop_front();
                self.sched.load_uops_since_last_load_fence.clear();
            }
        }
        if let Some(&u) = self.sched.pending_store_fence_uops.front() {
            if self.uops[u as usize].executed.is_some_and(|e| e <= clock as f64) {
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
        if self.uops[u as usize].ready_for_dispatch.is_some() {
            return Ok(true);
        }
        let prop = &self.prep.props[self.uops[u as usize].prop as usize];
        let (is_first, is_load, is_store, ii) = (prop.is_first, prop.is_load, prop.is_store_data || prop.is_store_addr, prop.instr as usize);
        let instr = &self.instrs[ii];
        let not_executed = |sim: &Sim, uops: &[u32]| uops.iter().any(|&u2| !sim.uops[u2 as usize].executed.is_some_and(|e| e <= clock as f64));

        if instr.is_load_serializing {
            if is_first {
                let Some(&front) = self.sched.pending_load_fence_uops.front() else {
                    return Err(crash("IndexError: deque index out of range (pendingLoadFenceUops)"));
                };
                if front != u || not_executed(self, &self.sched.load_uops_since_last_load_fence) {
                    return Ok(false);
                }
            }
        } else if instr.is_store_serializing {
            if is_first {
                let Some(&front) = self.sched.pending_store_fence_uops.front() else {
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
        let tp_res = self.prep.info[ii].tp_res;
        if is_first && self.sched.blocked_resources[tp_res] >= 1.0 {
            return Ok(false);
        }

        let Some(ready_for_dispatch_cycle) = self.get_ready_for_dispatch_cycle(clock, u)? else { return Ok(false) };

        self.uops[u as usize].ready_for_dispatch = Some(ready_for_dispatch_cycle);
        self.sched.uops_ready_in_cycle.push(clock, ready_for_dispatch_cycle, u);

        if is_first {
            if let Some(tp) = instr.tp {
                self.sched.blocked_resources[tp_res] += tp;
            }
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
        let cfg = self.cfg;
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
        let mut sorted_port_usages = std::mem::take(&mut self.sched.sorted_port_usages_buf);
        let mut sorted_ports = std::mem::take(&mut self.sched.sorted_ports_buf);
        let n_ports = self.n_ports;
        let icl_assignment = cfg.port_assignment.as_deref() == Some("ICL") || (cfg.port_assignment.is_none() && n_ports == 10);

        for (issue_slot, &fused) in new_uops.iter().enumerate() {
            for u in self.fused[fused as usize].unfused_uops() {
                let prop = &self.prep.props[self.uops[u as usize].prop as usize];
                if prop.ports.1 == 0 || self.uops[u as usize].eliminated {
                    continue;
                }
                let s = &mut self.sched;
                let hex = &self.prep.port_hex;
                let alternate = |next: &mut u8, a: u8, b: u8| -> u8 {
                    let p = *next;
                    *next = if p == a { b } else { a };
                    p
                };
                let port: usize;
                if prop.ports.1 == 1 {
                    port = prop.port0 as usize;
                } else if cfg.is_amd {
                    // least-loaded applicable port; ties are broken in favor of the port that was not used for the longest time
                    let mut best = prop.port0 as usize;
                    let (start, n) = prop.ports;
                    for &p in &self.prep.port_lists[start as usize + 1..(start + n) as usize] {
                        let p = p as usize;
                        if (s.port_usage[p], s.port_last_assigned[p]) < (s.port_usage[best], s.port_last_assigned[best]) {
                            best = p;
                        }
                    }
                    port = best;
                    s.n_ports_assigned += 1;
                    s.port_last_assigned[port] = s.n_ports_assigned;
                } else if icl_assignment {
                    // (usage, -int(port, 16), port)
                    sorted_port_usages.clear();
                    for p in 0..n_ports {
                        if prop.port_mask & (1 << p) != 0 {
                            sorted_port_usages.push((s.port_usage_prev_cycle[p], -hex[p], p));
                        }
                    }
                    sorted_port_usages.sort();
                    let min_port_usage = sorted_port_usages[0].0;
                    sorted_ports.clear();
                    for x in sorted_port_usages.iter() {
                        if x.0 < min_port_usage + 5 {
                            sorted_ports.push(x.2);
                        }
                    }

                    let n_pc = match port_combinations_in_cur_cycle.iter_mut().find(|e| e.0 == prop.port_mask) {
                        Some(e) => {
                            e.1 += 1;
                            e.1 - 1
                        }
                        None => {
                            port_combinations_in_cur_cycle.push((prop.port_mask, 1));
                            0
                        }
                    };

                    let by_char = |c: u8| -> Result<usize, SimError> {
                        let i = self.prep.port_idx[c as usize];
                        if i == u8::MAX {
                            Err(crash("KeyError: port"))
                        } else {
                            Ok(i as usize)
                        }
                    };
                    port = match prop.port_list {
                        PortList::P23 => by_char(alternate(&mut s.next_p23_port, b'2', b'3'))?,
                        PortList::P49 => by_char(alternate(&mut s.next_p49_port, b'4', b'9'))?,
                        PortList::P78 => by_char(alternate(&mut s.next_p78_port, b'7', b'8'))?,
                        _ => {
                            if issue_slot == 4 {
                                sorted_ports[0]
                            } else if issue_slot == 3 && n_pc == 0 && sorted_ports.len() > 1 {
                                sorted_ports[1]
                            } else {
                                sorted_ports[n_pc % sorted_ports.len()]
                            }
                        }
                    };
                } else if n_ports == 8 {
                    // the applicable ports as (usage, -int(port, 16), port); the keys are unique
                    let key = |p: usize| (s.port_usage_cur_cycle[p], -hex[p], p);
                    let min_excluding = |excluded: usize| -> Option<(i64, i64, usize)> {
                        let mut m: Option<(i64, i64, usize)> = None;
                        for p in 0..n_ports {
                            if prop.port_mask & (1 << p) != 0 && p != excluded {
                                let k = key(p);
                                if m.map_or(true, |m| k < m) {
                                    m = Some(k);
                                }
                            }
                        }
                        m
                    };
                    // port with minimum usage so far
                    let (min_port_usage, _, min_port) = min_excluding(usize::MAX).unwrap();
                    if prop.port_list == PortList::P23 {
                        let c = alternate(&mut s.next_p23_port, b'2', b'3');
                        port = self.prep.port_idx[c as usize] as usize;
                    } else if issue_slot % 2 == 0 {
                        port = min_port;
                    } else {
                        // port with second smallest usage so far
                        let Some((min2_port_usage, _, min2_port)) = min_excluding(min_port) else {
                            return Err(crash("ValueError: min() arg is an empty sequence"));
                        };
                        port = if min2_port_usage >= min_port_usage + 3 { min_port } else { min2_port };
                    }
                } else {
                    // the applicable ports as (usage, int(port, 16), port); the keys are unique
                    let mut min_key = (i64::MAX, i64::MAX, usize::MAX);
                    let mut max_key = (i64::MIN, i64::MIN, 0usize);
                    for p in 0..n_ports {
                        if prop.port_mask & (1 << p) != 0 {
                            let k = (s.port_usage_cur_cycle[p], hex[p], p);
                            if k < min_key {
                                min_key = k;
                            }
                            if k > max_key {
                                max_key = k;
                            }
                        }
                    }
                    let min_port = min_key.2;
                    let (max_usage, min_usage) = (max_key.0, min_key.0);
                    if prop.port_list == PortList::P23 {
                        let c = alternate(&mut s.next_p23_port, b'2', b'3');
                        port = self.prep.port_idx[c as usize] as usize;
                    } else if max_usage - min_usage >= 3 {
                        port = min_port;
                    } else if prop.port_list == PortList::P015 {
                        let order: [u8; 4] = match self.prep.ports[min_port] {
                            b'0' => *b"0510",
                            b'1' => *b"1501",
                            _ => *b"5105",
                        };
                        let Some(&c) = order.get(issue_slot) else { return Err(crash("IndexError: list index out of range (issueSlot)")) };
                        port = self.prep.port_idx[c as usize] as usize;
                    } else if issue_slot % 2 == 0 {
                        port = min_port;
                    } else {
                        port = max_key.2;
                    }
                }

                self.uops[u as usize].actual_port = Some(port as u8);
                self.sched.port_usage[port] += 1;
                self.sched.n_uops += 1;

                self.check_depending_uops_executed(u);

                let prop = &self.prep.props[self.uops[u as usize].prop as usize];
                if prop.is_first {
                    let instr = &self.instrs[prop.instr as usize];
                    if instr.is_store_serializing {
                        self.sched.pending_store_fence_uops.push_back(u);
                    }
                    if instr.is_load_serializing {
                        self.sched.pending_load_fence_uops.push_back(u);
                    }
                }
            }
        }
        self.sched.port_combinations_buf = port_combinations_in_cur_cycle;
        self.sched.sorted_port_usages_buf = sorted_port_usages;
        self.sched.sorted_ports_buf = sorted_ports;
        Ok(())
    }

    /// `Scheduler.checkDependingUopsExecuted`: checks if the uop depends on a uop for which the finish time has not been determined
    /// yet; in this case, it is added to dependentUops for this uop; otherwise, it is added to nonReadyUops
    fn check_depending_uops_executed(&mut self, u: u32) {
        let (start, n) = self.uops[u as usize].ren_in;
        for j in start..start + n {
            let r = self.ren_lists[j as usize];
            if self.get_ready_cycle(r).is_none() {
                let producer = self.ren_ops[r as usize].uop;
                if producer != NONE && self.uops[producer as usize].executed.is_none() {
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
        let (start, n) = self.uops[u as usize].ren_in;
        for j in start..start + n {
            let r = self.ren_lists[j as usize];
            match self.get_ready_cycle(r) {
                None => return Ok(None),
                Some(c) => {
                    if c > op_ready_cycle {
                        op_ready_cycle = c;
                    }
                }
            }
        }
        let issued = self.fused[self.uops[u as usize].fused_uop as usize].issued.ok_or_else(|| crash("TypeError: issued is None"))?;
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
