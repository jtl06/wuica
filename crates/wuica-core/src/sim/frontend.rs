//! The front end: `FrontEnd`, `DSB`, `MicrocodeSequencer`, `Decoder`, `PreDecoder`, `ReorderBuffer`, the cache-block generators
//! and the DSB helpers.
//!
//! The instruction instances that a cache-block generator creates for one cache block are created one after the other, so a
//! cache block is a range of instance indices ([`Block`]). The queues of blocks (`DSBBlockQueue`, `B16BlockQueue`) are stored
//! as one queue of entries and a queue of block lengths, and the lists that the Python methods return are written to buffers
//! that are reused from cycle to cycle.

use super::prep::{inf, pf, NONE};
use super::{crash, FxHashSet, Sim, SimError, UopSource};
use std::collections::VecDeque;

/// a cache block: the instruction instances `.0 .. .1`
pub(crate) type Block = (u32, u32);

/// `a % m` (Python's, which rounds toward negative infinity); without a division for the block sizes (powers of two)
#[inline(always)]
fn py_mod(a: i64, m: i64) -> i64 {
    if m > 0 && m & (m - 1) == 0 {
        a & (m - 1)
    } else {
        a.rem_euclid(m)
    }
}

/// `a // m` (Python's); a shift for powers of two
#[inline(always)]
fn py_div(a: i64, m: i64) -> i64 {
    if m > 0 && m & (m - 1) == 0 {
        a >> m.trailing_zeros()
    } else {
        a.div_euclid(m)
    }
}

fn block_vec(b: Block) -> Vec<u32> {
    (b.0..b.1).collect()
}

/// `DSBEntry`
pub(crate) struct DsbEntry {
    slot: usize,
    inst: u32,
    /// laminated uop or NONE
    uop: u32,
    /// `MSUops`: the laminated uops `ms_uops.0 .. ms_uops.0 + ms_uops.1`
    ms_uops: (u32, u32),
    requires_extra_entry: bool,
}

/// a queue of lists of `DSBEntry` (`DSBBlockQueue`, and the result of `getDSBBlocks`): the entries of all blocks, and the
/// number of entries of each block
#[derive(Default)]
pub(crate) struct DsbBlockQueue {
    entries: VecDeque<DsbEntry>,
    block_lens: VecDeque<u32>,
}

impl DsbBlockQueue {
    /// the number of blocks
    fn len(&self) -> usize {
        self.block_lens.len()
    }

    fn is_empty(&self) -> bool {
        self.block_lens.is_empty()
    }

    fn start_block(&mut self) {
        self.block_lens.push_back(0);
    }

    /// the number of entries of the last block
    fn last_block_len(&self) -> usize {
        *self.block_lens.back().unwrap() as usize
    }

    /// appends an entry to the last block
    fn push(&mut self, e: DsbEntry) {
        *self.block_lens.back_mut().unwrap() += 1;
        self.entries.push_back(e);
    }

    /// `self[0][0]`
    fn first_entry(&self) -> Option<&DsbEntry> {
        match self.block_lens.front() {
            Some(&n) if n > 0 => self.entries.front(),
            _ => None,
        }
    }

    /// `self[0][-1]` (None if the first block is empty or there is no block)
    fn first_block_last_entry(&self) -> Option<&DsbEntry> {
        match self.block_lens.front() {
            Some(&n) if n > 0 => self.entries.get(n as usize - 1),
            _ => None,
        }
    }

    /// `self[0].popleft()`
    fn pop_first_entry(&mut self) -> Option<DsbEntry> {
        match self.block_lens.front_mut() {
            Some(n) if *n > 0 => {
                *n -= 1;
                self.entries.pop_front()
            }
            _ => None,
        }
    }

    /// `not self[0]`
    fn first_block_is_empty(&self) -> bool {
        self.block_lens.front() == Some(&0)
    }

    /// `self.popleft()` for an empty first block
    fn pop_empty_first_block(&mut self) {
        debug_assert!(self.first_block_is_empty());
        self.block_lens.pop_front();
    }

}

/// `addressesInDSB`: a set of addresses. The addresses that are added are those of the instances of the first round, which lie in
/// `base .. base + len` (the length of the code); they are stored as bits. Other addresses (there are none) would be in `other`.
pub(crate) struct AddressSet {
    base: i64,
    len: i64,
    bits: Vec<u64>,
    other: FxHashSet<i64>,
}

impl AddressSet {
    fn new(base: i64, len: i64) -> AddressSet {
        AddressSet { base, len, bits: vec![0; (len.max(0) as usize).div_ceil(64)], other: FxHashSet::default() }
    }

    /// the offset of `a` in the bits
    #[inline]
    fn offset(&self, a: i64) -> Option<usize> {
        match a.checked_sub(self.base) {
            Some(off) if off >= 0 && off < self.len => Some(off as usize),
            _ => None,
        }
    }

    fn insert(&mut self, a: i64) {
        match self.offset(a) {
            Some(off) => self.bits[off / 64] |= 1 << (off % 64),
            None => {
                self.other.insert(a);
            }
        }
    }

    #[inline]
    fn contains(&self, a: i64) -> bool {
        match self.offset(a) {
            Some(off) => self.bits[off / 64] & (1 << (off % 64)) != 0,
            None => !self.other.is_empty() && self.other.contains(&a),
        }
    }
}

/// the state of `CacheBlockGenerator`
struct CacheBlockGenerator {
    unroll: bool,
    rnd: i64,
    pos: usize,
    next_addr: i64,
}

pub(crate) struct FrontEnd {
    pub unroll: bool,
    pub alignment_offset: i64,
    instruction_queue: VecDeque<u32>,
    /// the instances of the current round of the op cache that have not been delivered yet: `.0 .. .1`
    op_cache_round: Block,
    op_cache_rnd: i64,
    rsp_offset: i64,
    pub all_generated_instr_instances: Vec<u32>,
    addresses_in_dsb: AddressSet,
    pub lsd_unroll_count: i64,
    /// None, MITE, DSB or LSD
    pub uop_source: Option<UopSource>,
    cbg: CacheBlockGenerator,
    // CacheBlocksForNextRoundGenerator
    nrg_cache_blocks: Vec<Block>,
    nrg_prev_rnd: i64,
    // MicrocodeSequencer
    ms_uop_queue: VecDeque<u32>,
    ms_stalled: i64,
    ms_post_stall: i64,
    // DSB
    dsb_block_queue: DsbBlockQueue,
    dsb_delay_in_prev_cycle: bool,
    // PreDecoder
    /// `B16BlockQueue`: the instances of all blocks, and the number of instances of each block
    b16_entries: VecDeque<u32>,
    b16_block_lens: VecDeque<u32>,
    cur_block: VecDeque<u32>,
    non_stalled_predec_cycles_for_cur_block: i64,
    pre_dec_queue: Vec<u32>,
    predec_stalled: i64,
    partial_instr_i: u32,
    // reused buffers
    /// the uops issued in a cycle
    issue_uops: Vec<u32>,
    /// (instruction instance, laminated uop or NONE) from the decoders or the DSB
    instr_i_uops: Vec<(u32, u32)>,
    /// laminated uops added to the IDQ
    new_uops: Vec<u32>,
    round_blocks: Vec<Block>,
    split_buf1: Vec<u32>,
    split_buf2: Vec<u32>,
    split_buf3: Vec<u32>,
}

impl FrontEnd {
    /// `code_len`: the length of the code in bytes
    pub fn new(unroll: bool, alignment_offset: i64, code_len: i64) -> FrontEnd {
        FrontEnd {
            unroll,
            alignment_offset,
            instruction_queue: VecDeque::new(),
            op_cache_round: (0, 0),
            op_cache_rnd: 0,
            rsp_offset: 0,
            all_generated_instr_instances: Vec::new(),
            addresses_in_dsb: AddressSet::new(alignment_offset, code_len),
            lsd_unroll_count: 1,
            uop_source: None,
            cbg: CacheBlockGenerator { unroll: true, rnd: 0, pos: 0, next_addr: alignment_offset },
            nrg_cache_blocks: Vec::new(),
            nrg_prev_rnd: 0,
            ms_uop_queue: VecDeque::new(),
            ms_stalled: 0,
            ms_post_stall: 0,
            dsb_block_queue: DsbBlockQueue::default(),
            dsb_delay_in_prev_cycle: false,
            b16_entries: VecDeque::new(),
            b16_block_lens: VecDeque::new(),
            cur_block: VecDeque::new(),
            non_stalled_predec_cycles_for_cur_block: 0,
            pre_dec_queue: Vec::new(),
            predec_stalled: 0,
            partial_instr_i: NONE,
            issue_uops: Vec::new(),
            instr_i_uops: Vec::new(),
            new_uops: Vec::new(),
            round_blocks: Vec::new(),
            split_buf1: Vec::new(),
            split_buf2: Vec::new(),
            split_buf3: Vec::new(),
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

    /// `[ii for ii in block if b*size <= ii.address % modulus < (b+1)*size]`, written to `out`
    fn split_part(&self, block: &[u32], modulus: i64, size: i64, b: i64, out: &mut Vec<u32>) {
        out.clear();
        for &ii in block {
            let a = py_mod(self.inst_addr(ii), modulus);
            if b * size <= a && a < (b + 1) * size {
                out.push(ii);
            }
        }
    }

    /// `[[ii for ii in block if b*size <= ii.address % modulus < (b+1)*size] for b in range(0, n)]`
    fn split(&self, block: &[u32], modulus: i64, size: i64, n: i64) -> Vec<Vec<u32>> {
        (0..n)
            .map(|b| {
                let mut v = Vec::new();
                self.split_part(block, modulus, size, b, &mut v);
                v
            })
            .collect()
    }

    fn split_32_to_16(&self, block: &[u32]) -> Vec<Vec<u32>> {
        self.split(block, 32, 16, 2)
    }

    fn split_64_to_32(&self, block: &[u32]) -> Vec<Vec<u32>> {
        self.split(block, 64, 32, 2)
    }

    /// `instrInstanceCrossesPredecBlockBoundary`
    fn crosses_predec_block_boundary(&self, inst: u32, block_size: i64) -> bool {
        py_mod(self.inst_addr(inst), block_size) + self.inst_len(inst) > block_size
    }

    // ---- generators ----

    /// `next(CacheBlockGenerator(instructions, unroll, alignmentOffset))`
    fn next_cache_block(&mut self) -> Block {
        let n = self.instrs.len();
        let first = self.insts.len() as u32;
        loop {
            let instr = self.fe.cbg.pos;
            let (addr, rnd) = (self.fe.cbg.next_addr, self.fe.cbg.rnd);
            self.new_instr_instance(instr, addr, rnd);
            let g = &mut self.fe.cbg;
            g.pos += 1;
            if g.pos == n {
                g.pos = 0;
                g.rnd += 1;
            }
            if !g.unroll && instr == n - 1 {
                g.next_addr = self.fe.alignment_offset;
                return (first, self.insts.len() as u32);
            }
            let prev_addr = g.next_addr;
            g.next_addr = prev_addr + self.prep.info[instr].len;
            if prev_addr.div_euclid(64) != g.next_addr.div_euclid(64) {
                return (first, self.insts.len() as u32);
            }
        }
    }

    /// `next(CacheBlocksForNextRoundGenerator(instructions, alignmentOffset))`: the cache blocks of one round, written to `out`.
    /// The generator creates the first cache block of the following round before it returns.
    fn next_round_cache_blocks(&mut self, out: &mut Vec<Block>) {
        out.clear();
        loop {
            let cache_block = self.next_cache_block();
            let cur_rnd = self.insts[cache_block.1 as usize - 1].rnd;
            if self.fe.nrg_prev_rnd != cur_rnd {
                std::mem::swap(out, &mut self.fe.nrg_cache_blocks);
                self.fe.nrg_prev_rnd = cur_rnd;
                self.fe.nrg_cache_blocks.push(cache_block);
                return;
            }
            self.fe.nrg_cache_blocks.push(cache_block);
        }
    }

    // ---- DSB helpers ----

    /// `getDSBBlocks`: appends the blocks to `dsb_blocks`
    fn get_dsb_blocks(&self, cache_block: &[u32], dsb_blocks: &mut DsbBlockQueue) {
        let mut remaining_entries_in_cur_block: i64 = 0;
        // the first instruction that is not macro-fused with the previous one always starts a new block
        let mut started = false;
        for &inst in cache_block {
            let ii = self.inst_instr(inst);
            let info = &self.prep.info[ii];
            if info.has(inf::MACRO_FUSED_PREV) {
                continue;
            }
            let (uops_mite, uops_ms) = (info.uops_mite, info.uops_ms);
            let n_required_entries = info.dsb_required_entries;
            let requires_extra_entry = info.has(inf::DSB_EXTRA_ENTRY);
            if uops_ms != 0 || n_required_entries + requires_extra_entry as i64 > remaining_entries_in_cur_block {
                remaining_entries_in_cur_block = 6;
                dsb_blocks.start_block();
                started = true;
            }
            assert!(started, "getDSBBlocks: no current block");
            let i = &self.insts[inst as usize];
            let (first_uop, n_uops) = (i.first_uop, i.n_uops);
            let n_mite = (uops_mite.max(0) as u32).min(n_uops);
            if uops_mite != 0 {
                for k in 0..n_mite {
                    let lam = first_uop + k;
                    let slot = dsb_blocks.last_block_len();
                    if k as i64 == uops_mite - 1 {
                        dsb_blocks.push(DsbEntry { slot, inst, uop: lam, ms_uops: (first_uop + n_mite, n_uops - n_mite), requires_extra_entry });
                    } else {
                        dsb_blocks.push(DsbEntry { slot, inst, uop: lam, ms_uops: (0, 0), requires_extra_entry: false });
                    }
                    remaining_entries_in_cur_block -= 1;
                }
            } else if uops_ms != 0 {
                let slot = dsb_blocks.last_block_len();
                dsb_blocks.push(DsbEntry { slot, inst, uop: NONE, ms_uops: (first_uop, n_uops), requires_extra_entry: false });
            } else {
                let slot = dsb_blocks.last_block_len();
                dsb_blocks.push(DsbEntry { slot, inst, uop: NONE, ms_uops: (0, 0), requires_extra_entry: false });
                remaining_entries_in_cur_block -= 1;
            }
            if requires_extra_entry {
                remaining_entries_in_cur_block -= 1;
            }
            if uops_ms != 0 {
                remaining_entries_in_cur_block = 0;
            }
        }
    }

    /// `len(getDSBBlocks(cacheBlock))`
    fn n_dsb_blocks(&self, cache_block: &[u32]) -> usize {
        let mut q = DsbBlockQueue::default();
        self.get_dsb_blocks(cache_block, &mut q);
        q.len()
    }

    /// `canBeInDSB`
    fn can_be_in_dsb(&self, block: &[u32], dsb_block_size: i64) -> bool {
        if dsb_block_size == 32 && self.n_dsb_blocks(block) > 3 {
            return false;
        }
        if dsb_block_size == 64 && self.n_dsb_blocks(block) > 6 {
            return false;
        }
        if self.prep.info[self.inst_instr(*block.last().unwrap())].has(inf::JCC_ERRATUM) {
            return false;
        }
        let b32_blocks = if dsb_block_size == 32 { vec![block.to_vec()] } else { self.split_64_to_32(block) };
        for b32_block in b32_blocks {
            let mut b16 = self.split_32_to_16(&b32_block);
            let mut b16_2 = b16.pop().unwrap();
            let mut b16_1 = b16.pop().unwrap();
            if !b16_1.is_empty() && !b16_2.is_empty() {
                let last = *b16_1.last().unwrap();
                if self.inst_addr(last).rem_euclid(16) + self.prep.info[self.inst_instr(last)].pos_nominal_opcode >= 16 {
                    b16_2.insert(0, b16_1.pop().unwrap());
                }
            }
            let lcp_and_fusible = |inst: u32| {
                let f = self.prep.info[self.inst_instr(inst)].flags;
                f & inf::LCP_STALL != 0 && f & inf::MACRO_FUSIBLE != 0
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
        let mut cache_blocks_for_first_round = Vec::new();
        self.next_round_cache_blocks(&mut cache_blocks_for_first_round);
        let bs = self.cfg.dsb_block_size;

        let all_blocks_can_be_cached = if bs == 32 {
            cache_blocks_for_first_round
                .iter()
                .all(|&cb| self.split_64_to_32(&block_vec(cb)).iter().filter(|b| !b.is_empty()).all(|b| self.can_be_in_dsb(b, bs)))
        } else {
            cache_blocks_for_first_round.iter().all(|&b| self.can_be_in_dsb(&block_vec(b), bs))
        };
        let all_instrs_can_be_used_by_lsd = cache_blocks_for_first_round
            .iter()
            .flat_map(|&b| b.0..b.1)
            .all(|ii| self.prep.info[self.inst_instr(ii)].has(inf::CAN_BE_USED_BY_LSD));
        let n_uops: i64 = cache_blocks_for_first_round.iter().flat_map(|&b| b.0..b.1).map(|ii| self.insts[ii as usize].n_uops as i64).sum();
        if all_blocks_can_be_cached && self.cfg.lsd_enabled && all_instrs_can_be_used_by_lsd && n_uops <= self.cfg.idq_width {
            self.fe.uop_source = Some(UopSource::Lsd);
            self.fe.lsd_unroll_count = self.cfg.lsd_unrolling.get(&n_uops.to_string()).map_or(1, |&n| n as i64);
            let mut blocks = cache_blocks_for_first_round;
            let mut round = Vec::new();
            for _ in 0..self.fe.lsd_unroll_count - 1 {
                self.next_round_cache_blocks(&mut round);
                blocks.extend_from_slice(&round);
            }
            for cache_block in blocks {
                self.add_new_cache_block(cache_block);
            }
        } else {
            self.find_cacheable_addresses(&cache_blocks_for_first_round);
            for &cache_block in &cache_blocks_for_first_round {
                self.add_new_cache_block(cache_block);
            }
            if self.fe.addresses_in_dsb.contains(self.fe.alignment_offset) {
                self.fe.uop_source = Some(UopSource::Dsb);
            }
        }
        Ok(())
    }

    /// `FrontEnd.cycle`
    pub(crate) fn front_end_cycle(&mut self, clock: i64) -> Result<(), SimError> {
        let mut issue_uops = std::mem::take(&mut self.fe.issue_uops);
        issue_uops.clear();
        if !self.rob_is_full() && !self.scheduler_is_full() {
            self.renamer_cycle(&mut issue_uops)?;
        }
        for &fused in &issue_uops {
            self.fused[fused as usize].issued = clock;
        }
        self.rob_cycle(clock, &issue_uops);
        self.scheduler_cycle(clock, &issue_uops)?;
        self.fe.issue_uops = issue_uops;

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
                    if self.fe.op_cache_round.0 == self.fe.op_cache_round.1 {
                        self.fe.op_cache_round = self.new_round();
                    }
                    let inst = self.fe.op_cache_round.0;
                    let ii = self.inst_instr(inst);
                    let slots = self.insts[inst as usize].n_uops as i64 + self.prep.info[ii].has(inf::I64) as i64;
                    let window = (self.inst_addr(inst) + self.inst_len(inst) - 1).div_euclid(64);
                    let fields = self.prep.info[ii].op_cache_fields;
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
                    self.fe.op_cache_round.0 += 1;
                    self.fe.all_generated_instr_instances.push(inst);
                    for lam in self.insts[inst as usize].uops() {
                        let first = self.lams[lam as usize].first_uop;
                        self.add_stack_sync_uop(clock, first);
                        self.idq.push_back(lam);
                        self.lams[lam as usize].added_to_idq = clock;
                    }
                    n_ops += slots;
                    n_fields += fields;
                    if self.fe.op_cache_round.0 == self.fe.op_cache_round.1 {
                        break; // the entry ends at the end of the loop
                    }
                }
            }
        } else if self.fe.uop_source.is_none() {
            while (self.idq.len() as i64) < cfg.issue_width {
                let (first, end) = self.next_cache_block();
                for inst in first..end {
                    self.fe.all_generated_instr_instances.push(inst);
                    for lam in self.insts[inst as usize].uops() {
                        let first = self.lams[lam as usize].first_uop;
                        self.add_stack_sync_uop(clock, first);
                        if cfg.is_amd {
                            // the dispatch width is in macro-ops
                            self.idq.push_back(lam);
                            self.lams[lam as usize].added_to_idq = clock;
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
                let mut round = std::mem::take(&mut self.fe.round_blocks);
                for _ in 0..self.fe.lsd_unroll_count {
                    self.next_round_cache_blocks(&mut round);
                    for &cache_block in &round {
                        self.add_new_cache_block(cache_block);
                    }
                }
                self.fe.round_blocks = round;
            }
        } else {
            // add new cache blocks
            while self.fe.dsb_block_queue.len() < 2 && self.fe.b16_block_lens.len() < 4 {
                if self.fe.unroll {
                    let cache_block = self.next_cache_block();
                    self.add_new_cache_block(cache_block);
                } else {
                    let mut round = std::mem::take(&mut self.fe.round_blocks);
                    self.next_round_cache_blocks(&mut round);
                    for &cache_block in &round {
                        self.add_new_cache_block(cache_block);
                    }
                    self.fe.round_blocks = round;
                }
            }

            // add new uops to IDQ
            let mut new_uops = std::mem::take(&mut self.fe.new_uops);
            new_uops.clear();
            if self.ms_is_busy() {
                self.ms_cycle(&mut new_uops);
            } else if self.fe.uop_source == Some(UopSource::Mite) {
                self.pre_decoder_cycle(clock);
                let mut new_instr_i_uops = std::mem::take(&mut self.fe.instr_i_uops);
                new_instr_i_uops.clear();
                self.decoder_cycle(clock, &mut new_instr_i_uops)?;
                new_uops.extend(new_instr_i_uops.iter().filter(|x| x.1 != NONE).map(|x| x.1));
                if !self.fe.unroll {
                    if let Some(&(cur_inst, _)) = new_instr_i_uops.last() {
                        let info = &self.prep.info[self.inst_instr(cur_inst)];
                        if info.has(inf::LAST_DECODED)
                            && info.has(inf::BRANCH | inf::MACRO_FUSED_NEXT)
                            && self.fe.addresses_in_dsb.contains(self.fe.alignment_offset)
                        {
                            self.fe.uop_source = Some(UopSource::Dsb);
                        }
                    }
                }
                self.fe.instr_i_uops = new_instr_i_uops;
            } else if self.fe.uop_source == Some(UopSource::Dsb) {
                let mut new_instr_i_uops = std::mem::take(&mut self.fe.instr_i_uops);
                new_instr_i_uops.clear();
                self.dsb_cycle(&mut new_instr_i_uops)?;
                new_uops.extend(new_instr_i_uops.iter().filter(|x| x.1 != NONE).map(|x| x.1));
                if let Some(&last_lam) = new_uops.last() {
                    let l = &self.lams[last_lam as usize];
                    let last_uop = l.first_uop + l.n_uops - 1;
                    if self.prep.props[self.uops[last_uop as usize].prop as usize].has(pf::LAST) {
                        let cur_inst = new_instr_i_uops.last().unwrap().0;
                        let next_addr = if self.prep.info[self.inst_instr(cur_inst)].has(inf::LAST_DECODED) {
                            self.fe.alignment_offset
                        } else {
                            self.inst_addr(cur_inst) + self.inst_len(cur_inst)
                        };
                        if !self.fe.addresses_in_dsb.contains(next_addr) {
                            self.fe.uop_source = Some(UopSource::Mite);
                        }
                    }
                }
                self.fe.instr_i_uops = new_instr_i_uops;
            }

            for &lam in &new_uops {
                let first = self.lams[lam as usize].first_uop;
                self.add_stack_sync_uop(clock, first);
                self.idq.push_back(lam);
                self.lams[lam as usize].added_to_idq = clock;
            }
            self.fe.new_uops = new_uops;
        }
        Ok(())
    }

    /// `FrontEnd.opCacheFieldCapacity`
    fn op_cache_field_capacity(&self, n_ops: i64) -> i64 {
        let c = self.cfg;
        c.op_cache_max_fields.min(c.op_cache_entry_fields + 2 * (c.op_cache_entry_ops - n_ops))
    }

    /// `FrontEnd.newRound`
    fn new_round(&mut self) -> Block {
        let first = self.insts.len() as u32;
        let mut addr = self.fe.alignment_offset;
        for instr in 0..self.instrs.len() {
            let rnd = self.fe.op_cache_rnd;
            self.new_instr_instance(instr, addr, rnd);
            addr += self.prep.info[instr].len;
        }
        self.fe.op_cache_rnd += 1;
        (first, self.insts.len() as u32)
    }

    /// `FrontEnd.findCacheableAddresses`
    fn find_cacheable_addresses(&mut self, cache_blocks_for_first_round: &[Block]) {
        let bs = self.cfg.dsb_block_size;
        for &cache_block in cache_blocks_for_first_round {
            let split_cache_blocks: Vec<Vec<u32>>;
            if bs == 32 {
                split_cache_blocks = self.split_64_to_32(&block_vec(cache_block)).into_iter().filter(|b| !b.is_empty()).collect();
                if self.cfg.both_32byte_blocks_must_be_cacheable && split_cache_blocks.iter().any(|b| !self.can_be_in_dsb(b, bs)) {
                    return;
                }
            } else {
                split_cache_blocks = vec![block_vec(cache_block)];
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
    fn add_new_cache_block(&mut self, cache_block: Block) {
        let (first, end) = cache_block;
        self.fe.all_generated_instr_instances.extend(first..end);
        if self.fe.uop_source == Some(UopSource::Lsd) {
            for inst in first..end {
                self.insts[inst as usize].source = Some(UopSource::Lsd);
                for lam in self.insts[inst as usize].uops() {
                    self.idq.push_back(lam);
                    self.lams[lam as usize].uop_source = Some(UopSource::Lsd);
                }
            }
            return;
        }
        let bs = self.cfg.dsb_block_size;
        let mut cb = std::mem::take(&mut self.fe.split_buf1);
        let mut block = std::mem::take(&mut self.fe.split_buf2);
        cb.clear();
        cb.extend(first..end);
        // blocks: splitTo32ByteBlocks(cacheBlock) if DSBBlockSize == 32 else [cacheBlock]
        let n_blocks = if bs == 32 { 2 } else { 1 };
        let mut b16_block = std::mem::take(&mut self.fe.split_buf3);
        for b in 0..n_blocks {
            if bs == 32 {
                self.split_part(&cb, 64, 32, b, &mut block);
            } else {
                block.clear();
                block.extend_from_slice(&cb);
            }
            if block.is_empty() {
                continue;
            }
            if self.fe.addresses_in_dsb.contains(self.inst_addr(block[0])) {
                for &inst in &block {
                    self.insts[inst as usize].source = Some(UopSource::Dsb);
                }
                // DSBBlockQueue.extend(getDSBBlocks(block))
                let mut queue = std::mem::take(&mut self.fe.dsb_block_queue);
                self.get_dsb_blocks(&block, &mut queue);
                self.fe.dsb_block_queue = queue;
            } else {
                for &inst in &block {
                    self.insts[inst as usize].source = Some(UopSource::Mite);
                }
                // split32ByteBlockTo16ByteBlocks or split64ByteBlockTo16ByteBlocks
                let (modulus, n_b16) = if bs == 32 { (32, 2) } else { (64, 4) };
                for b16 in 0..n_b16 {
                    self.split_part(&block, modulus, 16, b16, &mut b16_block);
                    if b16_block.is_empty() {
                        continue;
                    }
                    let last = *b16_block.last().unwrap();
                    self.fe.b16_entries.extend(b16_block.iter().copied());
                    self.fe.b16_block_lens.push_back(b16_block.len() as u32);
                    if self.prep.info[self.inst_instr(last)].has(inf::BRANCH) && self.inst_addr(last).rem_euclid(16) + self.inst_len(last) > 16 {
                        // branch instr. ends in next block
                        self.fe.b16_block_lens.push_back(0);
                    }
                }
            }
        }
        self.fe.split_buf1 = cb;
        self.fe.split_buf2 = block;
        self.fe.split_buf3 = b16_block;
    }

    /// `FrontEnd.addStackSyncUop`
    fn add_stack_sync_uop(&mut self, clock: i64, uop: u32) {
        let prop = &self.prep.props[self.uops[uop as usize].prop as usize];
        if !prop.has(pf::FIRST) {
            return;
        }
        let ii = prop.instr as usize;
        let info = &self.prep.info[ii];
        let mut requires_sync_uop = false;

        if self.fe.rsp_offset != 0 && info.has(inf::READS_RSP_EXPLICITLY) {
            requires_sync_uop = true;
            self.fe.rsp_offset = 0;
        }
        self.fe.rsp_offset += info.implicit_rsp_change;
        if self.fe.rsp_offset > 192 {
            requires_sync_uop = true;
            self.fe.rsp_offset = 0;
        }
        if info.has(inf::WRITES_RSP) {
            self.fe.rsp_offset = 0;
        }

        if requires_sync_uop {
            let inst = self.uops[uop as usize].instr_instance;
            let stack_sync_prop = info.stack_sync_prop;
            let stack_sync_uop = self.new_uop(stack_sync_prop, inst);
            let lam = self.wrap_uop(stack_sync_uop);
            self.idq.push_back(lam);
            self.lams[lam as usize].added_to_idq = clock;
            self.lams[lam as usize].uop_source = Some(UopSource::Se);
            self.stack_sync_uops.push((inst, lam));
        }
    }

    // ---- DSB ----

    /// `DSB.cycle`: writes the result to `ret_list` (which must be empty)
    fn dsb_cycle(&mut self, ret_list: &mut Vec<(u32, u32)>) -> Result<(), SimError> {
        debug_assert!(ret_list.is_empty());
        let dsb_width = self.cfg.dsb_width;
        let bs = self.cfg.dsb_block_size;
        let Some(first_entry) = self.fe.dsb_block_queue.first_entry() else {
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
                let next_ok = if self.fe.dsb_block_queue.is_empty() {
                    false
                } else {
                    self.fe.dsb_block_queue.first_block_last_entry().map_or(true, |e| e.ms_uops.1 == 0)
                };
                if !second_dsb_block_loaded && next_ok {
                    second_dsb_block_loaded = true;
                    dsb_block_is_empty = false;
                    let Some(&(prev_inst, _)) = ret_list.last() else {
                        return Err(crash("IndexError: list index out of range (DSB.cycle)"));
                    };
                    let Some(next) = self.fe.dsb_block_queue.first_entry() else {
                        return Err(crash("IndexError: deque index out of range (DSBBlock)"));
                    };
                    let next_inst = next.inst;
                    if self.inst_addr(prev_inst) + self.inst_len(prev_inst) != self.inst_addr(next_inst)
                        && !self.prep.info[self.inst_instr(prev_inst)].has(inf::LAST_DECODED)
                    {
                        // next instr not in DSB
                        return Ok(());
                    }
                } else {
                    return Ok(());
                }
            }

            {
                let Some(entry) = self.fe.dsb_block_queue.first_entry() else {
                    return Err(crash("IndexError: deque index out of range (DSBBlock)"));
                };
                if entry.requires_extra_entry && remaining_slots < 2 {
                    return Ok(());
                }
            }
            let entry = self.fe.dsb_block_queue.pop_first_entry().unwrap();
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
            if entry.ms_uops.1 != 0 {
                self.ms_add_uops(entry.ms_uops, UopSource::Dsb);
                remaining_slots = 0;
            }

            if self.fe.dsb_block_queue.first_block_is_empty() {
                self.fe.dsb_block_queue.pop_empty_first_block();
                dsb_block_is_empty = true;
                if remaining_slots != 0 && !self.fe.dsb_block_queue.is_empty() && dsb_width == 6 {
                    let Some(next) = self.fe.dsb_block_queue.first_entry() else {
                        return Err(crash("IndexError: deque index out of range (DSBBlock)"));
                    };
                    let next_instr_addr = self.inst_addr(next.inst);
                    let next_instr_in_same_memory_block = py_div(next_instr_addr, bs) == py_div(self.inst_addr(entry.inst), bs);
                    let is_last_decoded = self.prep.info[self.inst_instr(entry.inst)].has(inf::LAST_DECODED);
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
        Ok(())
    }

    // ---- MicrocodeSequencer ----

    /// `MicrocodeSequencer.cycle`: writes the uops to `uops` (which must be empty)
    fn ms_cycle(&mut self, uops: &mut Vec<u32>) {
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
    }

    /// `MicrocodeSequencer.addUops`: adds the laminated uops `uops.0 .. uops.0 + uops.1`
    fn ms_add_uops(&mut self, uops: (u32, u32), prev_uop_source: UopSource) {
        self.fe.ms_uop_queue.extend(uops.0..uops.0 + uops.1);
        for lam in uops.0..uops.0 + uops.1 {
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

    /// `Decoder.cycle`: writes the result to `uops_list` (which must be empty)
    fn decoder_cycle(&mut self, clock: i64, uops_list: &mut Vec<(u32, u32)>) -> Result<(), SimError> {
        let cfg = self.cfg;
        debug_assert!(uops_list.is_empty());
        let mut n_decoded_instrs = 0;
        let mut remaining_decoder_slots = cfg.n_decoders;
        let predecoded = |sim: &Sim, inst: u32| super::opt(sim.insts[inst as usize].predecoded).ok_or_else(|| crash("TypeError: predecoded is None"));
        while let Some(&inst) = self.fe.instruction_queue.front() {
            let info = &self.prep.info[self.inst_instr(inst)];
            let (flags, uops_mite, uops_ms, n_available_simple_decoders) = (info.flags, info.uops_mite, info.uops_ms, info.n_available_simple_decoders);
            if flags & inf::MACRO_FUSED_PREV != 0 {
                self.fe.instruction_queue.pop_front();
                self.insts[inst as usize].removed_from_iq = clock;
                continue;
            }
            if predecoded(self, inst)? + cfg.predecode_decode_delay > clock {
                break;
            }
            if !uops_list.is_empty() && flags & inf::COMPLEX_DECODER != 0 {
                break;
            }
            if flags & inf::MACRO_FUSIBLE != 0 {
                if !cfg.macro_fusible_instr_can_be_decoded_as_last_instr && n_decoded_instrs == cfg.n_decoders - 1 {
                    break;
                }
                if self.fe.instruction_queue.len() <= 1 || predecoded(self, self.fe.instruction_queue[1])? + cfg.predecode_decode_delay > clock {
                    break;
                }
            }
            self.fe.instruction_queue.pop_front();
            self.insts[inst as usize].removed_from_iq = clock;

            let (first_uop, n_uops) = (self.insts[inst as usize].first_uop, self.insts[inst as usize].n_uops);
            let n_mite = (uops_mite.max(0) as u32).min(n_uops);
            if uops_mite != 0 {
                for lam in first_uop..first_uop + n_mite {
                    uops_list.push((inst, lam));
                    self.lams[lam as usize].uop_source = Some(UopSource::Mite);
                }
            } else {
                uops_list.push((inst, NONE));
            }

            if uops_ms != 0 {
                self.ms_add_uops((first_uop + n_mite, n_uops - n_mite), UopSource::Mite);
                break;
            }

            if flags & inf::COMPLEX_DECODER != 0 {
                let Some(n) = n_available_simple_decoders else {
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
            if flags & (inf::BRANCH | inf::MACRO_FUSED_NEXT) != 0 {
                break;
            }
        }
        Ok(())
    }

    // ---- PreDecoder ----

    /// `PreDecoder.cycle`
    fn pre_decoder_cycle(&mut self, clock: i64) {
        let cfg = self.cfg;
        let block_size = cfg.pre_decode_block_size;
        if self.fe.predec_stalled == 0 {
            if self.fe.pre_dec_queue.is_empty()
                && (!self.fe.b16_block_lens.is_empty() || self.fe.partial_instr_i != NONE)
                && self.fe.instruction_queue.len() as i64 + cfg.pre_decode_width <= cfg.iq_width
            {
                if self.fe.partial_instr_i != NONE {
                    self.fe.pre_dec_queue.push(self.fe.partial_instr_i);
                    self.fe.partial_instr_i = NONE;
                }

                if self.fe.cur_block.is_empty() {
                    if (self.fe.b16_block_lens.len() as i64) < block_size / 16 {
                        return;
                    }
                    for _ in 0..block_size / 16 {
                        let n = self.fe.b16_block_lens.pop_front().unwrap();
                        for _ in 0..n {
                            let ii = self.fe.b16_entries.pop_front().unwrap();
                            self.fe.cur_block.push_back(ii);
                        }
                    }
                    let lcp: i64 = self.fe.cur_block.iter().filter(|&&ii| self.prep.info[self.inst_instr(ii)].has(inf::LCP_STALL)).count() as i64 * 3;
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
                        let offset_of_nominal_opcode = self.inst_addr(inst).rem_euclid(16) + self.prep.info[self.inst_instr(inst)].pos_nominal_opcode;
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
                    self.insts[inst as usize].predecoded = clock;
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
                self.fused[fused as usize].unfused_uops().all(|u| self.uops[u as usize].executed < clock as f64);
            if all_executed {
                self.rob.pop_front();
                self.retire_queue.push_back(fused);
                self.fused[fused as usize].retired = clock;
                self.fused[fused as usize].retire_idx = n_retired_in_same_cycle;
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
                if !self.prep.props[uop.prop as usize].has(pf::HAS_PORTS) || uop.eliminated {
                    uop.executed = clock as f64;
                }
            }
        }
    }
}
