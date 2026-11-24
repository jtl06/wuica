//! The binary form of an instruction table ([`ArchData`]): what the npm package, the web page and the server ship instead of
//! `data/arch/<NAME>.json`, which stays the interchange format (the export tools, the fixtures and the tests read and write
//! JSON). `examples/encode_tables.rs` writes it at build time. It is read in place: [`LazyTable`] keeps the bytes and
//! decodes an instruction form, an attribute record or a performance record the first time the instruction builder asks
//! for it (a block uses a handful of the thousands of forms a table has); [`ArchData::from_bin`] decodes all of it (tools
//! and tests). `tests/table_bin.rs` checks that both give what [`ArchData::from_json`] gives, for every table.
//!
//! Layout (format version 2; little-endian, no pointers, no dependence on how a compiler lays out structs): the magic
//! `WUICATBL`, the format version (u16, [`VERSION`]), two zero bytes, then nine u32: the numbers of shared strings,
//! attribute records, performance records and instruction forms, and the lengths of the five streams that follow:
//! - `lens`: the length of each shared string (varints), `txt`: the shared strings' UTF-8 bytes;
//! - `attr`, `perf`: the attribute and performance records, `entry`: the forms' entry lists, sorted by the form's name
//!   (byte order; the lookup is a binary search); each record and list starts with its length in bytes (a varint).
//! Opening a table walks these lengths once for the offsets (no record is decoded); a record is decoded on first use.
//! Nothing else is stored: no offset tables, which compress badly (a first version of this format with u32 offsets and
//! string numbers was 2.6 times as large with brotli as the streamed format 1).
//!
//! In the records, numbers are LEB128 varints (integers zigzag), floats 8 bytes (IEEE 754), and a string is a reference:
//! k + 1 for the k-th shared string (one used more than once: port combinations, operand names, flags), or 0 followed by
//! the string itself (its length and bytes: the names of the entries and forms, used once, stay next to their record):
//! - attribute record: a bit mask of the fields present (declaration order), then their strings;
//! - performance record: a bit mask of the fields present (declaration order), then their values: port data as a count
//!   of (string, integer) pairs, latencies as a count of (input string, output string, kind byte: 0 none, 1 addr,
//!   2 addrI, 3 mem, latency);
//! - entry list: the form's name, the number of entries, the entries: its attribute record, its string, its performance
//!   record, a bit mask of its optional fields (flagsR, flagsW, locked, macroFusible) and their values (lists: a count of
//!   strings).
//!
//! A stale file (another magic or version) fails with a message, not with wrong tables; opening a file checks the
//! lengths, decoding a record checks the record. The forms' order in the table (the JSON's) is not kept: the builder
//! only looks forms up (each form's entries keep their order, which matters).

use crate::data::{ArchData, AttrData, InstrEntry, LatData, LatEntry, LatKind, PerfData, PortData, Tables};
use crate::fasthash::FxBuildHasher;
use indexmap::IndexMap;
use std::collections::HashMap;
use crate::fasthash::FastMap;
use std::sync::{Mutex, OnceLock};

pub const MAGIC: &[u8; 8] = b"WUICATBL";
/// The format version: increase it with any change of the layout (or of the fields of the structs).
pub const VERSION: u16 = 2;
const HEADER: usize = 8 + 2 + 2 + 9 * 4;

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

fn kind_code(k: Option<LatKind>) -> u8 {
    match k {
        None => 0,
        Some(LatKind::Addr) => 1,
        Some(LatKind::AddrI) => 2,
        Some(LatKind::Mem) => 3,
    }
}

// ---- writing ------------------------------------------------------------------------------------------------------------

fn uvar(out: &mut Vec<u8>, mut v: u64) {
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
fn ivar(out: &mut Vec<u8>, v: i64) {
    uvar(out, ((v << 1) ^ (v >> 63)) as u64);
}

/// The strings of a table: those used more than once are shared (numbered in the order they are first used), the others
/// are written where they are used.
struct Strings {
    uses: HashMap<String, usize>,
    shared: Vec<String>,
    index: HashMap<String, usize>,
}

impl Strings {
    fn reference(&mut self, out: &mut Vec<u8>, s: &str) {
        if self.uses.get(s).copied().unwrap_or(0) <= 1 {
            uvar(out, 0);
            uvar(out, s.len() as u64);
            out.extend_from_slice(s.as_bytes());
            return;
        }
        let k = match self.index.get(s) {
            Some(&k) => k,
            None => {
                self.index.insert(s.to_string(), self.shared.len());
                self.shared.push(s.to_string());
                self.shared.len() - 1
            }
        };
        uvar(out, k as u64 + 1);
    }
}

// Every string a table writes, in the order it writes them (to count the uses).
fn each_string(data: &ArchData, f: &mut dyn FnMut(&str)) {
    for (iform, entries) in &data.instr_data {
        f(iform);
        for e in entries {
            f(&e.string);
            for list in [&e.flags_r, &e.flags_w, &e.macro_fusible].into_iter().flatten() {
                for s in list {
                    f(s);
                }
            }
        }
    }
    for a in &data.attr_data {
        for x in attr_fields(&mut a.clone()) {
            if let Field::S(Some(s)) = x {
                f(s);
            }
        }
    }
    for p in &data.perf_data {
        for x in perf_fields(&mut p.clone()) {
            match x {
                Field::P(Some(p)) => p.keys().for_each(|k| f(k)),
                Field::L(Some(l)) => l.entries.iter().for_each(|e| {
                    f(&e.inp);
                    f(&e.out);
                }),
                _ => {}
            }
        }
    }
}

fn write_fields(out: &mut Vec<u8>, st: &mut Strings, fields: &[Field]) {
    let present = |f: &Field| match f {
        Field::I(v) => v.is_some(),
        Field::F(v) => v.is_some(),
        Field::S(v) => v.is_some(),
        Field::P(v) => v.is_some(),
        Field::L(v) => v.is_some(),
    };
    uvar(out, fields.iter().enumerate().fold(0u64, |m, (i, f)| if present(f) { m | 1 << i } else { m }));
    for f in fields {
        match f {
            Field::I(Some(v)) => ivar(out, *v),
            Field::F(Some(v)) => out.extend_from_slice(&v.to_le_bytes()),
            Field::S(Some(v)) => st.reference(out, v),
            Field::P(Some(p)) => {
                uvar(out, p.len() as u64);
                for (k, v) in p {
                    st.reference(out, k);
                    ivar(out, *v);
                }
            }
            Field::L(Some(l)) => {
                uvar(out, l.entries.len() as u64);
                for e in &l.entries {
                    st.reference(out, &e.inp);
                    st.reference(out, &e.out);
                    out.push(kind_code(e.kind));
                    ivar(out, e.lat);
                }
            }
            _ => {}
        }
    }
}

fn write_list(out: &mut Vec<u8>, st: &mut Strings, list: &[String]) {
    uvar(out, list.len() as u64);
    for s in list {
        st.reference(out, s);
    }
}

// a record with its length in front
fn record(stream: &mut Vec<u8>, body: &[u8]) {
    uvar(stream, body.len() as u64);
    stream.extend_from_slice(body);
}

impl ArchData {
    /// The binary form (see the top of this file).
    pub fn to_bin(&self) -> Vec<u8> {
        let mut uses = HashMap::new();
        each_string(self, &mut |s| *uses.entry(s.to_string()).or_insert(0) += 1);
        let mut st = Strings { uses, shared: Vec::new(), index: HashMap::new() };
        let (mut entry, mut attr, mut perf) = (Vec::new(), Vec::new(), Vec::new());
        let mut forms: Vec<(&String, &Vec<InstrEntry>)> = self.instr_data.iter().collect();
        forms.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let mut body = Vec::new();
        for (iform, entries) in forms {
            body.clear();
            st.reference(&mut body, iform);
            uvar(&mut body, entries.len() as u64);
            for e in entries {
                uvar(&mut body, e.attr as u64);
                st.reference(&mut body, &e.string);
                uvar(&mut body, e.perf_data as u64);
                let mask = [e.flags_r.is_some(), e.flags_w.is_some(), e.locked.is_some(), e.macro_fusible.is_some()]
                    .iter()
                    .enumerate()
                    .fold(0u64, |m, (i, &p)| if p { m | 1 << i } else { m });
                uvar(&mut body, mask);
                if let Some(f) = &e.flags_r {
                    write_list(&mut body, &mut st, f);
                }
                if let Some(f) = &e.flags_w {
                    write_list(&mut body, &mut st, f);
                }
                if let Some(l) = e.locked {
                    ivar(&mut body, l);
                }
                if let Some(f) = &e.macro_fusible {
                    write_list(&mut body, &mut st, f);
                }
            }
            record(&mut entry, &body);
        }
        for a in &self.attr_data {
            body.clear();
            write_fields(&mut body, &mut st, &attr_fields(&mut a.clone()));
            record(&mut attr, &body);
        }
        for p in &self.perf_data {
            body.clear();
            write_fields(&mut body, &mut st, &perf_fields(&mut p.clone()));
            record(&mut perf, &body);
        }
        let (mut lens, mut txt) = (Vec::new(), Vec::new());
        for s in &st.shared {
            uvar(&mut lens, s.len() as u64);
            txt.extend_from_slice(s.as_bytes());
        }
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        for n in [st.shared.len(), self.attr_data.len(), self.perf_data.len(), self.instr_data.len(), lens.len(), txt.len(), attr.len(), perf.len(), entry.len()] {
            out.extend_from_slice(&(n as u32).to_le_bytes());
        }
        for s in [&lens, &txt, &attr, &perf, &entry] {
            out.extend_from_slice(s);
        }
        out
    }

    /// Reads the binary form (see the top of this file) into the structures that [`ArchData::from_json`] builds: all of it
    /// (the forms in the order of their names).
    pub fn from_bin(bytes: &[u8]) -> Result<ArchData, String> {
        let t = Layout::read(bytes)?;
        let attr_data = (0..t.attr_at.len()).map(|k| t.attr(bytes, k)).collect::<Result<Vec<_>, _>>()?;
        let perf_data = (0..t.perf_at.len()).map(|k| t.perf(bytes, k)).collect::<Result<Vec<_>, _>>()?;
        let mut instr_data: IndexMap<String, Vec<InstrEntry>, FxBuildHasher> = IndexMap::with_capacity_and_hasher(t.entry_at.len(), Default::default());
        for k in 0..t.entry_at.len() {
            let (iform, entries) = t.form(bytes, k)?;
            if instr_data.insert(iform.clone(), entries).is_some() {
                return Err(format!("binary instruction table: iform {iform} twice"));
            }
        }
        Ok(ArchData { instr_data, attr_data, perf_data })
    }
}

// ---- reading ------------------------------------------------------------------------------------------------------------

/// Where everything is in the bytes of a table: the streams, and the offsets of the shared strings and of the records
/// (from their lengths, when the table is opened).
#[derive(Debug, Clone)]
struct Layout {
    txt: (usize, usize),
    attr: (usize, usize),
    perf: (usize, usize),
    entry: (usize, usize),
    str_at: Vec<u32>,   // n + 1 offsets in txt
    attr_at: Vec<u32>,  // offset of each record's body in attr
    perf_at: Vec<u32>,
    entry_at: Vec<u32>,
}

fn u32_at(b: &[u8], at: usize) -> usize {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap()) as usize
}

impl Layout {
    fn read(b: &[u8]) -> Result<Layout, String> {
        if !is_binary_table(b) {
            return Err("not a binary instruction table (no WUICATBL header)".into());
        }
        if b.len() < HEADER {
            return Err("binary instruction table: truncated header".into());
        }
        let version = u16::from_le_bytes([b[8], b[9]]);
        if version != VERSION {
            return Err(format!("binary instruction table of format version {version}; this analyzer reads version {VERSION} (rebuild the tables)"));
        }
        let h: Vec<usize> = (0..9).map(|k| u32_at(b, 12 + 4 * k)).collect();
        let mut at = HEADER;
        let mut stream = |len: usize| {
            let s = (at, at.saturating_add(len));
            at = at.saturating_add(len);
            s
        };
        let (lens, txt, attr, perf, entry) = (stream(h[4]), stream(h[5]), stream(h[6]), stream(h[7]), stream(h[8]));
        if at != b.len() {
            return Err(format!("binary instruction table: {} bytes, the header says {at}", b.len()));
        }
        // the shared strings' offsets from their lengths
        let mut r = Reader { b: &b[lens.0..lens.1], p: 0 };
        let mut str_at = Vec::with_capacity(h[0] + 1);
        let mut o = 0usize;
        str_at.push(0);
        for _ in 0..h[0] {
            o += r.count()?;
            str_at.push(o as u32);
        }
        if r.p != lens.1 - lens.0 || o != txt.1 - txt.0 {
            return Err("binary instruction table: the string lengths do not fit".into());
        }
        if std::str::from_utf8(&b[txt.0..txt.1]).is_err() {
            return Err("binary instruction table: the strings are not UTF-8".into());
        }
        // the records' offsets from their lengths
        let offsets = |s: (usize, usize), n: usize| -> Result<Vec<u32>, String> {
            let mut r = Reader { b: &b[s.0..s.1], p: 0 };
            let mut out = Vec::with_capacity(n);
            for _ in 0..n {
                let len = r.count()?;
                out.push(r.p as u32);
                r.p = r.p.checked_add(len).filter(|&e| e <= r.b.len()).ok_or("binary instruction table: a record runs past its stream")?;
            }
            if r.p != r.b.len() {
                return Err("binary instruction table: trailing bytes in a stream".into());
            }
            Ok(out)
        };
        let (attr_at, perf_at, entry_at) = (offsets(attr, h[1])?, offsets(perf, h[2])?, offsets(entry, h[3])?);
        Ok(Layout { txt, attr, perf, entry, str_at, attr_at, perf_at, entry_at })
    }

    /// A string reference (see the top of this file) at the reader's position: its bytes.
    fn str_ref<'b>(&self, b: &'b [u8], r: &mut Reader<'b>) -> Result<&'b [u8], String> {
        let k = r.count()?;
        if k == 0 {
            let n = r.count()?;
            let s = r.b.get(r.p..r.p + n).ok_or_else(|| r.err("truncated"))?;
            r.p += n;
            return Ok(s);
        }
        let k = k - 1;
        if k + 1 >= self.str_at.len() {
            return Err(r.err("string index out of range"));
        }
        Ok(&b[self.txt.0 + self.str_at[k] as usize..self.txt.0 + self.str_at[k + 1] as usize])
    }

    fn string<'b>(&self, b: &'b [u8], r: &mut Reader<'b>) -> Result<String, String> {
        let s = self.str_ref(b, r)?;
        String::from_utf8(s.to_vec()).map_err(|_| r.err("a string is not UTF-8"))
    }

    fn reader<'b>(&self, b: &'b [u8], stream: (usize, usize), at: u32) -> Reader<'b> {
        Reader { b: &b[stream.0..stream.1], p: at as usize }
    }

    fn attr(&self, b: &[u8], k: usize) -> Result<AttrData, String> {
        let mut r = self.reader(b, self.attr, self.attr_at[k]);
        let mut a = AttrData::default();
        self.fields(b, &mut r, &mut attr_fields(&mut a))?;
        Ok(a)
    }

    fn perf(&self, b: &[u8], k: usize) -> Result<PerfData, String> {
        let mut r = self.reader(b, self.perf, self.perf_at[k]);
        let mut p = PerfData::default();
        self.fields(b, &mut r, &mut perf_fields(&mut p))?;
        Ok(p)
    }

    /// The name of the k-th form (in name order).
    fn form_name<'b>(&self, b: &'b [u8], k: usize) -> Result<&'b [u8], String> {
        let mut r = self.reader(b, self.entry, self.entry_at[k]);
        self.str_ref(b, &mut r)
    }

    /// The k-th form: its name and its entries.
    fn form(&self, b: &[u8], k: usize) -> Result<(String, Vec<InstrEntry>), String> {
        let mut r = self.reader(b, self.entry, self.entry_at[k]);
        let iform = self.string(b, &mut r)?;
        let n = r.count()?;
        let mut entries = Vec::with_capacity(n.min(64));
        for _ in 0..n {
            let attr = r.count()?;
            let string = self.string(b, &mut r)?;
            let perf = r.count()?;
            let mask = r.uvar()?;
            if mask >> 4 != 0 {
                return Err(r.err("unknown fields in an instrData entry"));
            }
            let flags_r = if mask & 1 != 0 { Some(self.list(b, &mut r)?) } else { None };
            let flags_w = if mask & 2 != 0 { Some(self.list(b, &mut r)?) } else { None };
            let locked = if mask & 4 != 0 { Some(r.ivar()?) } else { None };
            let macro_fusible = if mask & 8 != 0 { Some(self.list(b, &mut r)?) } else { None };
            if attr >= self.attr_at.len() || perf >= self.perf_at.len() {
                return Err(format!("{string}: index out of range"));
            }
            entries.push(InstrEntry { attr, string, perf_data: perf, flags_r, flags_w, locked, macro_fusible });
        }
        Ok((iform, entries))
    }

    fn list<'b>(&self, b: &'b [u8], r: &mut Reader<'b>) -> Result<Vec<String>, String> {
        let n = r.count()?;
        (0..n).map(|_| self.string(b, r)).collect()
    }

    fn fields<'b>(&self, b: &'b [u8], r: &mut Reader<'b>, fields: &mut [Field]) -> Result<(), String> {
        let mask = r.uvar()?;
        if mask >> fields.len() != 0 {
            return Err(r.err("unknown fields"));
        }
        for (i, f) in fields.iter_mut().enumerate() {
            if mask & (1 << i) == 0 {
                continue;
            }
            match f {
                Field::I(v) => **v = Some(r.ivar()?),
                Field::F(v) => **v = Some(r.f64()?),
                Field::S(v) => **v = Some(self.string(b, r)?),
                Field::P(v) => {
                    let n = r.count()?;
                    let mut ports = PortData::with_capacity_and_hasher(n.min(64), Default::default());
                    for _ in 0..n {
                        let k = self.string(b, r)?;
                        ports.insert(k, r.ivar()?);
                    }
                    **v = Some(ports);
                }
                Field::L(v) => {
                    let n = r.count()?;
                    let mut entries = Vec::with_capacity(n.min(64));
                    for _ in 0..n {
                        let inp = self.string(b, r)?;
                        let out = self.string(b, r)?;
                        let kind = match r.byte()? {
                            0 => None,
                            1 => Some(LatKind::Addr),
                            2 => Some(LatKind::AddrI),
                            3 => Some(LatKind::Mem),
                            _ => return Err(r.err("latency kind")),
                        };
                        entries.push(LatEntry { inp, out, kind, lat: r.ivar()? });
                    }
                    **v = Some(LatData { entries });
                }
            }
        }
        Ok(())
    }

    /// The position of a form (binary search by name).
    fn find(&self, b: &[u8], iform: &str) -> Option<usize> {
        let (mut lo, mut hi) = (0, self.entry_at.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            match self.form_name(b, mid).ok()?.cmp(iform.as_bytes()) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return Some(mid),
            }
        }
        None
    }
}

struct Reader<'b> {
    b: &'b [u8],
    p: usize,
}

impl Reader<'_> {
    fn err(&self, what: &str) -> String {
        format!("binary instruction table: {what} (byte {})", self.p)
    }
    fn byte(&mut self) -> Result<u8, String> {
        let b = *self.b.get(self.p).ok_or_else(|| self.err("truncated"))?;
        self.p += 1;
        Ok(b)
    }
    fn uvar(&mut self) -> Result<u64, String> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = self.byte()?;
            v |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(self.err("varint too long"))
    }
    fn count(&mut self) -> Result<usize, String> {
        let v = self.uvar()?;
        usize::try_from(v).ok().filter(|&n| n <= u32::MAX as usize).ok_or_else(|| self.err("count out of range"))
    }
    fn ivar(&mut self) -> Result<i64, String> {
        let v = self.uvar()?;
        Ok(((v >> 1) as i64) ^ -((v & 1) as i64))
    }
    fn f64(&mut self) -> Result<f64, String> {
        let b = self.b.get(self.p..self.p + 8).ok_or_else(|| self.err("truncated"))?;
        self.p += 8;
        Ok(f64::from_le_bytes(b.try_into().unwrap()))
    }
}

// ---- on demand ------------------------------------------------------------------------------------------------------------

/// A table read in place: the bytes of its binary form, and each form, attribute record and performance record decoded
/// the first time it is asked for (then kept: the builder holds references to them, and shares a performance record's
/// port data between the instructions that use it, as uiCA shares the dict objects). The same structures as the eager
/// load ([`ArchData::from_bin`], [`ArchData::from_json`]).
pub struct LazyTable {
    bytes: Box<[u8]>,
    t: Layout,
    forms: Vec<OnceLock<Box<[InstrEntry]>>>,
    attrs: Vec<OnceLock<Box<AttrData>>>,
    perfs: Vec<OnceLock<Box<PerfData>>>,
    // the forms looked up so far: name -> position (or absent), so that an analysis does not search again for every
    // instruction (the eager table is a hash map too)
    found: Mutex<FastMap<Box<str>, Option<usize>>>,
}

impl LazyTable {
    /// Opens a table: checks the header and the lengths, and keeps the bytes (nothing is decoded yet).
    pub fn new(bytes: Vec<u8>) -> Result<LazyTable, String> {
        let t = Layout::read(&bytes)?;
        Ok(LazyTable {
            forms: (0..t.entry_at.len()).map(|_| OnceLock::new()).collect(),
            attrs: (0..t.attr_at.len()).map(|_| OnceLock::new()).collect(),
            perfs: (0..t.perf_at.len()).map(|_| OnceLock::new()).collect(),
            found: Mutex::new(FastMap::default()),
            bytes: bytes.into_boxed_slice(),
            t,
        })
    }

    /// The number of instruction forms.
    pub fn len(&self) -> usize {
        self.t.entry_at.len()
    }

    pub fn is_empty(&self) -> bool {
        self.t.entry_at.is_empty()
    }

    /// The forms' names, in name order (tests: every entry, decoded on demand, against the eager load).
    pub fn iforms(&self) -> Vec<String> {
        (0..self.len()).map(|k| String::from_utf8(self.t.form_name(&self.bytes, k).unwrap().to_vec()).unwrap()).collect()
    }

    /// How many forms, attribute and performance records have been decoded so far.
    pub fn decoded(&self) -> (usize, usize, usize) {
        (
            self.forms.iter().filter(|x| x.get().is_some()).count(),
            self.attrs.iter().filter(|x| x.get().is_some()).count(),
            self.perfs.iter().filter(|x| x.get().is_some()).count(),
        )
    }
}

// A record that does not decode is a damaged file that passed the checks of `new`: the analysis cannot go on.
fn decoded<T>(r: Result<T, String>) -> T {
    r.unwrap_or_else(|e| panic!("{e}"))
}

impl Tables for LazyTable {
    fn entries(&self, iform: &str) -> Option<&[InstrEntry]> {
        let k = {
            let mut found = self.found.lock().unwrap_or_else(|e| e.into_inner());
            match found.get(iform) {
                Some(&k) => k,
                None => {
                    let k = self.t.find(&self.bytes, iform);
                    found.insert(iform.into(), k);
                    k
                }
            }
        }?;
        Some(self.forms[k].get_or_init(|| decoded(self.t.form(&self.bytes, k)).1.into_boxed_slice()))
    }

    fn attr(&self, k: usize) -> &AttrData {
        self.attrs[k].get_or_init(|| Box::new(decoded(self.t.attr(&self.bytes, k))))
    }

    fn perf(&self, k: usize) -> &PerfData {
        self.perfs[k].get_or_init(|| Box::new(decoded(self.t.perf(&self.bytes, k))))
    }
}
