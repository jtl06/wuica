// gzip decompression in JavaScript, for browsers without DecompressionStream (Safari before 16.4: the page's tables are
// gzip files, loader.js gunzip). Loaded only there. A plain inflate (RFC 1951) after the gzip header (RFC 1952);
// the CRC is not checked (the table loader checks the table's own header and length).

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// A Huffman code from code lengths: {counts[len], symbols[] in canonical order}
function huffman(lengths) {
  const counts = new Uint16Array(16), offs = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  lengths.forEach((l, s) => { if (l) symbols[offs[l]++] = s; });
  return { counts, symbols };
}

export function inflateRaw(src, sizeHint = 0) {
  let pos = 0, bit = 0, bits = 0;
  let out = new Uint8Array(Math.max(1024, sizeHint)), n = 0;
  const need = (k) => { while (bits < k) { if (pos >= src.length) throw new Error('inflate: truncated'); bit |= src[pos++] << bits; bits += 8; } };
  const take = (k) => { need(k); const v = bit & ((1 << k) - 1); bit >>>= k; bits -= k; return v; };
  const put = (b) => { if (n === out.length) { const o = new Uint8Array(out.length * 2); o.set(out); out = o; } out[n++] = b; };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= take(1);
      const c = h.counts[len];
      if (code - first < c) return h.symbols[index + code - first];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  let fixedLit = null, fixedDist = null;
  for (let last = 0; !last;) {
    last = take(1);
    const type = take(2);
    if (type === 0) {
      bit = 0; bits = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      for (let i = 0; i < len; i++) put(src[pos++]);
      continue;
    }
    let lit, dist;
    if (type === 1) {
      if (!fixedLit) {
        const l = new Uint8Array(288);
        l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
        fixedLit = huffman(l); fixedDist = huffman(new Uint8Array(30).fill(5));
      }
      lit = fixedLit; dist = fixedDist;
    } else if (type === 2) {
      const hlit = take(5) + 257, hdist = take(5) + 1, hclen = take(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = take(3);
      const clh = huffman(cl);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const s = decode(clh);
        if (s < 16) lens[i++] = s;
        else if (s === 16) { const p = lens[i - 1]; for (let r = 3 + take(2); r > 0; r--) lens[i++] = p; }
        else if (s === 17) i += 3 + take(3);
        else i += 11 + take(7);
      }
      lit = huffman(lens.subarray(0, hlit)); dist = huffman(lens.subarray(hlit));
    } else throw new Error('inflate: bad block type');
    for (;;) {
      const s = decode(lit);
      if (s < 256) { put(s); continue; }
      if (s === 256) break;
      const len = LEN_BASE[s - 257] + take(LEN_EXTRA[s - 257]);
      const ds = decode(dist);
      const d = DIST_BASE[ds] + take(DIST_EXTRA[ds]);
      for (let i = 0; i < len; i++) put(out[n - d]);
    }
  }
  return out.subarray(0, n);
}

// A gzip file's content (one member).
export function gunzip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) throw new Error('not a gzip file');
  const flags = b[3];
  let p = 10;
  if (flags & 4) p += 2 + (b[p] | (b[p + 1] << 8));
  if (flags & 8) while (b[p++]);
  if (flags & 16) while (b[p++]);
  if (flags & 2) p += 2;
  const size = (b[b.length - 4] | (b[b.length - 3] << 8) | (b[b.length - 2] << 16) | (b[b.length - 1] << 24)) >>> 0;
  const out = inflateRaw(b.subarray(p, b.length - 8), size);
  if (out.length !== size) throw new Error('gzip: wrong length');
  return out;
}
