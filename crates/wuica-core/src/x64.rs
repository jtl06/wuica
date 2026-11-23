//! Register helpers (uiCA's `x64_lib.py`) and `memWidth` (from `instructions.py`). These are literal ports: the tests on substrings
//! of register names are those of the Python code, including their quirks.

/// The general-purpose registers (`GPRegs`).
pub const GP_REGS: &[&str] = &[
    "AH", "AL", "AX", "BH", "BL", "BP", "BPL", "BX", "CH", "CL", "CX", "DH", "DI", "DIL", "DL", "DX", "EAX", "EBP", "EBX", "ECX", "EDI",
    "EDX", "ESI", "ESP", "R10", "R10B", "R10D", "R10W", "R11", "R11B", "R11D", "R11W", "R12", "R12B", "R12D", "R12W", "R13", "R13B",
    "R13D", "R13W", "R14", "R14B", "R14D", "R14W", "R15", "R15B", "R15D", "R15W", "R8", "R8B", "R8D", "R8W", "R9", "R9B", "R9D", "R9W",
    "RAX", "RBP", "RBX", "RCX", "RDI", "RDX", "RSI", "RSP", "SI", "SIL", "SP", "SPL",
];

/// `High8Regs`
pub const HIGH8_REGS: &[&str] = &["AH", "BH", "CH", "DH"];

/// `reg in GPRegs`
pub fn is_gp_reg(reg: &str) -> bool {
    GP_REGS.binary_search(&reg).is_ok()
}

/// `reg in High8Regs`
pub fn is_high8_reg(reg: &str) -> bool {
    HIGH8_REGS.contains(&reg)
}

/// `regTo64`: the 64-bit register that contains a general-purpose register. `None` where the Python function returns `None`
/// (it is only called for general-purpose registers).
pub fn reg_to_64(reg: &str) -> Option<&'static str> {
    let has = |s: &str| reg.contains(s);
    if has("AX") || has("AH") || has("AL") {
        Some("RAX")
    } else if has("BX") || has("BH") || has("BL") {
        Some("RBX")
    } else if has("CX") || has("CH") || has("CL") {
        Some("RCX")
    } else if has("DX") || has("DH") || has("DL") {
        Some("RDX")
    } else if has("SP") {
        Some("RSP")
    } else if has("BP") {
        Some("RBP")
    } else if has("SI") {
        Some("RSI")
    } else if has("DI") {
        Some("RDI")
    } else if has("8") {
        Some("R8")
    } else if has("9") {
        Some("R9")
    } else if has("10") {
        Some("R10")
    } else if has("11") {
        Some("R11")
    } else if has("12") {
        Some("R12")
    } else if has("13") {
        Some("R13")
    } else if has("14") {
        Some("R14")
    } else if has("15") {
        Some("R15")
    } else {
        None
    }
}

/// `getCanonicalReg`: for a general-purpose register the 64-bit register that contains it, for a (X|Y|Z)MM register the XMM
/// register, and the register itself otherwise.
pub fn canonical_reg(reg: &str) -> String {
    if is_gp_reg(reg) {
        reg_to_64(reg).expect("general-purpose register").to_string()
    } else if reg.contains("MM") {
        // re.sub('^[YZ]', 'X', reg)
        match reg.as_bytes().first() {
            Some(b'Y') | Some(b'Z') => format!("X{}", &reg[1..]),
            _ => reg.to_string(),
        }
    } else {
        reg.to_string()
    }
}

/// `getRegSize`: the size of a register in bits; -1 for other registers. `reg` must not be empty.
pub fn reg_size(reg: &str) -> i64 {
    let last = *reg.as_bytes().last().expect("register name");
    let first = reg.as_bytes()[0];
    if last == b'L' || last == b'H' || last == b'B' {
        8
    } else if last == b'W' || ["AX", "BX", "CX", "DX", "SP", "BP", "SI", "DI"].contains(&reg) {
        16
    } else if first == b'E' || last == b'D' {
        32
    } else if is_gp_reg(reg) {
        64
    } else if reg.starts_with("MM") {
        64
    } else if reg.starts_with("XMM") {
        128
    } else if reg.starts_with("YMM") {
        256
    } else if reg.starts_with("ZMM") {
        512
    } else {
        -1
    }
}

/// `memWidth`: the width in bits of the memory operand of an instruction, from its uops.info string (e.g. "MOVZX (R32, M8)");
/// `None` if it has none. Python: 64 for strings that start with PUSH or POP, otherwise the first match of `\bM(\d+)\b`.
pub fn mem_width(instr_str: &str) -> Option<i64> {
    if instr_str.starts_with("PUSH") || instr_str.starts_with("POP") {
        return Some(64);
    }
    let b = instr_str.as_bytes();
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'M' && (i == 0 || !is_word(b[i - 1])) {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && (j == b.len() || !is_word(b[j])) {
                return instr_str[i + 1..j].parse().ok();
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gp_regs_are_sorted() {
        assert!(GP_REGS.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn registers() {
        assert_eq!(canonical_reg("EAX"), "RAX");
        assert_eq!(canonical_reg("R10B"), "R10");
        assert_eq!(canonical_reg("SIL"), "RSI");
        assert_eq!(canonical_reg("YMM12"), "XMM12");
        assert_eq!(canonical_reg("ZMM3"), "XMM3");
        assert_eq!(canonical_reg("MM1"), "MM1");
        assert_eq!(canonical_reg("K1"), "K1");
        assert_eq!(reg_size("AL"), 8);
        assert_eq!(reg_size("AH"), 8);
        assert_eq!(reg_size("R9B"), 8);
        assert_eq!(reg_size("SI"), 16);
        assert_eq!(reg_size("BP"), 16);
        assert_eq!(reg_size("R11W"), 16);
        assert_eq!(reg_size("EDI"), 32);
        assert_eq!(reg_size("R8D"), 32);
        assert_eq!(reg_size("RSP"), 64);
        assert_eq!(reg_size("R15"), 64);
        assert_eq!(reg_size("MM0"), 64);
        assert_eq!(reg_size("XMM0"), 128);
        assert_eq!(reg_size("YMM0"), 256);
        assert_eq!(reg_size("ZMM0"), 512);
        assert_eq!(reg_size("K1"), -1);
    }

    #[test]
    fn mem_widths() {
        assert_eq!(mem_width("MOVZX (R32, M8)"), Some(8));
        assert_eq!(mem_width("ADD (M64, R64)"), Some(64));
        assert_eq!(mem_width("PUSH (R64)"), Some(64));
        assert_eq!(mem_width("POP (M16)"), Some(64));
        assert_eq!(mem_width("ADD (R64, R64)"), None);
        assert_eq!(mem_width("VMOVDQU (YMM, M256)"), Some(256));
        assert_eq!(mem_width("VPADDD (XMM, XMM, XMM)"), None);
        assert_eq!(mem_width("PREFETCHW (M512)"), Some(512));
    }
}
