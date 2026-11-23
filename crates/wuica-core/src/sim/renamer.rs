//! `Renamer`, `StoreBufferEntry`, and `AbstractValueGenerator` (from `utils.py`).

use super::prep::{inf, pf, AvKind, Key, MemAddrInfo, KEY_NONE, NONE};
use super::{crash, FxHashMap, InitPolicy, RenamedOperand, SFused, SLam, Sim, SimError, READY_UNSET, UNSET};
use crate::config::Slots;

/// `AbstractValue`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct AbstractValue {
    base: u32,
    offset: i64,
}

/// (base, index, scale, disp)
pub(crate) type AbstractAddress = (Option<AbstractValue>, Option<AbstractValue>, Option<i64>, Option<i64>);

/// The abstract addresses (the keys of `storeBufferEntryDict` and `memValueDict`), interned: each distinct key (including
/// `None`) gets a number, and the two dicts become arrays indexed by it. They are only looked up, never iterated.
#[derive(Default)]
pub(crate) struct AddressTable {
    ids: FxHashMap<Option<AbstractAddress>, u32>,
    /// id -> abstract address
    pub values: Vec<Option<AbstractAddress>>,
    /// id -> `storeBufferEntryDict[key]` (NONE if not in the dict)
    sbe: Vec<u32>,
    /// id -> `memValueDict[key]`: (width, abstract value)
    mem_value: Vec<Option<(i64, AbstractValue)>>,
    /// for each address expression (`Prep::mem_addrs`, and one more for none), the last key computed for it and its id (NONE:
    /// none yet): the key of an expression only changes when one of its registers gets a new abstract value
    last: Vec<(Option<AbstractAddress>, u32)>,
}

impl AddressTable {
    fn new(n_mem_addrs: usize) -> AddressTable {
        AddressTable { last: vec![(None, NONE); n_mem_addrs + 1], ..Default::default() }
    }

    /// [`AddressTable::intern`] of the key of the address expression `site` (NONE: none)
    #[inline]
    fn intern_at(&mut self, site: u32, key: Option<AbstractAddress>) -> u32 {
        let slot = (site as usize).min(self.last.len() - 1);
        let (k, id) = self.last[slot];
        if id != NONE && k == key {
            return id;
        }
        let id = self.intern(key);
        self.last[slot] = (key, id);
        id
    }

    fn intern(&mut self, key: Option<AbstractAddress>) -> u32 {
        let next = self.values.len() as u32;
        let id = *self.ids.entry(key).or_insert(next);
        if id == next {
            self.values.push(key);
            self.sbe.push(NONE);
            self.mem_value.push(None);
        }
        id
    }
}

/// `StoreBufferEntry`
pub(crate) struct StoreBufferEntry {
    /// the abstract address: an id of `Renamer::addrs`
    pub abstract_address: u32,
    /// uops that write to this entry
    pub uops: SmallU32List,
    pub address_ready_cycle: Option<i64>,
    pub data_ready_cycle: Option<i64>,
    /// width of the store (bits)
    pub width: Option<i64>,
    pub renamable: bool,
}

/// A list of `u32` that stores its first elements inline.
#[derive(Default, Clone)]
pub(crate) struct SmallU32List {
    len: u32,
    inline: [u32; 4],
    spill: Vec<u32>,
}

impl SmallU32List {
    pub fn push(&mut self, x: u32) {
        if (self.len as usize) < self.inline.len() {
            self.inline[self.len as usize] = x;
        } else {
            self.spill.push(x);
        }
        self.len += 1;
    }

    pub fn len(&self) -> usize {
        self.len as usize
    }

    pub fn get(&self, i: usize) -> u32 {
        if i < self.inline.len() {
            self.inline[i]
        } else {
            self.spill[i - self.inline.len()]
        }
    }
}

/// A small ordered list of keys (a value of `multiUseGPRDict`/`multiUseSIMDDict`) that stores up to 6 keys inline.
#[derive(Default, Clone)]
pub(crate) struct SmallKeys {
    len: u32,
    spilled: bool,
    inline: [Key; 6],
    heap: Vec<Key>,
}

impl SmallKeys {
    pub fn as_slice(&self) -> &[Key] {
        if self.spilled {
            &self.heap
        } else {
            &self.inline[..self.len as usize]
        }
    }

    pub fn len(&self) -> usize {
        self.len as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn push(&mut self, k: Key) {
        if self.spilled {
            self.heap.push(k);
        } else if (self.len as usize) < self.inline.len() {
            self.inline[self.len as usize] = k;
        } else {
            self.heap.extend_from_slice(&self.inline);
            self.heap.push(k);
            self.spilled = true;
        }
        self.len += 1;
    }

    pub fn retain(&mut self, f: impl Fn(&Key) -> bool) {
        if self.spilled {
            self.heap.retain(|k| f(k));
            self.len = self.heap.len() as u32;
        } else {
            let mut n = 0;
            for i in 0..self.len as usize {
                let k = self.inline[i];
                if f(&k) {
                    self.inline[n] = k;
                    n += 1;
                }
            }
            self.len = n as u32;
        }
    }

    /// removes the element at `pos`, keeping the order
    pub fn remove(&mut self, pos: usize) {
        if self.spilled {
            self.heap.remove(pos);
        } else {
            let n = self.len as usize;
            assert!(pos < n);
            self.inline.copy_within(pos + 1..n, pos);
        }
        self.len -= 1;
    }
}

/// `RenameDictEntry`
#[derive(Clone, Copy)]
struct RenameDictEntry {
    renamed_op: u32,
    renamed_by_elim_32bit_move: bool,
}

/// `AbstractValueGenerator`
struct AbstractValueGenerator {
    init_policy: InitPolicy,
    load_value_numbering: bool,
    // (memValueDict is in Renamer::addrs)
    next_base: u32,
    init_value: AbstractValue,
    abstract_value_dict: Vec<Option<AbstractValue>>,
    cur_instr_rnd_abstract_value_dict: Vec<(Key, AbstractValue)>,
}

impl AbstractValueGenerator {
    fn generate_fresh_abstract_value(&mut self) -> AbstractValue {
        let v = AbstractValue { base: self.next_base, offset: 0 };
        self.next_base += 1;
        v
    }

    /// `getAbstractValueForReg` for a register (key of the canonical register)
    fn get_abstract_value_for_reg(&mut self, key: Key) -> AbstractValue {
        if let Some(v) = self.abstract_value_dict[key as usize] {
            return v;
        }
        let v = if self.init_policy == InitPolicy::Diff { self.generate_fresh_abstract_value() } else { self.init_value };
        self.abstract_value_dict[key as usize] = Some(v);
        v
    }

    /// `getAddressKey`
    fn get_address_key(&mut self, m: &MemAddrInfo) -> AbstractAddress {
        let base = m.base.map(|k| self.get_abstract_value_for_reg(k));
        let index = m.index.map(|k| self.get_abstract_value_for_reg(k));
        (base, index, m.scale, m.disp)
    }

    fn finish_cur_instr(&mut self) {
        for &(k, v) in &self.cur_instr_rnd_abstract_value_dict {
            self.abstract_value_dict[k as usize] = Some(v);
        }
        self.cur_instr_rnd_abstract_value_dict.clear();
    }
}

pub(crate) struct Renamer {
    abs_val_gen: AbstractValueGenerator,
    rename_dict: Vec<Option<RenameDictEntry>>,
    // renamed operands written by the current instruction
    cur_instr_rnd_rename_dict: Vec<(Key, RenameDictEntry)>,
    cur_instr_pseudo_op_dict: Vec<(u32, u32)>,
    n_gpr_move_elim_in_cycle: CycleCounter,
    /// renamed operand -> registers
    multi_use_gpr_dict: Vec<(u32, SmallKeys)>,
    multi_use_gpr_dict_use_in_cycle: CycleCounter,
    n_simd_move_elim_in_cycle: CycleCounter,
    multi_use_simd_dict: Vec<(u32, SmallKeys)>,
    multi_use_simd_dict_use_in_cycle: CycleCounter,
    renamer_active_cycle: i64,
    cur_store_buffer_entry: u32,
    /// the abstract addresses, with `storeBufferEntryDict` and `memValueDict`
    pub addrs: AddressTable,
    /// register -> width of the operation if its value was computed by the renamer
    folded_width: Vec<Option<i64>>,
    cur_instr_folded_width: Vec<(Key, i64)>,
    /// last uop for which register merge uops were issued
    last_reg_merge_issued: u32,
    pub sbes: Vec<StoreBufferEntry>,
}

impl Renamer {
    /// `window`: `moveEliminationPipelineLength`
    /// `n_mem_addrs`: the number of address expressions (`Prep::mem_addrs`)
    pub fn new(init_policy: InitPolicy, load_value_numbering: bool, n_keys: usize, window: i64, n_mem_addrs: usize) -> Renamer {
        let mut g = AbstractValueGenerator {
            init_policy,
            load_value_numbering,
            next_base: 0,
            init_value: AbstractValue { base: 0, offset: 0 },
            abstract_value_dict: vec![None; n_keys],
            cur_instr_rnd_abstract_value_dict: Vec::new(),
        };
        g.init_value = g.generate_fresh_abstract_value();
        Renamer {
            abs_val_gen: g,
            rename_dict: vec![None; n_keys],
            cur_instr_rnd_rename_dict: Vec::new(),
            cur_instr_pseudo_op_dict: Vec::new(),
            n_gpr_move_elim_in_cycle: CycleCounter::new(window),
            multi_use_gpr_dict: Vec::new(),
            multi_use_gpr_dict_use_in_cycle: CycleCounter::new(window),
            n_simd_move_elim_in_cycle: CycleCounter::new(window),
            multi_use_simd_dict: Vec::new(),
            multi_use_simd_dict_use_in_cycle: CycleCounter::new(window),
            renamer_active_cycle: 0,
            cur_store_buffer_entry: NONE,
            addrs: AddressTable::new(n_mem_addrs),
            folded_width: vec![None; n_keys],
            cur_instr_folded_width: Vec::new(),
            last_reg_merge_issued: NONE,
            sbes: Vec::new(),
        }
    }
}

/// A per-cycle counter of the renamer (`nGPRMoveElimInCycle` etc.): one value for each of the cycles 0, 1, ... (cycle 0 is 0),
/// of which only the last `window` are read (`moveEliminationPipelineLength`): they are kept in a ring (all of them if the
/// window is large).
struct CycleCounter {
    ring: Vec<i64>,
    /// the length of the ring; 0: no ring, `ring` holds all values
    len: i64,
    /// the number of values pushed (the cycle of the next value)
    n: i64,
}

impl CycleCounter {
    fn new(window: i64) -> CycleCounter {
        // (a power of two, so that the position is a mask)
        let len = if window <= 4096 { (window.max(1) as u64).next_power_of_two() as i64 } else { 0 };
        let mut c = CycleCounter { ring: vec![0; len as usize], len, n: 0 };
        c.push(0);
        c
    }

    fn push(&mut self, v: i64) {
        if self.len == 0 {
            self.ring.push(v);
        } else {
            self.ring[(self.n & (self.len - 1)) as usize] = v;
        }
        self.n += 1;
    }

    /// `d.get(cycle, 0)`, for cycles in the window `n - window .. n`; 0 for cycles that are not set yet or negative
    #[inline]
    fn get_or_0(&self, cycle: i64) -> i64 {
        if cycle < 0 || cycle >= self.n {
            0
        } else if self.len == 0 {
            self.ring[cycle as usize]
        } else {
            debug_assert!(cycle >= self.n - self.len);
            self.ring[(cycle & (self.len - 1)) as usize]
        }
    }
}

/// `d[key] = value` for the small insertion-ordered dicts
fn dict_set<K: PartialEq, V>(d: &mut Vec<(K, V)>, key: K, value: V) {
    match d.iter_mut().find(|e| e.0 == key) {
        Some(e) => e.1 = value,
        None => d.push((key, value)),
    }
}

impl<'a> Sim<'a> {
    fn new_renamed_operand(&mut self, uop: u32, ready: i64, lat: i64) -> u32 {
        self.ren_ops.push(RenamedOperand { uop, ready, lat });
        (self.ren_ops.len() - 1) as u32
    }

    /// `renameDict.setdefault(key, RenameDictEntry(RenamedOperand(ready=-1), False))`
    fn rename_dict_setdefault(&mut self, key: Key) -> RenameDictEntry {
        if let Some(e) = self.rn.rename_dict[key as usize] {
            return e;
        }
        let r = self.new_renamed_operand(NONE, -1, 1);
        let e = RenameDictEntry { renamed_op: r, renamed_by_elim_32bit_move: false };
        self.rn.rename_dict[key as usize] = Some(e);
        e
    }

    /// `AbstractValueGenerator.__computeAbstractValue`
    fn compute_abstract_value(&mut self, instr: usize) -> AbstractValue {
        let info = &self.prep.info[instr];
        let g = &mut self.rn.abs_val_gen;
        if g.load_value_numbering && info.has(inf::HAS_INPUT_MEM) && !info.has(inf::HAS_OUTPUT_MEM) {
            if let (Some(width), Some(mem)) = (info.mov_load_width, self.prep.mem_addr(info.in_mem0)) {
                let id = self.rn.addrs.intern_at(info.in_mem0, Some(g.get_address_key(mem)));
                if self.rn.addrs.mem_value[id as usize].map(|v| v.0) != Some(width) {
                    let fresh = g.generate_fresh_abstract_value();
                    self.rn.addrs.mem_value[id as usize] = Some((width, fresh));
                }
                return self.rn.addrs.mem_value[id as usize].unwrap().1;
            }
        }
        if let Some(in_reg0) = info.in_reg0 {
            let abs_val = g.get_abstract_value_for_reg(in_reg0);
            match info.av_kind {
                AvKind::Copy => abs_val,
                AvKind::Add(imm) => AbstractValue { base: abs_val.base, offset: abs_val.offset.wrapping_add(imm) },
                AvKind::Sub(imm) => AbstractValue { base: abs_val.base, offset: abs_val.offset.wrapping_sub(imm) },
                AvKind::Inc => AbstractValue { base: abs_val.base, offset: abs_val.offset.wrapping_add(1) },
                AvKind::Dec => AbstractValue { base: abs_val.base, offset: abs_val.offset.wrapping_sub(1) },
                AvKind::Fresh => g.generate_fresh_abstract_value(),
            }
        } else {
            g.generate_fresh_abstract_value()
        }
    }

    /// `AbstractValueGenerator.setAbstractValueForCurInstr`
    fn set_abstract_value_for_cur_instr(&mut self, key: Key, instr: usize) {
        let v = self.compute_abstract_value(instr);
        dict_set(&mut self.rn.abs_val_gen.cur_instr_rnd_abstract_value_dict, key, v);
    }

    /// `Renamer.getStoreBufferKey`, interned
    /// (`site`: the index of `mem_addr` in `Prep::mem_addrs`, or NONE)
    fn get_store_buffer_key(&mut self, site: u32, mem_addr: Option<&MemAddrInfo>) -> u32 {
        let key = mem_addr.map(|m| self.rn.abs_val_gen.get_address_key(m));
        self.rn.addrs.intern_at(site, key)
    }

    /// `Renamer.cycle`: writes the fused uops that are issued in this cycle to `renamer_uops` (which must be empty)
    pub(crate) fn renamer_cycle(&mut self, renamer_uops: &mut Vec<u32>) -> Result<(), SimError> {
        let cfg = self.cfg;
        self.rn.renamer_active_cycle += 1;
        let active_cycle = self.rn.renamer_active_cycle;

        debug_assert!(renamer_uops.is_empty());
        while let Some(&lam) = self.idq.front() {
            let first_unfused_uop = self.lams[lam as usize].first_uop;
            let prop = &self.prep.props[self.uops[first_unfused_uop as usize].prop as usize];
            let (flags, ii) = (prop.flags, prop.instr as usize);
            if flags & pf::FIRST_MERGE != 0 {
                let (first_merge_prop, n_merge_props) = (self.prep.info[ii].first_merge_prop, self.prep.info[ii].n_merge_props);
                if !renamer_uops.is_empty() {
                    break;
                }
                if self.rn.last_reg_merge_issued != first_unfused_uop {
                    let inst = self.uops[first_unfused_uop as usize].instr_instance;
                    for merge_prop in first_merge_prop..first_merge_prop + n_merge_props {
                        let u = self.new_uop(merge_prop, inst);
                        let merge_lam = self.lams.len() as u32;
                        let merge_uop = self.fused.len() as u32;
                        self.fused.push(SFused { first_uop: u, n_uops: 1, laminated_uop: merge_lam, issued: UNSET, retired: UNSET, retire_idx: UNSET });
                        self.uops[u as usize].fused_uop = merge_uop;
                        renamer_uops.push(merge_uop);
                        self.lams.push(SLam {
                            first_fused_uop: merge_uop,
                            n_fused_uops: 1,
                            first_uop: u,
                            n_uops: 1,
                            added_to_idq: UNSET,
                            uop_source: None,
                        });
                        self.reg_merge_uops.push((inst, merge_lam));
                    }
                    self.rn.last_reg_merge_issued = first_unfused_uop;
                    break;
                }
            }

            if flags & pf::FIRST_SERIALIZING != 0 && !self.rob.is_empty() {
                break;
            }
            let fused_uops = self.lams[lam as usize].fused_uops();
            if renamer_uops.len() as i64 + fused_uops.len() as i64 > cfg.issue_width {
                break;
            }
            renamer_uops.extend(fused_uops);
            self.idq.pop_front();
        }

        let mut n_gpr_move_elim: i64 = 0;
        let mut n_simd_move_elim: i64 = 0;
        let pipeline_length = cfg.move_elimination_pipeline_length;

        for &fused in renamer_uops.iter() {
            for u in self.fused[fused as usize].unfused_uops() {
                let prop = &self.prep.props[self.uops[u as usize].prop as usize];
                let ii = prop.instr as usize;
                if prop.has(pf::ELIM_CANDIDATE) {
                    let Some(canonical_inp_reg) = self.prep.info[ii].in_reg0 else {
                        return Err(crash("IndexError: list index out of range (inputRegOperands)"));
                    };
                    let key_info = &self.prep.keys.info[canonical_inp_reg as usize];
                    if key_info.is_gpr {
                        let n_possible = match &cfg.move_elimination_gpr_slots {
                            Slots::Unlimited(_) => 1,
                            Slots::Limited(slots) => {
                                slots
                                    - n_gpr_move_elim
                                    - (1..pipeline_length).map(|i| self.rn.n_gpr_move_elim_in_cycle.get_or_0(active_cycle - i)).sum::<i64>()
                                    - self.rn.multi_use_gpr_dict_use_in_cycle.get_or_0(active_cycle - pipeline_length)
                            }
                        };
                        if n_possible > 0 {
                            self.uops[u as usize].eliminated = true;
                            n_gpr_move_elim += 1;
                        }
                    } else if key_info.has_mm {
                        let n_possible = match &cfg.move_elimination_simd_slots {
                            Slots::Unlimited(_) => 1,
                            Slots::Limited(slots) => {
                                slots
                                    - n_simd_move_elim
                                    - (1..pipeline_length).map(|i| self.rn.n_simd_move_elim_in_cycle.get_or_0(active_cycle - i)).sum::<i64>()
                                    - self.rn.multi_use_simd_dict_use_in_cycle.get_or_0(active_cycle - pipeline_length)
                            }
                        };
                        if n_possible > 0 {
                            self.uops[u as usize].eliminated = true;
                            n_simd_move_elim += 1;
                        }
                    }
                }
            }
        }

        if n_gpr_move_elim == 0 && !cfg.move_elimination_gpr_all_aliases_must_be_overwritten {
            self.rn.multi_use_gpr_dict.retain(|e| e.1.len() > 1);
        }
        if n_simd_move_elim == 0 {
            self.rn.multi_use_simd_dict.retain(|e| e.1.len() > 1);
        }

        for &fused in renamer_uops.iter() {
            for u in self.fused[fused as usize].unfused_uops() {
                self.rename_uop(u)?;
            }
        }

        self.rn.n_gpr_move_elim_in_cycle.push(n_gpr_move_elim);
        self.rn.n_simd_move_elim_in_cycle.push(n_simd_move_elim);

        self.rn.multi_use_gpr_dict.retain(|e| !e.1.is_empty());
        let n = self.rn.multi_use_gpr_dict.len() as i64;
        self.rn.multi_use_gpr_dict_use_in_cycle.push(n);

        self.rn.multi_use_simd_dict.retain(|e| !e.1.is_empty());
        let n = self.rn.multi_use_simd_dict.len() as i64;
        self.rn.multi_use_simd_dict_use_in_cycle.push(n);

        Ok(())
    }

    /// the body of the second loop over the uops in `Renamer.cycle`
    fn rename_uop(&mut self, u: u32) -> Result<(), SimError> {
        let cfg = self.cfg;
        let prop_id = self.uops[u as usize].prop as usize;
        let ii = self.prep.props[prop_id].instr as usize;
        let prop_flags = self.prep.props[prop_id].flags;

        if self.uops[u as usize].eliminated {
            let info = &self.prep.info[ii];
            let is_32bit_move = info.has(inf::OUT_REG0_IS_32);
            let canonical_inp_reg = info.in_reg0.ok_or_else(|| crash("IndexError: list index out of range (inputRegOperands)"))?;
            if info.out_regs.1 == 0 {
                return Err(crash("IndexError: list index out of range (outputRegOperands)"));
            }
            let canonical_out_reg = self.prep.out_reg_list[info.out_regs.0 as usize].0;
            let is_gpr = self.prep.keys.info[canonical_inp_reg as usize].is_gpr;

            let entry = self.rename_dict_setdefault(canonical_inp_reg);
            dict_set(
                &mut self.rn.cur_instr_rnd_rename_dict,
                canonical_out_reg,
                RenameDictEntry { renamed_op: entry.renamed_op, renamed_by_elim_32bit_move: is_32bit_move },
            );
            if let Some(w) = self.rn.folded_width[canonical_inp_reg as usize] {
                dict_set(&mut self.rn.cur_instr_folded_width, canonical_out_reg, w);
            }
            let cur_multi_use_dict = if is_gpr { &mut self.rn.multi_use_gpr_dict } else { &mut self.rn.multi_use_simd_dict };
            let pos = match cur_multi_use_dict.iter().position(|e| e.0 == entry.renamed_op) {
                Some(p) => p,
                None => {
                    cur_multi_use_dict.push((entry.renamed_op, SmallKeys::default()));
                    cur_multi_use_dict.len() - 1
                }
            };
            for k in [canonical_inp_reg, canonical_out_reg] {
                if !cur_multi_use_dict[pos].1.as_slice().contains(&k) {
                    cur_multi_use_dict[pos].1.push(k);
                }
            }
            self.set_abstract_value_for_cur_instr(canonical_out_reg, ii);
        } else if prop_flags & pf::RENAMED != 0 {
            let (is_store_addr, is_store_data, is_load, mem_addr_id) =
                (prop_flags & pf::STORE_ADDR != 0, prop_flags & pf::STORE_DATA != 0, prop_flags & pf::LOAD != 0, self.prep.props[prop_id].mem_addr);
            let mem_addr = self.prep.mem_addr(mem_addr_id).copied();
            let instr_mem_width = self.prep.info[ii].mem_width;
            if is_store_addr {
                let key = self.get_store_buffer_key(mem_addr_id, mem_addr.as_ref());
                let sbe_id = self.rn.sbes.len() as u32;
                let mut sbe = StoreBufferEntry {
                    abstract_address: key,
                    uops: SmallU32List::default(),
                    address_ready_cycle: None,
                    data_ready_cycle: None,
                    width: instr_mem_width,
                    renamable: true,
                };
                self.rn.cur_store_buffer_entry = sbe_id;
                self.rn.addrs.sbe[key as usize] = sbe_id;
                // recordStore
                if self.rn.abs_val_gen.load_value_numbering {
                    let info = &self.prep.info[ii];
                    match (info.mov_store_width, info.in_reg0) {
                        (Some(width), Some(in_reg0)) => {
                            let v = self.rn.abs_val_gen.get_abstract_value_for_reg(in_reg0);
                            self.rn.addrs.mem_value[key as usize] = Some((width, v));
                        }
                        _ => {
                            self.rn.addrs.mem_value[key as usize] = None;
                        }
                    }
                }
                if let Some(widths) = cfg.mem_renaming_widths.as_ref().filter(|w| !w.is_empty()) {
                    if !sbe.width.is_some_and(|w| widths.iter().any(|&x| x as i64 == w)) {
                        sbe.renamable = false;
                    }
                }
                if cfg.mem_renaming_folded_check {
                    if let Some(width) = sbe.width.filter(|&w| w != 0) {
                        let (s, n) = self.prep.info[ii].in_regs;
                        if self.prep.in_reg_list[s as usize..(s + n) as usize].iter().any(|&k| self.rn.folded_width[k as usize].unwrap_or(0) > width) {
                            sbe.renamable = false;
                        }
                    }
                }
                self.rn.sbes.push(sbe);
            }
            if is_store_addr || is_store_data {
                let sbe = self.rn.cur_store_buffer_entry;
                if sbe == NONE {
                    return Err(crash("AttributeError: 'NoneType' object has no attribute 'uops'"));
                }
                self.uops[u as usize].store_buffer_entry = sbe;
                self.rn.sbes[sbe as usize].uops.push(u);
            }
            if is_load {
                let key = self.get_store_buffer_key(mem_addr_id, mem_addr.as_ref());
                let Some(mem_addr) = mem_addr else {
                    return Err(crash("AttributeError: 'NoneType' object has no attribute 'get'"));
                };
                let base_entry = mem_addr.base.and_then(|k| self.rn.rename_dict[k as usize]);
                let instr_of = |sim: &Sim, e: Option<RenameDictEntry>| -> Option<usize> {
                    let uop = sim.ren_ops[e?.renamed_op as usize].uop;
                    if uop == NONE {
                        None
                    } else {
                        Some(sim.prep.props[sim.uops[uop as usize].prop as usize].instr as usize)
                    }
                };
                let base_instr = instr_of(self, base_entry);
                let index_entry = mem_addr.index.and_then(|k| self.rn.rename_dict[k as usize]);
                let index_instr = instr_of(self, index_entry);
                // latReducedDueToFastPtrChasing
                let lat_reduced = cfg.fast_pointer_chasing
                    && (0..2048).contains(&mem_addr.disp.unwrap_or(0))
                    && !base_entry.is_some_and(|e| e.renamed_by_elim_32bit_move)
                    && base_instr.is_some_and(|i| self.prep.info[i].has(inf::FAST_PTR_CHASING_SOURCE))
                    && (mem_addr.index.is_none() || index_instr.is_some_and(|i| self.prep.info[i].has(inf::NO_UOPS)));
                let sbe = self.rn.addrs.sbe[key as usize];
                let uop = &mut self.uops[u as usize];
                uop.lat_reduced_due_to_fast_ptr_chasing = lat_reduced;
                uop.store_buffer_entry = sbe;
                if sbe != NONE {
                    let sb = &self.rn.sbes[sbe as usize];
                    let load_width = instr_mem_width.unwrap_or(0);
                    if sb.width.is_some_and(|w| w != 0 && load_width > w) {
                        uop.forward_fails = true;
                    }
                    if cfg.mem_renaming_widths.as_ref().is_some_and(|w| !w.is_empty()) {
                        uop.mem_renaming_blocked = !sb.renamable || load_width > sb.width.unwrap_or(0);
                    }
                }
            }

            let ren_in_start = self.ren_lists.len() as u32;
            let (in_start, n_in) = self.prep.props[prop_id].in_keys;
            for i in in_start..in_start + n_in {
                let k = &self.prep.in_key_list[i as usize];
                let (op, is_pseudo, key) = (k.op, k.is_pseudo, k.key);
                let ren_op = if is_pseudo {
                    match self.rn.cur_instr_pseudo_op_dict.iter().find(|e| e.0 == op) {
                        Some(e) => e.1,
                        None => return Err(crash("KeyError: curInstrPseudoOpDict")),
                    }
                } else {
                    self.rename_dict_setdefault(key).renamed_op
                };
                self.ren_lists.push(ren_op);
            }
            let ren_out_start = self.ren_lists.len() as u32;
            // (at most 255 operands: checked in Prep::new)
            self.uops[u as usize].ren = ren_in_start;
            self.uops[u as usize].n_in = (ren_out_start - ren_in_start) as u8;
            let (out_start, n_out) = self.prep.props[prop_id].out_keys;
            for i in out_start..out_start + n_out {
                let k = &self.prep.out_key_list[i as usize];
                let (op, is_pseudo, key, is_reg, lat) = (k.op, k.is_pseudo, k.key, k.is_reg, k.lat);
                let ren_op = self.new_renamed_operand(u, READY_UNSET, lat);
                self.ren_lists.push(ren_op);
                if is_pseudo {
                    dict_set(&mut self.rn.cur_instr_pseudo_op_dict, op, ren_op);
                } else {
                    dict_set(&mut self.rn.cur_instr_rnd_rename_dict, key, RenameDictEntry { renamed_op: ren_op, renamed_by_elim_32bit_move: false });
                    if is_reg {
                        self.set_abstract_value_for_cur_instr(key, ii);
                    }
                }
            }
            self.uops[u as usize].n_out = (self.ren_lists.len() as u32 - ren_out_start) as u8;
        } else {
            // e.g., xor rax, rax
            let (out_start, n_out) = self.prep.info[ii].out_regs;
            for i in out_start..out_start + n_out {
                let (out_key, out_size) = self.prep.out_reg_list[i as usize];
                if let Some(folded_input_reg) = self.prep.info[ii].folded_input_reg {
                    // e.g., add rax, 1 on Golden Cove: the result is available as soon as the input is
                    let entry = self.rename_dict_setdefault(folded_input_reg);
                    dict_set(
                        &mut self.rn.cur_instr_rnd_rename_dict,
                        out_key,
                        RenameDictEntry { renamed_op: entry.renamed_op, renamed_by_elim_32bit_move: false },
                    );
                    dict_set(&mut self.rn.cur_instr_folded_width, out_key, out_size);
                    // the register has a new value (e.g., add r9, 1 changes the address of [rax+r9*4])
                    self.set_abstract_value_for_cur_instr(out_key, ii);
                    continue;
                }
                let r = self.new_renamed_operand(u, -1, 1);
                dict_set(&mut self.rn.cur_instr_rnd_rename_dict, out_key, RenameDictEntry { renamed_op: r, renamed_by_elim_32bit_move: false });
            }
        }

        if prop_flags & pf::ENDS_INSTR != 0 {
            let eliminated = self.uops[u as usize].eliminated;
            // (nothing to discard if both dicts are empty)
            let n_multi_use = self.rn.multi_use_gpr_dict.len() + self.rn.multi_use_simd_dict.len();
            for i in 0..if n_multi_use == 0 { 0 } else { self.rn.cur_instr_rnd_rename_dict.len() } {
                let (key, cur_entry) = self.rn.cur_instr_rnd_rename_dict[i];
                if let Some(prev) = self.rn.rename_dict[key as usize] {
                    let prev_ren_op = prev.renamed_op;
                    if !eliminated || prev_ren_op != cur_entry.renamed_op {
                        let key_info = &self.prep.keys.info[key as usize];
                        if key_info.is_gpr && self.rn.multi_use_gpr_dict.iter().any(|e| e.0 == prev_ren_op) {
                            // discard: a register whose value was computed by the renamer shares the renamed operand of its input
                            // without being an alias created by move elimination
                            let e = self.rn.multi_use_gpr_dict.iter_mut().find(|e| e.0 == prev_ren_op).unwrap();
                            e.1.retain(|&k| k != key);
                        } else if key != KEY_NONE && key_info.has_mm {
                            if let Some(e) = self.rn.multi_use_simd_dict.iter_mut().find(|e| e.0 == prev_ren_op) {
                                if !e.1.is_empty() {
                                    match e.1.as_slice().iter().position(|&k| k == key) {
                                        Some(p) => {
                                            e.1.remove(p);
                                        }
                                        None => return Err(crash("KeyError: multiUseSIMDDict")),
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // foldedWidth and renameDict.update(curInstrRndRenameDict) (independent for each key: one loop)
            let rn = &mut self.rn;
            for &(key, entry) in &rn.cur_instr_rnd_rename_dict {
                rn.folded_width[key as usize] = rn.cur_instr_folded_width.iter().find(|e| e.0 == key).map(|e| e.1);
                rn.rename_dict[key as usize] = Some(entry);
            }
            rn.cur_instr_folded_width.clear();
            self.rn.abs_val_gen.finish_cur_instr();
            self.rn.cur_instr_rnd_rename_dict.clear();
            self.rn.cur_instr_pseudo_op_dict.clear();
        }
        Ok(())
    }
}
