//! `needle in haystack` for the short strings that uiCA tests (register names, uops.info names, operand names).
//!
//! `str::contains` with a string pattern builds a two-way searcher for every call; for a needle of a few bytes in a name of a
//! few dozen bytes, that setup costs more than the search (in WebAssembly, where there is no vectorized fast path, it was ~5% of
//! the analysis of a large block). This is the plain search: the same result for every input.

/// `needle in haystack` (Python), i.e. `haystack.contains(needle)`
#[inline]
pub(crate) fn has(haystack: &str, needle: &str) -> bool {
    let (h, n) = (haystack.as_bytes(), needle.as_bytes());
    let Some((&first, rest)) = n.split_first() else { return true };
    if h.len() < n.len() {
        return false;
    }
    let mut i = 0;
    let last = h.len() - n.len();
    while i <= last {
        if h[i] == first && h[i + 1..i + n.len()].iter().zip(rest).all(|(a, b)| a == b) {
            return true;
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::has;

    #[test]
    fn same_as_contains() {
        let words = ["", "M", "MM", "XMM0", "YMM15", "MOV", "CMOV", "CMOVNZ (R64, R64)", "MOVSX (R32, M8)", "IP", "RIP", "STACKPUSH",
            "AGEN", "I64", "ADD_LOCK", "aaa", "aab", "abab", "ba", "MMM", "M256", "VMOVDQU (YMM, M256)", "\u{e9}M", "M\u{e9}"];
        for h in words {
            for n in words {
                assert_eq!(has(h, n), h.contains(n), "{h:?} {n:?}");
            }
        }
    }
}
