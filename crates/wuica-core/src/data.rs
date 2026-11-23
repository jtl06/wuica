//! Instruction tables of one microarchitecture: the content of `data/arch/<NAME>.json`, which `tools/export_data.py` writes from
//! uiCA's `instrData/<NAME>_data.py` (derived from uops.info's `instructions.xml`).
//!
//! The file is `{"instrData": {iform: [entry...]}, "attrData": [{attribute: value}], "perfData": [{...}]}`. An entry refers to
//! its XML attributes and its performance data by index; several entries can share one `perfData` element (in Python they then
//! share the dict *objects*, which matters for the one place where uiCA modifies a table in place: see `instr_builder`).
//!
//! The order of the dicts is kept (`ports` is iterated by uiCA). Unknown keys are an error, so that a new kind of data in the
//! tables is not silently ignored.

use indexmap::IndexMap;
use serde::Deserialize;

/// Port usage: ports (one character each, e.g. "015") -> number of uops, in the order of the Python dict.
pub type PortData = IndexMap<String, i64>;

/// The instruction tables of a microarchitecture (uiCA's `archData` module).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchData {
    /// XED iform -> the variants of the instruction, in the order in which they are tried
    #[serde(rename = "instrData")]
    pub instr_data: IndexMap<String, Vec<InstrEntry>>,
    #[serde(rename = "attrData")]
    pub attr_data: Vec<AttrData>,
    #[serde(rename = "perfData")]
    pub perf_data: Vec<PerfData>,
}

impl ArchData {
    pub fn from_json(json: &str) -> Result<ArchData, serde_json::Error> {
        let data: ArchData = serde_json::from_str(json)?;
        for entry in data.instr_data.values().flatten() {
            if entry.attr >= data.attr_data.len() || entry.perf_data >= data.perf_data.len() {
                return Err(serde::de::Error::custom(format!("{}: index out of range", entry.string)));
            }
        }
        Ok(data)
    }
}

/// One variant of an instruction (an element of `instrData[iform]`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstrEntry {
    /// index into [`ArchData::attr_data`]
    pub attr: usize,
    /// the uops.info name, e.g. "ADD (R64, R64)"
    pub string: String,
    /// index into [`ArchData::perf_data`]
    #[serde(rename = "perfData")]
    pub perf_data: usize,
    /// the flags that are read (sorted letters); `None` if the key is absent
    #[serde(rename = "flagsR", default)]
    pub flags_r: Option<Vec<String>>,
    /// the flags that are written (sorted letters); `None` if the key is absent
    #[serde(rename = "flagsW", default)]
    pub flags_w: Option<Vec<String>>,
    /// the value of the key `locked`; uiCA only tests whether the key is present (see [`InstrEntry::has_lock_prefix`])
    #[serde(default)]
    pub locked: Option<i64>,
    /// the instruction strings this instruction can macro-fuse with (sorted); `None` if the key is absent
    #[serde(rename = "macroFusible", default)]
    pub macro_fusible: Option<Vec<String>>,
}

impl InstrEntry {
    /// `'locked' in instrData`
    pub fn has_lock_prefix(&self) -> bool {
        self.locked.is_some()
    }
}

/// The XML attributes that select a variant (an element of `attrData`); all values are strings, as in the decoded records.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttrData {
    #[serde(default)]
    pub agen: Option<String>,
    #[serde(default)]
    pub bcast: Option<String>,
    #[serde(default)]
    pub eosz: Option<String>,
    #[serde(default)]
    pub high8: Option<String>,
    #[serde(default)]
    pub iform: Option<String>,
    #[serde(default)]
    pub immzero: Option<String>,
    #[serde(default)]
    pub mask: Option<String>,
    #[serde(default)]
    pub rep: Option<String>,
    #[serde(default)]
    pub sae: Option<String>,
    #[serde(default)]
    pub zeroing: Option<String>,
    /// the possible values of the ModRM r/m field, as one string that contains them
    #[serde(default)]
    pub rm: Option<String>,
}

/// The third element of a latency key: which part of a memory operand the latency is from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LatKind {
    /// from the base register of the address
    Addr,
    /// from the index register of the address
    AddrI,
    /// from the memory content
    Mem,
}

/// One item of a latency dict: the Python key is `(inp, out)` or `(inp, out, kind)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatEntry {
    /// name of the input operand (e.g. "REG1", "MEM0")
    pub inp: String,
    /// name of the output operand
    pub out: String,
    pub kind: Option<LatKind>,
    pub lat: i64,
}

/// A latency dict (`lat`, `lat_SR`), in the order of the Python dict.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(try_from = "IndexMap<String, i64>")]
pub struct LatData {
    pub entries: Vec<LatEntry>,
}

impl TryFrom<IndexMap<String, i64>> for LatData {
    type Error = String;

    fn try_from(map: IndexMap<String, i64>) -> Result<LatData, String> {
        let mut entries = Vec::with_capacity(map.len());
        for (key, lat) in map {
            let mut parts = key.split(',');
            let (Some(inp), Some(out)) = (parts.next(), parts.next()) else {
                return Err(format!("latency key {key:?}"));
            };
            let kind = match parts.next() {
                None => None,
                Some("addr") => Some(LatKind::Addr),
                Some("addrI") => Some(LatKind::AddrI),
                Some("mem") => Some(LatKind::Mem),
                Some(_) => return Err(format!("latency key {key:?}")),
            };
            if parts.next().is_some() {
                return Err(format!("latency key {key:?}"));
            }
            entries.push(LatEntry { inp: inp.to_string(), out: out.to_string(), kind, lat });
        }
        Ok(LatData { entries })
    }
}

impl LatData {
    /// `latData.get((inp, out))` for `kind == None`, `latData.get((inp, out, kind))` otherwise
    pub fn get(&self, inp: &str, out: &str, kind: Option<LatKind>) -> Option<i64> {
        self.entries.iter().find(|e| e.kind == kind && e.inp == inp && e.out == out).map(|e| e.lat)
    }

    /// `latData[key] = lat`: replaces the value of an existing key (which keeps its position) or appends
    pub fn set(&mut self, inp: &str, out: &str, kind: Option<LatKind>, lat: i64) {
        match self.entries.iter_mut().find(|e| e.kind == kind && e.inp == inp && e.out == out) {
            Some(e) => e.lat = lat,
            None => self.entries.push(LatEntry { inp: inp.to_string(), out: out.to_string(), kind, lat }),
        }
    }

    /// `any(name == k[0] for k in latData.keys())`
    pub fn has_input(&self, name: &str) -> bool {
        self.entries.iter().any(|e| e.inp == name)
    }
}

/// Performance data (an element of `perfData`). All keys are optional; the builder applies uiCA's defaults. The keys with the
/// suffix `_SR` apply if all register operands are the same register, those with `_I` if the address has an index register.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerfData {
    #[serde(default)]
    pub uops: Option<i64>,
    #[serde(rename = "retSlots", default)]
    pub ret_slots: Option<i64>,
    #[serde(rename = "uopsMITE", default)]
    pub uops_mite: Option<i64>,
    #[serde(rename = "uopsMS", default)]
    pub uops_ms: Option<i64>,
    #[serde(default)]
    pub ports: Option<PortData>,
    #[serde(default)]
    pub lat: Option<LatData>,
    /// requires the complex decoder (a number that is used as a truth value)
    #[serde(rename = "complDec", default)]
    pub compl_dec: Option<i64>,
    /// number of simple decoders that are available in the same cycle
    #[serde(rename = "sDec", default)]
    pub s_dec: Option<i64>,
    /// throughput limit in cycles
    #[serde(rename = "TP", default)]
    pub tp: Option<f64>,
    /// throughput limit of microcoded instructions (only used by the experimental configurations)
    #[serde(rename = "TP_MS", default)]
    pub tp_ms: Option<f64>,
    /// cycles for which the divider is blocked
    #[serde(rename = "divC", default)]
    pub div_c: Option<i64>,
    /// the instruction's load can be renamed (a number that is used as a truth value)
    #[serde(rename = "memRename", default)]
    pub mem_rename: Option<i64>,

    #[serde(rename = "uops_SR", default)]
    pub uops_sr: Option<i64>,
    #[serde(rename = "retSlots_SR", default)]
    pub ret_slots_sr: Option<i64>,
    #[serde(rename = "uopsMITE_SR", default)]
    pub uops_mite_sr: Option<i64>,
    #[serde(rename = "uopsMS_SR", default)]
    pub uops_ms_sr: Option<i64>,
    #[serde(rename = "ports_SR", default)]
    pub ports_sr: Option<PortData>,
    #[serde(rename = "lat_SR", default)]
    pub lat_sr: Option<LatData>,
    #[serde(rename = "complDec_SR", default)]
    pub compl_dec_sr: Option<i64>,
    #[serde(rename = "sDec_SR", default)]
    pub s_dec_sr: Option<i64>,
    #[serde(rename = "TP_SR", default)]
    pub tp_sr: Option<f64>,
    #[serde(rename = "divC_SR", default)]
    pub div_c_sr: Option<i64>,

    #[serde(rename = "uops_I", default)]
    pub uops_i: Option<i64>,
    #[serde(rename = "retSlots_I", default)]
    pub ret_slots_i: Option<i64>,
    #[serde(rename = "uopsMITE_I", default)]
    pub uops_mite_i: Option<i64>,
    #[serde(rename = "uopsMS_I", default)]
    pub uops_ms_i: Option<i64>,
    #[serde(rename = "ports_I", default)]
    pub ports_i: Option<PortData>,
    #[serde(rename = "complDec_I", default)]
    pub compl_dec_i: Option<i64>,
    #[serde(rename = "sDec_I", default)]
    pub s_dec_i: Option<i64>,
    #[serde(rename = "TP_I", default)]
    pub tp_i: Option<f64>,
    #[serde(rename = "divC_I", default)]
    pub div_c_i: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_a_table() {
        let json = r#"{"instrData": {"ADD_GPRv_GPRv_01": [
              {"attr": 1, "string": "ADD_01 (R64, R64)", "flagsW": ["A", "C"], "macroFusible": ["JZ (Rel8)"], "perfData": 0},
              {"attr": 0, "string": "LOCK ADD", "locked": 1, "perfData": 0}]},
            "attrData": [{}, {"eosz": "3", "rm": "0123"}],
            "perfData": [{"uops": 1, "retSlots": 1, "uopsMITE": 1, "uopsMS": 0, "ports": {"0156": 1, "23": 2}, "TP": 0.5, "TP_I": 2,
                          "lat": {"REG0,REG0": 1, "MEM0,REG0,addr": 6, "MEM0,REG0,addrI": 7, "MEM0,REG0,mem": 3}, "complDec": 1}]}"#;
        let data = ArchData::from_json(json).unwrap();
        let entries = &data.instr_data["ADD_GPRv_GPRv_01"];
        assert_eq!(entries[0].flags_w.as_deref(), Some(&["A".to_string(), "C".to_string()][..]));
        assert!(!entries[0].has_lock_prefix() && entries[1].has_lock_prefix());
        assert_eq!(data.attr_data[1].eosz.as_deref(), Some("3"));
        let perf = &data.perf_data[0];
        assert_eq!(perf.ports.as_ref().unwrap().iter().map(|(p, n)| (p.as_str(), *n)).collect::<Vec<_>>(), [("0156", 1), ("23", 2)]);
        assert_eq!((perf.tp, perf.tp_i, perf.tp_ms), (Some(0.5), Some(2.0), None));
        let lat = perf.lat.as_ref().unwrap();
        assert_eq!(lat.get("REG0", "REG0", None), Some(1));
        assert_eq!(lat.get("MEM0", "REG0", Some(LatKind::AddrI)), Some(7));
        assert_eq!(lat.get("MEM0", "REG0", None), None);
        assert!(lat.has_input("MEM0") && !lat.has_input("REG1"));
        // unknown keys and bad indices are errors
        assert!(ArchData::from_json(r#"{"instrData": {}, "attrData": [], "perfData": [{"uops_X": 1}]}"#).is_err());
        assert!(ArchData::from_json(r#"{"instrData": {"X": [{"attr": 0, "string": "X", "perfData": 0}]}, "attrData": [], "perfData": []}"#).is_err());
    }
}
