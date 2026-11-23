//! wuica: machine code in, analysis out. Combines the decoder (`wuica-xed`) and the core (`wuica-core`).

use std::collections::HashMap;
pub use wuica_core::analyze::{Request, Response};
pub use wuica_core::config::UArch;
pub use wuica_core::data::ArchData;

/// The loaded configurations and instruction tables.
#[derive(Default)]
pub struct Engine {
    uarch: Option<UArch>,
    tables: HashMap<String, ArchData>,
}

impl Engine {
    pub fn new() -> Engine {
        Engine::default()
    }

    /// Loads the content of `data/uarch.json`.
    pub fn load_uarch(&mut self, json: &str) -> Result<(), String> {
        self.uarch = Some(UArch::from_json(json).map_err(|e| format!("uarch.json: {e}"))?);
        Ok(())
    }

    /// Loads the content of `data/arch/<name>.json`.
    pub fn load_arch(&mut self, name: &str, json: &str) -> Result<(), String> {
        self.tables.insert(name.to_string(), ArchData::from_json(json).map_err(|e| format!("{name}.json: {e}"))?);
        Ok(())
    }

    pub fn uarch(&self) -> Option<&UArch> {
        self.uarch.as_ref()
    }

    /// The name of the instruction table that a configuration needs.
    pub fn table_name(&self, arch: &str) -> Option<&str> {
        Some(self.uarch.as_ref()?.configs.get(arch)?.name.as_str())
    }

    /// Analyzes the machine code `request.hex` (hex digits; whitespace is ignored).
    pub fn analyze(&self, request: &Request) -> Result<Response, String> {
        let uarch = self.uarch.as_ref().ok_or("the configurations (uarch.json) are not loaded")?;
        let config = uarch.configs.get(&request.arch).ok_or_else(|| format!("unknown microarchitecture: {}", request.arch))?;
        let data = self.tables.get(&config.name).ok_or_else(|| format!("the instruction table {} is not loaded", config.name))?;
        let hex: String = request.hex.chars().filter(|c| !c.is_whitespace()).collect();
        let code = wuica_xed::parse_hex(&hex).ok_or("the machine code is not a sequence of hex bytes")?;
        let decoded = wuica_xed::decode(&code, &config.xed_name).map_err(|e| e.to_string())?;
        wuica_core::analyze::analyze(&decoded.instrs, decoded.errors, request, uarch, data)
    }

    /// As [`Engine::analyze`], with the request and the response as JSON (docs/WASM-API.md); errors are `{"error": ...}`.
    pub fn analyze_json(&self, request: &str) -> String {
        let result = serde_json::from_str::<Request>(request).map_err(|e| format!("invalid request: {e}")).and_then(|r| self.analyze(&r));
        match result {
            Ok(response) => serde_json::to_string(&response).unwrap_or_else(|e| error_json(&e.to_string())),
            Err(e) => error_json(&e),
        }
    }
}

pub fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}
