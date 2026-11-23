//! The results of a simulation: the uop table (`getUopsTableColumns`, `printUopsTable`) and the `-json` output
//! (`generateJSONOutput`).

use super::prep::NONE;
use super::{InstrSummary, Sim, SimResult, UopSource};
use serde_json::{json, Map, Value};

/// `canonicalizeInstrString`: `re.sub('[(){}, ]+', '_', instrString).strip('_')`
pub fn canonicalize_instr_string(instr_string: &str) -> String {
    let mut s = String::new();
    let mut in_run = false;
    for c in instr_string.chars() {
        if matches!(c, '(' | ')' | '{' | '}' | ',' | ' ') {
            if !in_run {
                s.push('_');
            }
            in_run = true;
        } else {
            s.push(c);
            in_run = false;
        }
    }
    s.trim_matches('_').to_string()
}

/// `getURL`
pub fn get_url(instr_str: &str) -> String {
    format!("https://www.uops.info/html-instr/{}.html", canonicalize_instr_string(instr_str))
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

/// `TableLineData`
struct TableLineData<'a> {
    string: &'a str,
    /// index of the instruction
    instr: Option<usize>,
    url: Option<String>,
    /// laminated uops for each round
    uops_for_rnd: Vec<Vec<u32>>,
}

pub(crate) fn build_result(sim: Sim, tp: f64, first_relevant_round: i64, last_relevant_round: i64, max_cycle: i64) -> SimResult {
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
    SimResult {
        tp,
        first_relevant_round,
        last_relevant_round,
        unroll: sim.fe.unroll,
        max_cycle,
        uops: sim.uops,
        fused_uops: sim.fused,
        laminated_uops: sim.lams,
        instr_instances: sim.insts,
        all_generated_instr_instances: sim.fe.all_generated_instr_instances,
        relevant_instr_instances_for_instr: relevant,
        ports,
        port_columns,
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

    fn table_line_data(&self) -> Vec<TableLineData<'_>> {
        let mut table_line_data = Vec::new();
        for (ii, instr) in self.instrs.iter().enumerate() {
            let instr_instances = &self.relevant_instr_instances_for_instr[ii];
            let insts = || instr_instances.iter().map(|&i| &self.instr_instances[i as usize]);
            if insts().any(|i| !i.reg_merge_uops.is_empty()) {
                let uops = insts().map(|i| i.reg_merge_uops.clone()).collect();
                table_line_data.push(TableLineData { string: "<Register Merge Uop>", instr: None, url: None, uops_for_rnd: uops });
            }
            if insts().any(|i| !i.stack_sync_uops.is_empty()) {
                let uops = insts().map(|i| i.stack_sync_uops.clone()).collect();
                table_line_data.push(TableLineData { string: "<Stack Sync Uop>", instr: None, url: None, uops_for_rnd: uops });
            }
            let uops = insts().map(|i| i.uops().collect()).collect();
            let url = (!instr.is_unknown).then(|| get_url(&instr.instr_str));
            table_line_data.push(TableLineData { string: &instr.asm, instr: Some(ii), url, uops_for_rnd: uops });
        }
        table_line_data
    }

    /// `getUopsTableColumns`: (column name, values of the lines)
    fn uops_table_columns_for(&self, table_line_data: &[TableLineData]) -> Vec<(String, Vec<TableValue>)> {
        let mut column_keys: Vec<String> = ["MITE", "MS", "DSB", "LSD", "Issued", "Exec."].iter().map(|s| s.to_string()).collect();
        column_keys.extend(self.port_columns.iter().cloned());
        let has_div = table_line_data.iter().any(|tld| {
            tld.uops_for_rnd.first().is_some_and(|lams| {
                lams.iter().any(|&l| self.laminated_uops[l as usize].unfused_uops().any(|u| self.uops[u as usize].div_cycles != 0))
            })
        });
        if has_div {
            column_keys.push("Div".to_string());
        }
        column_keys.push("Notes".to_string());
        let n = column_keys.len();
        let notes = n - 1;
        let col = |name: &str| column_keys.iter().position(|k| k == name);
        let (issued, exec, div) = (4, 5, col("Div"));
        let mut columns: Vec<Vec<TableValue>> = vec![Vec::new(); n];
        let mut cur = vec![0.0f64; n];
        let mut any_notes = false;

        for tld in table_line_data {
            cur.iter_mut().for_each(|v| *v = 0.0);
            let mut note: Option<&str> = None;
            let instr = tld.instr.map(|i| &self.instrs[i]);
            let mut skip = false;
            if instr.is_some_and(|i| i.is_unknown) {
                note = Some("X");
            } else if instr.is_some_and(|i| i.macro_fused_with_prev_instr) {
                note = Some("M");
                skip = true;
            } else if instr.is_some_and(|i| i.cannot_be_in_dsb_due_to_jcc_erratum) {
                note = Some("J");
            }
            if !skip {
                for lam_uops in &tld.uops_for_rnd {
                    for &l in lam_uops {
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
                let n_rnds = tld.uops_for_rnd.len() as f64;
                for (k, v) in cur.iter_mut().enumerate() {
                    if k != notes {
                        *v /= n_rnds;
                    }
                }
            }
            for (k, c) in columns.iter_mut().enumerate() {
                if k == notes {
                    match note {
                        Some(s) => {
                            any_notes = true;
                            c.push(TableValue::Text(s.to_string()));
                        }
                        None => c.push(TableValue::Number(0.0)),
                    }
                } else {
                    c.push(TableValue::Number(cur[k]));
                }
            }
        }

        let mut result: Vec<(String, Vec<TableValue>)> = column_keys.into_iter().zip(columns).collect();
        if !any_notes {
            result.pop();
        }
        result
    }

    /// The columns of the uop table (`getUopsTableColumns`): (name, value for each line).
    pub fn uops_table_columns(&self) -> Vec<(String, Vec<TableValue>)> {
        self.uops_table_columns_for(&self.table_line_data())
    }

    /// What `printUopsTable(tableLineData, uArchConfig)` prints: the legend of the notes (if there are notes) and the table.
    pub fn uops_table(&self) -> String {
        let table_line_data = self.table_line_data();
        let columns = self.uops_table_columns_for(&table_line_data);
        let first_port_column = self.port_columns.first().map(|s| s.as_str()).unwrap_or("");
        let mut out = String::new();

        if let Some((_, notes)) = columns.iter().find(|c| c.0 == "Notes") {
            let has = |s: &str| notes.iter().any(|v| matches!(v, TableValue::Text(t) if t == s));
            if has("J") {
                let jcc_url = "https://www.intel.com/content/dam/support/us/en/documents/processors/mitigations-jump-conditional-code-erratum.pdf";
                out += &format!("J - Block not in DSB due to {}\n", get_terminal_hyperlink(jcc_url, "JCC erratum"));
            }
            if has("M") {
                out += "M - Macro-fused with previous instruction\n";
            }
            if has("X") {
                out += "X - Instruction not supported\n";
            }
            out += "\n";
        }

        let column_width_list: Vec<usize> = columns
            .iter()
            .map(|(k, lines)| 2 + k.chars().count().max(lines.iter().map(|l| l.format().chars().count()).max().unwrap_or(0)))
            .collect();

        let get_table_border_line = |first_c: char, middle_c: char, last_c: char| -> String {
            let mut line = String::new();
            for ((h, _), &w) in columns.iter().zip(&column_width_list) {
                if h == "MITE" {
                    line.push(first_c);
                } else if h == "Issued" || h == "Exec." || h == first_port_column || h == "Notes" {
                    line.push(middle_c);
                } else {
                    line.push('\u{2500}');
                }
                for _ in 0..w {
                    line.push('\u{2500}');
                }
            }
            line.push(last_c);
            line
        };
        let get_table_line = |column_values: Vec<String>| -> String {
            let mut line = String::new();
            for (((h, _), &w), val) in columns.iter().zip(&column_width_list).zip(column_values) {
                if h == "MITE" || h == "Issued" || h == "Exec." || h == first_port_column || h == "Notes" {
                    line.push('\u{2502}');
                } else {
                    line.push(' ');
                }
                // '{:^w}'.format(val)
                let len = val.chars().count();
                let pad = w.saturating_sub(len);
                let left = pad / 2;
                for _ in 0..left {
                    line.push(' ');
                }
                line += &val;
                for _ in 0..pad - left {
                    line.push(' ');
                }
            }
            line.push('\u{2502}');
            line
        };

        out += &get_table_border_line('\u{250c}', '\u{252c}', '\u{2510}');
        out.push('\n');
        out += &get_table_line(columns.iter().map(|c| c.0.clone()).collect());
        out.push('\n');
        out += &get_table_border_line('\u{251c}', '\u{253c}', '\u{2524}');
        out.push('\n');

        for (i, tld) in table_line_data.iter().enumerate() {
            let mut line = get_table_line(columns.iter().map(|c| c.1[i].format()).collect());
            line.push(' ');
            match &tld.url {
                Some(url) => line += &get_terminal_hyperlink(url, tld.string),
                None => line += tld.string,
            }
            out += &line;
            out.push('\n');
        }

        out += &get_table_border_line('\u{251c}', '\u{253c}', '\u{2524}');
        out.push('\n');
        let sums: Vec<String> = columns
            .iter()
            .map(|(k, v)| {
                if k == "Notes" {
                    String::new()
                } else {
                    // sum(v): CPython (3.12 and later) adds floats with compensated summation (Neumaier), which the totals
                    // depend on in the last digit
                    let mut values = v.iter().map(|x| match x {
                        TableValue::Number(n) => *n,
                        TableValue::Text(_) => 0.0,
                    });
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
                    TableValue::Number(sum).format()
                }
            })
            .collect();
        out += &get_table_line(sums);
        out += " Total\n";
        out += &get_table_border_line('\u{2514}', '\u{2534}', '\u{2518}');
        out.push('\n');
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
