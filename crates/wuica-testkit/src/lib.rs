//! Test helpers of the workspace (a dev-dependency only).
//!
//! The fixtures are gzipped JSONL files (docs/PORTING.md), about 1.7 GB of JSON in all, 1.3 GB of which is the `json` field
//! (the `-json` trace) of the simulation fixtures. Every test that reads a fixture used to decompress it (flate2's Rust
//! backend: about 1 s per GB) and to scan all of it, including the traces it does not use.
//!
//! - [`open`] and [`lines`] decompress a `.gz` file (up to 8 MB gzipped: the instruction and decode fixtures) once into
//!   `target/fixture-cache/` and from then on read that copy.
//! - [`lines_without_json`] gives the lines without their top-level `json` field, for tests that do not use it, from a copy
//!   in the cache made once (the simulation fixtures: 1.4 GB of JSON become 100 MB).
//!
//! A copy is named after the path, size and modification time of the source, so a regenerated fixture gets a new copy (and the
//! old one is removed). The lines are exactly those of the gzipped file (decompressed with the same `GzDecoder` as before).
//!
//! Environment: `WUICA_FIXTURE_CACHE` = the directory of the cache (default `<workspace>/target/fixture-cache`), or `off` to
//! read the gzipped files directly.

use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BUF: usize = 1 << 20;
/// [`open`] makes uncompressed copies of gzipped files up to this size.
const MAX_COPIED: u64 = 8 << 20;

/// The root of the workspace.
pub fn root() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

fn resolve(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        root().join(path)
    }
}

fn is_gz(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "gz")
}

fn open_raw(path: &Path) -> Box<dyn BufRead + Send> {
    let file = File::open(path).unwrap_or_else(|e| panic!("{}: {e} (see docs/PORTING.md)", path.display()));
    if is_gz(path) {
        Box::new(BufReader::with_capacity(BUF, flate2::read::GzDecoder::new(BufReader::with_capacity(BUF, file))))
    } else {
        Box::new(BufReader::with_capacity(BUF, file))
    }
}

/// Opens a fixture file (a path relative to the workspace root, or absolute). Files ending in `.gz` are read decompressed,
/// from the cache when possible. Panics if the file cannot be opened.
pub fn open(path: impl AsRef<Path>) -> Box<dyn BufRead + Send> {
    let path = resolve(path.as_ref());
    // Only smaller files are copied: the simulation fixtures (45 MB gzipped, 1 GB of JSON, mostly traces) are read by tests
    // that parse all of it, so decompressing is a small part of their time (sim_fixtures: no measurable difference) and a
    // copy would only take 1.5 GB of disk.
    if is_gz(&path) && fs::metadata(&path).is_ok_and(|m| m.len() <= MAX_COPIED) {
        if let Some(cached) = cached(&path, "", |input, out| io::copy(input, out).map(drop)) {
            return Box::new(BufReader::with_capacity(BUF, cached));
        }
    }
    open_raw(&path)
}

/// The lines of a fixture file (see [`open`]).
pub fn lines(path: impl AsRef<Path>) -> Box<dyn Iterator<Item = String> + Send> {
    Box::new(open(path).lines().map(|l| l.unwrap()))
}

/// The lines of a fixture file without their top-level `"json"` field, where it is the last field of the line (as in the
/// simulation fixtures); other lines are unchanged. Only for readers that do not use that field: they get the same values.
pub fn lines_without_json(path: impl AsRef<Path>) -> Box<dyn Iterator<Item = String> + Send> {
    let path = resolve(path.as_ref());
    if is_gz(&path) {
        let made = cached(&path, ".nojson", |input, out| {
            for line in input.lines() {
                let line = line?;
                out.write_all(strip_json_field(&line).as_deref().unwrap_or(&line).as_bytes())?;
                out.write_all(b"\n")?;
            }
            Ok(())
        });
        if let Some(file) = made {
            return Box::new(BufReader::with_capacity(BUF, file).lines().map(|l| l.unwrap()));
        }
    }
    Box::new(open_raw(&path).lines().map(|l| l.unwrap()).map(|l| strip_json_field(&l).unwrap_or(l)))
}

/// `line` without its top-level field `"json"` if that is the last field of the object (`, "json": VALUE}` at the end);
/// `None` otherwise.
fn strip_json_field(line: &str) -> Option<String> {
    const KEY: &[u8] = b", \"json\": ";
    let b = line.as_bytes();
    if b.last() != Some(&b'}') {
        return None;
    }
    let (mut depth, mut in_str, mut esc, mut cut) = (0i32, false, false, None);
    for (i, &c) in b.iter().enumerate() {
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 && i != b.len() - 1 {
                    return None;
                }
            }
            b',' if depth == 1 => {
                if cut.is_some() {
                    return None; // a further field after "json"
                }
                if b[i..].starts_with(KEY) {
                    cut = Some(i);
                }
            }
            _ => {}
        }
    }
    let cut = cut?;
    (depth == 0 && !in_str).then(|| format!("{}}}", &line[..cut]))
}

fn cache_dir() -> Option<PathBuf> {
    match std::env::var_os("WUICA_FIXTURE_CACHE") {
        Some(v) if v == "off" || v == "0" => None,
        Some(v) if !v.is_empty() => Some(PathBuf::from(v)),
        _ => Some(root().join("target/fixture-cache")),
    }
}

/// The file in the cache made by `make` from the decompressed `source`, made if it does not exist yet; `None` if the cache
/// is off or cannot be written (then the caller reads the gzipped file).
fn cached(source: &Path, variant: &str, make: impl Fn(&mut dyn BufRead, &mut dyn Write) -> io::Result<()>) -> Option<File> {
    static CREATING: Mutex<()> = Mutex::new(());
    static TMP: AtomicUsize = AtomicUsize::new(0);

    let dir = cache_dir()?;
    let meta = fs::metadata(source).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    let mut h = DefaultHasher::new();
    fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf()).hash(&mut h);
    // e.g. sim_fixtures.jsonl.nojson.<hash of the source's path>.<size>-<mtime>
    let prefix = format!("{}{variant}.{:016x}.", source.file_stem()?.to_string_lossy(), h.finish());
    let name = format!("{prefix}{}-{mtime}", meta.len());
    let path = dir.join(&name);
    if let Ok(f) = File::open(&path) {
        return Some(f);
    }
    // one thread of this process makes the copy, the others wait for it (other processes may make it at the same time:
    // each writes its own temporary file and renames it into place, which is atomic)
    let _guard = CREATING.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(f) = File::open(&path) {
        return Some(f);
    }
    fs::create_dir_all(&dir).ok()?;
    let tmp = dir.join(format!("{name}.tmp-{}-{}", std::process::id(), TMP.fetch_add(1, Ordering::Relaxed)));
    let made = (|| -> io::Result<()> {
        let mut out = BufWriter::with_capacity(BUF, File::create(&tmp)?);
        let file = BufReader::with_capacity(BUF, File::open(source)?);
        let mut input = BufReader::with_capacity(BUF, flate2::read::GzDecoder::new(file));
        make(&mut input, &mut out)?;
        // the whole input must have been consumed
        if input.read(&mut [0u8; 1])? != 0 {
            return Err(io::Error::other("input not consumed"));
        }
        out.into_inner().map_err(|e| e.into_error())?;
        fs::rename(&tmp, &path)
    })();
    if made.is_err() {
        let _ = fs::remove_file(&tmp);
        return None;
    }
    // remove the copies of earlier versions of this file, and temporary files left by killed runs
    let hour_ago = SystemTime::now() - Duration::from_secs(3600);
    for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let n = entry.file_name().to_string_lossy().into_owned();
        let stale_tmp = n.contains(".tmp-") && entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < hour_ago);
        if (n.starts_with(&prefix) && n != name && !n.contains(".tmp-")) || stale_tmp {
            let _ = fs::remove_file(entry.path());
        }
    }
    File::open(&path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_json_field_only_removes_a_last_top_level_field() {
        let s = |l: &str| strip_json_field(l);
        assert_eq!(s(r#"{"a": 1, "json": {"x": [1, "}"]}}"#).as_deref(), Some(r#"{"a": 1}"#));
        assert_eq!(s(r#"{"a": "s, \"json\": 2", "json": 3}"#).as_deref(), Some(r#"{"a": "s, \"json\": 2"}"#));
        assert_eq!(s(r#"{"a": 1, "json": {"x": 1}, "b": 2}"#), None);
        assert_eq!(s(r#"{"a": {"b": 1, "json": 2}}"#), None);
        assert_eq!(s(r#"{"a": "x\\", "json": [1]}"#).as_deref(), Some(r#"{"a": "x\\"}"#));
        assert_eq!(s(r#"{"a": 1}"#), None);
    }

    #[test]
    fn cached_lines_equal_the_gzipped_lines() {
        let dir = std::env::temp_dir().join(format!("wuica-testkit-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let gz = dir.join("t.jsonl.gz");
        let text = "{\"a\": 1, \"json\": {\"t\": [1]}}\n{\"b\": \"\u{2502}\"}\n\nlast line without newline";
        let mut enc = flate2::write::GzEncoder::new(File::create(&gz).unwrap(), flate2::Compression::fast());
        enc.write_all(text.as_bytes()).unwrap();
        enc.finish().unwrap();
        std::env::set_var("WUICA_FIXTURE_CACHE", dir.join("cache"));
        let expected: Vec<String> = text.lines().map(String::from).collect();
        assert_eq!(lines(&gz).collect::<Vec<_>>(), expected); // makes the copy
        assert_eq!(fs::read_dir(dir.join("cache")).unwrap().count(), 1);
        assert_eq!(lines(&gz).collect::<Vec<_>>(), expected); // reads the copy
        let mut raw = String::new();
        open(&gz).read_to_string(&mut raw).unwrap();
        assert_eq!(raw, text);
        let mut stripped = expected.clone();
        stripped[0] = "{\"a\": 1}".into();
        assert_eq!(lines_without_json(&gz).collect::<Vec<_>>(), stripped);
        assert_eq!(lines_without_json(&gz).collect::<Vec<_>>(), stripped);
        assert_eq!(fs::read_dir(dir.join("cache")).unwrap().count(), 2);
        fs::remove_dir_all(&dir).unwrap();
    }
}
