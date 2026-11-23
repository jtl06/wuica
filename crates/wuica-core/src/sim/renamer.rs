//! `Renamer`, `StoreBufferEntry`, and `AbstractValueGenerator` (from `utils.py`).

use super::prep::{AvKind, Key, MemAddrInfo, KEY_NONE, NONE};
use super::{crash, FusedUop, InitPolicy, LaminatedUop, RenamedOperand, Sim, SimError, READY_UNSET};
use crate::config::Slots;
use std::collections::HashMap;

/// `AbstractValue`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct AbstractValue {
    base: u32,
    offset: i64,
}

/// (base, index, scale, disp)
pub(crate) type AbstractAddress = (Option<AbstractValue>, Option<AbstractValue>, Option<i64>, Option<i64>);

/// `StoreBufferEntry`
pub(crate) struct StoreBufferEntry {
    pub abstract_address: Option<AbstractAddress>,
    /// uops that write to this entry
    pub uops: Vec<u32>,
    pub address_ready_cycle: Option<i64>,
    pub data_ready_cycle: Option<i64>,
    /// width of the store (bits)
    pub width: Option<i64>,
    pub renamable: bool,
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
    /// abstract address -> (width, abstract value)
    mem_value_dict: HashMap<Option<AbstractAddress>, (i64, AbstractValue)>,
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
    n_gpr_move_elim_in_cycle: Vec<i64>,
    /// renamed operand -> registers
    multi_use_gpr_dict: Vec<(u32, Vec<Key>)>,
    multi_use_gpr_dict_use_in_cycle: Vec<i64>,
    n_simd_move_elim_in_cycle: Vec<i64>,
    multi_use_simd_dict: Vec<(u32, Vec<Key>)>,
    multi_use_simd_dict_use_in_cycle: Vec<i64>,
    renamer_active_cycle: i64,
    cur_store_buffer_entry: u32,
    store_buffer_entry_dict: HashMap<Option<AbstractAddress>, u32>,
    /// register -> width of the operation if its value was computed by the renamer
    folded_width: Vec<Option<i64>>,
    cur_instr_folded_width: Vec<(Key, i64)>,
    /// last uop for which register merge uops were issued
    last_reg_merge_issued: u32,
    pub sbes: Vec<StoreBufferEntry>,
}

impl Renamer {
    pub fn new(init_policy: InitPolicy, load_value_numbering: bool, n_keys: usize) -> Renamer {
        let mut g = AbstractValueGenerator {
            init_policy,
            load_value_numbering,
            mem_value_dict: HashMap::new(),
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
            n_gpr_move_elim_in_cycle: vec![0],
            multi_use_gpr_dict: Vec::new(),
            multi_use_gpr_dict_use_in_cycle: vec![0],
            n_simd_move_elim_in_cycle: vec![0],
            multi_use_simd_dict: Vec::new(),
            multi_use_simd_dict_use_in_cycle: vec![0],
            renamer_active_cycle: 0,
            cur_store_buffer_entry: NONE,
            store_buffer_entry_dict: HashMap::new(),
            folded_width: vec![None; n_keys],
            cur_instr_folded_width: Vec::new(),
            last_reg_merge_issued: NONE,
            sbes: Vec::new(),
        }
    }
}

/// `d.get(cycle, 0)` for the per-cycle counters
fn get_or_0(v: &[i64], cycle: i64) -> i64 {
    if cycle >= 0 {
        v.get(cycle as usize).copied().unwrap_or(0)
    } else {
        0
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
        if g.load_value_numbering && info.has_input_mem && !info.has_output_mem {
            if let (Some(width), Some(mem)) = (info.mov_load_width, info.in_mem0.as_ref()) {
                let key = Some(g.get_address_key(mem));
                if g.mem_value_dict.get(&key).map(|v| v.0) != Some(width) {
                    let fresh = g.generate_fresh_abstract_value();
                    g.mem_value_dict.insert(key, (width, fresh));
                }
                return g.mem_value_dict[&key].1;
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

    /// `Renamer.getStoreBufferKey`
    fn get_store_buffer_key(&mut self, mem_addr: &Option<MemAddrInfo>) -> Option<AbstractAddress> {
        mem_addr.as_ref().map(|m| self.rn.abs_val_gen.get_address_key(m))
    }

    /// `Renamer.cycle`: returns the fused uops that are issued in this cycle
    pub(crate) fn renamer_cycle(&mut self) -> Result<Vec<u32>, SimError> {
        let cfg = self.cfg;
        self.rn.renamer_active_cycle += 1;
        let active_cycle = self.rn.renamer_active_cycle;

        let mut renamer_uops: Vec<u32> = Vec::new();
        while let Some(&lam) = self.idq.front() {
            let first_unfused_uop = self.lams[lam as usize].first_uop;
            let prop = &self.prep.props[self.uops[first_unfused_uop as usize].prop as usize];
            let (is_first, ii) = (prop.is_first, prop.instr as usize);
            let (first_merge_prop, n_merge_props) = (self.prep.info[ii].first_merge_prop, self.prep.info[ii].n_merge_props);
            if is_first && n_merge_props > 0 {
                if !renamer_uops.is_empty() {
                    break;
                }
                if self.rn.last_reg_merge_issued != first_unfused_uop {
                    let inst = self.uops[first_unfused_uop as usize].instr_instance;
                    for merge_prop in first_merge_prop..first_merge_prop + n_merge_props {
                        let u = self.new_uop(merge_prop, inst);
                        let merge_lam = self.lams.len() as u32;
                        let merge_uop = self.fused.len() as u32;
                        self.fused.push(FusedUop { first_uop: u, n_uops: 1, laminated_uop: merge_lam, issued: None, retired: None, retire_idx: None });
                        self.uops[u as usize].fused_uop = merge_uop;
                        renamer_uops.push(merge_uop);
                        self.lams.push(LaminatedUop {
                            first_fused_uop: merge_uop,
                            n_fused_uops: 1,
                            first_uop: u,
                            n_uops: 1,
                            added_to_idq: None,
                            uop_source: None,
                        });
                        self.insts[inst as usize].reg_merge_uops.push(merge_lam);
                    }
                    self.rn.last_reg_merge_issued = first_unfused_uop;
                    break;
                }
            }

            if is_first && self.instrs[ii].is_serializing_instr && !self.rob.is_empty() {
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

        for &fused in &renamer_uops {
            for u in self.fused[fused as usize].unfused_uops() {
                let prop = &self.prep.props[self.uops[u as usize].prop as usize];
                let ii = prop.instr as usize;
                if self.instrs[ii].may_be_eliminated && !prop.is_reg_merge && !prop.is_stack_sync {
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
                                    - (1..pipeline_length).map(|i| get_or_0(&self.rn.n_gpr_move_elim_in_cycle, active_cycle - i)).sum::<i64>()
                                    - get_or_0(&self.rn.multi_use_gpr_dict_use_in_cycle, active_cycle - pipeline_length)
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
                                    - (1..pipeline_length).map(|i| get_or_0(&self.rn.n_simd_move_elim_in_cycle, active_cycle - i)).sum::<i64>()
                                    - get_or_0(&self.rn.multi_use_simd_dict_use_in_cycle, active_cycle - pipeline_length)
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

        for &fused in &renamer_uops {
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

        Ok(renamer_uops)
    }

    /// the body of the second loop over the uops in `Renamer.cycle`
    fn rename_uop(&mut self, u: u32) -> Result<(), SimError> {
        let cfg = self.cfg;
        let prop_id = self.uops[u as usize].prop as usize;
        let ii = self.prep.props[prop_id].instr as usize;
        let is_stack_sync = self.prep.props[prop_id].is_stack_sync;

        if self.uops[u as usize].eliminated {
            let info = &self.prep.info[ii];
            let is_32bit_move = info.out_reg0_is_32;
            let canonical_inp_reg = info.in_reg0.ok_or_else(|| crash("IndexError: list index out of range (inputRegOperands)"))?;
            let canonical_out_reg = info.out_regs.first().ok_or_else(|| crash("IndexError: list index out of range (outputRegOperands)"))?.0;
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
                    cur_multi_use_dict.push((entry.renamed_op, Vec::new()));
                    cur_multi_use_dict.len() - 1
                }
            };
            for k in [canonical_inp_reg, canonical_out_reg] {
                if !cur_multi_use_dict[pos].1.contains(&k) {
                    cur_multi_use_dict[pos].1.push(k);
                }
            }
            self.set_abstract_value_for_cur_instr(canonical_out_reg, ii);
        } else if self.instrs[ii].uops != 0 || is_stack_sync {
            let (is_store_addr, is_store_data, is_load, mem_addr) = {
                let p = &self.prep.props[prop_id];
                (p.is_store_addr, p.is_store_data, p.is_load, p.mem_addr)
            };
            let instr_mem_width = self.prep.info[ii].mem_width;
            if is_store_addr {
                let key = self.get_store_buffer_key(&mem_addr);
                let sbe_id = self.rn.sbes.len() as u32;
                let mut sbe = StoreBufferEntry {
                    abstract_address: key,
                    uops: Vec::new(),
                    address_ready_cycle: None,
                    data_ready_cycle: None,
                    width: instr_mem_width,
                    renamable: true,
                };
                self.rn.cur_store_buffer_entry = sbe_id;
                self.rn.store_buffer_entry_dict.insert(key, sbe_id);
                // recordStore
                if self.rn.abs_val_gen.load_value_numbering {
                    let info = &self.prep.info[ii];
                    match (info.mov_store_width, info.in_reg0) {
                        (Some(width), Some(in_reg0)) => {
                            let v = self.rn.abs_val_gen.get_abstract_value_for_reg(in_reg0);
                            self.rn.abs_val_gen.mem_value_dict.insert(key, (width, v));
                        }
                        _ => {
                            self.rn.abs_val_gen.mem_value_dict.remove(&key);
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
                        if self.prep.info[ii].in_regs.iter().any(|&k| self.rn.folded_width[k as usize].unwrap_or(0) > width) {
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
                let key = self.get_store_buffer_key(&mem_addr);
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
                    && base_instr.is_some_and(|i| self.prep.info[i].fast_ptr_chasing_source)
                    && (mem_addr.index.is_none() || index_instr.is_some_and(|i| self.instrs[i].uops == 0));
                let sbe = self.rn.store_buffer_entry_dict.get(&key).copied().unwrap_or(NONE);
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
            for i in 0..self.prep.props[prop_id].in_keys.len() {
                let k = &self.prep.props[prop_id].in_keys[i];
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
            self.uops[u as usize].ren_in = (ren_in_start, ren_out_start - ren_in_start);
            for i in 0..self.prep.props[prop_id].out_keys.len() {
                let k = &self.prep.props[prop_id].out_keys[i];
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
            self.uops[u as usize].ren_out = (ren_out_start, self.ren_lists.len() as u32 - ren_out_start);
        } else {
            // e.g., xor rax, rax
            for i in 0..self.prep.info[ii].out_regs.len() {
                let (out_key, out_size) = self.prep.info[ii].out_regs[i];
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

        let prop = &self.prep.props[prop_id];
        if prop.is_last || prop.is_reg_merge || is_stack_sync {
            let eliminated = self.uops[u as usize].eliminated;
            for i in 0..self.rn.cur_instr_rnd_rename_dict.len() {
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
                                    match e.1.iter().position(|&k| k == key) {
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

            for i in 0..self.rn.cur_instr_rnd_rename_dict.len() {
                let key = self.rn.cur_instr_rnd_rename_dict[i].0;
                self.rn.folded_width[key as usize] = self.rn.cur_instr_folded_width.iter().find(|e| e.0 == key).map(|e| e.1);
            }
            self.rn.cur_instr_folded_width.clear();
            for i in 0..self.rn.cur_instr_rnd_rename_dict.len() {
                let (key, entry) = self.rn.cur_instr_rnd_rename_dict[i];
                self.rn.rename_dict[key as usize] = Some(entry);
            }
            self.rn.abs_val_gen.finish_cur_instr();
            self.rn.cur_instr_rnd_rename_dict.clear();
            self.rn.cur_instr_pseudo_op_dict.clear();
        }
        Ok(())
    }
}
