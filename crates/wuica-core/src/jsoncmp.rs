//! Comparison of JSON values for the fixture tests: numbers are compared by value (the reference writes `8` where Rust writes
//! `8.0`), and the order of the keys of objects is ignored (the order of arrays is not).

use serde_json::Value;

/// Returns `None` if the values are equal, and a description of the first difference (with its path) otherwise.
pub fn diff(a: &Value, b: &Value) -> Option<String> {
    diff_at(a, b, &mut String::from("$"))
}

fn diff_at(a: &Value, b: &Value, path: &mut String) -> Option<String> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let equal = match (x.as_i64(), y.as_i64()) {
                (Some(p), Some(q)) => p == q,
                _ => x.as_f64() == y.as_f64(),
            };
            (!equal).then(|| format!("{path}: {x} != {y}"))
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{path}: arrays of length {} and {}", x.len(), y.len()));
            }
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                let len = path.len();
                path.push_str(&format!("[{i}]"));
                if let Some(d) = diff_at(p, q, path) {
                    return Some(d);
                }
                path.truncate(len);
            }
            None
        }
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys() {
                if !y.contains_key(k) {
                    return Some(format!("{path}: key {k:?} only on the left"));
                }
            }
            for (k, q) in y {
                let Some(p) = x.get(k) else {
                    return Some(format!("{path}: key {k:?} only on the right"));
                };
                let len = path.len();
                path.push_str(&format!(".{k}"));
                if let Some(d) = diff_at(p, q, path) {
                    return Some(d);
                }
                path.truncate(len);
            }
            None
        }
        _ => (a != b).then(|| format!("{path}: {a} != {b}")),
    }
}
