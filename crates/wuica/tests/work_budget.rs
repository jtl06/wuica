//! The work budget (`analyze::MAX_UOPS_PER_ITERATION`, docs/DEVIATIONS.md): `wbinvd`, with about 10^6 uops in the tables,
//! is refused at once on every CPU whose table gives it more uops than the budget; a block just under the budget is not.
//! (That the budget refuses nothing in the fixture corpus is shown by the fixture comparisons: a refused case would differ.)

use std::time::Instant;
use wuica::{Engine, Request};
use wuica_core::analyze::MAX_UOPS_PER_ITERATION;

fn root() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../..")
}

fn engine(archs: &[&str]) -> Engine {
    let mut engine = Engine::new();
    engine.load_uarch(&std::fs::read_to_string(format!("{}/data/uarch.json", root())).expect("run tools/export_data.py")).unwrap();
    for name in archs {
        engine.load_arch(name, &std::fs::read_to_string(format!("{}/data/arch/{name}.json", root())).unwrap()).unwrap();
    }
    engine
}

#[test]
fn wbinvd_is_refused_at_once() {
    let archs = ["SKL", "IVB", "ADL-P", "CLX"];
    let engine = engine(&archs);
    for arch in archs {
        let mut request = Request::new(arch);
        request.hex = "0f09".to_string(); // wbinvd
        let t0 = Instant::now();
        let r = engine.analyze(&request);
        let ms = t0.elapsed().as_millis();
        let e = r.expect_err(arch);
        assert!(e.contains("uops per iteration, more than the 250000 wuica simulates"), "{arch}: {e}");
        assert!(ms < 5_000, "{arch}: {ms} ms");
    }
}

#[test]
fn the_budget_is_far_above_real_blocks() {
    assert_eq!(MAX_UOPS_PER_ITERATION, 250_000);
    // 2,000 instructions of one uop each: analyzed
    let engine = engine(&["SKL"]);
    let mut request = Request::new("SKL");
    request.hex = "4883c001".repeat(1000) + &"4801d8".repeat(1000);
    let r = engine.analyze(&request).expect("analyzed");
    assert!(r.tp > 0.0);
}
