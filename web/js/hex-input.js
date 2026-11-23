// Parser for the "Machine code (hex)" input. Pure: no DOM, runs under Node (tests-js/web_hex_input.mjs).
//
// Accepted:
//   plain hex            4801d8 49ffcf / 48 01 d8 / 0x48, 0x01 / \x48\x01 / {0x48, 0x1} / 48h 01h
//                        with ; # // comments; digits may be split anywhere by white space
//   disassembly listings objdump -d, llvm-objdump -d, Compiler Explorer binary output, lldb/capstone style and xxd:
//                        only the byte column is used; addresses, mnemonics, labels and headers are ignored
//   llvm-mc              lines with "encoding: [0x48,0x01,0xd8]"
//
// parseHexInput(text) returns
//   { ok: true, bytes: Uint8Array, hex: "4801d8...", format: "plain" | "listing" }
//   { ok: false, code: "empty" | "no-bytes" | "odd" | "invalid", message: string, line?: number }

const HEX2 = /^[0-9a-f]{2}$/i;
const ADDR_LINE = /^\s*(?:0x)?[0-9a-f]+:(.*)$/i;
const ENCODING = /encoding:\s*\[([^\]]*)\]/i;
const PLAIN_ONLY = /^(?:0x|\\x|[0-9a-f\s,])*$/i;

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(2 * i, 2), 16);
  return out;
}

// The byte column of a listing line (what follows "addr:"), or of a line that starts with bytes.
// Bytes are two digits separated by single spaces; the column ends at a tab, at two or more spaces, or at the
// first thing that is not a byte ("add", "(bad)", ...). xxd groups ("4801 d848") are accepted when the column
// starts with such a group.
function byteColumn(rest) {
  const s = rest.replace(/^[ \t]+/, '');
  const out = [];
  let i = 0;
  const first = /^[0-9a-f]+/i.exec(s);
  const grouped = !!first && first[0].length > 2 && first[0].length % 2 === 0;
  for (;;) {
    const m = /^[0-9a-f]+/i.exec(s.slice(i));
    if (!m) break;
    const tok = m[0];
    if (grouped ? tok.length % 2 !== 0 : tok.length !== 2) break;
    const next = s[i + tok.length];
    if (next !== undefined && next !== ' ' && next !== '\t' && next !== '\r') break; // "add": "ad" is followed by "d"
    for (let k = 0; k < tok.length; k += 2) out.push(parseInt(tok.substr(k, 2), 16));
    i += tok.length;
    if (s[i] !== ' ' || s[i + 1] === ' ' || s[i + 1] === '\t' || s[i + 1] === undefined) break; // end of the column
    i += 1;
  }
  return { bytes: out, rest: s.slice(i) };
}

function listingLine(line) {
  const enc = ENCODING.exec(line);
  if (enc) {
    const out = [];
    for (const t of enc[1].split(',')) {
      const m = /^\s*0x([0-9a-f]{1,2})\s*$/i.exec(t);
      if (!m) return null; // fixup placeholders ("A") and the like: not machine code yet
      out.push(parseInt(m[1], 16));
    }
    return out.length ? out : null;
  }
  const a = ADDR_LINE.exec(line);
  if (a) {
    const { bytes } = byteColumn(a[1]);
    return bytes.length ? bytes : null;
  }
  // No address (Compiler Explorer): bytes, a gap, then text that is not hex itself.
  const { bytes, rest } = byteColumn(line);
  if (bytes.length && /^(\t|  )/.test(rest) && rest.trim() !== '' && !PLAIN_ONLY.test(rest)) return bytes;
  return null;
}

function stripComment(line) {
  const m = /;|#|\/\//.exec(line);
  return m ? line.slice(0, m.index) : line;
}

function quote(tok) {
  return JSON.stringify(tok.length > 24 ? tok.slice(0, 24) + '…' : tok);
}

function parsePlain(lines) {
  const out = [];
  let run = '';
  let runLine = 0;
  let err = null;
  const flush = () => {
    if (run.length % 2 !== 0) {
      err = {
        ok: false, code: 'odd', line: runLine,
        message: `Odd number of hex digits (${run.length}): every byte needs two digits`,
      };
      return false;
    }
    for (let k = 0; k < run.length; k += 2) out.push(parseInt(run.substr(k, 2), 16));
    run = '';
    return true;
  };
  for (let n = 0; n < lines.length; n++) {
    const line = stripComment(lines[n]).replace(/\bb(?=["'])/g, ' '); // Python b"..."
    for (const tok of line.split(/[\s,{}[\]()"']+/)) {
      if (tok === '') continue;
      let m;
      if (/^[0-9a-f]+$/i.test(tok)) {
        run += tok;
        runLine = n + 1;
      } else if ((m = /^0x([0-9a-f]+)$/i.exec(tok))) {
        if (!flush()) return err;
        let d = m[1];
        if (d.length === 1) d = '0' + d; // 0x5 is the byte 05
        if (d.length % 2 !== 0) {
          return { ok: false, code: 'odd', line: n + 1, message: `Odd number of hex digits in ${quote(tok)}` };
        }
        for (let k = 0; k < d.length; k += 2) out.push(parseInt(d.substr(k, 2), 16));
      } else if (/^(?:\\x[0-9a-f]{1,2})+$/i.test(tok)) {
        if (!flush()) return err;
        for (const p of tok.split(/\\x/i)) if (p !== '') out.push(parseInt(p, 16));
      } else if ((m = /^([0-9a-f]{1,2})h$/i.exec(tok))) {
        if (!flush()) return err;
        out.push(parseInt(m[1], 16));
      } else {
        return { ok: false, code: 'invalid', line: n + 1, message: `Not hex: ${quote(tok)}` };
      }
    }
  }
  if (!flush()) return err;
  return { ok: true, bytes: out };
}

export function parseHexInput(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.every((l) => l.trim() === '')) {
    return { ok: false, code: 'empty', message: 'No bytes: enter machine code as hex' };
  }
  let listing = null;
  let sawAddress = false;
  for (const line of lines) {
    if (ADDR_LINE.test(line)) sawAddress = true;
    const b = listingLine(line);
    if (b) (listing ??= []).push(...b);
  }
  if (listing) {
    const bytes = Uint8Array.from(listing);
    return { ok: true, bytes, hex: toHex(bytes), format: 'listing' };
  }
  const plain = parsePlain(lines);
  if (plain.ok) {
    if (plain.bytes.length === 0) return { ok: false, code: 'no-bytes', message: 'No bytes found in the input' };
    const bytes = Uint8Array.from(plain.bytes);
    return { ok: true, bytes, hex: toHex(bytes), format: 'plain' };
  }
  if (sawAddress && plain.code === 'invalid') {
    return {
      ok: false, code: 'no-bytes',
      message: 'No bytes found: this looks like a disassembly without the byte column (objdump --no-show-raw-insn?)',
    };
  }
  return plain;
}
