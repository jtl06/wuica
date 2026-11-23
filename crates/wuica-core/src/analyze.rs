//! A complete analysis: decoded instructions -> instruction objects -> simulation -> bottleneck analysis -> a response with the
//! structure described in docs/WASM-API.md. This is what the command-line tool and the WebAssembly interface call.

use crate::config::UArch;
use crate::data::ArchData;
use crate::decoded::DecodedInstr;
use crate::facile::{self, InstrInstanceSummary, InstrSource, SimSummary, UopSummary};
use crate::instr_builder::build_instructions;
use crate::sim::{simulate, InitPolicy, SimOptions, SimResult, TableValue, UopSource};
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
                            source: match inst.source {
                                Some(UopSource::Mite) => Some(InstrSource::Mite),
                                Some(UopSource::Dsb) => Some(InstrSource::Dsb),
                                Some(UopSource::Lsd) => Some(InstrSource::Lsd),
                                _ => None,
                            },
                            uops: unfused(&mut inst.uops()),
                            other_uops: unfused(&mut inst.reg_merge_uops.iter().chain(&inst.stack_sync_uops).copied()),
                        }
                    })
                    .collect()
            })
            .collect(),
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
        let bel = after.find('\x07').map(|i| (i, 1));
        let st = after.find("\x1b\\").map(|i| (i, 2));
        let end = match (bel, st) {
            (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
            (a, b) => a.or(b),
        };
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
        let summary = sim_summary(&r);
        let dep_limit = facile::compute_dependency_limit(&instrs, config, &request.init_policy);
        let report = facile::bottleneck_report(&instrs, decoded, config, request.alignment_offset, dep_limit, &summary);
        let table = r.uops_table();
        let text_with_hyperlinks = format!("Throughput (in cycles per iteration): {:.2}\n{report}\n{table}\n", r.tp);
        let (bottlenecks, limits) = parse_bottleneck_report(&report);

        // the lines of the table: for each instruction, a line for its register merge uops and one for its stack sync uops
        // (if any instance in the relevant rounds has such uops), then the instruction
        let mut meta: Vec<(&'static str, String, Option<usize>)> = Vec::new();
        for (i, instr) in instrs.instrs.iter().enumerate() {
            let instances = &r.relevant_instr_instances_for_instr[i];
            if instances.iter().any(|&ii| !r.instr_instances[ii as usize].reg_merge_uops.is_empty()) {
                meta.push(("regMerge", "<Register Merge Uop>".to_string(), None));
            }
            if instances.iter().any(|&ii| !r.instr_instances[ii as usize].stack_sync_uops.is_empty()) {
                meta.push(("stackSync", "<Stack Sync Uop>".to_string(), None));
            }
            meta.push(("instr", instr.asm.clone(), Some(i)));
        }
        let table_columns = r.uops_table_columns();
        if table_columns.iter().any(|(_, values)| values.len() != meta.len()) {
            return Err("internal error: the uop table has an unexpected number of lines".to_string());
        }
        let notes: Vec<String> = match table_columns.iter().find(|(name, _)| name == "Notes") {
            Some((_, values)) => values.iter().map(|v| if let TableValue::Text(t) = v { t.clone() } else { String::new() }).collect(),
            None => vec![String::new(); meta.len()],
        };
        let number_columns: Vec<&(String, Vec<TableValue>)> = table_columns.iter().filter(|(name, _)| name != "Notes").collect();
        let rows = meta
            .into_iter()
            .enumerate()
            .map(|(line, (kind, label, instr))| {
                let instr = instr.map(|i| &instrs.instrs[i]);
                Row {
                    kind,
                    label,
                    opcode: instr.map(|i| i.opcode.clone()),
                    instr_str: instr.map(|i| i.instr_str.clone()),
                    url: instr.filter(|i| !i.is_unknown).map(|i| crate::sim::get_url(&i.instr_str)),
                    notes: if notes[line] == "0" { String::new() } else { notes[line].clone() },
                    values: number_columns.iter().map(|(_, values)| if let TableValue::Number(v) = values[line] { v } else { 0.0 }).collect(),
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
            columns: number_columns.iter().map(|(name, _)| name.clone()).collect(),
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
