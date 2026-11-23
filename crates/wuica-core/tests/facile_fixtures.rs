//! Checks the bottleneck analysis (`wuica_core::facile`) against the text that the Python reference prints after
//! "Throughput (in cycles per iteration): X" (`printBottlenecks`; the `stdout` field of the simulation fixtures), for every
//! simulation case that has an instruction fixture, in the main and the extra set.
//!
//! What is compared, per case:
//! - Predecoder, Decoder, DSB, LSD: whether such an entry is printed depends on the simulation (where the instructions of the
//!   relevant rounds came from); where the reference prints one, the number must be the same.
//! - Issue, Dependencies: the entry is printed if and only if the limit is not 0, with the same number.
//! - Ports: if no instruction may be eliminated, the limit does not depend on the simulation, and presence and number must be
//!   the same. Otherwise, the average number of non-eliminated uops is taken from the "Exec." column of the printed table
//!   (two decimals), and the result is counted as equal, close (within 0.011) or different.
//! - The whole text (`format_bottlenecks`): with the limits above (the Ports limit from the reference where it depends on the
//!   simulation) and the port and divider usage per round from the "Total" line of the table (two decimals). The text must be
//!   the same; if it is only the same with a usage that differs by 0.01, the case is counted as "near a threshold".
//! - `bottleneck_report` over a `SimSummary` made from the same values (sources as the printed entries imply).

use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use wuica_core::config::{UArch, UArchConfig};
use wuica_core::decoded::DecodedInstr;
use wuica_core::facile::*;
use wuica_core::model::{Instr, InstrList, Operand};

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

fn lines(path: &str) -> impl Iterator<Item = String> {
    wuica_testkit::lines(path)
}

#[derive(Deserialize)]
struct DecodeLine {
    file: String,
    chip: String,
    instrs: Vec<DecodedInstr>,
}

#[derive(Deserialize)]
struct InstrLineHead {
    file: String,
    arch: String,
    options: serde_json::Value,
}

#[derive(Deserialize)]
struct InstrLine {
    error: Option<String>,
    operands: Option<Vec<Operand>>,
    instrs: Option<Vec<Instr>>,
}

#[derive(Deserialize)]
struct SimLine {
    file: String,
    arch: String,
    options: serde_json::Value,
    error: Option<String>,
    #[serde(rename = "TP")]
    tp: Option<f64>,
    stdout: Option<String>,
}

/// (file, arch, alignmentOffset, noMicroFusion, noMacroFusion): the options that the instruction objects depend on
type Key = (String, String, i64, bool, bool);

fn key(file: &str, arch: &str, options: &serde_json::Value) -> Key {
    (
        file.to_string(),
        arch.to_string(),
        options.get("alignmentOffset").and_then(|v| v.as_i64()).unwrap_or(0),
        options.get("noMicroFusion").and_then(|v| v.as_bool()).unwrap_or(false),
        options.get("noMacroFusion").and_then(|v| v.as_bool()).unwrap_or(false),
    )
}

/// What the reference printed for a simulation case.
struct SimCase {
    name: String,
    init_policy: String,
    tp: f64,
    /// the output up to the table
    head: String,
    /// the entries of the list of limits: (name, number as printed)
    entries: Vec<(String, String)>,
    table: Result<Table, String>,
}

impl SimCase {
    fn entry(&self, name: &str) -> Option<&str> {
        self.entries.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

/// The values of the printed table of uops that the test uses.
struct Table {
    /// the "Exec." column of the lines of the instructions (without the lines for register merge and stack sync uops)
    exec: Vec<f64>,
    /// the largest value of the port columns in the "Total" line
    max_port_total: Option<f64>,
    /// the "Div" column in the "Total" line
    div_total: f64,
}

fn parse_table(stdout: &str, port_names: &[String]) -> Result<Table, String> {
    let lines: Vec<&str> = stdout.lines().collect();
    let top = lines.iter().position(|l| l.starts_with('\u{250c}')).ok_or("no table")?;
    let header: Vec<char> = lines[top + 1].chars().collect();
    let bars: Vec<usize> = header.iter().enumerate().filter(|(_, c)| **c == '\u{2502}').map(|(i, _)| i).collect();
    if bars.len() != 5 && bars.len() != 6 {
        return Err(format!("{} column groups", bars.len()));
    }
    let group = |row: &[char], k: usize| -> Result<String, String> {
        if row.len() <= bars[k + 1] || row[bars[k]] != '\u{2502}' || row[bars[k + 1]] != '\u{2502}' {
            return Err("row does not match the header".to_string());
        }
        Ok(row[bars[k] + 1..bars[k + 1]].iter().collect())
    };

    // the columns of the group of the ports: the ports and, if there are uops that use the divider, "Div"
    let ports_header = group(&header, 3)?;
    let mut names: Vec<&str> = port_names.iter().map(|n| n.as_str()).collect();
    if ports_header.trim_end().ends_with(" Div") {
        names.push("Div");
    }
    let mut centers = Vec::new();
    let mut pos = 0;
    for name in &names {
        let i = ports_header[pos..].find(name).ok_or_else(|| format!("column {name} not found"))? + pos;
        centers.push(i as f64 + name.len() as f64 / 2.0);
        pos = i + name.len();
    }

    let mut exec = Vec::new();
    let mut i = top + 3;
    while !lines.get(i).ok_or("table without end")?.starts_with('\u{251c}') {
        let row: Vec<char> = lines[i].chars().collect();
        let label: String = row[bars[bars.len() - 1] + 1..].iter().collect();
        let value = group(&row, 2)?;
        if !["<Register Merge Uop>", "<Stack Sync Uop>"].contains(&label.trim()) {
            exec.push(if value.trim().is_empty() { 0.0 } else { value.trim().parse::<f64>().map_err(|e| e.to_string())? });
        }
        i += 1;
    }

    let total: Vec<char> = lines.get(i + 1).ok_or("no Total line")?.chars().collect();
    let ports_total: Vec<char> = group(&total, 3)?.chars().collect();
    let (mut max_port_total, mut div_total) = (None, 0.0);
    let mut start = 0;
    while start < ports_total.len() {
        if ports_total[start] == ' ' {
            start += 1;
            continue;
        }
        let end = (start..ports_total.len()).find(|&j| ports_total[j] == ' ').unwrap_or(ports_total.len());
        let value: f64 = ports_total[start..end].iter().collect::<String>().parse().map_err(|e| format!("Total: {e}"))?;
        let center = start as f64 + (end - start) as f64 / 2.0;
        let (col, dist) = centers.iter().map(|c| (c - center).abs()).enumerate().fold((0, f64::MAX), |b, c| if c.1 < b.1 { c } else { b });
        if dist > 1.0 {
            return Err(format!("Total: value at {start} is not under a column"));
        }
        if names[col] == "Div" {
            div_total = value;
        } else if max_port_total.is_none_or(|m| value > m) {
            max_port_total = Some(value);
        }
        start = end;
    }
    Ok(Table { exec, max_port_total, div_total })
}

fn port_names(config: &UArchConfig, uarch: &UArch) -> Vec<String> {
    config.ports(uarch).iter().map(|p| config.port_names.get(p).cloned().unwrap_or_else(|| format!("Port {p}"))).collect()
}

#[derive(Default)]
struct Stats {
    counts: BTreeMap<&'static str, usize>,
    failures: BTreeMap<&'static str, Vec<String>>,
}

impl Stats {
    fn count(&mut self, what: &'static str) {
        *self.counts.entry(what).or_default() += 1;
    }

    fn fail(&mut self, kind: &'static str, message: String) {
        self.failures.entry(kind).or_default().push(message);
    }

    fn print(&self, title: &str) {
        println!("== {title} ==");
        for (what, n) in &self.counts {
            println!("{n:6} {what}");
        }
        for (kind, messages) in &self.failures {
            println!("FAILED {kind}: {} cases", messages.len());
            let shown = std::env::var("WUICA_FACILE_SHOW").ok().and_then(|n| n.parse().ok()).unwrap_or(5);
            for m in messages.iter().take(shown) {
                println!("   {m}");
            }
        }
    }

    fn assert_no_failures(&self) {
        let n_failures: usize = self.failures.values().map(|m| m.len()).sum();
        let kinds: Vec<String> = self.failures.iter().map(|(k, m)| format!("{k}: {}", m.len())).collect();
        assert!(n_failures == 0, "{n_failures} differences ({})", kinds.join("; "));
    }
}

fn load_sim_cases(path: &str, uarch: &UArch, stats: &mut Stats) -> HashMap<Key, Vec<SimCase>> {
    let mut cases: HashMap<Key, Vec<SimCase>> = HashMap::new();
    for line in wuica_testkit::lines_without_json(path) {
        let l: SimLine = serde_json::from_str(&line).unwrap();
        stats.count("simulation cases");
        if l.error.is_some() {
            stats.count("  skipped: the reference failed (error)");
            continue;
        }
        let stdout = l.stdout.unwrap();
        let head = stdout.split('\u{250c}').next().unwrap().to_string();
        let entries = head
            .lines()
            .filter_map(|l| l.strip_prefix("  - "))
            .map(|l| l.split_once(": ").map(|(n, v)| (n.to_string(), v.to_string())).expect("entry"))
            .collect();
        let config = &uarch.configs[&l.arch];
        cases.entry(key(&l.file, &l.arch, &l.options)).or_default().push(SimCase {
            name: format!("{} {} {}", l.file, l.arch, l.options),
            init_policy: l.options.get("initPolicy").and_then(|v| v.as_str()).unwrap_or("diff").to_string(),
            tp: l.tp.unwrap(),
            head,
            entries,
            table: parse_table(&stdout, &port_names(config, uarch)),
        });
    }
    cases
}

/// The uops of `n` instances of an instruction, `count` uops in the first one.
fn instances_with(n: usize, uop: &UopSummary, count: i64, other: bool) -> Vec<InstrInstanceSummary> {
    let mut list = vec![InstrInstanceSummary::default(); n];
    let uops = vec![uop.clone(); count as usize];
    if other {
        list[0].other_uops = uops;
    } else {
        list[0].uops = uops;
    }
    list
}

fn check(sim: &SimCase, list: &InstrList, disas: &[DecodedInstr], config: &UArchConfig, alignment_offset: i64, stats: &mut Stats) {
    const N_ROUNDS: usize = 100; // the table has two decimals
    let name = &sim.name;
    let is_loop = list.instrs.last().unwrap().is_branch_instr;

    // the limits of the front end: the entry depends on the simulation, the number does not
    let front_end: [(&'static str, &'static str, f64); 4] = [
        ("Predecoder", "number: Predecoder", compute_predec_limit(disas, is_loop, alignment_offset)),
        ("Decoder", "number: Decoder", compute_dec_limit(list, config)),
        ("DSB", "number: DSB", compute_dsb_limit(list, alignment_offset)),
        ("LSD", "number: LSD", compute_lsd_limit(list, config)),
    ];
    let mut front_end_limits = [None; 4];
    for (i, (entry, kind, limit)) in front_end.iter().enumerate() {
        if let Some(expected) = sim.entry(entry) {
            stats.count(kind);
            front_end_limits[i] = Some(*limit);
            let rounded = py_round2(*limit);
            if rounded == 0.0 || py_format2(rounded) != expected {
                stats.fail(kind, format!("{name}: {limit} instead of {expected}"));
            }
        }
    }

    // limits that do not depend on the simulation
    let issue_limit = compute_issue_limit(list, config);
    let dep_limit = compute_dependency_limit(list, config, &sim.init_policy);
    let issue_text = (py_round2(issue_limit) != 0.0).then(|| py_format2(py_round2(issue_limit)));
    let dep_text = (dep_limit != 0.0).then(|| py_format2(dep_limit));
    for (entry, kind, text) in [("Issue", "number: Issue", issue_text), ("Dependencies", "number: Dependencies", dep_text)] {
        stats.count(kind);
        if text.as_deref() != sim.entry(entry) {
            stats.fail(kind, format!("{name}: {text:?} instead of {:?}", sim.entry(entry)));
        }
    }

    let table = match &sim.table {
        Ok(table) if table.exec.len() == list.instrs.len() => table,
        Ok(table) => return stats.fail("table of the reference", format!("{name}: {} lines of instructions", table.exec.len())),
        Err(e) => return stats.fail("table of the reference", format!("{name}: {e}")),
    };

    // Ports
    let depends_on_sim = |i: &Instr| !i.macro_fused_with_prev_instr && i.may_be_eliminated && !i.port_data.is_empty();
    let ports_static = !list.instrs.iter().any(depends_on_sim);
    let not_eliminated = UopSummary { actual_port: None, eliminated: false, div_cycles: 0 };
    let mut instances: Vec<Vec<InstrInstanceSummary>> = (list.instrs.iter().zip(&table.exec))
        .map(|(i, exec)| instances_with(N_ROUNDS, &not_eliminated, if depends_on_sim(i) { (exec * N_ROUNDS as f64).round() as i64 } else { 0 }, false))
        .collect();
    let computed_port_limit = compute_port_usage_limit(list, Some(&instances));
    let port_text = (py_round2(computed_port_limit) != 0.0).then(|| py_format2(py_round2(computed_port_limit)));
    let expected_port_limit: f64 = sim.entry("Ports").map_or(0.0, |v| v.parse().unwrap());
    let ports_equal = port_text.as_deref() == sim.entry("Ports");
    if ports_static {
        stats.count("number: Ports (independent of the simulation)");
        if !ports_equal || compute_port_usage_limit(list, None) != computed_port_limit {
            stats.fail("number: Ports (independent of the simulation)", format!("{name}: {port_text:?} instead of {:?}", sim.entry("Ports")));
        }
    } else if ports_equal {
        stats.count("number: Ports (eliminated uops from the table): equal");
    } else if (computed_port_limit - expected_port_limit).abs() <= 0.011 {
        stats.count("number: Ports (eliminated uops from the table): within 0.011 (not verified)");
    } else {
        stats.count("number: Ports (eliminated uops from the table): different");
        stats.fail("number: Ports (eliminated uops from the table)", format!("{name}: {port_text:?} instead of {:?}", sim.entry("Ports")));
    }

    // the text
    let hundredths = |v: f64| (v * N_ROUNDS as f64).round() as i64;
    let values = BottleneckValues {
        tp: sim.tp,
        predec_limit: front_end_limits[0],
        dec_limit: front_end_limits[1],
        dsb_limit: front_end_limits[2],
        lsd_limit: front_end_limits[3],
        issue_limit,
        port_usage_limit: if ports_static { computed_port_limit } else { expected_port_limit },
        max_port_usage: table.max_port_total.map(hundredths),
        div_usage: hundredths(table.div_total),
        n_rounds: N_ROUNDS as i64,
        dep_limit,
    };
    let is_expected = |report: &str| sim.head.starts_with(&format!("Throughput (in cycles per iteration): {}\n{report}\n", py_format2(sim.tp)));
    stats.count("text");
    let report = format_bottlenecks(&values);
    if is_expected(&report) {
        stats.count("  text: equal");
    } else {
        // the usage per round is only known to two decimals: Scheduling and Divider cannot be decided near their thresholds
        let near = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)].iter().any(|(dp, dd)| {
            let v = BottleneckValues { max_port_usage: values.max_port_usage.map(|m| m + dp), div_usage: values.div_usage + dd, ..values.clone() };
            is_expected(&format_bottlenecks(&v))
        });
        if near {
            stats.count("  text: equal if the port or divider usage differs by 0.01 (near a threshold: not verified)");
        } else {
            stats.fail("text", format!("{name}:\n{report}--- instead of ---\n{}", sim.head));
        }
        return;
    }

    // the same through bottleneck_report, with a summary of a simulation that would give these values
    if !ports_static && !ports_equal {
        return stats.count("  report from a summary: skipped (Ports limit not reproduced from the table)");
    }
    let sources: Vec<InstrSource> = [(1, InstrSource::Mite), (2, InstrSource::Dsb), (3, InstrSource::Lsd)]
        .iter()
        .filter(|(i, _)| front_end_limits[*i].is_some())
        .map(|(_, s)| *s)
        .collect();
    if sources.len() > list.instrs.len() {
        return stats.count("  report from a summary: skipped (fewer instructions than sources)");
    }
    for (i, source) in sources.iter().enumerate() {
        instances[i][0].source = Some(*source);
    }
    let on_port = UopSummary { actual_port: Some("0".to_string()), eliminated: true, div_cycles: 0 };
    instances[0][0].other_uops = vec![on_port; values.max_port_usage.unwrap_or(0) as usize];
    instances[0][1].other_uops = vec![UopSummary { actual_port: None, eliminated: true, div_cycles: values.div_usage }];
    let summary = SimSummary { tp: sim.tp, is_loop, n_rounds: N_ROUNDS as i64, instances };
    stats.count("report from a summary");
    let report2 = bottleneck_report(list, disas, config, alignment_offset, dep_limit, &summary);
    if report2 != report {
        stats.fail("report from a summary", format!("{name}:\n{report2}--- instead of ---\n{report}"));
    }
}

fn load_decoded(path: &str) -> HashMap<(String, String), Vec<DecodedInstr>> {
    let mut decoded = HashMap::new();
    for line in lines(path) {
        let l: DecodeLine = serde_json::from_str(&line).unwrap();
        decoded.insert((l.file, l.chip), l.instrs);
    }
    decoded
}

/// Calls `f` for the instruction fixtures whose key is wanted, with the instructions (`None`: the fixture has an error), the
/// configuration and the decoded records.
fn for_each_instr_case(
    decode: &str,
    instr: &str,
    uarch: &UArch,
    wanted: impl Fn(&Key) -> bool,
    mut f: impl FnMut(&Key, Option<&InstrList>, &UArchConfig, &[DecodedInstr]),
) {
    let decoded = load_decoded(decode);
    for line in lines(instr) {
        let head: InstrLineHead = serde_json::from_str(&line).unwrap();
        let k = key(&head.file, &head.arch, &head.options);
        if !wanted(&k) {
            continue;
        }
        let l: InstrLine = serde_json::from_str(&line).unwrap();
        let list = l.error.is_none().then(|| InstrList { operands: l.operands.unwrap(), instrs: l.instrs.unwrap() });
        let config = &uarch.configs[&head.arch];
        f(&k, list.as_ref(), config, &decoded[&(head.file.clone(), config.xed_name.clone())]);
    }
}

/// Runs `f` with its own statistics and adds them to `stats`; a panic is a failure of the kind "panic".
fn guarded(stats: &mut Stats, name: &str, f: impl FnOnce(&mut Stats)) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut s = Stats::default();
        f(&mut s);
        s
    }));
    match result {
        Ok(s) => {
            for (what, n) in s.counts {
                *stats.counts.entry(what).or_default() += n;
            }
            for (kind, messages) in s.failures {
                stats.failures.entry(kind).or_default().extend(messages);
            }
        }
        Err(e) => stats.fail("panic", format!("{name}: {}", panic_message(&e))),
    }
}

fn panic_message(e: &Box<dyn std::any::Any + Send>) -> String {
    e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
}

fn run_set(name: &str, decode: &str, instr: &str, sim: &str, uarch: &UArch) -> Stats {
    let mut stats = Stats::default();
    let sims = std::cell::RefCell::new(load_sim_cases(sim, uarch, &mut stats));

    for_each_instr_case(decode, instr, uarch, |k| sims.borrow().contains_key(k), |k, list, config, disas| {
        let cases = sims.borrow_mut().remove(k).unwrap();
        let Some(list) = list else {
            for _ in &cases {
                stats.count("  skipped: the instruction fixture has an error");
            }
            return;
        };
        for case in &cases {
            stats.count("compared");
            *stats.counts.entry(Box::leak(format!("  compared for {}", k.1).into_boxed_str())).or_default() += 1;
            guarded(&mut stats, &case.name, |s| check(case, list, disas, config, k.2, s));
        }
    });
    let sims = sims.into_inner();
    for cases in sims.values() {
        for _ in cases {
            stats.count("  skipped: no instruction fixture (block of more than 2000 bytes)");
        }
    }

    stats.print(&format!("{name} set"));
    stats
}

fn uarch() -> UArch {
    UArch::from_json(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap()
}

fn assert_no_failures(stats: &Stats, min_cases: usize) {
    stats.assert_no_failures();
    assert!(stats.counts["compared"] >= min_cases, "only {} cases", stats.counts["compared"]);
    assert_eq!(stats.counts.keys().filter(|k| k.starts_with("  compared for ")).count(), 19, "configurations");
}

#[test]
fn bottlenecks_of_the_main_set() {
    let stats = run_set(
        "main",
        "fixtures/decode_fixtures.jsonl.gz",
        "fixtures/generated/instr_fixtures.jsonl.gz",
        "fixtures/generated/sim_fixtures.jsonl.gz",
        &uarch(),
    );
    assert_no_failures(&stats, 9000);
}

#[test]
fn bottlenecks_of_the_extra_set() {
    let stats = run_set(
        "extra",
        "fixtures/decode_fixtures_extra.jsonl.gz",
        "fixtures/generated/extra_instr_fixtures.jsonl.gz",
        "fixtures/generated/extra_sim_fixtures.jsonl.gz",
        &uarch(),
    );
    assert_no_failures(&stats, 5000);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Exact results of the reference's functions
// ---------------------------------------------------------------------------------------------------------------------------
//
// The printed text cannot show everything: numbers have two decimals, the limits of the front end are only printed for some
// cases, and the options of the fixtures do not reach every path. The lines below are results of the reference's own
// functions, called on the instruction objects of the instruction fixtures (rebuilt from the JSON) over a grid of parameters:
// floats as `repr`, the latency graph as a checksum of its nodes, edges, components and longest cycle, and the text of
// `printBottlenecks` for made-up results of a simulation. `REFERENCE_SAMPLE` is a small part of such a sweep; a whole sweep
// (a gzip file with one line per instruction fixture) is compared if the environment variable `WUICA_FACILE_SWEEP` names it.

#[derive(Deserialize)]
struct SweepLine {
    file: String,
    arch: String,
    options: serde_json::Value,
    /// a change that is made to the instructions of the fixture before the functions are called (see `apply_patch`)
    patch: Option<String>,
    /// the instruction objects, for a block that is not in the fixtures (then `file` is only a name)
    operands: Option<Vec<Operand>>,
    instrs: Option<Vec<Instr>>,
    /// (loop, alignmentOffset, computePredecLimit)
    #[serde(default)]
    predec: Vec<(u8, i64, String)>,
    /// (alignmentOffset, computeDSBLimit)
    #[serde(default)]
    dsb: Vec<(i64, String)>,
    dec: Option<String>,
    lsd: Option<String>,
    issue: Option<String>,
    /// computePortUsageLimit(instructions)
    ports: Option<String>,
    /// initPolicy -> (maxCycleRatio, checksum of the graph)
    #[serde(default)]
    dep: BTreeMap<String, (String, String)>,
    #[serde(default)]
    summaries: Vec<SweepSummary>,
}

/// A call of `printBottlenecks` with made-up instruction instances.
#[derive(Deserialize)]
struct SweepSummary {
    tp: String,
    #[serde(rename = "loop")]
    is_loop: bool,
    ao: i64,
    #[serde(rename = "nRounds")]
    n_rounds: i64,
    dep: String,
    /// per instruction, its instances: "source|uops|register merge and stack sync uops", a uop is port, e(liminated) or n, divCycles
    inst: Vec<Vec<String>>,
    /// computePortUsageLimit(instructions, instrInstancesForInstr)
    ports: String,
    text: Option<String>,
    error: Option<String>,
}

fn parse_instance(s: &str) -> InstrInstanceSummary {
    let parts: Vec<&str> = s.split('|').collect();
    let uops = |s: &str| -> Vec<UopSummary> {
        s.split_whitespace()
            .map(|t| {
                let mut c = t.chars();
                let (port, eliminated) = (c.next().unwrap(), c.next().unwrap() == 'e');
                UopSummary { actual_port: (port != '-').then(|| port.to_string()), eliminated, div_cycles: c.as_str().parse().unwrap() }
            })
            .collect()
    };
    let source = match parts[0] {
        "M" => Some(InstrSource::Mite),
        "D" => Some(InstrSource::Dsb),
        "L" => Some(InstrSource::Lsd),
        _ => None,
    };
    InstrInstanceSummary { source, uops: uops(parts[1]), other_uops: uops(parts[2]) }
}

/// Compares a value with the `repr` of the reference's value; "error:Name" means that the reference raised an exception, and
/// the port must panic.
fn check_exact(stats: &mut Stats, kind: &'static str, name: &str, expected: &str, f: impl FnOnce() -> f64) {
    stats.count(kind);
    let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    match (got, expected.strip_prefix("error:")) {
        (Err(_), Some(_)) => {}
        (Ok(v), None) => {
            let e: f64 = expected.parse().unwrap();
            if v.to_bits() != e.to_bits() && !(v == 0.0 && e == 0.0) {
                stats.fail(kind, format!("{name}: {v:?} instead of {expected}"));
            }
        }
        (Ok(v), Some(error)) => stats.fail(kind, format!("{name}: {v:?}, but the reference raises {error}")),
        (Err(e), None) => stats.fail(kind, format!("{name}: panic ({}) instead of {expected}", panic_message(&e))),
    }
}

/// The nodes, edges, strongly connected components and the longest cycle of a latency graph, as text.
fn graph_string(graph: &LatencyGraph, max: &MaximumLatency) -> String {
    let ids = |l: &[u32]| l.iter().map(|o| o.to_string()).collect::<Vec<_>>().join(",");
    let edges = |l: &[LatGraphEdge]| l.iter().map(|e| format!("{}/{}/{}/{}", e.source, e.target, e.cost, e.time)).collect::<Vec<_>>().join(",");
    let mut s = String::from("N");
    for nodes in &graph.nodes_for_instr {
        s += &format!("{};", ids(nodes));
    }
    s += "E";
    for (node, e) in &graph.edges_for_node {
        s += &format!("{node}:{};", edges(e));
    }
    s += "C";
    for comp in &max.components {
        s += &format!("{};", ids(comp));
    }
    s + "M" + &edges(&max.edges_on_max_cycle)
}

/// The 32-bit register of a 64-bit general-purpose register.
fn to32(reg: &str) -> String {
    if ["RAX", "RBX", "RCX", "RDX", "RSI", "RDI", "RBP", "RSP"].contains(&reg) {
        format!("E{}", &reg[1..])
    } else if ["R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15"].contains(&reg) {
        format!("{reg}D")
    } else {
        reg.to_string()
    }
}

/// The instructions of a fixture with a change that makes them reach a path that the fixtures do not reach (the sweep made
/// the same change to the reference's objects):
/// - `base32`: the base registers of the memory operands are 32-bit registers
/// - `mov32`: the moves that may be eliminated write 32-bit registers
/// - `inc`: ADD and SUB are called INC and DEC
/// - `cmov`: MOV instructions are called CMOV
/// - `ports3`: the moves that may be eliminated use the first port, the second port, or one of both, in turn
fn apply_patch(patch: &str, list: &InstrList, ports: &[String]) -> InstrList {
    let mut list = list.clone();
    match patch {
        "base32" => {
            for o in &mut list.operands {
                if let Operand::Mem { mem_addr } = o {
                    mem_addr.base = mem_addr.base.as_deref().map(to32);
                }
            }
        }
        "mov32" => {
            for i in list.instrs.iter().filter(|i| i.may_be_eliminated) {
                if let Operand::Reg { reg, .. } = &mut list.operands[i.output_reg_operands[0] as usize] {
                    *reg = to32(reg);
                }
            }
        }
        "inc" => {
            for i in &mut list.instrs {
                i.instr_str = i.instr_str.replace("ADD", "INC").replace("SUB", "DEC");
            }
        }
        "cmov" => {
            for i in &mut list.instrs {
                if i.instr_str.contains("MOV") && !i.instr_str.contains("CMOV") {
                    i.instr_str = i.instr_str.replace("MOV", "CMOV");
                }
            }
        }
        "ports3" => {
            let sets = [ports[0].clone(), ports[1].clone(), format!("{}{}", ports[0], ports[1])];
            for (n, i) in list.instrs.iter_mut().filter(|i| i.may_be_eliminated && !i.macro_fused_with_prev_instr).enumerate() {
                i.port_data = vec![(sets[n % 3].clone(), 1)];
            }
        }
        _ => panic!("unknown patch {patch}"),
    }
    list
}

fn check_sweep_line(l: &SweepLine, list: &InstrList, disas: &[DecodedInstr], config: &UArchConfig, ports: &[String], stats: &mut Stats) {
    let name = format!("{} {} {}{}", l.file, l.arch, l.options, l.patch.as_ref().map(|p| format!(" patch={p}")).unwrap_or_default());
    let patched = l.patch.as_ref().map(|p| apply_patch(p, list, ports));
    let list = patched.as_ref().unwrap_or(list);
    for (is_loop, ao, expected) in &l.predec {
        let name = format!("{name} loop={is_loop} alignmentOffset={ao}");
        check_exact(stats, "exact: computePredecLimit", &name, expected, || compute_predec_limit(disas, *is_loop != 0, *ao));
    }
    for (ao, expected) in &l.dsb {
        check_exact(stats, "exact: computeDSBLimit", &format!("{name} alignmentOffset={ao}"), expected, || compute_dsb_limit(list, *ao));
    }
    if let Some(expected) = &l.dec {
        check_exact(stats, "exact: computeDecLimit", &name, expected, || compute_dec_limit(list, config));
    }
    if let Some(expected) = &l.lsd {
        check_exact(stats, "exact: computeLSDLimit", &name, expected, || compute_lsd_limit(list, config));
    }
    if let Some(expected) = &l.issue {
        check_exact(stats, "exact: computeIssueLimit", &name, expected, || compute_issue_limit(list, config));
    }
    if let Some(expected) = &l.ports {
        check_exact(stats, "exact: computePortUsageLimit without instances", &name, expected, || compute_port_usage_limit(list, None));
    }
    for (policy, (expected, expected_graph)) in &l.dep {
        let name = format!("{name} initPolicy={policy}");
        let mut graph_text = String::new();
        check_exact(stats, "exact: computeMaximumLatencyForGraph", &name, expected, || {
            let graph = generate_latency_graph(list, config, policy);
            let max = compute_maximum_latency_for_graph(list, &graph);
            graph_text = graph_string(&graph, &max);
            max.max_cycle_ratio
        });
        if !expected.starts_with("error:") {
            stats.count("exact: latency graph (nodes, edges, components, longest cycle)");
            let mut crc = flate2::Crc::new();
            crc.update(graph_text.as_bytes());
            let checksum = format!("{}:{:08x}", graph_text.len(), crc.sum());
            if checksum != *expected_graph {
                stats.fail("exact: latency graph (nodes, edges, components, longest cycle)", format!("{name}: {checksum} instead of {expected_graph}"));
            }
        }
    }
    for (i, s) in l.summaries.iter().enumerate() {
        let name = format!("{name} summary {i}");
        let summary = SimSummary {
            tp: s.tp.parse().unwrap(),
            is_loop: s.is_loop,
            n_rounds: s.n_rounds,
            instances: s.inst.iter().map(|l| l.iter().map(|ii| parse_instance(ii)).collect()).collect(),
        };
        check_exact(stats, "exact: computePortUsageLimit with instances", &name, &s.ports, || {
            compute_port_usage_limit(list, Some(&summary.instances))
        });
        stats.count("exact: text of printBottlenecks");
        let dep_limit: f64 = s.dep.parse().unwrap();
        let report = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| bottleneck_report(list, disas, config, s.ao, dep_limit, &summary)));
        match (report, &s.text, &s.error) {
            (Ok(report), Some(text), _) if report == *text => {}
            (Err(_), None, Some(_)) => {}
            (Ok(report), Some(text), _) => stats.fail("exact: text of printBottlenecks", format!("{name}:\n{report}--- instead of ---\n{text}")),
            (Ok(report), None, error) => stats.fail("exact: text of printBottlenecks", format!("{name}:\n{report}--- but the reference raises {error:?}")),
            (Err(e), _, _) => stats.fail("exact: text of printBottlenecks", format!("{name}: panic ({})", panic_message(&e))),
        }
    }
}

fn run_sweep(title: &str, sweep_lines: impl Iterator<Item = String>) -> Stats {
    let uarch = uarch();
    let mut stats = Stats::default();
    // the key of an instruction fixture and its options (as the simulation cases have more options, the key is not enough)
    let mut sweep: HashMap<Key, Vec<SweepLine>> = HashMap::new();
    for line in sweep_lines.filter(|l| !l.trim().is_empty()) {
        let mut l: SweepLine = serde_json::from_str(&line).unwrap();
        stats.count("lines");
        if let (Some(operands), Some(instrs)) = (l.operands.take(), l.instrs.take()) {
            // a block of its own
            stats.count("lines compared");
            let config = &uarch.configs[&l.arch];
            let list = InstrList { operands, instrs };
            guarded(&mut stats, &l.file, |s| check_sweep_line(&l, &list, &[], config, config.ports(&uarch), s));
            continue;
        }
        sweep.entry(key(&l.file, &l.arch, &l.options)).or_default().push(l);
    }
    for (decode, instr) in [
        ("fixtures/decode_fixtures.jsonl.gz", "fixtures/generated/instr_fixtures.jsonl.gz"),
        ("fixtures/decode_fixtures_extra.jsonl.gz", "fixtures/generated/extra_instr_fixtures.jsonl.gz"),
    ] {
        for_each_instr_case(decode, instr, &uarch, |k| sweep.contains_key(k), |k, list, config, disas| {
            for l in &sweep[k] {
                stats.count("lines compared");
                let list = list.expect("an instruction fixture without error");
                guarded(&mut stats, &l.file, |s| check_sweep_line(l, list, disas, config, config.ports(&uarch), s));
            }
        });
    }
    stats.print(title);
    stats
}

#[test]
fn reference_sample() {
    let stats = run_sweep("sample of the reference's exact results", REFERENCE_SAMPLE.lines().map(|l| l.to_string()));
    stats.assert_no_failures();
    assert_eq!(stats.counts.get("lines"), stats.counts.get("lines compared"));
}

#[test]
fn reference_sweep() {
    let Ok(path) = std::env::var("WUICA_FACILE_SWEEP") else {
        println!("skipped: WUICA_FACILE_SWEEP is not set");
        return;
    };
    let file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let stats = run_sweep("sweep of the reference's exact results", BufReader::new(flate2::read::GzDecoder::new(file)).lines().map(|l| l.unwrap()));
    stats.assert_no_failures();
    assert_eq!(stats.counts["lines"], stats.counts["lines compared"]);
}

/// Lines of a sweep (see above), selected so that each of about 50 deliberate changes to `facile.rs` (one per branch or
/// constant of the port) makes at least one of them fail. The `syn_*` lines are blocks written for paths that no fixture
/// reaches (arithmetic on abstract values, a base register renamed by a 32-bit move, the displacement limit of fast pointer
/// chasing, the reset of the implicit change of RSP); they carry their instruction objects.
const REFERENCE_SAMPLE: &str = r####"
{"file":"add32_chain4.exe.o","arch":"ADL-P","options":{"alignmentOffset":5},"issue":"3.5","lsd":"3.6666666666666665","predec":[[0,0,"7.625"],[0,1,"7.625"],[0,31,"7.625"]]}
{"file":"add32_chain4.exe.o","arch":"ADL-P","options":{"noMacroFusion":true},"dec":"4.0"}
{"file":"add32_chain4.exe.o","arch":"ADL-P","options":{},"issue":"3.5","lsd":"3.6666666666666665","predec":[[0,0,"7.625"],[0,1,"7.625"],[0,31,"7.625"]]}
{"file":"add32_chain4.exe.o","arch":"BDW","options":{"noMacroFusion":true},"dec":"6.0"}
{"file":"add32_chain4.exe.o","arch":"ZEN3","options":{"alignmentOffset":5},"dec":"6.0"}
{"file":"add32_chain4.exe.o","arch":"ZEN3","options":{},"dec":"6.0"}
{"file":"addimm_chain2.o","arch":"ADL-P","options":{},"dsb":[[31,"0.5"]]}
{"file":"addimm_chain2.o","arch":"BDW","options":{},"dsb":[[31,"0.5"]]}
{"file":"b10.o","arch":"ADL-P","options":{},"dep":{"diff":["4.0","386:9b4f17cd"]}}
{"file":"b10.o","arch":"CFL","options":{},"dep":{"diff":["4.0","386:9ad0de7f"]}}
{"file":"b100.o","arch":"ADL-P","options":{},"dep":{"diff":["13.0","5212:71072ba6"]}}
{"file":"b100.o","arch":"BDW","options":{},"dep":{"diff":["14.0","5565:908b957a"]}}
{"file":"clang_s1_0026.o","arch":"BDW","options":{},"dep":{"diff":["1.0","278:d9b76456"]}}
{"file":"clang_s1_0026.o","arch":"BDW","options":{},"patch":"base32","dep":{"diff":["1.0","278:6f343ac0"]}}
{"file":"clang_s1_0026.o","arch":"CFL","options":{},"dep":{"diff":["1.0","278:c809b889"]}}
{"file":"clang_s1_0026.o","arch":"CFL","options":{},"patch":"base32","dep":{"diff":["1.0","278:7e8ae61f"]}}
{"file":"clang_s1_0130.o","arch":"ICL","options":{},"summaries":[{"tp":"1.41","loop":false,"ao":31,"nRounds":1,"dep":"0.004","inst":[["-|0n0|"],["-|6n0|"],["-|0n0|"],[]],"ports":"0.75","text":"Bottleneck: Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.60\n  - Ports: 0.75\n  - Dependencies: 0.00\n"}]}
{"file":"clang_s1_0177.o","arch":"ADL-P","options":{},"predec":[[0,0,"7.3125"],[0,1,"7.3125"]]}
{"file":"clang_s1_0177.o","arch":"BDW","options":{},"predec":[[0,0,"7.3125"],[0,1,"7.3125"]]}
{"file":"clang_s1_0187.o","arch":"ADL-P","options":{},"dsb":[[16,"1"]]}
{"file":"clang_s1_0187.o","arch":"BDW","options":{},"dsb":[[16,"1"]]}
{"file":"ctx_add16imm_ld1.exe.o","arch":"ADL-P","options":{},"dep":{"diff":["0","160:af9776f4"]}}
{"file":"ctx_add16imm_ld1.exe.o","arch":"BDW","options":{},"dep":{"diff":["0","142:448e4237"]}}
{"file":"eigen_s1_0284.o","arch":"BDW","options":{},"dep":{"diff":["2.0","160:4c985974"]}}
{"file":"eigen_s1_0284.o","arch":"CFL","options":{},"dep":{"diff":["2.0","160:a778b528"]}}
{"file":"eigen_s1_0326.o","arch":"ICL","options":{},"summaries":[{"tp":"12","loop":true,"ao":37,"nRounds":2,"dep":"0","inst":[["D|0n0|0n3 8n0","M|5n0|"],[],["L|0n0|","D|6n0|"],["L||5n0 4n0","M||9n0"]],"ports":"0.75","text":"Bottleneck: unknown\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - DSB: 1.00\n  - LSD: 0.67\n  - Issue: 0.60\n  - Ports: 0.75\n"}]}
{"file":"eigen_s1_0379.o","arch":"CLX_fullMoveElim","options":{},"summaries":[{"tp":"1.0204081632653061","loop":false,"ao":0,"nRounds":1,"dep":"0","inst":[["L|3n0 4n0|"],["L|6n0|7n0"],["L||"]],"ports":"1.0","text":"Bottleneck: Ports\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - LSD: 0.50\n  - Issue: 0.50\n  - Ports: 1.00\n"}]}
{"file":"embree_s1_0636.o","arch":"CLX_noLSD","options":{},"summaries":[{"tp":"2.0408163265306123","loop":false,"ao":1,"nRounds":1,"dep":"0","inst":[["-|3n0|"],["-|3n0|"],["-|-n0|"],["-||1n0"]],"ports":"1.0","text":"Bottleneck: Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.75\n  - Ports: 1.00\n"}]}
{"file":"embree_s1_0653.o","arch":"ADL-P","options":{},"summaries":[{"tp":"4.545454545454546","loop":true,"ao":31,"nRounds":2,"dep":"0","inst":[["-|9n0 8n0|3n3 1n0","-|9n0 8n0|3n0 0n3"],["-|6n0|Bn3","-|6n0|9n0"],["-||","-||"]],"ports":"1.0","text":"Bottleneck: Divider\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.33\n  - Ports: 1.00\n"}]}
{"file":"ffmpeg_s1_0787.o","arch":"ICL","options":{"noMacroFusion":true},"summaries":[{"tp":"1.0255102040816324","loop":false,"ao":5,"nRounds":1,"dep":"1.005","inst":[[],["L|6n0|"],["L|0n0|3n0"]],"ports":"0.5","text":"Bottleneck: Dependencies\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - LSD: 0.67\n  - Issue: 0.60\n  - Ports: 0.50\n  - Dependencies: 1.00\n"}]}
{"file":"ffmpeg_s1_0787.o","arch":"TGL","options":{"alignmentOffset":5},"summaries":[{"tp":"1.0255102040816324","loop":true,"ao":31,"nRounds":1,"dep":"1.005","inst":[["-|2n0|"],["-|6n0|2n0"],["-||"]],"ports":"0.5","text":"Bottlenecks: Dependencies, Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.40\n  - Ports: 0.50\n  - Dependencies: 1.00\n"}]}
{"file":"ffmpeg_s1_0814.o","arch":"ADL-P","options":{},"dep":{"same":["0","263:9d14452f"],"stack":["0","211:ba2086be"]}}
{"file":"ffmpeg_s1_0814.o","arch":"BDW","options":{},"dep":{"same":["1.0","332:eac48f31"],"stack":["1.0","280:6a03f521"]}}
{"file":"ffmpeg_s1_0895.o","arch":"BDW","options":{},"dep":{"diff":["1.0","249:3a475d88"]}}
{"file":"ffmpeg_s1_0895.o","arch":"CFL","options":{},"dep":{"diff":["1.0","249:426dbc8a"]}}
{"file":"ffmpeg_s1_0895.o","arch":"SNB","options":{},"dep":{"diff":["1.0","249:f6028eb8"]}}
{"file":"ffmpeg_s1_0902.o","arch":"CLX","options":{},"summaries":[{"tp":"2","loop":true,"ao":5,"nRounds":1,"dep":"0","inst":[["-|-n0|"],["-|1n0|"],["-|5n0|"],["-|6n0|1n0"],["-||3n0"]],"ports":"1.0","text":"Bottleneck: Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 1.00\n  - Ports: 1.00\n"}]}
{"file":"ffmpeg_s1_0952.o","arch":"ICX","options":{},"summaries":[{"tp":"3.0303030303030307","loop":true,"ao":0,"nRounds":1,"dep":"0.004","inst":[["-|5n0 3n0|","D|0n0 3n0|1n3","M|0n0 3n0|"],["-|6n0|"],[]],"ports":"0.5","text":"Bottleneck: Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.40\n  - Ports: 0.50\n  - Dependencies: 0.00\n"}]}
{"file":"gzip_s1_1003.o","arch":"BDW","options":{},"ports":"2.25"}
{"file":"gzip_s1_1003.o","arch":"CFL","options":{},"ports":"2.25"}
{"file":"gzip_s1_1083.o","arch":"CLX_fullMoveElim","options":{},"summaries":[{"tp":"1.0204081632653061","loop":false,"ao":37,"nRounds":1,"dep":"1.0","inst":[["-|-n0|"],["-|6n0|4n0 2n0"],["-||"]],"ports":"1.0","text":"Bottlenecks: Dependencies, Ports\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.50\n  - Ports: 1.00\n  - Dependencies: 1.00\n"}]}
{"file":"gzip_s1_1200.o","arch":"CLX_fullMoveElim","options":{"noMacroFusion":true},"summaries":[{"tp":"1.0204081632653061","loop":true,"ao":5,"nRounds":1,"dep":"0","inst":[["-|2n0 4n0|5n0"],["-|1n0|"],["-|6n0|"]],"ports":"1.0","text":"Bottleneck: Ports\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.75\n  - Ports: 1.00\n"}]}
{"file":"gzip_s1_1200.o","arch":"SKL","options":{"alignmentOffset":31},"summaries":[{"tp":"2.0408163265306123","loop":true,"ao":0,"nRounds":1,"dep":"0","inst":[["D|3n0 4n0|"],["D|6n0|4n0 7n0"],["D||"]],"ports":"1.0","text":"Bottleneck: Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - DSB: 1.00\n  - Issue: 0.50\n  - Ports: 1.00\n"}]}
{"file":"gzip_s1_1200.o","arch":"SKX","options":{},"summaries":[{"tp":"0.004081632653061225","loop":false,"ao":5,"nRounds":1,"dep":"0.004","inst":[["-|2n0 4n0|"],["-|6n0|"],["-||"]],"ports":"1.0","text":"Bottlenecks: Dependencies, Issue, Ports\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.50\n  - Ports: 1.00\n  - Dependencies: 0.00\n"}]}
{"file":"gzip_s1_1200.o","arch":"TGL","options":{"alignmentOffset":31},"summaries":[{"tp":"1.0204081632653061","loop":true,"ao":5,"nRounds":1,"dep":"0","inst":[["D|4n0 8n0|"],["D|6n0|0n3"],["D||"]],"ports":"0.5","text":"Bottlenecks: DSB, Divider, Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - DSB: 1.00\n  - Issue: 0.40\n  - Ports: 0.50\n"}]}
{"file":"gzip_s1_1200.o","arch":"TGL","options":{},"summaries":[{"tp":"3.0303030303030307","loop":false,"ao":37,"nRounds":1,"dep":"0","inst":[["D|4n0 7n0|7n3 0n0"],["D|6n0|8n0"],["D||","D||","D||"]],"ports":"0.5","text":"Bottleneck: unknown\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - DSB: 1.00\n  - Issue: 0.40\n  - Ports: 0.50\n"}]}
{"file":"occ_dpps_none.o","arch":"ADL-P","options":{},"ports":"1.75"}
{"file":"occ_dpps_none.o","arch":"ICL","options":{},"ports":"1.75"}
{"file":"occ_dpps_none.o","arch":"SKL","options":{},"summaries":[{"tp":"0","loop":false,"ao":0,"nRounds":1,"dep":"0.004","inst":[["-|1n0 1n0 0n0 -n0|"],["-|6n0|6n0 3n0"],["-||"]],"ports":"1.5","text":"Bottlenecks: Dependencies, Divider, Issue, Ports\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 1.25\n  - Ports: 1.50\n  - Dependencies: 0.00\n"}]}
{"file":"occ_mpsadbw_paddd3.o","arch":"RKL","options":{"alignmentOffset":31},"summaries":[{"tp":"1.7040816326530612","loop":true,"ao":1,"nRounds":1,"dep":"0.004","inst":[["-|5n0 5n0|"],["-|0n0|3n0 5n0 9n0","-|0n0|"],["-|1n0|"],["-|1n0|3n0","-|0n0|7n3","-|1n0|"],["-|-n0|"],["-||"]],"ports":"1.6666666666666667","text":"Bottlenecks: Divider, Ports\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 1.20\n  - Ports: 1.67\n  - Dependencies: 0.00\n"}]}
{"file":"openblas_s1_1408.o","arch":"ADL-P","options":{},"summaries":[{"tp":"1.020408163265306","loop":true,"ao":37,"nRounds":1,"dep":"0","inst":[["-|1n0|"],["-|6n0|3n3"],["-||0n0"]],"ports":"1.0","text":"Bottlenecks: Divider, Ports\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.33\n  - Ports: 1.00\n"}]}
{"file":"openssl_s1_1550.o","arch":"ICL","options":{},"summaries":[{"tp":"3","loop":false,"ao":5,"nRounds":1,"dep":"1.0","inst":[[],["M|-n0|"],["D|0n0|"],["M||5n3"]],"ports":"0.5","text":"Bottleneck: Divider\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Decoder: 1.00\n  - DSB: 1.00\n  - Issue: 0.60\n  - Ports: 0.50\n  - Dependencies: 1.00\n"}]}
{"file":"s1_0543.o","arch":"IVB","options":{},"summaries":[{"tp":"1.3571428571428574","loop":true,"ao":15,"nRounds":2,"dep":"1.0","inst":[["D|5n0|","D|1n0|"],["L|1n0|2n0","-|5n0|"],["-|0n0|","L|5n0|"],["L|5n0|0n0 5n0","L|5n0|","D|5n0|"],[]],"ports":"1.3333333333333333","text":"Bottleneck: Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - DSB: 1.00\n  - LSD: 1.00\n  - Issue: 1.00\n  - Ports: 1.33\n  - Dependencies: 1.00\n"}]}
{"file":"s2_0003.o","arch":"CLX_noLSDUnrolling","options":{},"patch":"ports3","summaries":[{"tp":"2.02020202020202","loop":false,"ao":31,"nRounds":3,"dep":"1.0","inst":[["D|1n0|5n0","D|1n0|","D|1n0|5n0"],["D|6n0 -e0|7n0 1n0"],["D|-e0 4n0|","D|-e0 -e0|1n3 6n3","D|-e0|"],["D|7n0 2n0|1n0","D|-e0|2n0","D|-e0|7n0"],["D|1n0|","D|6n0|0n0 7n0","D|5n0|6n0"],["D|6n0|","D|6n0|","D|6n0|"],[]],"ports":"1.5","text":"Bottlenecks: Divider, Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - DSB: 1.00\n  - Issue: 1.50\n  - Ports: 1.50\n  - Dependencies: 1.00\n"}]}
{"file":"sf_rmw_add.o","arch":"CLX_noMoveElim","options":{"noMicroFusion":true},"summaries":[{"tp":"6.060606060606061","loop":true,"ao":31,"nRounds":1,"dep":"4.0","inst":[["-|5n0 3n0 7n0 4n0|"],["-|6n0|4n3"],["-||4n0 2n3"]],"ports":"1.0","text":"Bottleneck: unknown\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 1.25\n  - Ports: 1.00\n  - Dependencies: 4.00\n"}]}
{"file":"st1_lines.o","arch":"CLX_noMoveElim","options":{},"summaries":[{"tp":"1.0204081632653061","loop":false,"ao":37,"nRounds":1,"dep":"0","inst":[["D|3n0 4n0|"],["D|6n0|"],["D||1n0"]],"ports":"1.0","text":"Bottlenecks: DSB, Ports\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - DSB: 1.00\n  - Issue: 0.50\n  - Ports: 1.00\n"}]}
{"file":"syn_addsub","arch":"ICL","options":{},"operands":[{"kind":"mem","memAddr":{"base":"RDI","scale":1,"disp":0}},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"flag","flags":"C"},{"kind":"flag","flags":"SPAZO"},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"flag","flags":"C"},{"kind":"flag","flags":"SPAZO"},{"kind":"mem","memAddr":{"base":"RDI","scale":1,"disp":0}},{"kind":"reg","reg":"RAX","isImplicitStackOperand":false},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"flag","flags":"SPAZO"},{"kind":"flag","flags":"SPAZO"}],"instrs":[{"isUnknown":false,"asm":"mov qword ptr [rdi], rax","opcode":"488907","posNominalOpcode":1,"instrStr":"MOV (M64, R64)","portData":[["49",1],["78",1]],"uops":2,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[0],"memAddrOperands":[1],"agenOperands":[],"latencies":[[1,0,0]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (M64, R64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"add rdi, 0x8","opcode":"4883C708","posNominalOpcode":1,"instrStr":"ADD (R64, I8)","portData":[["0156",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[2],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[3],"outputFlagOperands":[4,5],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[2,3,1],[2,4,1],[2,5,1]],"TP":null,"immediate":8,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JB (Rel32)","JB (Rel8)","JBE (Rel32)","JBE (Rel8)","JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNB (Rel32)","JNB (Rel8)","JNBE (Rel32)","JNBE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"ADD (R64, I8)","opCacheFields":1,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"sub rdi, 0x8","opcode":"4883EF08","posNominalOpcode":1,"instrStr":"SUB (R64, I8)","portData":[["0156",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[6],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[7],"outputFlagOperands":[8,9],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[6,7,1],[6,8,1],[6,9,1]],"TP":null,"immediate":8,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JB (Rel32)","JB (Rel8)","JBE (Rel32)","JBE (Rel8)","JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNB (Rel32)","JNB (Rel8)","JNBE (Rel32)","JNBE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"SUB (R64, I8)","opCacheFields":1,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"mov rax, qword ptr [rdi]","opcode":"488B07","posNominalOpcode":1,"instrStr":"MOV (R64, M64)","portData":[["23",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[10],"outputRegOperands":[11],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[12],"agenOperands":[],"latencies":[[10,11,0],[12,11,5]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (R64, M64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"dec r15","opcode":"49FFCF","posNominalOpcode":1,"instrStr":"DEC (R64)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[13],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[14],"outputFlagOperands":[15],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[13,14,1],[13,15,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":true,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"DEC (R64)","opCacheFields":0,"isNextToLastInstr":true,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"jnz 0xffffffffffffffef","opcode":"75ED","posNominalOpcode":0,"instrStr":"JNZ (Rel8)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[16],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":true,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":true,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"JNZ (Rel8)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":true,"UopPropertiesList":[],"regMergeUopPropertiesList":[]}],"dep":{"diff":["2.0","126:aa71bba0"]}}
{"file":"syn_chase32","arch":"HSW","options":{},"operands":[{"kind":"mem","memAddr":{"base":"RBX","scale":1,"disp":0}},{"kind":"reg","reg":"RAX","isImplicitStackOperand":false},{"kind":"reg","reg":"RBX","isImplicitStackOperand":false},{"kind":"reg","reg":"EAX","isImplicitStackOperand":false},{"kind":"reg","reg":"ECX","isImplicitStackOperand":false},{"kind":"mem","memAddr":{"base":"RCX","scale":1,"disp":0}},{"kind":"reg","reg":"RBX","isImplicitStackOperand":false},{"kind":"reg","reg":"RCX","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"flag","flags":"SPAZO"},{"kind":"flag","flags":"SPAZO"}],"instrs":[{"isUnknown":false,"asm":"mov rax, qword ptr [rbx]","opcode":"488B03","posNominalOpcode":1,"instrStr":"MOV (R64, M64)","portData":[["23",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[0],"outputRegOperands":[1],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[2],"agenOperands":[],"latencies":[[0,1,4],[2,1,5]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (R64, M64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"mov ecx, eax","opcode":"89C1","posNominalOpcode":0,"instrStr":"MOV_89 (R32, R32)","portData":[["0156",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[3],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[4],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[3,4,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":true,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV_89 (R32, R32)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"mov rbx, qword ptr [rcx]","opcode":"488B19","posNominalOpcode":1,"instrStr":"MOV (R64, M64)","portData":[["23",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[5],"outputRegOperands":[6],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[7],"agenOperands":[],"latencies":[[5,6,4],[7,6,5]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (R64, M64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"dec r15","opcode":"49FFCF","posNominalOpcode":1,"instrStr":"DEC (R64)","portData":[["6",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[8],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[9],"outputFlagOperands":[10],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[8,9,1],[8,10,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":true,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"DEC (R64)","opCacheFields":0,"isNextToLastInstr":true,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"jnz 0xfffffffffffffff5","opcode":"75F3","posNominalOpcode":0,"instrStr":"JNZ (Rel8)","portData":[["6",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[11],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":true,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":true,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"JNZ (Rel8)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":true,"UopPropertiesList":[],"regMergeUopPropertiesList":[]}],"dep":{"diff":["9.0","126:e5c975ba"]}}
{"file":"syn_cmov","arch":"ICL","options":{},"operands":[{"kind":"mem","memAddr":{"base":"RDI","scale":1,"disp":0}},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"RSI","isImplicitStackOperand":false},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"flag","flags":"SPAZO"},{"kind":"reg","reg":"RSI","isImplicitStackOperand":false},{"kind":"mem","memAddr":{"base":"RSI","scale":1,"disp":0}},{"kind":"reg","reg":"RAX","isImplicitStackOperand":false},{"kind":"reg","reg":"RSI","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"flag","flags":"SPAZO"},{"kind":"flag","flags":"SPAZO"}],"instrs":[{"isUnknown":false,"asm":"mov qword ptr [rdi], rax","opcode":"488907","posNominalOpcode":1,"instrStr":"MOV (M64, R64)","portData":[["49",1],["78",1]],"uops":2,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[0],"memAddrOperands":[1],"agenOperands":[],"latencies":[[1,0,0]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (M64, R64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"cmovz rsi, rdi","opcode":"480F44F7","posNominalOpcode":2,"instrStr":"CMOVZ (R64, R64)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[2,3],"inputFlagOperands":[4],"inputMemOperands":[],"outputRegOperands":[5],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[2,5,1],[3,5,1],[4,5,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":true,"nAvailableSimpleDecoders":3,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"CMOVZ (R64, R64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"mov rax, qword ptr [rsi]","opcode":"488B06","posNominalOpcode":1,"instrStr":"MOV (R64, M64)","portData":[["23",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[6],"outputRegOperands":[7],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[8],"agenOperands":[],"latencies":[[6,7,0],[8,7,5]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (R64, M64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"dec r15","opcode":"49FFCF","posNominalOpcode":1,"instrStr":"DEC (R64)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[9],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[10],"outputFlagOperands":[11],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[9,10,1],[9,11,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":true,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"DEC (R64)","opCacheFields":0,"isNextToLastInstr":true,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"jnz 0xfffffffffffffff3","opcode":"75F1","posNominalOpcode":0,"instrStr":"JNZ (Rel8)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[12],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":true,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":true,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"JNZ (Rel8)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":true,"UopPropertiesList":[],"regMergeUopPropertiesList":[]}],"dep":{"same":["1.0","126:7b3cd2e1"]}}
{"file":"syn_disp","arch":"HSW","options":{},"operands":[{"kind":"mem","memAddr":{"base":"RAX","scale":1,"disp":2048}},{"kind":"reg","reg":"RAX","isImplicitStackOperand":false},{"kind":"reg","reg":"RAX","isImplicitStackOperand":false},{"kind":"mem","memAddr":{"base":"RBX","scale":1,"disp":2047}},{"kind":"reg","reg":"RBX","isImplicitStackOperand":false},{"kind":"reg","reg":"RBX","isImplicitStackOperand":false},{"kind":"mem","memAddr":{"base":"RCX","scale":1,"disp":-8}},{"kind":"reg","reg":"RCX","isImplicitStackOperand":false},{"kind":"reg","reg":"RCX","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"flag","flags":"SPAZO"},{"kind":"flag","flags":"SPAZO"}],"instrs":[{"isUnknown":false,"asm":"mov rax, qword ptr [rax+0x800]","opcode":"488B8000080000","posNominalOpcode":1,"instrStr":"MOV (R64, M64)","portData":[["23",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[0],"outputRegOperands":[1],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[2],"agenOperands":[],"latencies":[[0,1,4],[2,1,5]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (R64, M64)","opCacheFields":1,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"mov rbx, qword ptr [rbx+0x7ff]","opcode":"488B9BFF070000","posNominalOpcode":1,"instrStr":"MOV (R64, M64)","portData":[["23",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[3],"outputRegOperands":[4],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[5],"agenOperands":[],"latencies":[[3,4,4],[5,4,5]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (R64, M64)","opCacheFields":1,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"mov rcx, qword ptr [rcx-0x8]","opcode":"488B49F8","posNominalOpcode":1,"instrStr":"MOV (R64, M64)","portData":[["23",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[6],"outputRegOperands":[7],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[8],"agenOperands":[],"latencies":[[6,7,4],[8,7,5]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (R64, M64)","opCacheFields":1,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"dec r15","opcode":"49FFCF","posNominalOpcode":1,"instrStr":"DEC (R64)","portData":[["6",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[9],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[10],"outputFlagOperands":[11],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[9,10,1],[9,11,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":true,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"DEC (R64)","opCacheFields":0,"isNextToLastInstr":true,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"jnz 0xffffffffffffffeb","opcode":"75E9","posNominalOpcode":0,"instrStr":"JNZ (Rel8)","portData":[["6",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[12],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":true,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":true,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"JNZ (Rel8)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":true,"UopPropertiesList":[],"regMergeUopPropertiesList":[]}],"dep":{"diff":["5.0","124:b977cc51"]}}
{"file":"syn_incdec","arch":"ICL","options":{},"operands":[{"kind":"mem","memAddr":{"base":"RDI","scale":1,"disp":0}},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"flag","flags":"SPAZO"},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"flag","flags":"SPAZO"},{"kind":"mem","memAddr":{"base":"RDI","scale":1,"disp":0}},{"kind":"reg","reg":"RAX","isImplicitStackOperand":false},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"flag","flags":"SPAZO"},{"kind":"flag","flags":"SPAZO"}],"instrs":[{"isUnknown":false,"asm":"mov qword ptr [rdi], rax","opcode":"488907","posNominalOpcode":1,"instrStr":"MOV (M64, R64)","portData":[["49",1],["78",1]],"uops":2,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[0],"memAddrOperands":[1],"agenOperands":[],"latencies":[[1,0,0]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (M64, R64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"inc rdi","opcode":"48FFC7","posNominalOpcode":1,"instrStr":"INC (R64)","portData":[["0156",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[2],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[3],"outputFlagOperands":[4],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[2,3,1],[2,4,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"INC (R64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"dec rdi","opcode":"48FFCF","posNominalOpcode":1,"instrStr":"DEC (R64)","portData":[["0156",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[5],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[6],"outputFlagOperands":[7],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[5,6,1],[5,7,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"DEC (R64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"mov rax, qword ptr [rdi]","opcode":"488B07","posNominalOpcode":1,"instrStr":"MOV (R64, M64)","portData":[["23",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[8],"outputRegOperands":[9],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[10],"agenOperands":[],"latencies":[[8,9,0],[10,9,5]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (R64, M64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"dec r15","opcode":"49FFCF","posNominalOpcode":1,"instrStr":"DEC (R64)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[11],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[12],"outputFlagOperands":[13],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[11,12,1],[11,13,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":true,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"DEC (R64)","opCacheFields":0,"isNextToLastInstr":true,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"jnz 0xfffffffffffffff1","opcode":"75EF","posNominalOpcode":0,"instrStr":"JNZ (Rel8)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[14],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":true,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":true,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"JNZ (Rel8)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":true,"UopPropertiesList":[],"regMergeUopPropertiesList":[]}],"dep":{"diff":["2.0","123:ef159df4"]}}
{"file":"syn_movcopy","arch":"ICL","options":{},"operands":[{"kind":"mem","memAddr":{"base":"RDI","scale":1,"disp":0}},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"RDI","isImplicitStackOperand":false},{"kind":"reg","reg":"RSI","isImplicitStackOperand":false},{"kind":"mem","memAddr":{"base":"RSI","scale":1,"disp":0}},{"kind":"reg","reg":"RAX","isImplicitStackOperand":false},{"kind":"reg","reg":"RSI","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"flag","flags":"SPAZO"},{"kind":"flag","flags":"SPAZO"}],"instrs":[{"isUnknown":false,"asm":"mov qword ptr [rdi], rax","opcode":"488907","posNominalOpcode":1,"instrStr":"MOV (M64, R64)","portData":[["49",1],["78",1]],"uops":2,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[0],"memAddrOperands":[1],"agenOperands":[],"latencies":[[1,0,0]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (M64, R64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"mov rsi, rdi","opcode":"4889FE","posNominalOpcode":1,"instrStr":"MOV_89 (R64, R64)","portData":[["0156",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[2],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[3],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[2,3,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV_89 (R64, R64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"mov rax, qword ptr [rsi]","opcode":"488B06","posNominalOpcode":1,"instrStr":"MOV (R64, M64)","portData":[["23",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[4],"outputRegOperands":[5],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[6],"agenOperands":[],"latencies":[[4,5,0],[6,5,5]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (R64, M64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"dec r15","opcode":"49FFCF","posNominalOpcode":1,"instrStr":"DEC (R64)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[7],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[8],"outputFlagOperands":[9],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[7,8,1],[7,9,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":true,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"DEC (R64)","opCacheFields":0,"isNextToLastInstr":true,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"jnz 0xfffffffffffffff4","opcode":"75F2","posNominalOpcode":0,"instrStr":"JNZ (Rel8)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[10],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":true,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":true,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"JNZ (Rel8)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":true,"UopPropertiesList":[],"regMergeUopPropertiesList":[]}],"dep":{"diff":["1.0","76:5963ff64"]}}
{"file":"syn_rspreset","arch":"ICL","options":{},"operands":[{"kind":"mem","memAddr":{"base":"RSP","scale":1,"disp":0}},{"kind":"reg","reg":"RSP","isImplicitStackOperand":true},{"kind":"mem","memAddr":{"base":"RSP","scale":1,"disp":0}},{"kind":"reg","reg":"RBX","isImplicitStackOperand":false},{"kind":"reg","reg":"RSP","isImplicitStackOperand":false},{"kind":"reg","reg":"RSP","isImplicitStackOperand":false},{"kind":"reg","reg":"RSP","isImplicitStackOperand":false},{"kind":"flag","flags":"C"},{"kind":"flag","flags":"SPAZO"},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"reg","reg":"R15","isImplicitStackOperand":false},{"kind":"flag","flags":"SPAZO"},{"kind":"flag","flags":"SPAZO"}],"instrs":[{"isUnknown":false,"asm":"push rax","opcode":"50","posNominalOpcode":0,"instrStr":"PUSH (R64)","portData":[["49",1],["78",1]],"uops":2,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[0],"memAddrOperands":[1],"agenOperands":[],"latencies":[[1,0,0]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":-8,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"PUSH (R64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"mov rbx, qword ptr [rsp]","opcode":"488B1C24","posNominalOpcode":1,"instrStr":"MOV (R64, M64)","portData":[["23",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[],"inputMemOperands":[2],"outputRegOperands":[3],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[4],"agenOperands":[],"latencies":[[2,3,0],[4,3,5]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"MOV (R64, M64)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"add rsp, 0x8","opcode":"4883C408","posNominalOpcode":1,"instrStr":"ADD (R64, I8)","portData":[["0156",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[5],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[6],"outputFlagOperands":[7,8],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[5,6,1],[5,7,1],[5,8,1]],"TP":null,"immediate":8,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JB (Rel32)","JB (Rel8)","JBE (Rel32)","JBE (Rel8)","JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNB (Rel32)","JNB (Rel8)","JNBE (Rel32)","JNBE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"ADD (R64, I8)","opCacheFields":1,"isNextToLastInstr":false,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"dec r15","opcode":"49FFCF","posNominalOpcode":1,"instrStr":"DEC (R64)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[9],"inputFlagOperands":[],"inputMemOperands":[],"outputRegOperands":[10],"outputFlagOperands":[11],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[[9,10,1],[9,11,1]],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":false,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":["JL (Rel32)","JL (Rel8)","JLE (Rel32)","JLE (Rel8)","JNL (Rel32)","JNL (Rel8)","JNLE (Rel32)","JNLE (Rel8)","JNZ (Rel32)","JNZ (Rel8)","JZ (Rel32)","JZ (Rel8)"],"macroFusedWithPrevInstr":false,"macroFusedWithNextInstr":true,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"DEC (R64)","opCacheFields":0,"isNextToLastInstr":true,"isLastInstr":false,"UopPropertiesList":[],"regMergeUopPropertiesList":[]},{"isUnknown":false,"asm":"jnz 0xfffffffffffffff4","opcode":"75F2","posNominalOpcode":0,"instrStr":"JNZ (Rel8)","portData":[["06",1]],"uops":1,"retireSlots":1,"uopsMITE":1,"uopsMS":0,"divCycles":0,"inputRegOperands":[],"inputFlagOperands":[12],"inputMemOperands":[],"outputRegOperands":[],"outputFlagOperands":[],"outputMemOperands":[],"memAddrOperands":[],"agenOperands":[],"latencies":[],"TP":null,"immediate":null,"lcpStall":false,"implicitRSPChange":0,"mayBeEliminated":false,"complexDecoder":false,"nAvailableSimpleDecoders":4,"hasLockPrefix":false,"isBranchInstr":true,"isSerializingInstr":false,"isLoadSerializing":false,"isStoreSerializing":false,"macroFusibleWith":[],"macroFusedWithPrevInstr":true,"macroFusedWithNextInstr":false,"cannotBeInDSBDueToJCCErratum":false,"foldedInputReg":null,"memRenaming":false,"TPKey":"JNZ (Rel8)","opCacheFields":0,"isNextToLastInstr":false,"isLastInstr":true,"UopPropertiesList":[],"regMergeUopPropertiesList":[]}],"dep":{"diff":["1.0","92:7bab1409"]}}
{"file":"tensorflow_s1_2261.o","arch":"SNB","options":{},"summaries":[{"tp":"6","loop":false,"ao":0,"nRounds":1,"dep":"0.004","inst":[["-|-n0 4n0|3n3 0n0"],["-|5n0|5n0 5n3"],[]],"ports":"1.0","text":"Bottleneck: Divider\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.50\n  - Ports: 1.00\n  - Dependencies: 0.00\n"}]}
{"file":"tensorflow_s1_2261.o","arch":"TGL","options":{},"summaries":[{"tp":"2.04","loop":true,"ao":16,"nRounds":1,"dep":"1.0","inst":[["-|9n0 8n0|7n0"],["-|0n0|"],["-||9n0"]],"ports":"0.5","text":"Bottleneck: Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.40\n  - Ports: 0.50\n  - Dependencies: 1.00\n"}]}
{"file":"tensorflow_s1_2298.o","arch":"HSW","options":{},"summaries":[{"tp":"1.0204081632653061","loop":true,"ao":31,"nRounds":1,"dep":"0","inst":[["-|2n0|"],["M|6n0|"],["L||"]],"ports":"1.0","text":"Bottlenecks: Decoder, Ports\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Decoder: 1.00\n  - LSD: 0.50\n  - Issue: 0.50\n  - Ports: 1.00\n"}]}
{"file":"tensorflow_s1_2364.o","arch":"BDW","options":{"noMicroFusion":true},"summaries":[{"tp":"4.0816326530612255","loop":false,"ao":16,"nRounds":1,"dep":"0","inst":[["-|1n0|6n3"],["-|1n0|1n0 7n0"],["-|0n0|2n0 7n0"],["-|2n0|1n0"],["-|6n0|6n3"],["-||"]],"ports":"1.25","text":"Bottleneck: Divider\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 1.25\n  - Ports: 1.25\n"}]}
{"file":"tensorflow_s1_2364.o","arch":"ZEN3","options":{"alignmentOffset":5},"summaries":[{"tp":"4.33","loop":true,"ao":37,"nRounds":1,"dep":"1.0","inst":[["-|dn0|"],["-|bn0|"],["-|bn0|"],["-|-e0|in0"],["-|an0|"],["-||"]],"ports":"1.0","text":"Bottleneck: unknown\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Issue: 0.83\n  - Ports: 1.00\n  - Dependencies: 1.00\n"}]}
{"file":"x_moves.o","arch":"CFL","options":{"noMicroFusion":true},"patch":"ports3","summaries":[{"tp":"3","loop":false,"ao":16,"nRounds":1,"dep":"2.3333333333333335","inst":[["M|-e0|","M|-e0|7n3 1n0","M|0n0|"],["M|1n0|"],["M|2n0 -e0|3n0"],["M|5n0|"],["M|1n0|7n3 3n0"],["M|7n0 -e0|6n0","M|-e0|0n3","M|-e0|6n0"],["M|6n0|"],["M|6n0|4n0 2n0"],["M|0n0|1n0"],["M|6n0|","M|6n0|","M|6n0|"],["M||4n0"]],"ports":"2.3333333333333335","text":"Bottlenecks: Decoder, Divider, Predecoder, Scheduling\n\nThe following throughputs could be achieved if the given property were the only bottleneck:\n\n  - Predecoder: 3.31\n  - Decoder: 3.00\n  - Issue: 2.50\n  - Ports: 2.33\n  - Dependencies: 2.33\n"}]}
"####;
