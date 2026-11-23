//! Command-line tool of wuica: prints the report that uiCA prints for a block of machine code.

use std::path::PathBuf;
use wuica::{Engine, Request};

const USAGE: &str = "Usage: wuica [options] (HEX | -raw FILE)

Analyzes x86-64 machine code given as hex bytes (e.g. 4801d84801c349ffcf75f5, \"48 01 d8\" or 0x48,0x01,0xd8) or as a
raw binary file.

Options:
  -arch NAME             microarchitecture (default: SKL; case-insensitive, `-` optional: adlp = ADL-P); `-arch list`
                         lists them
  -data DIR              directory with uarch.json and arch/*.json (default: $WUICA_DATA or ./data)
  -raw FILE              read the machine code from a file that contains only the code
  -TPonly                print only the throughput
  -json                  print the response as JSON (docs/WASM-API.md)
  -trace                 with -json: include the cycle-by-cycle events
  -details               with -json: include the details (allowed ports, latencies, port set, issue slots)
  -alignmentOffset N     alignment offset relative to a 64-byte cache line (default: 0)
  -initPolicy P          initial register state: diff (default), same, stack
  -simpleFrontEnd        simulate a front end that is only limited by the issue width
  -noMicroFusion, -noMacroFusion
  -minIterations N       simulate at least N iterations (default: 10)
  -minCycles N           simulate at least N cycles (default: 500)";

/// The configuration key for an architecture name: the exact key, else the key that matches ignoring case and `-` (as the
/// npm package, the API server and the page accept them: `adlp` and `adl-p` are `ADL-P`); whitespace around it is ignored.
fn resolve_arch<'a>(name: &str, keys: impl Iterator<Item = &'a String> + Clone) -> Option<String> {
    let name = name.trim();
    let norm = |k: &str| k.to_uppercase().replace('-', "");
    keys.clone().find(|k| k.as_str() == name).or_else(|| keys.into_iter().find(|k| norm(k) == norm(name))).cloned()
}

/// Machine code given as text, in the forms the npm package accepts: hex digits with `0x` or `\x` prefixes, whitespace,
/// commas or semicolons between them (`0x48,0x01,0xd8`). Lowercase hex digits, or None if the rest is not an even
/// number of hex digits.
fn normalize_hex(input: &str) -> Option<String> {
    let lower = input.to_lowercase();
    let s: String = lower.replace("0x", "").replace("\\x", "").chars().filter(|c| !c.is_whitespace() && *c != ',' && *c != ';').collect();
    (!s.is_empty() && s.len() % 2 == 0 && s.chars().all(|c| c.is_ascii_hexdigit())).then_some(s)
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(1)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut request = Request::new("SKL");
    let mut data_dir = std::env::var("WUICA_DATA").unwrap_or_else(|_| "data".to_string());
    let (mut tp_only, mut json, mut hex) = (false, false, None);
    let mut value = |args: &mut dyn Iterator<Item = String>, name: &str| args.next().unwrap_or_else(|| fail(&format!("{name} needs a value")));
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" | "-help" => {
                println!("{USAGE}");
                return;
            }
            "-arch" => request.arch = value(&mut args, "-arch"),
            "-data" => data_dir = value(&mut args, "-data"),
            "-raw" => {
                let path = value(&mut args, "-raw");
                let bytes = std::fs::read(&path).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
                hex = Some(bytes.iter().map(|b| format!("{b:02x}")).collect::<String>());
            }
            "-TPonly" => tp_only = true,
            "-json" => json = true,
            "-trace" => request.include_trace = true,
            "-details" => request.details = true,
            "-alignmentOffset" => request.alignment_offset = value(&mut args, "-alignmentOffset").parse().unwrap_or_else(|_| fail("-alignmentOffset: not a number")),
            "-initPolicy" => request.init_policy = value(&mut args, "-initPolicy"),
            "-simpleFrontEnd" => request.simple_front_end = true,
            "-noMicroFusion" => request.no_micro_fusion = true,
            "-noMacroFusion" => request.no_macro_fusion = true,
            "-minIterations" => request.min_iterations = value(&mut args, "-minIterations").parse().unwrap_or_else(|_| fail("-minIterations: not a number")),
            "-minCycles" => request.min_cycles = value(&mut args, "-minCycles").parse().unwrap_or_else(|_| fail("-minCycles: not a number")),
            other if other.starts_with('-') => fail(&format!("unknown option {other}\n\n{USAGE}")),
            other => hex = Some(other.to_string()),
        }
    }

    let data_dir = PathBuf::from(data_dir);
    let mut engine = Engine::new();
    let uarch_path = data_dir.join("uarch.json");
    let uarch = std::fs::read_to_string(&uarch_path).unwrap_or_else(|e| fail(&format!("{}: {e} (set -data or WUICA_DATA)", uarch_path.display())));
    engine.load_uarch(&uarch).unwrap_or_else(|e| fail(&e));
    if request.arch.trim() == "list" {
        for (key, config) in &engine.uarch().unwrap().configs {
            println!("{key}{}", if config.experimental { " (experimental)" } else { "" });
        }
        return;
    }
    let hex = hex.unwrap_or_else(|| fail(USAGE));
    if request.details && !json {
        eprintln!("-details: shown only with -json; ignored");
    }
    request.hex = normalize_hex(&hex).unwrap_or(hex); // anything else: the analyzer's own message
    request.arch = resolve_arch(&request.arch, engine.uarch().unwrap().configs.keys()).unwrap_or_else(|| fail(&format!("unknown microarchitecture: {} (see -arch list)", request.arch)));
    let table = engine.table_name(&request.arch).unwrap().to_string();
    let table_path = data_dir.join("arch").join(format!("{table}.json"));
    let table_json = std::fs::read_to_string(&table_path).unwrap_or_else(|e| fail(&format!("{}: {e}", table_path.display())));
    engine.load_arch(&table, &table_json).unwrap_or_else(|e| fail(&e));

    match engine.analyze(&request) {
        Err(e) => fail(&e),
        Ok(response) => {
            if json {
                println!("{}", serde_json::to_string(&response).unwrap());
            } else if tp_only {
                println!("{:.2}", response.tp);
            } else {
                if response.decode_errors > 0 {
                    eprintln!("Warning: {} position(s) could not be decoded", response.decode_errors);
                }
                // with hyperlinks to uops.info if the output is a terminal, as uiCA prints them
                let text = if std::io::IsTerminal::is_terminal(&std::io::stdout()) { &response.text_with_hyperlinks } else { &response.text };
                print!("{text}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arch_names_like_the_other_interfaces() {
        let keys: Vec<String> = ["SKL", "ADL-P", "CLX", "CLX_noLSD", "ZEN3"].iter().map(|s| s.to_string()).collect();
        let r = |n: &str| resolve_arch(n, keys.iter());
        assert_eq!(r("SKL").as_deref(), Some("SKL"));
        assert_eq!(r("skl").as_deref(), Some("SKL"));
        assert_eq!(r("adlp").as_deref(), Some("ADL-P"));
        assert_eq!(r("adl-p").as_deref(), Some("ADL-P"));
        assert_eq!(r("A-D-L-P").as_deref(), Some("ADL-P"));
        assert_eq!(r("zen3").as_deref(), Some("ZEN3"));
        assert_eq!(r("clx_nolsd").as_deref(), Some("CLX_noLSD"));
        assert_eq!(r("SKX"), None);
        assert_eq!(r(""), None);
        assert_eq!(r("skl ").as_deref(), Some("SKL"));
        assert_eq!(r(" adl-p\t").as_deref(), Some("ADL-P"));
        assert_eq!(r(" "), None);
    }

    #[test]
    fn hex_like_the_other_interfaces() {
        let n = |s: &str| normalize_hex(s);
        assert_eq!(n("4801d8").as_deref(), Some("4801d8"));
        assert_eq!(n("48 01 D8").as_deref(), Some("4801d8"));
        assert_eq!(n("0x4801d8").as_deref(), Some("4801d8"));
        assert_eq!(n("0x48, 0x01, 0xd8").as_deref(), Some("4801d8"));
        assert_eq!(n("0X48 0X01 0XD8").as_deref(), Some("4801d8"));
        assert_eq!(n("\\x48\\x01\\xd8").as_deref(), Some("4801d8"));
        assert_eq!(n("48;01;d8").as_deref(), Some("4801d8"));
        assert_eq!(n("0x"), None);
        assert_eq!(n(""), None);
        assert_eq!(n("480"), None);
        assert_eq!(n("zz"), None);
    }
}
