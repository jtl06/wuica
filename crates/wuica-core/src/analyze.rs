//! A complete analysis: decoded instructions -> instruction objects -> simulation -> bottleneck analysis -> a response with the
//! structure described in docs/WASM-API.md. This is what the command-line tool and the WebAssembly interface call.

use crate::config::UArch;
use crate::data::ArchData;
use crate::decoded::DecodedInstr;
use crate::facile::{self, InstrInstanceSummary, InstrSource, SimSummary, SimView, UopSummary};
use crate::instr_builder::build_instructions;
use crate::sim::{simulate, InitPolicy, SimOptions, SimResult, UopSource};
use serde::{Deserialize, Serialize};

fn default_init_policy() -> String {
    "diff".to_string()
}
fn default_min_iterations() -> i64 {
    10
}
fn default_min_cycles() -> i64 {
    500
}

/// The request of an analysis (docs/WASM-API.md). `hex` is not used by [`analyze`], which gets the decoded instructions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub hex: String,
    pub arch: String,
    #[serde(rename = "alignmentOffset", default)]
    pub alignment_offset: i64,
    #[serde(rename = "initPolicy", default = "default_init_policy")]
    pub init_policy: String,
    #[serde(rename = "simpleFrontEnd", default)]
    pub simple_front_end: bool,
    #[serde(rename = "noMicroFusion", default)]
    pub no_micro_fusion: bool,
    #[serde(rename = "noMacroFusion", default)]
    pub no_macro_fusion: bool,
    #[serde(rename = "minIterations", default = "default_min_iterations")]
    pub min_iterations: i64,
    #[serde(rename = "minCycles", default = "default_min_cycles")]
    pub min_cycles: i64,
    #[serde(rename = "includeTrace", default)]
    pub include_trace: bool,
}

impl Request {
    pub fn new(arch: &str) -> Request {
        Request {
            hex: String::new(),
            arch: arch.to_string(),
            alignment_offset: 0,
            init_policy: default_init_policy(),
            simple_front_end: false,
            no_micro_fusion: false,
            no_macro_fusion: false,
            min_iterations: default_min_iterations(),
            min_cycles: default_min_cycles(),
            include_trace: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Limit {
    pub name: String,
    pub tp: f64,
}

/// A line of the uop table.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    /// "instr", "regMerge" or "stackSync"
    pub kind: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opcode: Option<String>,
    #[serde(rename = "instrStr", skip_serializing_if = "Option::is_none")]
    pub instr_str: Option<String>,
    /// the instruction's page on uops.info; `None` for instructions without data and for the extra uops
    pub url: Option<String>,
    /// "M", "J", "X" or ""
    pub notes: String,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Response {
    pub arch: String,
    pub tp: f64,
    /// "loop" or "unroll"
    pub mode: &'static str,
    #[serde(rename = "decodeErrors")]
    pub decode_errors: u32,
    pub bottlenecks: Vec<String>,
    pub limits: Vec<Limit>,
    pub columns: Vec<String>,
    pub rows: Vec<Row>,
    /// the report as the command-line tool prints it, without terminal escape sequences
    pub text: String,
    /// the report with the terminal hyperlinks of the reference (what uiCA prints)
    #[serde(skip)]
    pub text_with_hyperlinks: String,
    pub trace: Option<serde_json::Value>,
}

/// `facile::SimSummary` from the result of the simulation
pub fn sim_summary(r: &SimResult) -> SimSummary {
    let uop = |u: u32| {
        let uop = &r.uops[u as usize];
        UopSummary { actual_port: uop.actual_port.map(|p| r.port_name(p).to_string()), eliminated: uop.eliminated, div_cycles: uop.div_cycles }
    };
    let unfused =
        |lams: &mut dyn Iterator<Item = u32>| -> Vec<UopSummary> { lams.flat_map(|l| r.laminated_uops[l as usize].unfused_uops()).map(uop).collect() };
    SimSummary {
        tp: r.tp,
        is_loop: !r.unroll,
        n_rounds: r.n_relevant_rounds(),
        instances: r
            .relevant_instr_instances_for_instr
            .iter()
            .map(|list| {
                list.iter()
                    .map(|&i| {
                        let inst = &r.instr_instances[i as usize];
                        InstrInstanceSummary {
                            source: instr_source(inst.source),
                            uops: unfused(&mut inst.uops()),
                            other_uops: unfused(&mut inst.reg_merge_uops.iter().chain(&inst.stack_sync_uops).copied()),
                        }
                    })
                    .collect()
            })
            .collect(),
    }
}

/// The source of an instruction instance as `sim_summary` describes it
fn instr_source(source: Option<UopSource>) -> Option<InstrSource> {
    match source {
        Some(UopSource::Mite) => Some(InstrSource::Mite),
        Some(UopSource::Dsb) => Some(InstrSource::Dsb),
        Some(UopSource::Lsd) => Some(InstrSource::Lsd),
        _ => None,
    }
}

/// The result of the simulation read directly, with the same answers as the [`SimSummary`] of [`sim_summary`].
impl SimView for SimResult {
    fn tp(&self) -> f64 {
        self.tp
    }
    fn is_loop(&self) -> bool {
        !self.unroll
    }
    fn n_rounds(&self) -> i64 {
        self.n_relevant_rounds()
    }
    fn n_instances(&self, instr: usize) -> usize {
        self.relevant_instr_instances_for_instr.get(instr).map_or(0, |l| l.len())
    }
    fn not_eliminated_uops(&self, instr: usize) -> i64 {
        let list: &[u32] = self.relevant_instr_instances_for_instr.get(instr).map(|l| l.as_slice()).unwrap_or(&[]);
        let mut n = 0;
        for &i in list {
            for l in self.instr_instances[i as usize].uops() {
                n += self.laminated_uops[l as usize].unfused_uops().filter(|&u| !self.uops[u as usize].eliminated).count() as i64;
            }
        }
        n
    }
    fn any_instr_from(&self, source: InstrSource) -> bool {
        self.relevant_instr_instances_for_instr
            .iter()
            .any(|list| list.first().is_some_and(|&i| instr_source(self.instr_instances[i as usize].source) == Some(source)))
    }
    fn port_and_div_usage(&self) -> (Option<i64>, i64) {
        // counted by port index; ports with the same name (there are none) are then added up as the Counter of names would
        let mut by_index = vec![0i64; self.ports.len()];
        let mut div_usage = 0;
        for list in &self.relevant_instr_instances_for_instr {
            for &i in list {
                let inst = &self.instr_instances[i as usize];
                for l in inst.uops().chain(inst.reg_merge_uops.iter().copied()).chain(inst.stack_sync_uops.iter().copied()) {
                    for u in self.laminated_uops[l as usize].unfused_uops() {
                        let uop = &self.uops[u as usize];
                        if let Some(p) = uop.actual_port {
                            by_index[p as usize] += 1;
                        }
                        div_usage += uop.div_cycles;
                    }
                }
            }
        }
        let mut by_name: Vec<(&str, i64)> = Vec::new();
        for (p, &n) in by_index.iter().enumerate().filter(|(_, &n)| n != 0) {
            let name = self.port_name(p as u8);
            if name.is_empty() {
                continue;
            }
            match by_name.iter_mut().find(|(q, _)| *q == name) {
                Some((_, m)) => *m += n,
                None => by_name.push((name, n)),
            }
        }
        (by_name.iter().map(|(_, n)| *n).max(), div_usage)
    }
}

/// Removes terminal hyperlinks (`ESC ] 8 ; ; url BEL text ESC ] 8 ; ; BEL`, as the reference writes them; the terminator can
/// also be `ESC \`), keeping the text.
pub fn strip_hyperlinks(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("\x1b]8;;") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 5..];
        // the first terminator (one pass: searching for each kind separately over the whole rest is quadratic)
        let end = after.char_indices().find_map(|(i, c)| match c {
            '\x07' => Some((i, 1)),
            '\x1b' if after[i + 1..].starts_with('\\') => Some((i, 2)),
            _ => None,
        });
        match end {
            Some((i, len)) => rest = &after[i + len..],
            None => {
                // not terminated: keep the rest as it is
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// The bottlenecks and limits from the text of `facile::format_bottlenecks` (the text is the reference's output format, so
/// that there is one implementation of the rules).
fn parse_bottleneck_report(report: &str) -> (Vec<String>, Vec<Limit>) {
    let mut bottlenecks = Vec::new();
    let mut limits = Vec::new();
    for line in report.lines() {
        if let Some(rest) = line.strip_prefix("Bottlenecks: ").or_else(|| line.strip_prefix("Bottleneck: ")) {
            if rest != "unknown" {
                bottlenecks = rest.split(", ").map(str::to_string).collect();
            }
        } else if let Some(rest) = line.strip_prefix("  - ") {
            if let Some((name, value)) = rest.split_once(": ") {
                if let Ok(tp) = value.parse() {
                    limits.push(Limit { name: name.to_string(), tp });
                }
            }
        }
    }
    (bottlenecks, limits)
}

/// Runs an analysis of decoded instructions. `decode_errors` is passed through to the response. `data` must be the instruction
/// table of the configuration (`uarch.configs[request.arch].name`).
pub fn analyze(decoded: &[DecodedInstr], decode_errors: u32, request: &Request, uarch: &UArch, data: &ArchData) -> Result<Response, String> {
    let config = uarch.configs.get(&request.arch).ok_or_else(|| format!("unknown microarchitecture: {}", request.arch))?;
    let init_policy = match request.init_policy.as_str() {
        "diff" => InitPolicy::Diff,
        "same" => InitPolicy::Same,
        "stack" => InitPolicy::Stack,
        other => return Err(format!("unknown initPolicy: {other}")),
    };
    if decoded.is_empty() {
        return Err("no instructions found".to_string());
    }
    let options = SimOptions {
        alignment_offset: request.alignment_offset,
        init_policy,
        simple_front_end: request.simple_front_end,
        min_iterations: request.min_iterations,
        min_cycles: request.min_cycles,
    };

    // The port of the reference keeps its failure modes: where the Python code raises an exception, the Rust code returns an
    // error or panics. A panic is turned into an error here (not in WebAssembly, where a panic aborts the call).
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Response, String> {
        let instrs = build_instructions(decoded, config, uarch, data, request.alignment_offset, request.no_micro_fusion, request.no_macro_fusion);
        let r = simulate(&instrs, config, uarch, &options).map_err(|e| e.to_string())?;
        let dep_limit = facile::compute_dependency_limit(&instrs, config, &request.init_policy);
        let report =
            facile::format_bottlenecks(&facile::bottleneck_values_for(&instrs, decoded, config, request.alignment_offset, dep_limit, &r));
        // the uop table: its text and its lines, from one computation of its values
        let table_data = r.uops_table_data();
        let table = r.format_uops_table(&table_data);
        let text_with_hyperlinks = format!("Throughput (in cycles per iteration): {:.2}\n{report}\n{table}\n", r.tp);
        let (bottlenecks, limits) = parse_bottleneck_report(&report);

        let kinds: Vec<(&'static str, Option<usize>)> = (0..table_data.rows.len()).map(|line| table_data.line(line)).collect();
        let columns = table_data.columns;
        let rows = kinds
            .into_iter()
            .zip(table_data.rows)
            .zip(table_data.notes)
            .map(|(((kind, instr), values), note)| {
                let instr = instr.map(|i| &instrs.instrs[i]);
                Row {
                    kind,
                    label: match kind {
                        "regMerge" => "<Register Merge Uop>".to_string(),
                        "stackSync" => "<Stack Sync Uop>".to_string(),
                        _ => instr.map(|i| i.asm.clone()).unwrap_or_default(),
                    },
                    opcode: instr.map(|i| i.opcode.clone()),
                    instr_str: instr.map(|i| i.instr_str.clone()),
                    url: instr.filter(|i| !i.is_unknown).map(|i| crate::sim::get_url(&i.instr_str)),
                    notes: note.to_string(),
                    values,
                }
            })
            .collect();

        Ok(Response {
            arch: request.arch.clone(),
            tp: r.tp,
            mode: if r.unroll { "unroll" } else { "loop" },
            decode_errors,
            bottlenecks,
            limits,
            columns,
            rows,
            text: strip_hyperlinks(&text_with_hyperlinks),
            text_with_hyperlinks,
            trace: request.include_trace.then(|| r.to_json()),
        })
    }));
    match result {
        Ok(r) => r,
        Err(panic) => {
            let message = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()));
            Err(format!("the analysis failed (the reference fails for this input as well): {}", message.unwrap_or_default()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::strip_hyperlinks;

    #[test]
    fn hyperlinks_are_removed() {
        assert_eq!(strip_hyperlinks("a \x1b]8;;https://x.y/z\x07add rax, rbx\x1b]8;;\x07 b"), "a add rax, rbx b");
        assert_eq!(strip_hyperlinks("\x1b]8;;u\x1b\\t\x1b]8;;\x1b\\"), "t");
        assert_eq!(strip_hyperlinks("no links"), "no links");
    }
}
