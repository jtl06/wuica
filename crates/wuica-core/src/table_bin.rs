//! The binary form of an instruction table ([`ArchData`]): what the npm package, the web page and the server ship instead of
//! `data/arch/<NAME>.json`, which stays the interchange format (the export tools, the fixtures and the tests read and write
//! JSON). `examples/encode_tables.rs` writes it at build time; [`ArchData::from_bin`] reads it into the same structures as
//! [`ArchData::from_json`] (`tests/table_bin.rs` checks that they are equal for every table).
//!
//! Layout (little-endian, no pointers, no dependence on how a compiler lays out structs): the magic `WUICATBL`, the format
//! version (u16, [`VERSION`]), two zero bytes, the lengths of the five streams (u32 each), then the streams. Each kind of
//! value goes to its own stream, so that brotli finds the repeats of each kind (one stream of mixed varints compressed 36%
//! worse than the JSON):
//! - `ctl`: counts, bit masks of the fields present, latency kinds (unsigned LEB128 varints; kinds 0 none, 1 addr, 2 addrI,
//!   3 mem);
//! - `int`: integer values (zigzag varints) and the attr / perfData indices of the entries (varints);
//! - `flt`: float values (`TP` and the like: 8 bytes, IEEE 754);
//! - `ref`: references to strings: 0 for a string seen for the first time (it is the next one in `txt`), k + 1 for the k-th
//!   string seen before (port combinations, operand names, flags repeat thousands of times: each is stored once);
//! - `txt`: the strings in the order they are first seen, each followed by a zero byte.
//!
//! In `ctl`: `attrData`'s count, then per element a mask of its fields (declaration order); the same
//! for `perfData` (port data: a count of (string, integer); latencies: a count of (input, output, kind, latency)); the number
//! of iforms, then per iform its entry count and per entry a mask of its optional fields (flagsR, flagsW, locked,
//! macroFusible) and the lengths of its lists. Every byte of every stream must be read: trailing bytes are an error, like a
//! wrong magic or version (a stale file fails with a message, not with wrong tables).

use crate::data::{ArchData, AttrData, InstrEntry, LatData, LatEntry, LatKind, PerfData, PortData};
use crate::fasthash::FxBuildHasher;
use indexmap::IndexMap;
use crate::fasthash::LookupMap;

pub const MAGIC: &[u8; 8] = b"WUICATBL";
/// The format version: increase it with any change of the layout (or of the fields of the structs).
pub const VERSION: u16 = 1;
const HEADER: usize = 8 + 2 + 2 + 5 * 4;
const CTL: usize = 0;
const INT: usize = 1;
const FLT: usize = 2;
const REF: usize = 3;
const TXT: usize = 4;

/// Whether the bytes start like a binary table (whatever its version).
pub fn is_binary_table(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && &bytes[..8] == MAGIC
}

/// The value of one field of a struct, for the field lists below (one list per struct, in declaration order, shared by the
/// writer and the reader so that they cannot disagree).
enum Field<'a> {
    I(&'a mut Option<i64>),
    F(&'a mut Option<f64>),
    S(&'a mut Option<String>),
    P(&'a mut Option<PortData>),
    L(&'a mut Option<LatData>),
}

// (destructured without `..`: a field added to a struct fails to compile here until the format has it, and VERSION goes up)
fn attr_fields(a: &mut AttrData) -> [Field<'_>; 11] {
    use Field::S;
    let AttrData { agen, bcast, eosz, high8, iform, immzero, mask, rep, sae, zeroing, rm } = a;
    [S(agen), S(bcast), S(eosz), S(high8), S(iform), S(immzero), S(mask), S(rep), S(sae), S(zeroing), S(rm)]
}

fn perf_fields(p: &mut PerfData) -> [Field<'_>; 31] {
    use Field::{F, I, L, P};
    let PerfData {
        uops, ret_slots, uops_mite, uops_ms, ports, lat, compl_dec, s_dec, tp, tp_ms, div_c, mem_rename,
        uops_sr, ret_slots_sr, uops_mite_sr, uops_ms_sr, ports_sr, lat_sr, compl_dec_sr, s_dec_sr, tp_sr, div_c_sr,
        uops_i, ret_slots_i, uops_mite_i, uops_ms_i, ports_i, compl_dec_i, s_dec_i, tp_i, div_c_i,
    } = p;
    [
        I(uops), I(ret_slots), I(uops_mite), I(uops_ms), P(ports), L(lat), I(compl_dec), I(s_dec), F(tp), F(tp_ms), I(div_c), I(mem_rename),
        I(uops_sr), I(ret_slots_sr), I(uops_mite_sr), I(uops_ms_sr), P(ports_sr), L(lat_sr), I(compl_dec_sr), I(s_dec_sr), F(tp_sr), I(div_c_sr),
        I(uops_i), I(ret_slots_i), I(uops_mite_i), I(uops_ms_i), P(ports_i), I(compl_dec_i), I(s_dec_i), F(tp_i), I(div_c_i),
    ]
}

fn kind_code(k: Option<LatKind>) -> u64 {
    match k {
        None => 0,
        Some(LatKind::Addr) => 1,
        Some(LatKind::AddrI) => 2,
        Some(LatKind::Mem) => 3,
    }
}

// ---- writing ------------------------------------------------------------------------------------------------------------

struct Writer {
    s: [Vec<u8>; 5],
    strings: Vec<String>,
    index: LookupMap<String, usize>,
}

impl Writer {
    fn uvar(&mut self, stream: usize, mut v: u64) {
        let out = &mut self.s[stream];
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }
    fn ivar(&mut self, v: i64) {
        self.uvar(INT, ((v << 1) ^ (v >> 63)) as u64);
    }
    fn str(&mut self, s: &str) {
        match self.index.get(s) {
            Some(&k) => self.uvar(REF, k as u64 + 1),
            None => {
                self.index.insert(s.to_string(), self.strings.len());
                self.strings.push(s.to_string());
                self.uvar(REF, 0);
                self.s[TXT].extend_from_slice(s.as_bytes());
                self.s[TXT].push(0);
            }
        }
    }
    fn strs(&mut self, list: &[String]) {
        self.uvar(CTL, list.len() as u64);
        for s in list {
            self.str(s);
        }
    }
    fn fields(&mut self, fields: &[Field]) {
        let present = |f: &Field| match f {
            Field::I(v) => v.is_some(),
            Field::F(v) => v.is_some(),
            Field::S(v) => v.is_some(),
            Field::P(v) => v.is_some(),
            Field::L(v) => v.is_some(),
        };
        let mask = fields.iter().enumerate().fold(0u64, |m, (i, f)| if present(f) { m | 1 << i } else { m });
        self.uvar(CTL, mask);
        for f in fields {
            match f {
                Field::I(Some(v)) => self.ivar(*v),
                Field::F(Some(v)) => self.s[FLT].extend_from_slice(&v.to_le_bytes()),
                Field::S(Some(v)) => self.str(v),
                Field::P(Some(p)) => {
                    self.uvar(CTL, p.len() as u64);
                    for (k, v) in p {
                        self.str(k);
                        self.ivar(*v);
                    }
                }
                Field::L(Some(l)) => {
                    self.uvar(CTL, l.entries.len() as u64);
                    for e in &l.entries {
                        self.str(&e.inp);
                        self.str(&e.out);
                        self.uvar(CTL, kind_code(e.kind));
                        self.ivar(e.lat);
                    }
                }
                _ => {}
            }
        }
    }
}

impl ArchData {
    /// The binary form (see the top of this file).
    pub fn to_bin(&self) -> Vec<u8> {
        let mut w = Writer { s: Default::default(), strings: Vec::new(), index: LookupMap::default() };
        w.uvar(CTL, self.attr_data.len() as u64);
        for a in &self.attr_data {
            w.fields(&attr_fields(&mut a.clone()));
        }
        w.uvar(CTL, self.perf_data.len() as u64);
        for p in &self.perf_data {
            w.fields(&perf_fields(&mut p.clone()));
        }
        w.uvar(CTL, self.instr_data.len() as u64);
        for (iform, entries) in &self.instr_data {
            w.str(iform);
            w.uvar(CTL, entries.len() as u64);
            for e in entries {
                w.uvar(INT, e.attr as u64);
                w.str(&e.string);
                w.uvar(INT, e.perf_data as u64);
                let mask = [e.flags_r.is_some(), e.flags_w.is_some(), e.locked.is_some(), e.macro_fusible.is_some()]
                    .iter()
                    .enumerate()
                    .fold(0u64, |m, (i, &p)| if p { m | 1 << i } else { m });
                w.uvar(CTL, mask);
                if let Some(f) = &e.flags_r {
                    w.strs(f);
                }
                if let Some(f) = &e.flags_w {
                    w.strs(f);
                }
                if let Some(l) = e.locked {
                    w.ivar(l);
                }
                if let Some(f) = &e.macro_fusible {
                    w.strs(f);
                }
            }
        }
        let mut out = Vec::with_capacity(HEADER + w.s.iter().map(Vec::len).sum::<usize>());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        for s in &w.s {
            out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        }
        for s in &w.s {
            out.extend_from_slice(s);
        }
        out
    }

    /// Reads the binary form (see the top of this file) into the structures that [`ArchData::from_json`] builds.
    pub fn from_bin(bytes: &[u8]) -> Result<ArchData, String> {
        if !is_binary_table(bytes) {
            return Err("not a binary instruction table (no WUICATBL header)".into());
        }
        if bytes.len() < HEADER {
            return Err("binary instruction table: truncated header".into());
        }
        let version = u16::from_le_bytes([bytes[8], bytes[9]]);
        if version != VERSION {
            return Err(format!("binary instruction table of format version {version}; this analyzer reads version {VERSION} (rebuild the tables)"));
        }
        let mut r = Reader { s: [&[][..]; 5], p: [0; 5], strings: Vec::new() };
        let mut at = HEADER;
        for k in 0..5 {
            let len = u32::from_le_bytes(bytes[12 + 4 * k..16 + 4 * k].try_into().unwrap()) as usize;
            let end = at.checked_add(len).filter(|&e| e <= bytes.len()).ok_or("binary instruction table: truncated")?;
            r.s[k] = &bytes[at..end];
            at = end;
        }
        if at != bytes.len() {
            return Err("binary instruction table: trailing bytes".into());
        }
        let n = r.count(CTL)?;
        let mut attr_data = Vec::with_capacity(n);
        for _ in 0..n {
            let mut a = AttrData::default();
            r.fields(&mut attr_fields(&mut a))?;
            attr_data.push(a);
        }
        let n = r.count(CTL)?;
        let mut perf_data = Vec::with_capacity(n);
        for _ in 0..n {
            let mut p = PerfData::default();
            r.fields(&mut perf_fields(&mut p))?;
            perf_data.push(p);
        }
        let n = r.count(CTL)?;
        let mut instr_data: IndexMap<String, Vec<InstrEntry>, FxBuildHasher> = IndexMap::with_capacity_and_hasher(n, Default::default());
        for _ in 0..n {
            let iform = r.string()?;
            let m = r.count(CTL)?;
            let mut entries = Vec::with_capacity(m);
            for _ in 0..m {
                let attr = r.count(INT)?;
                let string = r.string()?;
                let perf = r.count(INT)?;
                let mask = r.uvar(CTL)?;
                if mask >> 4 != 0 {
                    return Err(r.err(CTL, "unknown fields in an instrData entry"));
                }
                let flags_r = if mask & 1 != 0 { Some(r.strs()?) } else { None };
                let flags_w = if mask & 2 != 0 { Some(r.strs()?) } else { None };
                let locked = if mask & 4 != 0 { Some(r.ivar()?) } else { None };
                let macro_fusible = if mask & 8 != 0 { Some(r.strs()?) } else { None };
                if attr >= attr_data.len() || perf >= perf_data.len() {
                    return Err(format!("{string}: index out of range"));
                }
                entries.push(InstrEntry { attr, string, perf_data: perf, flags_r, flags_w, locked, macro_fusible });
            }
            if instr_data.insert(iform.clone(), entries).is_some() {
                return Err(r.err(REF, &format!("iform {iform} twice")));
            }
        }
        for k in 0..5 {
            if r.p[k] != r.s[k].len() {
                return Err(r.err(k, "trailing bytes"));
            }
        }
        Ok(ArchData { instr_data, attr_data, perf_data })
    }
}

// ---- reading ------------------------------------------------------------------------------------------------------------

struct Reader<'a> {
    s: [&'a [u8]; 5],
    p: [usize; 5],
    strings: Vec<String>,
}

impl<'a> Reader<'a> {
    fn err(&self, stream: usize, what: &str) -> String {
        format!("binary instruction table: {what} (stream {stream}, byte {})", self.p[stream])
    }
    fn uvar(&mut self, k: usize) -> Result<u64, String> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = *self.s[k].get(self.p[k]).ok_or_else(|| self.err(k, "truncated"))?;
            self.p[k] += 1;
            v |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(self.err(k, "varint too long"))
    }
    fn count(&mut self, k: usize) -> Result<usize, String> {
        let v = self.uvar(k)?;
        // a count or an index cannot exceed the size of the file
        usize::try_from(v).ok().filter(|&n| n <= self.s.iter().map(|s| s.len()).sum()).ok_or_else(|| self.err(k, "count out of range"))
    }
    fn ivar(&mut self) -> Result<i64, String> {
        let v = self.uvar(INT)?;
        Ok(((v >> 1) as i64) ^ -((v & 1) as i64))
    }
    fn f64(&mut self) -> Result<f64, String> {
        let at = self.p[FLT];
        let b = self.s[FLT].get(at..at + 8).ok_or_else(|| self.err(FLT, "truncated"))?;
        self.p[FLT] += 8;
        Ok(f64::from_le_bytes(b.try_into().unwrap()))
    }
    fn string(&mut self) -> Result<String, String> {
        let k = self.uvar(REF)? as usize;
        if k > 0 {
            return self.strings.get(k - 1).cloned().ok_or_else(|| self.err(REF, "string index out of range"));
        }
        let (txt, from) = (self.s[TXT], self.p[TXT]);
        let len = txt[from..].iter().position(|&b| b == 0).ok_or_else(|| self.err(TXT, "truncated"))?;
        let s = std::str::from_utf8(&txt[from..from + len]).map_err(|_| self.err(TXT, "a string is not UTF-8"))?.to_string();
        self.p[TXT] = from + len + 1;
        self.strings.push(s.clone());
        Ok(s)
    }
    fn strs(&mut self) -> Result<Vec<String>, String> {
        let n = self.count(CTL)?;
        (0..n).map(|_| self.string()).collect()
    }
    fn fields(&mut self, fields: &mut [Field]) -> Result<(), String> {
        let mask = self.uvar(CTL)?;
        if mask >> fields.len() != 0 {
            return Err(self.err(CTL, "unknown fields"));
        }
        for (i, f) in fields.iter_mut().enumerate() {
            if mask & (1 << i) == 0 {
                continue;
            }
            match f {
                Field::I(v) => **v = Some(self.ivar()?),
                Field::F(v) => **v = Some(self.f64()?),
                Field::S(v) => **v = Some(self.string()?),
                Field::P(v) => {
                    let n = self.count(CTL)?;
                    let mut ports = PortData::with_capacity_and_hasher(n, Default::default());
                    for _ in 0..n {
                        let k = self.string()?;
                        let c = self.ivar()?;
                        ports.insert(k, c);
                    }
                    **v = Some(ports);
                }
                Field::L(v) => {
                    let n = self.count(CTL)?;
                    let mut entries = Vec::with_capacity(n);
                    for _ in 0..n {
                        let inp = self.string()?;
                        let out = self.string()?;
                        let kind = match self.uvar(CTL)? {
                            0 => None,
                            1 => Some(LatKind::Addr),
                            2 => Some(LatKind::AddrI),
                            3 => Some(LatKind::Mem),
                            _ => return Err(self.err(CTL, "latency kind")),
                        };
                        entries.push(LatEntry { inp, out, kind, lat: self.ivar()? });
                    }
                    **v = Some(LatData { entries });
                }
            }
        }
        Ok(())
    }
}
