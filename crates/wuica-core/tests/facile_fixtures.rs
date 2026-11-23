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
    let path = format!("{}/{path}", root());
    let file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("{path}: {e} (run tools/export_fixtures.py)"));
    BufReader::new(flate2::read::GzDecoder::new(file)).lines().map(|l| l.unwrap())
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
    for line in lines(path) {
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

const REFERENCE_SAMPLE: &str = r#"
"#;
