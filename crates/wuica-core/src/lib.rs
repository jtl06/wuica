//! The core of wuica, a port of uiCA (the uops.info Code Analyzer). See docs/DESIGN.md for the structure and the rules of the port.
//!
//! Pipeline: decoded instructions ([`decoded`]) + instruction tables ([`data`]) + microarchitecture configuration ([`config`])
//! -> instruction objects ([`model`], built by [`instr_builder`]) -> simulation ([`sim`]).

pub mod analyze;
pub mod config;
pub mod data;
pub mod decoded;
pub mod details;
pub mod facile;
mod fasthash;
pub use fasthash::{LookupMap, LookupSet};
pub mod instr_builder;
pub mod jsoncmp;
pub mod model;
pub mod sim;
mod substr;
pub mod table_bin;
pub mod x64;
