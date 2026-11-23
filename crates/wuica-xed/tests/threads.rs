//! XED initializes its tables on first use. Many threads that decode at once in a new process (through both entry points)
//! must get the same records as a single thread after initialization. The initialization happens once per process, so the
//! test runs itself as a child process several times (WUICA_XED_RACE_RUNS, default 40).

use std::sync::{Arc, Barrier};

const TEST: &str = "first_decodes_from_many_threads";
const CHILD: &str = "WUICA_XED_RACE_CHILD";
const BLOCKS: [&str; 4] = [
    "C096C0000000054883C001",
    "4D8D4C3D004883C005483BE8C4C26500F14C0FAFD7492BD2498D49084C23E0418BC54C89A6C01C00004803BEC01C00004833D049FFCF75C8",
    "49D1E00FBAF90549C1E4074C33DF66410F382BC049D1E24F8D4C150049FFCF75DF",
    "62F1FD48580C2562F27D48B84C24014C8D5A0849FFCF75E4",
];

/// The records of a block as JSON, through `decode` (typed records) or `decode_json`.
fn decode(hex: &str, typed: bool) -> String {
    let code = wuica_xed::parse_hex(hex).unwrap();
    if typed {
        serde_json::to_string(&wuica_xed::decode(&code, "ALL").unwrap().instrs).unwrap()
    } else {
        let (json, _) = wuica_xed::decode_json(&code, "ALL").unwrap();
        serde_json::to_string(&serde_json::from_str::<serde_json::Value>(&json).unwrap()).unwrap()
    }
}

fn race() {
    let threads = 16;
    let barrier = Arc::new(Barrier::new(threads));
    let handles: Vec<_> = (0..threads)
        .map(|t| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (0..BLOCKS.len()).map(|i| decode(BLOCKS[(i + t) % BLOCKS.len()], t % 2 == 0)).collect::<Vec<_>>()
            })
        })
        .collect();
    let results: Vec<Vec<String>> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    for (t, got) in results.iter().enumerate() {
        for (i, json) in got.iter().enumerate() {
            let hex = BLOCKS[(i + t) % BLOCKS.len()];
            let expected = decode(hex, true);
            let opcodes = |j: &str| serde_json::from_str::<serde_json::Value>(j).unwrap().as_array().unwrap().iter().map(|i| i["opcode"].to_string()).collect::<Vec<_>>().join(" ");
            assert!(json == &expected, "thread {t}, block {hex}: {} instead of {}", opcodes(json), opcodes(&expected));
        }
    }
}

#[test]
fn first_decodes_from_many_threads() {
    if std::env::var_os(CHILD).is_some() {
        race();
        return;
    }
    let runs: usize = std::env::var("WUICA_XED_RACE_RUNS").ok().and_then(|s| s.parse().ok()).unwrap_or(40);
    let exe = std::env::current_exe().unwrap();
    let mut failed = 0;
    for _ in 0..runs {
        let out = std::process::Command::new(&exe).args(["--exact", TEST, "--test-threads=1", "--nocapture"]).env(CHILD, "1").output().unwrap();
        if !out.status.success() {
            failed += 1;
            if failed == 1 {
                eprintln!("{}", String::from_utf8_lossy(&out.stderr));
            }
        }
    }
    assert_eq!(failed, 0, "{failed} of {runs} processes decoded differently from many threads");
}
