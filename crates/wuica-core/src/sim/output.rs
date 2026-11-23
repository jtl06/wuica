//! The results of a simulation: the uop table (`getUopsTableColumns`, `printUopsTable`) and the `-json` output
//! (`generateJSONOutput`).

use super::prep::{pf, NONE};
use super::{opt, FusedUop, InstrInstance, InstrSummary, LaminatedUop, Sim, SimResult, Uop, UopSource, NO_PORT};
use serde_json::{json, Map, Value};

/// `canonicalizeInstrString`: `re.sub('[(){}, ]+', '_', instrString).strip('_')`
pub fn canonicalize_instr_string(instr_string: &str) -> String {
    let mut s = String::with_capacity(instr_string.len());
    canonicalize_into(instr_string, &mut s);
    s
}

/// [`canonicalize_instr_string`], appended to `out`
fn canonicalize_into(instr_string: &str, out: &mut String) {
    let start = out.len();
    let mut in_run = false;
    for c in instr_string.chars() {
        if matches!(c, '(' | ')' | '{' | '}' | ',' | ' ') {
            if !in_run {
                out.push('_');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    // strip('_')
    let end = start + out[start..].trim_end_matches('_').len();
    out.truncate(end);
    let leading = out[start..].len() - out[start..].trim_start_matches('_').len();
    if leading > 0 {
        out.replace_range(start..start + leading, "");
    }
}

/// `formatTableValue` of a number (see [`TableValue::format`]), formatted in `buf`
fn format_number(v: f64, buf: &mut String) -> &str {
    use std::fmt::Write;
    buf.clear();
    if v.fract() == 0.0 && v.abs() < 1e15 && !(v == 0.0 && v.is_sign_negative()) {
        // an integer (most values): '{:.2}' gives its digits and ".00", which are removed (and "0" is shown as "")
        if v == 0.0 {
            return "";
        }
        // the digits of the integer (what `{}` writes, without the formatting machinery)
        let i = v as i64;
        let mut digits = [0u8; 20];
        let mut n = i.unsigned_abs();
        let mut k = digits.len();
        loop {
            k -= 1;
            digits[k] = b'0' + (n % 10) as u8;
            n /= 10;
            if n == 0 {
                break;
            }
        }
        if i < 0 {
            buf.push('-');
        }
        // (ASCII digits)
        buf.push_str(std::str::from_utf8(&digits[k..]).unwrap());
        return buf;
    }
    write!(buf, "{v:.2}").unwrap();
    let s = buf.trim_end_matches('0').trim_end_matches('.');
    if s == "0" {
        ""
    } else {
        s
    }
}

/// `sum(v)` of floats: CPython (3.12 and later) adds floats with compensated summation (Neumaier), which the totals of the uop
/// table depend on in the last digit
fn py_sum(mut values: impl Iterator<Item = f64>) -> f64 {
    let mut sum = values.next().unwrap_or(0.0);
    let mut c = 0.0f64;
    for x in values {
        let t = sum + x;
        if sum.abs() >= x.abs() {
            c += (sum - t) + x;
        } else {
            c += (x - t) + sum;
        }
        sum = t;
    }
    if c != 0.0 && c.is_finite() {
        sum += c;
    }
    sum
}

/// `getURL`
pub fn get_url(instr_str: &str) -> String {
    let mut url = String::with_capacity(40 + instr_str.len());
    url.push_str("https://www.uops.info/html-instr/");
    canonicalize_into(instr_str, &mut url);
    url.push_str(".html");
    url
}

/// `getTerminalHyperlink`
pub fn get_terminal_hyperlink(url: &str, text: &str) -> String {
    format!("\x1b]8;;{url}\x07{text}\x1b]8;;\x07")
}

/// a cell of the uop table
#[derive(Clone, Debug, PartialEq)]
pub enum TableValue {
    Number(f64),
    Text(String),
}

impl TableValue {
    /// `formatTableValue`
    pub fn format(&self) -> String {
        match self {
            TableValue::Number(v) => {
                let s = format!("{v:.2}");
                let s = s.trim_end_matches('0').trim_end_matches('.');
                if s == "0" {
                    String::new()
                } else {
                    s.to_string()
                }
            }
            TableValue::Text(s) => {
                if s == "0" {
                    String::new()
                } else {
                    s.clone()
                }
            }
        }
    }
}

/// The kind of a line of the uop table (`TableLineData`): the register merge uops or the stack sync uops of an instruction, or
/// the instruction itself.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LineKind {
    RegMerge,
    StackSync,
    Instr,
}

/// A line of the uop table (`TableLineData`); its uops for each round are those of the instances of `instr` in the relevant
/// rounds.
#[derive(Clone, Copy)]
struct TableLine {
    kind: LineKind,
    instr: usize,
}

/// The values of the uop table (`getUopsTableColumns`), by line: the number columns, and the notes.
pub struct UopsTableData {
    /// the names of the number columns (all columns but "Notes")
    pub columns: Vec<String>,
    /// for each line, the values of the number columns
    pub rows: Vec<Vec<f64>>,
    /// for each line, its note ("X", "M", "J" or "")
    pub notes: Vec<&'static str>,
    /// whether there is a "Notes" column (a line has a note)
    pub has_notes: bool,
    lines: Vec<TableLine>,
}

impl UopsTableData {
    /// the kind of a line ("regMerge", "stackSync" or "instr") and, for "instr", the index of the instruction
    pub fn line(&self, line: usize) -> (&'static str, Option<usize>) {
        let l = self.lines[line];
        match l.kind {
            LineKind::RegMerge => ("regMerge", None),
            LineKind::StackSync => ("stackSync", None),
            LineKind::Instr => ("instr", Some(l.instr)),
        }
    }
}

pub(crate) fn build_result(mut sim: Sim, tp: f64, first_relevant_round: i64, last_relevant_round: i64, max_cycle: i64) -> SimResult {
    let cfg = sim.cfg;
    let ports: Vec<String> = sim.prep.ports.iter().map(|&c| (c as char).to_string()).collect();
    // getPortColumnName
    let port_columns = ports.iter().map(|p| cfg.port_names.get(p).cloned().unwrap_or_else(|| format!("Port {p}"))).collect();
    let mut relevant = vec![Vec::new(); sim.instrs.len()];
    for &inst in &sim.fe.all_generated_instr_instances {
        let i = &sim.insts[inst as usize];
        if first_relevant_round <= i.rnd && i.rnd <= last_relevant_round {
            relevant[i.instr as usize].push(inst);
        }
    }
    let parameters = json!({
        "uArchName": cfg.name,
        "IQWidth": cfg.iq_width,
        "IDQWidth": cfg.idq_width,
        "issueWidth": cfg.issue_width,
        "RBWidth": cfg.rb_width,
        "RSWidth": cfg.rs_width,
        "allPorts": ports,
        "nDecoders": cfg.n_decoders,
        "DSBBlockSize": cfg.dsb_block_size,
        "LSD": sim.fe.uop_source == Some(UopSource::Lsd),
        "LSDUnrollCount": sim.fe.lsd_unroll_count,
        "mode": if sim.fe.unroll { "unroll" } else { "loop" },
    });
    // the public form of the entities
    let props = &sim.prep.props;
    let uops: Vec<Uop> = sim
        .uops
        .iter()
        .map(|u| {
            let p = &props[u.prop as usize];
            Uop {
                instr_instance: u.instr_instance,
                fused_uop: u.fused_uop,
                actual_port: (u.actual_port != NO_PORT).then_some(u.actual_port),
                eliminated: u.eliminated,
                ren_in: (u.ren, u.n_in as u32),
                ready_for_dispatch: opt(u.ready_for_dispatch),
                dispatched: opt(u.dispatched),
                executed: (!u.executed.is_nan()).then_some(u.executed),
                div_cycles: p.div_cycles,
                is_stack_sync_uop: p.has(pf::STACK_SYNC),
                is_reg_merge_uop: p.has(pf::REG_MERGE),
            }
        })
        .collect();
    // (each internal array is freed as soon as it is converted: a lower peak of memory)
    sim.uops = Vec::new();
    let fused_uops: Vec<FusedUop> = sim
        .fused
        .iter()
        .map(|f| FusedUop {
            first_uop: f.first_uop,
            n_uops: f.n_uops,
            laminated_uop: f.laminated_uop,
            issued: opt(f.issued),
            retired: opt(f.retired),
            retire_idx: opt(f.retire_idx),
        })
        .collect();
    sim.fused = Vec::new();
    let laminated_uops: Vec<LaminatedUop> = sim
        .lams
        .iter()
        .map(|l| LaminatedUop {
            first_fused_uop: l.first_fused_uop,
            n_fused_uops: l.n_fused_uops,
            first_uop: l.first_uop,
            n_uops: l.n_uops,
            added_to_idq: opt(l.added_to_idq),
            uop_source: l.uop_source,
        })
        .collect();
    sim.lams = Vec::new();
    let mut instr_instances: Vec<InstrInstance> = sim
        .insts
        .iter()
        .map(|i| InstrInstance {
            instr: i.instr,
            address: i.address,
            rnd: i.rnd,
            first_uop: i.first_uop,
            n_uops: i.n_uops,
            reg_merge_uops: Vec::new(),
            stack_sync_uops: Vec::new(),
            source: i.source,
            predecoded: opt(i.predecoded),
            removed_from_iq: opt(i.removed_from_iq),
        })
        .collect();
    sim.insts = Vec::new();
    for &(inst, lam) in &sim.reg_merge_uops {
        instr_instances[inst as usize].reg_merge_uops.push(lam);
    }
    for &(inst, lam) in &sim.stack_sync_uops {
        instr_instances[inst as usize].stack_sync_uops.push(lam);
    }
    SimResult {
        tp,
        first_relevant_round,
        last_relevant_round,
        unroll: sim.fe.unroll,
        max_cycle,
        uops,
        fused_uops,
        laminated_uops,
        instr_instances,
        all_generated_instr_instances: sim.fe.all_generated_instr_instances,
        relevant_instr_instances_for_instr: relevant,
        ports,
        port_columns,
        issue_log: None,
        instrs: sim
            .instrs
            .iter()
            .map(|i| InstrSummary {
                asm: i.asm.clone(),
                opcode: i.opcode.clone(),
                instr_str: i.instr_str.clone(),
                is_unknown: i.is_unknown,
                macro_fused_with_prev_instr: i.macro_fused_with_prev_instr,
                macro_fused_with_next_instr: i.macro_fused_with_next_instr,
                cannot_be_in_dsb_due_to_jcc_erratum: i.cannot_be_in_dsb_due_to_jcc_erratum,
            })
            .collect(),
        ren_ops: sim.ren_ops,
        ren_lists: sim.ren_lists,
        parameters,
    }
}

impl SimResult {
    /// the number of relevant rounds (`nRounds` of `printBottlenecks`)
    pub fn n_relevant_rounds(&self) -> i64 {
        self.last_relevant_round - self.first_relevant_round + 1
    }

    /// the name of a port (`Uop::actual_port`)
    pub fn port_name(&self, port: u8) -> &str {
        &self.ports[port as usize]
    }

    /// the lines of the uop table: for each instruction, a line for its register merge uops and one for its stack sync uops (if
    /// any instance in the relevant rounds has such uops), then the instruction
    fn table_lines(&self) -> Vec<TableLine> {
        let mut lines = Vec::with_capacity(self.instrs.len());
        for ii in 0..self.instrs.len() {
            let insts = || self.relevant_instr_instances_for_instr[ii].iter().map(|&i| &self.instr_instances[i as usize]);
            if insts().any(|i| !i.reg_merge_uops.is_empty()) {
                lines.push(TableLine { kind: LineKind::RegMerge, instr: ii });
            }
            if insts().any(|i| !i.stack_sync_uops.is_empty()) {
                lines.push(TableLine { kind: LineKind::StackSync, instr: ii });
            }
            lines.push(TableLine { kind: LineKind::Instr, instr: ii });
        }
        lines
    }

    /// the laminated uops of a line in the round of instance `inst`
    fn line_uops(&self, kind: LineKind, inst: u32) -> impl Iterator<Item = u32> + '_ {
        let inst = &self.instr_instances[inst as usize];
        let (list, range): (&[u32], _) = match kind {
            LineKind::RegMerge => (&inst.reg_merge_uops, 0..0),
            LineKind::StackSync => (&inst.stack_sync_uops, 0..0),
            LineKind::Instr => (&[], inst.uops()),
        };
        list.iter().copied().chain(range)
    }

    /// `getUopsTableColumns`, by line
    pub fn uops_table_data(&self) -> UopsTableData {
        let lines = self.table_lines();
        let mut columns: Vec<String> = Vec::with_capacity(7 + self.port_columns.len());
        columns.extend(["MITE", "MS", "DSB", "LSD", "Issued", "Exec."].iter().map(|s| s.to_string()));
        columns.extend(self.port_columns.iter().cloned());
        let has_div = lines.iter().any(|line| {
            self.relevant_instr_instances_for_instr[line.instr].first().is_some_and(|&inst| {
                self.line_uops(line.kind, inst)
                    .any(|l| self.laminated_uops[l as usize].unfused_uops().any(|u| self.uops[u as usize].div_cycles != 0))
            })
        });
        if has_div {
            columns.push("Div".to_string());
        }
        let n = columns.len();
        let (issued, exec, div) = (4, 5, has_div.then_some(n - 1));
        let mut rows: Vec<Vec<f64>> = Vec::with_capacity(lines.len());
        let mut notes: Vec<&'static str> = Vec::with_capacity(lines.len());

        for line in &lines {
            let mut cur = vec![0.0f64; n];
            let mut note = "";
            let instr = (line.kind == LineKind::Instr).then(|| &self.instrs[line.instr]);
            let mut skip = false;
            if instr.is_some_and(|i| i.is_unknown) {
                note = "X";
            } else if instr.is_some_and(|i| i.macro_fused_with_prev_instr) {
                note = "M";
                skip = true;
            } else if instr.is_some_and(|i| i.cannot_be_in_dsb_due_to_jcc_erratum) {
                note = "J";
            }
            if !skip {
                let instances = &self.relevant_instr_instances_for_instr[line.instr];
                for &inst in instances {
                    for l in self.line_uops(line.kind, inst) {
                        let lam = &self.laminated_uops[l as usize];
                        match lam.uop_source {
                            Some(UopSource::Mite) => cur[0] += 1.0,
                            Some(UopSource::Ms) => cur[1] += 1.0,
                            Some(UopSource::Dsb) => cur[2] += 1.0,
                            Some(UopSource::Lsd) => cur[3] += 1.0,
                            _ => {}
                        }
                        for f in lam.fused_uops() {
                            cur[issued] += 1.0;
                            for u in self.fused_uops[f as usize].unfused_uops() {
                                let uop = &self.uops[u as usize];
                                if let Some(p) = uop.actual_port {
                                    cur[exec] += 1.0;
                                    cur[6 + p as usize] += 1.0;
                                }
                                if uop.div_cycles != 0 {
                                    // the reference raises a KeyError if there is no 'Div' column
                                    if let Some(d) = div {
                                        cur[d] += uop.div_cycles as f64;
                                    }
                                }
                            }
                        }
                    }
                }
                let n_rnds = instances.len() as f64;
                for v in cur.iter_mut() {
                    *v /= n_rnds;
                }
            }
            rows.push(cur);
            notes.push(note);
        }
        let has_notes = notes.iter().any(|n| !n.is_empty());
        UopsTableData { columns, rows, notes, has_notes, lines }
    }

    /// The columns of the uop table (`getUopsTableColumns`): (name, value for each line).
    pub fn uops_table_columns(&self) -> Vec<(String, Vec<TableValue>)> {
        let t = self.uops_table_data();
        let mut result: Vec<(String, Vec<TableValue>)> = t
            .columns
            .iter()
            .enumerate()
            .map(|(k, name)| (name.clone(), t.rows.iter().map(|row| TableValue::Number(row[k])).collect()))
            .collect();
        if t.has_notes {
            let notes = t.notes.iter().map(|&n| if n.is_empty() { TableValue::Number(0.0) } else { TableValue::Text(n.to_string()) }).collect();
            result.push(("Notes".to_string(), notes));
        }
        result
    }

    /// What `printUopsTable(tableLineData, uArchConfig)` prints: the legend of the notes (if there are notes) and the table.
    pub fn uops_table(&self) -> String {
        self.format_uops_table(&self.uops_table_data())
    }

    /// [`SimResult::uops_table`] for the values of [`SimResult::uops_table_data`]
    pub fn format_uops_table(&self, t: &UopsTableData) -> String {
        let first_port_column = self.port_columns.first().map(|s| s.as_str()).unwrap_or("");
        let n_lines = t.rows.len();
        let mut out = String::new();

        if t.has_notes {
            let has = |s: &str| t.notes.iter().any(|&n| n == s);
            if has("J") {
                let jcc_url = "https://www.intel.com/content/dam/support/us/en/documents/processors/mitigations-jump-conditional-code-erratum.pdf";
                out += "J - Block not in DSB due to ";
                out += &get_terminal_hyperlink(jcc_url, "JCC erratum");
                out += "\n";
            }
            if has("M") {
                out += "M - Macro-fused with previous instruction\n";
            }
            if has("X") {
                out += "X - Instruction not supported\n";
            }
            out += "\n";
        }

        // the columns: the number columns, then "Notes" if there are notes
        let n_cols = t.columns.len() + usize::from(t.has_notes);
        let name = |k: usize| if k < t.columns.len() { t.columns[k].as_str() } else { "Notes" };
        // the formatted values (formatTableValue) of the lines and the total, column by column, in one string
        let mut cells = String::with_capacity(n_cols * (n_lines + 1) * 3);
        let mut ends: Vec<usize> = Vec::with_capacity(n_cols * (n_lines + 1));
        let mut tmp = String::with_capacity(32);
        let mut widths: Vec<usize> = Vec::with_capacity(n_cols);
        for k in 0..n_cols {
            let mut w = name(k).chars().count();
            if k < t.columns.len() {
                for row in &t.rows {
                    let s = format_number(row[k], &mut tmp);
                    w = w.max(s.chars().count());
                    cells.push_str(s);
                    ends.push(cells.len());
                }
                // the total (not part of the width)
                cells.push_str(format_number(py_sum(t.rows.iter().map(|row| row[k])), &mut tmp));
            } else {
                for &note in &t.notes {
                    w = w.max(note.chars().count());
                    cells.push_str(note);
                    ends.push(cells.len());
                }
            }
            ends.push(cells.len());
            widths.push(2 + w);
        }
        let cell = |k: usize, line: usize| {
            let i = k * (n_lines + 1) + line;
            let start = if i == 0 { 0 } else { ends[i - 1] };
            &cells[start..ends[i]]
        };

        // the kind of the separator before each column (from its name, once): 0 for "MITE", 1 for the other columns that start a
        // group, 2 for the others
        let sep: Vec<u8> = (0..n_cols)
            .map(|k| {
                let h = name(k);
                if h == "MITE" {
                    0
                } else if h == "Issued" || h == "Exec." || h == first_port_column || h == "Notes" {
                    1
                } else {
                    2
                }
            })
            .collect();
        let border_line = |out: &mut String, first_c: char, middle_c: char, last_c: char| {
            for (k, &w) in widths.iter().enumerate() {
                match sep[k] {
                    0 => out.push(first_c),
                    1 => out.push(middle_c),
                    _ => out.push('\u{2500}'),
                }
                for _ in 0..w {
                    out.push('\u{2500}');
                }
            }
            out.push(last_c);
            out.push('\n');
        };
        // a cell of a line of the table: the separator and the value, centered ('{:^w}'.format(val)); a line ends with '\u{2502}'
        let table_cell = |out: &mut String, k: usize, val: &str| {
            if sep[k] != 2 {
                out.push('\u{2502}');
            } else {
                out.push(' ');
            }
            let w = widths[k];
            let pad = w.saturating_sub(val.chars().count());
            let left = pad / 2;
            for _ in 0..left {
                out.push(' ');
            }
            out.push_str(val);
            for _ in 0..pad - left {
                out.push(' ');
            }
        };

        border_line(&mut out, '\u{250c}', '\u{252c}', '\u{2510}');
        for k in 0..n_cols {
            table_cell(&mut out, k, name(k));
        }
        out.push('\u{2502}');
        out.push('\n');
        border_line(&mut out, '\u{251c}', '\u{253c}', '\u{2524}');

        for (i, line) in t.lines.iter().enumerate() {
            for k in 0..n_cols {
                table_cell(&mut out, k, cell(k, i));
            }
            out.push('\u{2502}');
            out.push(' ');
            match line.kind {
                LineKind::RegMerge => out.push_str("<Register Merge Uop>"),
                LineKind::StackSync => out.push_str("<Stack Sync Uop>"),
                LineKind::Instr => {
                    let instr = &self.instrs[line.instr];
                    if instr.is_unknown {
                        out.push_str(&instr.asm);
                    } else {
                        // getTerminalHyperlink(getURL(instr.instrStr), instr.asm)
                        out.push_str("\x1b]8;;https://www.uops.info/html-instr/");
                        canonicalize_into(&instr.instr_str, &mut out);
                        out.push_str(".html\x07");
                        out.push_str(&instr.asm);
                        out.push_str("\x1b]8;;\x07");
                    }
                }
            }
            out.push('\n');
        }

        border_line(&mut out, '\u{251c}', '\u{253c}', '\u{2524}');
        for k in 0..n_cols {
            table_cell(&mut out, k, if k < t.columns.len() { cell(k, n_lines) } else { "" });
        }
        out.push('\u{2502}');
        out += " Total\n";
        border_line(&mut out, '\u{2514}', '\u{2534}', '\u{2518}');
        out
    }

    /// The content of the `-json` output (`generateJSONOutput`).
    pub fn to_json(&self) -> Value {
        let max_cycle = self.max_cycle;
        let mut instr_list = Vec::new();
        // the first instance of each instruction
        let mut first_instance: Vec<Option<u32>> = vec![None; self.instrs.len()];
        for &inst in &self.all_generated_instr_instances {
            let i = self.instr_instances[inst as usize].instr as usize;
            if first_instance[i].is_none() {
                first_instance[i] = Some(inst);
            }
        }
        for (id, instr) in self.instrs.iter().enumerate() {
            let mut d = Map::new();
            d.insert("asm".into(), json!(instr.asm));
            d.insert("opcode".into(), json!(instr.opcode));
            d.insert("url".into(), json!(get_url(&instr.instr_str)));
            d.insert("instrID".into(), json!(id));
            if instr.macro_fused_with_next_instr {
                d.insert("macroFusedWithNextInstr".into(), json!(true));
            }
            if let Some(inst) = first_instance[id] {
                d.insert("source".into(), json!(self.instr_instances[inst as usize].source.map(|s| s.as_str())));
            }
            instr_list.push(Value::Object(d));
        }

        let n_cycles = (max_cycle + 1).max(0) as usize;
        let mut cycles: Vec<Map<String, Value>> = (0..n_cycles)
            .map(|i| {
                let mut m = Map::new();
                m.insert("cycle".into(), json!(i));
                m
            })
            .collect();
        fn append(cycles: &mut [Map<String, Value>], cycle: i64, key: &str, v: Value) {
            if let Value::Array(a) = cycles[cycle as usize].entry(key).or_insert_with(|| Value::Array(Vec::new())) {
                a.push(v);
            }
        }
        let in_range = |c: Option<i64>| c.filter(|&c| c >= 0 && c <= max_cycle);

        let mut unfused_uop_to_dict: Vec<Option<Value>> = vec![None; self.uops.len()];
        for &inst_id in &self.all_generated_instr_instances {
            let inst = &self.instr_instances[inst_id as usize];
            let instr_id = inst.instr;
            let rnd = inst.rnd;
            if let Some(c) = in_range(inst.predecoded) {
                append(&mut cycles, c, "addedToIQ", json!({"rnd": rnd, "instr": instr_id}));
            }
            if let Some(c) = in_range(inst.removed_from_iq) {
                append(&mut cycles, c, "removedFromIQ", json!({"rnd": rnd, "instr": instr_id}));
            }

            let n_merge = inst.reg_merge_uops.len();
            let n_sync = inst.stack_sync_uops.len();
            let lam_uops = inst.reg_merge_uops.iter().copied().chain(inst.stack_sync_uops.iter().copied()).chain(inst.uops());
            for (lam_uop_i, l) in lam_uops.enumerate() {
                let lam = &self.laminated_uops[l as usize];
                let mut base_uop_dict = Map::new();
                base_uop_dict.insert("rnd".into(), json!(rnd));
                base_uop_dict.insert("instrID".into(), json!(instr_id));
                base_uop_dict.insert("lamUopID".into(), json!(lam_uop_i));
                if lam_uop_i < n_merge {
                    base_uop_dict.insert("regMergeUop".into(), json!(true));
                } else if lam_uop_i < n_merge + n_sync {
                    base_uop_dict.insert("stackSyncUop".into(), json!(true));
                }

                if let Some(c) = in_range(lam.added_to_idq) {
                    let mut lam_uop_dict = base_uop_dict.clone();
                    lam_uop_dict.insert("source".into(), json!(lam.uop_source.map(|s| s.as_str())));
                    append(&mut cycles, c, "addedToIDQ", Value::Object(lam_uop_dict));
                }

                for (f_uop_i, f) in lam.fused_uops().enumerate() {
                    let f_uop = &self.fused_uops[f as usize];
                    let mut f_uop_dict = base_uop_dict.clone();
                    f_uop_dict.insert("fUopID".into(), json!(f_uop_i));

                    if let Some(c) = in_range(f_uop.issued) {
                        if lam.added_to_idq.is_some() && f_uop_i == 0 {
                            append(&mut cycles, c, "removedFromIDQ", Value::Object(f_uop_dict.clone()));
                        }
                        append(&mut cycles, c, "addedToRB", Value::Object(f_uop_dict.clone()));
                    }
                    if let Some(c) = in_range(f_uop.retired) {
                        append(&mut cycles, c, "removedFromRB", Value::Object(f_uop_dict.clone()));
                    }

                    for (uop_i, u) in f_uop.unfused_uops().enumerate() {
                        let uop = &self.uops[u as usize];
                        let mut unfused_uop_dict = f_uop_dict.clone();
                        unfused_uop_dict.insert("uopID".into(), json!(uop_i));
                        let unfused_uop_dict = Value::Object(unfused_uop_dict);
                        unfused_uop_to_dict[u as usize] = Some(unfused_uop_dict.clone());

                        if let Some(c) = in_range(f_uop.issued) {
                            if uop.executed != Some(c as f64) {
                                let mut rs_dict = unfused_uop_dict.as_object().unwrap().clone();
                                let mut depends_on = Vec::new();
                                let (start, n) = uop.ren_in;
                                for j in start..start + n {
                                    let producer = self.ren_ops[self.ren_lists[j as usize] as usize].uop;
                                    if producer != NONE {
                                        if let Some(d) = &unfused_uop_to_dict[producer as usize] {
                                            depends_on.push(d.clone());
                                        }
                                    }
                                }
                                rs_dict.insert("dependsOn".into(), Value::Array(depends_on));
                                append(&mut cycles, c, "addedToRS", Value::Object(rs_dict));
                            }
                        }
                        if let Some(c) = in_range(uop.ready_for_dispatch) {
                            append(&mut cycles, c, "readyForDispatch", unfused_uop_dict.clone());
                        }
                        if let Some(c) = in_range(uop.dispatched) {
                            let port = uop.actual_port.map(|p| self.ports[p as usize].as_str()).unwrap_or("");
                            let d = cycles[c as usize].entry("dispatched").or_insert_with(|| Value::Object(Map::new()));
                            if let Some(d) = d.as_object_mut() {
                                d.insert(format!("Port{port}"), unfused_uop_dict.clone());
                            }
                        }
                        // the reference fails if the cycle is a float (fractional throughput limits); the event is added to the
                        // cycle in which the fractional cycle lies
                        if let Some(e) = uop.executed {
                            if e <= max_cycle as f64 && e >= 0.0 {
                                append(&mut cycles, e.floor() as i64, "executed", unfused_uop_dict.clone());
                            }
                        }
                    }
                }
            }
        }

        json!({
            "parameters": self.parameters,
            "instructions": instr_list,
            "cycles": cycles.into_iter().map(Value::Object).collect::<Vec<_>>(),
        })
    }
}
