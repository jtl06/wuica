//! The front end: `FrontEnd`, `DSB`, `MicrocodeSequencer`, `Decoder`, `PreDecoder`, `ReorderBuffer`, the cache-block generators
//! and the DSB helpers.

use super::prep::NONE;
use super::{crash, Sim, SimError, UopSource};
use std::collections::{HashSet, VecDeque};

/// `DSBEntry`
pub(crate) struct DsbEntry {
    slot: usize,
    inst: u32,
    /// laminated uop or NONE
    uop: u32,
    ms_uops: Vec<u32>,
    requires_extra_entry: bool,
}

/// the state of `CacheBlockGenerator`
struct CacheBlockGenerator {
    unroll: bool,
    rnd: i64,
    pos: usize,
    cache_block: Vec<u32>,
    next_addr: i64,
}

pub(crate) struct FrontEnd {
    pub unroll: bool,
    pub alignment_offset: i64,
    instruction_queue: VecDeque<u32>,
    op_cache_round: VecDeque<u32>,
    op_cache_rnd: i64,
    rsp_offset: i64,
    pub all_generated_instr_instances: Vec<u32>,
    addresses_in_dsb: HashSet<i64>,
    pub lsd_unroll_count: i64,
    /// None, MITE, DSB or LSD
    pub uop_source: Option<UopSource>,
    cbg: CacheBlockGenerator,
    // CacheBlocksForNextRoundGenerator
    nrg_cache_blocks: Vec<Vec<u32>>,
    nrg_prev_rnd: i64,
    // MicrocodeSequencer
    ms_uop_queue: VecDeque<u32>,
    ms_stalled: i64,
    ms_post_stall: i64,
    // DSB
    dsb_block_queue: VecDeque<VecDeque<DsbEntry>>,
    dsb_delay_in_prev_cycle: bool,
    // PreDecoder
    b16_block_queue: VecDeque<VecDeque<u32>>,
    cur_block: VecDeque<u32>,
    non_stalled_predec_cycles_for_cur_block: i64,
    pre_dec_queue: Vec<u32>,
    predec_stalled: i64,
    partial_instr_i: u32,
}

impl FrontEnd {
    pub fn new(unroll: bool, alignment_offset: i64) -> FrontEnd {
        FrontEnd {
            unroll,
            alignment_offset,
            instruction_queue: VecDeque::new(),
            op_cache_round: VecDeque::new(),
            op_cache_rnd: 0,
            rsp_offset: 0,
            all_generated_instr_instances: Vec::new(),
            addresses_in_dsb: HashSet::new(),
            lsd_unroll_count: 1,
            uop_source: None,
            cbg: CacheBlockGenerator { unroll: true, rnd: 0, pos: 0, cache_block: Vec::new(), next_addr: alignment_offset },
            nrg_cache_blocks: Vec::new(),
            nrg_prev_rnd: 0,
            ms_uop_queue: VecDeque::new(),
            ms_stalled: 0,
            ms_post_stall: 0,
            dsb_block_queue: VecDeque::new(),
            dsb_delay_in_prev_cycle: false,
            b16_block_queue: VecDeque::new(),
            cur_block: VecDeque::new(),
            non_stalled_predec_cycles_for_cur_block: 0,
            pre_dec_queue: Vec::new(),
            predec_stalled: 0,
            partial_instr_i: NONE,
        }
    }
}

impl<'a> Sim<'a> {
    // ---- helpers ----

    fn inst_instr(&self, inst: u32) -> usize {
        self.insts[inst as usize].instr as usize
    }

    fn inst_addr(&self, inst: u32) -> i64 {
        self.insts[inst as usize].address
    }

    fn inst_len(&self, inst: u32) -> i64 {
        self.prep.info[self.inst_instr(inst)].len
    }

    /// `[[ii for ii in block if b*size <= ii.address % modulus < (b+1)*size] for b in range(0, n)]`
    fn split(&self, block: &[u32], modulus: i64, size: i64, n: i64) -> Vec<Vec<u32>> {
        (0..n)
            .map(|b| {
                block
                    .iter()
                    .copied()
                    .filter(|&ii| {
                        let a = self.inst_addr(ii).rem_euclid(modulus);
                        b * size <= a && a < (b + 1) * size
                    })
                    .collect()
            })
            .collect()
    }

    fn split_64_to_16(&self, block: &[u32]) -> Vec<Vec<u32>> {
        self.split(block, 64, 16, 4)
    }

    fn split_32_to_16(&self, block: &[u32]) -> Vec<Vec<u32>> {
        self.split(block, 32, 16, 2)
    }

    fn split_64_to_32(&self, block: &[u32]) -> Vec<Vec<u32>> {
        self.split(block, 64, 32, 2)
    }

    /// `instrInstanceCrossesPredecBlockBoundary`
    fn crosses_predec_block_boundary(&self, inst: u32, block_size: i64) -> bool {
        self.inst_addr(inst).rem_euclid(block_size) + self.inst_len(inst) > block_size
    }

    // ---- generators ----

    /// `next(CacheBlockGenerator(instructions, unroll, alignmentOffset))`
    fn next_cache_block(&mut self) -> Vec<u32> {
        let n = self.instrs.len();
        loop {
            let instr = self.fe.cbg.pos;
            let (addr, rnd) = (self.fe.cbg.next_addr, self.fe.cbg.rnd);
            let inst = self.new_instr_instance(instr, addr, rnd);
            let g = &mut self.fe.cbg;
            g.cache_block.push(inst);
            g.pos += 1;
            if g.pos == n {
                g.pos = 0;
                g.rnd += 1;
            }
            if !g.unroll && instr == n - 1 {
                g.next_addr = self.fe.alignment_offset;
                return std::mem::take(&mut g.cache_block);
            }
            let prev_addr = g.next_addr;
            g.next_addr = prev_addr + self.prep.info[instr].len;
            if prev_addr.div_euclid(64) != g.next_addr.div_euclid(64) {
                return std::mem::take(&mut g.cache_block);
            }
        }
    }

    /// `next(CacheBlocksForNextRoundGenerator(instructions, alignmentOffset))`: the cache blocks of one round. The generator
    /// creates the first cache block of the following round before it returns.
    fn next_round_cache_blocks(&mut self) -> Vec<Vec<u32>> {
        loop {
            let cache_block = self.next_cache_block();
            let cur_rnd = self.insts[*cache_block.last().unwrap() as usize].rnd;
            if self.fe.nrg_prev_rnd != cur_rnd {
                let result = std::mem::take(&mut self.fe.nrg_cache_blocks);
                self.fe.nrg_prev_rnd = cur_rnd;
                self.fe.nrg_cache_blocks.push(cache_block);
                return result;
            }
            self.fe.nrg_cache_blocks.push(cache_block);
        }
    }

    // ---- DSB helpers ----

    /// `getDSBBlocks`
    fn get_dsb_blocks(&self, cache_block: &[u32]) -> Vec<VecDeque<DsbEntry>> {
        let mut remaining_entries_in_cur_block: i64 = 0;
        let mut dsb_blocks: Vec<VecDeque<DsbEntry>> = Vec::new();
        for &inst in cache_block {
            let ii = self.inst_instr(inst);
            let instr = &self.instrs[ii];
            let info = &self.prep.info[ii];
            if instr.macro_fused_with_prev_instr {
                continue;
            }
            let n_required_entries = info.dsb_required_entries;
            let requires_extra_entry = info.dsb_requires_extra_entry;
            if instr.uops_ms != 0 || n_required_entries + requires_extra_entry as i64 > remaining_entries_in_cur_block {
                remaining_entries_in_cur_block = 6;
                dsb_blocks.push(VecDeque::new());
            }
            let cur_block = dsb_blocks.last_mut().unwrap();
            let uops: Vec<u32> = self.insts[inst as usize].uops().collect();
            let n_mite = (instr.uops_mite.max(0) as usize).min(uops.len());
            if instr.uops_mite != 0 {
                for (i, &lam) in uops[..n_mite].iter().enumerate() {
                    let slot = cur_block.len();
                    if i as i64 == instr.uops_mite - 1 {
                        cur_block.push_back(DsbEntry { slot, inst, uop: lam, ms_uops: uops[n_mite..].to_vec(), requires_extra_entry });
                    } else {
                        cur_block.push_back(DsbEntry { slot, inst, uop: lam, ms_uops: Vec::new(), requires_extra_entry: false });
                    }
                    remaining_entries_in_cur_block -= 1;
                }
            } else if instr.uops_ms != 0 {
                let slot = cur_block.len();
                cur_block.push_back(DsbEntry { slot, inst, uop: NONE, ms_uops: uops, requires_extra_entry: false });
            } else {
                let slot = cur_block.len();
                cur_block.push_back(DsbEntry { slot, inst, uop: NONE, ms_uops: Vec::new(), requires_extra_entry: false });
                remaining_entries_in_cur_block -= 1;
            }
            if requires_extra_entry {
                remaining_entries_in_cur_block -= 1;
            }
            if instr.uops_ms != 0 {
                remaining_entries_in_cur_block = 0;
            }
        }
        dsb_blocks
    }

    /// `canBeInDSB`
    fn can_be_in_dsb(&self, block: &[u32], dsb_block_size: i64) -> bool {
        if dsb_block_size == 32 && self.get_dsb_blocks(block).len() > 3 {
            return false;
        }
        if dsb_block_size == 64 && self.get_dsb_blocks(block).len() > 6 {
            return false;
        }
        if self.instrs[self.inst_instr(*block.last().unwrap())].cannot_be_in_dsb_due_to_jcc_erratum {
            return false;
        }
        let b32_blocks = if dsb_block_size == 32 { vec![block.to_vec()] } else { self.split_64_to_32(block) };
        for b32_block in b32_blocks {
            let mut b16 = self.split_32_to_16(&b32_block);
            let mut b16_2 = b16.pop().unwrap();
            let mut b16_1 = b16.pop().unwrap();
            if !b16_1.is_empty() && !b16_2.is_empty() {
                let last = *b16_1.last().unwrap();
                if self.inst_addr(last).rem_euclid(16) + self.instrs[self.inst_instr(last)].pos_nominal_opcode >= 16 {
                    b16_2.insert(0, b16_1.pop().unwrap());
                }
            }
            let lcp_and_fusible = |inst: u32| {
                let ii = self.inst_instr(inst);
                self.instrs[ii].lcp_stall && self.prep.info[ii].has_macro_fusible
            };
            if !b16_1.is_empty() && lcp_and_fusible(*b16_1.last().unwrap()) && b16_2.iter().filter(|&&i| lcp_and_fusible(i)).count() >= 2 {
                // if there are too many instructions with an lcpStall, the block cannot be cached
                return false;
            }
        }
        true
    }

    // ---- FrontEnd ----

    /// `FrontEnd.__init__`
    pub(crate) fn front_end_init(&mut self, simple_front_end: bool) -> Result<(), SimError> {
        self.fe.uop_source = if simple_front_end { None } else { Some(UopSource::Mite) };
        if self.fe.unroll || simple_front_end {
            self.fe.cbg.unroll = true;
            return Ok(());
        }
        self.fe.cbg.unroll = false;
        let cache_blocks_for_first_round = self.next_round_cache_blocks();
        let bs = self.cfg.dsb_block_size;

        let all_blocks_can_be_cached = if bs == 32 {
            cache_blocks_for_first_round
                .iter()
                .all(|cb| self.split_64_to_32(cb).iter().filter(|b| !b.is_empty()).all(|b| self.can_be_in_dsb(b, bs)))
        } else {
            cache_blocks_for_first_round.iter().all(|b| self.can_be_in_dsb(b, bs))
        };
        let all_instrs_can_be_used_by_lsd =
            cache_blocks_for_first_round.iter().flatten().all(|&ii| self.prep.info[self.inst_instr(ii)].can_be_used_by_lsd);
        let n_uops: i64 = cache_blocks_for_first_round.iter().flatten().map(|&ii| self.insts[ii as usize].n_uops as i64).sum();
        if all_blocks_can_be_cached && self.cfg.lsd_enabled && all_instrs_can_be_used_by_lsd && n_uops <= self.cfg.idq_width {
            self.fe.uop_source = Some(UopSource::Lsd);
            self.fe.lsd_unroll_count = self.cfg.lsd_unrolling.get(&n_uops.to_string()).map_or(1, |&n| n as i64);
            let mut blocks = cache_blocks_for_first_round;
            for _ in 0..self.fe.lsd_unroll_count - 1 {
                blocks.extend(self.next_round_cache_blocks());
            }
            for cache_block in blocks {
                self.add_new_cache_block(cache_block);
            }
        } else {
            self.find_cacheable_addresses(&cache_blocks_for_first_round);
            for cache_block in cache_blocks_for_first_round {
                self.add_new_cache_block(cache_block);
            }
            if self.fe.addresses_in_dsb.contains(&self.fe.alignment_offset) {
                self.fe.uop_source = Some(UopSource::Dsb);
            }
        }
        Ok(())
    }

    /// `FrontEnd.cycle`
    pub(crate) fn front_end_cycle(&mut self, clock: i64) -> Result<(), SimError> {
        let mut issue_uops = Vec::new();
        if !self.rob_is_full() && !self.scheduler_is_full() {
            issue_uops = self.renamer_cycle()?;
        }
        for &fused in &issue_uops {
            self.fused[fused as usize].issued = Some(clock);
        }
        self.rob_cycle(clock, &issue_uops);
        self.scheduler_cycle(clock, &issue_uops)?;

        let cfg = self.cfg;
        if self.idq.len() as i64 + cfg.dsb_width > cfg.idq_width {
            return Ok(());
        }

        if self.fe.uop_source.is_none() && cfg.op_cache_entry_ops != 0 {
            // one op cache entry per cycle; an instruction's macro-ops are not split between entries
            if self.idq.len() as i64 + cfg.op_cache_entry_ops <= cfg.idq_width {
                let mut n_ops = 0;
                let mut n_fields = 0;
                let mut entry_window: Option<i64> = None;
                loop {
                    if self.fe.op_cache_round.is_empty() {
                        self.fe.op_cache_round = self.new_round().into();
                    }
                    let inst = self.fe.op_cache_round[0];
                    let ii = self.inst_instr(inst);
                    let slots = self.insts[inst as usize].n_uops as i64 + self.prep.info[ii].has_i64 as i64;
                    let window = (self.inst_addr(inst) + self.inst_len(inst) - 1).div_euclid(64);
                    let fields = self.instrs[ii].op_cache_fields;
                    if let Some(w) = entry_window {
                        if n_ops + slots > cfg.op_cache_entry_ops
                            || window != w
                            || (cfg.op_cache_entry_fields != 0 && n_fields + fields > self.op_cache_field_capacity(n_ops + slots))
                        {
                            break;
                        }
                    } else {
                        entry_window = Some(window);
                    }
                    self.fe.op_cache_round.pop_front();
                    self.fe.all_generated_instr_instances.push(inst);
                    for lam in self.insts[inst as usize].uops() {
                        let first = self.lams[lam as usize].first_uop;
                        self.add_stack_sync_uop(clock, first);
                        self.idq.push_back(lam);
                        self.lams[lam as usize].added_to_idq = Some(clock);
                    }
                    n_ops += slots;
                    n_fields += fields;
                    if self.fe.op_cache_round.is_empty() {
                        break; // the entry ends at the end of the loop
                    }
                }
            }
        } else if self.fe.uop_source.is_none() {
            while (self.idq.len() as i64) < cfg.issue_width {
                for inst in self.next_cache_block() {
                    self.fe.all_generated_instr_instances.push(inst);
                    for lam in self.insts[inst as usize].uops() {
                        let first = self.lams[lam as usize].first_uop;
                        self.add_stack_sync_uop(clock, first);
                        if cfg.is_amd {
                            // the dispatch width is in macro-ops
                            self.idq.push_back(lam);
                            self.lams[lam as usize].added_to_idq = Some(clock);
                            continue;
                        }
                        for uop in self.lams[lam as usize].unfused_uops() {
                            let new_lam = self.wrap_uop(uop);
                            self.idq.push_back(new_lam);
                        }
                    }
                }
            }
        } else if self.fe.uop_source == Some(UopSource::Lsd) {
            if self.idq.is_empty() {
                for _ in 0..self.fe.lsd_unroll_count {
                    for cache_block in self.next_round_cache_blocks() {
                        self.add_new_cache_block(cache_block);
                    }
                }
            }
        } else {
            // add new cache blocks
            while self.fe.dsb_block_queue.len() < 2 && self.fe.b16_block_queue.len() < 4 {
                if self.fe.unroll {
                    let cache_block = self.next_cache_block();
                    self.add_new_cache_block(cache_block);
                } else {
                    for cache_block in self.next_round_cache_blocks() {
                        self.add_new_cache_block(cache_block);
                    }
                }
            }

            // add new uops to IDQ
            let mut new_uops: Vec<u32> = Vec::new();
            if self.ms_is_busy() {
                new_uops = self.ms_cycle();
            } else if self.fe.uop_source == Some(UopSource::Mite) {
                self.pre_decoder_cycle(clock);
                let new_instr_i_uops = self.decoder_cycle(clock)?;
                new_uops = new_instr_i_uops.iter().filter(|x| x.1 != NONE).map(|x| x.1).collect();
                if !self.fe.unroll {
                    if let Some(&(cur_inst, _)) = new_instr_i_uops.last() {
                        let ii = self.inst_instr(cur_inst);
                        let instr = &self.instrs[ii];
                        if self.prep.info[ii].is_last_decoded
                            && (instr.is_branch_instr || instr.macro_fused_with_next_instr)
                            && self.fe.addresses_in_dsb.contains(&self.fe.alignment_offset)
                        {
                            self.fe.uop_source = Some(UopSource::Dsb);
                        }
                    }
                }
            } else if self.fe.uop_source == Some(UopSource::Dsb) {
                let new_instr_i_uops = self.dsb_cycle()?;
                new_uops = new_instr_i_uops.iter().filter(|x| x.1 != NONE).map(|x| x.1).collect();
                if let Some(&last_lam) = new_uops.last() {
                    let l = &self.lams[last_lam as usize];
                    let last_uop = l.first_uop + l.n_uops - 1;
                    if self.prep.props[self.uops[last_uop as usize].prop as usize].is_last {
                        let cur_inst = new_instr_i_uops.last().unwrap().0;
                        let next_addr = if self.prep.info[self.inst_instr(cur_inst)].is_last_decoded {
                            self.fe.alignment_offset
                        } else {
                            self.inst_addr(cur_inst) + self.inst_len(cur_inst)
                        };
                        if !self.fe.addresses_in_dsb.contains(&next_addr) {
                            self.fe.uop_source = Some(UopSource::Mite);
                        }
                    }
                }
            }

            for lam in new_uops {
                let first = self.lams[lam as usize].first_uop;
                self.add_stack_sync_uop(clock, first);
                self.idq.push_back(lam);
                self.lams[lam as usize].added_to_idq = Some(clock);
            }
        }
        Ok(())
    }

    /// `FrontEnd.opCacheFieldCapacity`
    fn op_cache_field_capacity(&self, n_ops: i64) -> i64 {
        let c = self.cfg;
        c.op_cache_max_fields.min(c.op_cache_entry_fields + 2 * (c.op_cache_entry_ops - n_ops))
    }

    /// `FrontEnd.newRound`
    fn new_round(&mut self) -> Vec<u32> {
        let mut instr_is = Vec::new();
        let mut addr = self.fe.alignment_offset;
        for instr in 0..self.instrs.len() {
            let rnd = self.fe.op_cache_rnd;
            instr_is.push(self.new_instr_instance(instr, addr, rnd));
            addr += self.prep.info[instr].len;
        }
        self.fe.op_cache_rnd += 1;
        instr_is
    }

    /// `FrontEnd.findCacheableAddresses`
    fn find_cacheable_addresses(&mut self, cache_blocks_for_first_round: &[Vec<u32>]) {
        let bs = self.cfg.dsb_block_size;
        for cache_block in cache_blocks_for_first_round {
            let split_cache_blocks: Vec<Vec<u32>>;
            if bs == 32 {
                split_cache_blocks = self.split_64_to_32(cache_block).into_iter().filter(|b| !b.is_empty()).collect();
                if self.cfg.both_32byte_blocks_must_be_cacheable && split_cache_blocks.iter().any(|b| !self.can_be_in_dsb(b, bs)) {
                    return;
                }
            } else {
                split_cache_blocks = vec![cache_block.clone()];
            }
            for block in &split_cache_blocks {
                if self.can_be_in_dsb(block, bs) {
                    for &inst in block {
                        let a = self.inst_addr(inst);
                        self.fe.addresses_in_dsb.insert(a);
                    }
                } else {
                    return;
                }
            }
        }
    }

    /// `FrontEnd.addNewCacheBlock`
    fn add_new_cache_block(&mut self, cache_block: Vec<u32>) {
        self.fe.all_generated_instr_instances.extend_from_slice(&cache_block);
        if self.fe.uop_source == Some(UopSource::Lsd) {
            for &inst in &cache_block {
                self.insts[inst as usize].source = Some(UopSource::Lsd);
                for lam in self.insts[inst as usize].uops() {
                    self.idq.push_back(lam);
                    self.lams[lam as usize].uop_source = Some(UopSource::Lsd);
                }
            }
        } else {
            let bs = self.cfg.dsb_block_size;
            let blocks = if bs == 32 { self.split_64_to_32(&cache_block) } else { vec![cache_block] };
            for block in blocks {
                if block.is_empty() {
                    continue;
                }
                if self.fe.addresses_in_dsb.contains(&self.inst_addr(block[0])) {
                    for &inst in &block {
                        self.insts[inst as usize].source = Some(UopSource::Dsb);
                    }
                    let dsb_blocks = self.get_dsb_blocks(&block);
                    self.fe.dsb_block_queue.extend(dsb_blocks);
                } else {
                    for &inst in &block {
                        self.insts[inst as usize].source = Some(UopSource::Mite);
                    }
                    let b16_blocks = if bs == 32 { self.split_32_to_16(&block) } else { self.split_64_to_16(&block) };
                    for b16_block in b16_blocks {
                        if b16_block.is_empty() {
                            continue;
                        }
                        let last = *b16_block.last().unwrap();
                        self.fe.b16_block_queue.push_back(b16_block.into_iter().collect());
                        if self.instrs[self.inst_instr(last)].is_branch_instr && self.inst_addr(last).rem_euclid(16) + self.inst_len(last) > 16 {
                            // branch instr. ends in next block
                            self.fe.b16_block_queue.push_back(VecDeque::new());
                        }
                    }
                }
            }
        }
    }

    /// `FrontEnd.addStackSyncUop`
    fn add_stack_sync_uop(&mut self, clock: i64, uop: u32) {
        let prop = &self.prep.props[self.uops[uop as usize].prop as usize];
        if !prop.is_first {
            return;
        }
        let ii = prop.instr as usize;
        let info = &self.prep.info[ii];
        let mut requires_sync_uop = false;

        if self.fe.rsp_offset != 0 && info.reads_rsp_explicitly {
            requires_sync_uop = true;
            self.fe.rsp_offset = 0;
        }
        self.fe.rsp_offset += self.instrs[ii].implicit_rsp_change;
        if self.fe.rsp_offset > 192 {
            requires_sync_uop = true;
            self.fe.rsp_offset = 0;
        }
        if info.writes_rsp {
            self.fe.rsp_offset = 0;
        }

        if requires_sync_uop {
            let inst = self.uops[uop as usize].instr_instance;
            let stack_sync_prop = info.stack_sync_prop;
            let stack_sync_uop = self.new_uop(stack_sync_prop, inst);
            let lam = self.wrap_uop(stack_sync_uop);
            self.idq.push_back(lam);
            self.lams[lam as usize].added_to_idq = Some(clock);
            self.lams[lam as usize].uop_source = Some(UopSource::Se);
            self.insts[inst as usize].stack_sync_uops.push(lam);
        }
    }

    // ---- DSB ----

    /// `DSB.cycle`
    fn dsb_cycle(&mut self) -> Result<Vec<(u32, u32)>, SimError> {
        let mut ret_list: Vec<(u32, u32)> = Vec::new();
        let dsb_width = self.cfg.dsb_width;
        let bs = self.cfg.dsb_block_size;
        let Some(first_entry) = self.fe.dsb_block_queue.front().and_then(|b| b.front()) else {
            return Err(crash("IndexError: deque index out of range (DSBBlockQueue)"));
        };
        let new_dsb_block_started = first_entry.slot == 0;
        let mut second_dsb_block_loaded = false;
        let mut remaining_slots = dsb_width;
        let delay_in_prev_cycle = self.fe.dsb_delay_in_prev_cycle;
        self.fe.dsb_delay_in_prev_cycle = false;
        // the local variable DSBBlock is the first block of the queue, or a block that is empty and was removed from the queue
        let mut dsb_block_is_empty = false;
        while remaining_slots > 0 {
            if dsb_block_is_empty {
                let next_ok = match self.fe.dsb_block_queue.front() {
                    Some(b) => b.back().map_or(true, |e| e.ms_uops.is_empty()),
                    None => false,
                };
                if !second_dsb_block_loaded && next_ok {
                    second_dsb_block_loaded = true;
                    dsb_block_is_empty = false;
                    let Some(&(prev_inst, _)) = ret_list.last() else {
                        return Err(crash("IndexError: list index out of range (DSB.cycle)"));
                    };
                    let next_inst = self.fe.dsb_block_queue[0][0].inst;
                    if self.inst_addr(prev_inst) + self.inst_len(prev_inst) != self.inst_addr(next_inst)
                        && !self.prep.info[self.inst_instr(prev_inst)].is_last_decoded
                    {
                        // next instr not in DSB
                        return Ok(ret_list);
                    }
                } else {
                    return Ok(ret_list);
                }
            }

            {
                let entry = &self.fe.dsb_block_queue[0][0];
                if entry.requires_extra_entry && remaining_slots < 2 {
                    return Ok(ret_list);
                }
            }
            let entry = self.fe.dsb_block_queue[0].pop_front().unwrap();
            if entry.uop != NONE {
                ret_list.push((entry.inst, entry.uop));
                self.lams[entry.uop as usize].uop_source = Some(UopSource::Dsb);
                if entry.requires_extra_entry {
                    remaining_slots = 0;
                    self.fe.dsb_delay_in_prev_cycle = true;
                } else {
                    remaining_slots -= 1;
                }
            }
            if !entry.ms_uops.is_empty() {
                self.ms_add_uops(&entry.ms_uops, UopSource::Dsb);
                remaining_slots = 0;
            }

            if self.fe.dsb_block_queue[0].is_empty() {
                self.fe.dsb_block_queue.pop_front();
                dsb_block_is_empty = true;
                if remaining_slots != 0 && !self.fe.dsb_block_queue.is_empty() && dsb_width == 6 {
                    let next_instr_addr = self.inst_addr(self.fe.dsb_block_queue[0][0].inst);
                    let next_instr_in_same_memory_block = next_instr_addr.div_euclid(bs) == self.inst_addr(entry.inst).div_euclid(bs);
                    let is_last_decoded = self.prep.info[self.inst_instr(entry.inst)].is_last_decoded;
                    if bs == 32 && next_instr_in_same_memory_block && is_last_decoded && !delay_in_prev_cycle {
                        remaining_slots = 0;
                    } else if !next_instr_in_same_memory_block {
                        if new_dsb_block_started {
                            match ret_list.len() {
                                1 | 2 => remaining_slots = 4,
                                3 | 4 => remaining_slots = 2,
                                5 => remaining_slots = 1,
                                _ => {}
                            }
                        } else if is_last_decoded {
                            if ret_list.len() == 1 || (ret_list.len() == 2 && entry.slot >= 4) {
                                remaining_slots = 4;
                            } else {
                                remaining_slots = remaining_slots.min(2);
                            }
                        }
                    }
                }
            }
        }
        Ok(ret_list)
    }

    // ---- MicrocodeSequencer ----

    /// `MicrocodeSequencer.cycle`
    fn ms_cycle(&mut self) -> Vec<u32> {
        let mut uops = Vec::new();
        if self.fe.ms_stalled != 0 {
            self.fe.ms_stalled -= 1;
        } else if !self.fe.ms_uop_queue.is_empty() {
            while uops.len() < 4 {
                match self.fe.ms_uop_queue.pop_front() {
                    Some(u) => uops.push(u),
                    None => break,
                }
            }
            if self.fe.ms_uop_queue.is_empty() {
                self.fe.ms_stalled = self.fe.ms_post_stall;
            }
        }
        uops
    }

    /// `MicrocodeSequencer.addUops`
    fn ms_add_uops(&mut self, uops: &[u32], prev_uop_source: UopSource) {
        self.fe.ms_uop_queue.extend(uops.iter().copied());
        for &lam in uops {
            self.lams[lam as usize].uop_source = Some(UopSource::Ms);
        }
        if prev_uop_source == UopSource::Mite {
            self.fe.ms_stalled = 1;
            self.fe.ms_post_stall = 1;
        } else if prev_uop_source == UopSource::Dsb {
            self.fe.ms_stalled = self.cfg.dsb_ms_stall;
            self.fe.ms_post_stall = 0;
        }
    }

    /// `MicrocodeSequencer.isBusy`
    fn ms_is_busy(&self) -> bool {
        !self.fe.ms_uop_queue.is_empty() || self.fe.ms_stalled != 0
    }

    // ---- Decoder ----

    /// `Decoder.cycle`
    fn decoder_cycle(&mut self, clock: i64) -> Result<Vec<(u32, u32)>, SimError> {
        let cfg = self.cfg;
        let mut uops_list: Vec<(u32, u32)> = Vec::new();
        let mut n_decoded_instrs = 0;
        let mut remaining_decoder_slots = cfg.n_decoders;
        let predecoded = |sim: &Sim, inst: u32| sim.insts[inst as usize].predecoded.ok_or_else(|| crash("TypeError: predecoded is None"));
        while let Some(&inst) = self.fe.instruction_queue.front() {
            let ii = self.inst_instr(inst);
            let instr = &self.instrs[ii];
            if instr.macro_fused_with_prev_instr {
                self.fe.instruction_queue.pop_front();
                self.insts[inst as usize].removed_from_iq = Some(clock);
                continue;
            }
            if predecoded(self, inst)? + cfg.predecode_decode_delay > clock {
                break;
            }
            if !uops_list.is_empty() && instr.complex_decoder {
                break;
            }
            if self.prep.info[ii].has_macro_fusible {
                if !cfg.macro_fusible_instr_can_be_decoded_as_last_instr && n_decoded_instrs == cfg.n_decoders - 1 {
                    break;
                }
                if self.fe.instruction_queue.len() <= 1 || predecoded(self, self.fe.instruction_queue[1])? + cfg.predecode_decode_delay > clock {
                    break;
                }
            }
            self.fe.instruction_queue.pop_front();
            self.insts[inst as usize].removed_from_iq = Some(clock);

            let uops: Vec<u32> = self.insts[inst as usize].uops().collect();
            let n_mite = (instr.uops_mite.max(0) as usize).min(uops.len());
            if instr.uops_mite != 0 {
                for &lam in &uops[..n_mite] {
                    uops_list.push((inst, lam));
                    self.lams[lam as usize].uop_source = Some(UopSource::Mite);
                }
            } else {
                uops_list.push((inst, NONE));
            }

            if instr.uops_ms != 0 {
                self.ms_add_uops(&uops[n_mite..], UopSource::Mite);
                break;
            }

            if instr.complex_decoder {
                let Some(n) = instr.n_available_simple_decoders else {
                    return Err(crash("TypeError: nAvailableSimpleDecoders is None"));
                };
                remaining_decoder_slots = (remaining_decoder_slots - 1).min(n);
            } else {
                remaining_decoder_slots -= 1;
            }
            n_decoded_instrs += 1;
            if remaining_decoder_slots <= 0 {
                break;
            }
            if instr.is_branch_instr || instr.macro_fused_with_next_instr {
                break;
            }
        }
        Ok(uops_list)
    }

    // ---- PreDecoder ----

    /// `PreDecoder.cycle`
    fn pre_decoder_cycle(&mut self, clock: i64) {
        let cfg = self.cfg;
        let block_size = cfg.pre_decode_block_size;
        if self.fe.predec_stalled == 0 {
            if self.fe.pre_dec_queue.is_empty()
                && (!self.fe.b16_block_queue.is_empty() || self.fe.partial_instr_i != NONE)
                && self.fe.instruction_queue.len() as i64 + cfg.pre_decode_width <= cfg.iq_width
            {
                if self.fe.partial_instr_i != NONE {
                    self.fe.pre_dec_queue.push(self.fe.partial_instr_i);
                    self.fe.partial_instr_i = NONE;
                }

                if self.fe.cur_block.is_empty() {
                    if (self.fe.b16_block_queue.len() as i64) < block_size / 16 {
                        return;
                    }
                    for _ in 0..block_size / 16 {
                        let b = self.fe.b16_block_queue.pop_front().unwrap();
                        self.fe.cur_block.extend(b);
                    }
                    let lcp: i64 = self.fe.cur_block.iter().filter(|&&ii| self.instrs[self.inst_instr(ii)].lcp_stall).count() as i64 * 3;
                    self.fe.predec_stalled = (lcp - (self.fe.non_stalled_predec_cycles_for_cur_block - 1).max(0)).max(0);
                    self.fe.non_stalled_predec_cycles_for_cur_block = 0;
                }

                while !self.fe.cur_block.is_empty() && (self.fe.pre_dec_queue.len() as i64) < cfg.pre_decode_width {
                    if self.crosses_predec_block_boundary(self.fe.cur_block[0], block_size) {
                        break;
                    }
                    let ii = self.fe.cur_block.pop_front().unwrap();
                    self.fe.pre_dec_queue.push(ii);
                }

                if self.fe.cur_block.len() == 1 {
                    let inst = self.fe.cur_block[0];
                    if self.crosses_predec_block_boundary(inst, block_size) {
                        let offset_of_nominal_opcode = self.inst_addr(inst).rem_euclid(16) + self.instrs[self.inst_instr(inst)].pos_nominal_opcode;
                        if (self.fe.pre_dec_queue.len() as i64) < cfg.pre_decode_width || offset_of_nominal_opcode >= 16 {
                            self.fe.partial_instr_i = inst;
                            self.fe.cur_block.pop_front();
                        }
                    }
                }

                self.fe.non_stalled_predec_cycles_for_cur_block += 1;
            }

            if self.fe.predec_stalled == 0 {
                for i in 0..self.fe.pre_dec_queue.len() {
                    let inst = self.fe.pre_dec_queue[i];
                    self.insts[inst as usize].predecoded = Some(clock);
                    self.fe.instruction_queue.push_back(inst);
                }
                self.fe.pre_dec_queue.clear();
            }
        }
        self.fe.predec_stalled = (self.fe.predec_stalled - 1).max(0);
    }

    // ---- ReorderBuffer ----

    /// `ReorderBuffer.isFull`
    fn rob_is_full(&self) -> bool {
        self.rob.len() as i64 + self.cfg.issue_width > self.cfg.rb_width
    }

    /// `ReorderBuffer.cycle`
    fn rob_cycle(&mut self, clock: i64, new_uops: &[u32]) {
        // retireUops
        let mut n_retired_in_same_cycle = 0;
        for _ in 0..self.cfg.retire_width {
            let Some(&fused) = self.rob.front() else { break };
            let all_executed =
                self.fused[fused as usize].unfused_uops().all(|u| self.uops[u as usize].executed.is_some_and(|e| e < clock as f64));
            if all_executed {
                self.rob.pop_front();
                self.retire_queue.push_back(fused);
                self.fused[fused as usize].retired = Some(clock);
                self.fused[fused as usize].retire_idx = Some(n_retired_in_same_cycle);
                n_retired_in_same_cycle += 1;
            } else {
                break;
            }
        }
        // addUops
        for &fused in new_uops {
            self.rob.push_back(fused);
            for u in self.fused[fused as usize].unfused_uops() {
                let uop = &mut self.uops[u as usize];
                if self.prep.props[uop.prop as usize].ports.is_empty() || uop.eliminated {
                    uop.executed = Some(clock as f64);
                }
            }
        }
    }
}
