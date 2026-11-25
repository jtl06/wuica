"""The deliberate breaks of the round-11 mechanisms: name -> (file, old, new, mechanisms of the reviewer's cases it touches)."""
BREAKS = {
 'B1-stlf-end': ('crates/wuica-core/src/sim/renamer.rs', 'ds < d && d < ds + w.div_euclid(8)', 'ds < d && d <= ds + w.div_euclid(8)', 'stlf failorder'),
 'B2-regfile-free': ('crates/wuica-core/src/sim/frontend.rs', 'clock + 1 + self.cfg.vec_reg_free_delay, v)', 'clock + self.cfg.vec_reg_free_delay, v)', 'regfiles'),
 'B3-lsd-end': ('crates/wuica-core/src/sim/frontend.rs', '(a + len - 1).div_euclid(64)', '(a + len).div_euclid(64)', 'lsdlines'),
 'B4-fail-interval': ('crates/wuica-core/src/sim/mod.rs', 'r = r.max(last + interval);', 'r = r.max(last + interval - 1);', 'stlf failorder'),
 'B5-fusion-length': ('crates/wuica-core/src/instr_builder.rs', '/ 2 <= 15', '/ 2 < 15', 'branch'),
 'B6-move-slot': ('crates/wuica-core/src/sim/renamer.rs', 'contains(&(slot as i64))', 'contains(&(slot as i64 + 1))', 'moveslots'),
 'B7-queue-full': ('crates/wuica-core/src/sim/scheduler.rs', 'c + self.cfg.issue_width > *size', 'c + self.cfg.issue_width >= *size', 'queues'),
 'B8-fastadd-load': ('crates/wuica-core/src/sim/scheduler.rs', 'if !prod.has(pf::LOAD)\n                                && self.prep.info[prod.instr as usize].has(inf::FAST_ADD)',
                     'if self.prep.info[prod.instr as usize].has(inf::FAST_ADD)', 'fastadd'),
 'B9-gpr-free-delay': ('crates/wuica-core/src/sim/frontend.rs', 'clock + 1 + self.cfg.gpr_reg_free_delay, g)', 'clock + 1 + self.cfg.vec_reg_free_delay, g)', 'regfiles'),
 'B10-vec-forward': ('crates/wuica-core/src/instr_builder.rs', 'delays[usize::from(wide)]', 'delays[0]', 'stlf'),
 'B12-fastadd-store': ('crates/wuica-core/src/sim/scheduler.rs', 'see fastAddBypassDelay)\n                        let producer = self.ren_ops[r as usize].uop;\n                        let cons = &self.prep.props[self.uops[u as usize].prop as usize];\n                        if producer != NONE && !cons.has(pf::STORE_DATA) {',
                       'see fastAddBypassDelay)\n                        let producer = self.ren_ops[r as usize].uop;\n                        let cons = &self.prep.props[self.uops[u as usize].prop as usize];\n                        if producer != NONE {', 'fastadd'),
 'B11-incdec-jnbe': ('crates/wuica-core/src/instr_builder.rs', '"JB" | "JNB" | "JBE" | "JNBE"', '"JB" | "JNB" | "JBE"', 'branch'),
}

if __name__ == '__main__':
    import sys, os
    name, root = sys.argv[1], sys.argv[2]
    f, old, new, _ = BREAKS[name]
    p = os.path.join(root, f)
    s = open(p).read()
    assert s.count(old) == 1, (name, s.count(old))
    open(p, 'w').write(s.replace(old, new))
