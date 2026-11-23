// Known blind spots of the model, found in a response's instructions (no analysis): what uiCA does not simulate and
// that the block is likely to meet. Shown as one small line under the throughput (render.js) and as insights.caveats in
// the API (the npm package has a copy: packages/wuica/lib/web). No DOM.
//   rmw-index  a read-modify-write to an indexed address (inc dword ptr [rsp+rdx*4]), or a load and a store to the same
//              indexed address: whether an iteration's load waits for an earlier store (store forwarding) depends on the
//              data (a histogram of repeated bytes); uiCA assumes it does not.
//   exit       a loop with an exit before its branch (a search): the exit's mispredict, once per call, is not modelled;
//              with short trip counts it can cost more than the loop.
//   split      loads at an offset that is not a multiple of their width (ymmword ptr [rdi+rax*4+0x4]): with a base
//              aligned to the width, some of them cross a 64-byte line (split loads cost extra; not modelled).

const SIZE = { byte: 1, word: 2, dword: 4, qword: 8, xmmword: 16, ymmword: 32, zmmword: 64, tbyte: 10 };
const RMW = /^(?:lock )?(?:add|adc|sub|sbb|and|or|xor|inc|dec|neg|not|shl|shr|sar|sal|rol|ror|rcl|rcr|xadd|btc|btr|bts)$/;
// instructions whose memory destination is only written (a store, not a read)
const STORE_ONLY = /^(?:v?mov\w*|movnt\w*|stos\w*|set\w+|v?pextr\w+|v?extract\w*|vextract\w+|v?pmovm\w*|vp?scatter\w+|vmaskmov\w*|vpmaskmov\w*|v?cvt\w*|push\w*|pop\w*|fstp?\w*|fistp?\w*)$/;
const COND_BRANCH = /^(?:j(?!mp)[a-z]+|loop\w*)$/;

// The memory operand of an instruction label (XED's Intel syntax): {first, size, base, index, disp, text} or null.
export function memOperand(label) {
  const t = String(label).trim().replace(/\s+/g, ' ');
  const sp = t.indexOf(' ');
  if (sp < 0) return null;
  const mnemonic = t.slice(0, sp).toLowerCase();
  const ops = t.slice(sp + 1);
  const m = /(?:(\w+) ptr )?\[([^\]]*)\]/.exec(ops);
  if (!m) return null;
  const inner = m[2].replace(/\s/g, '').toLowerCase();
  const parts = inner.split(/(?=[+-])/);
  let base = null, index = null, disp = 0;
  for (const p of parts) {
    const v = p.replace(/^\+/, '');
    if (/\*/.test(v)) index = v.split('*')[0];
    else if (/^-?(?:0x[0-9a-f]+|\d+)$/.test(v)) disp += Number(v.startsWith('-') ? -Number(v.slice(1)) : Number(v));
    else if (/^[a-z]\w*$/.test(v)) { if (base === null) base = v; else index = v; }
  }
  if (base === 'rip') return null;
  return { mnemonic, first: ops.indexOf('[') <= (ops.indexOf(',') < 0 ? ops.length : ops.indexOf(',')), size: SIZE[String(m[1] ?? '').toLowerCase()] ?? null, base, index, disp, text: m[0].replace(/^\w+ ptr /, '') };
}

// [{id, text, title, rows}] (rows: indices into response.rows), in the order rmw-index, exit, split; [] if none.
export function caveats(response) {
  const rows = Array.isArray(response?.rows) ? response.rows : [];
  const instrs = rows.map((x, row) => ({ x, row })).filter(({ x }) => x?.kind === 'instr');
  const out = [];
  // read-modify-write, or a load and a store, to the same indexed address
  const rmw = [];
  const loads = new Map(), stores = new Map();
  for (const { x, row } of instrs) {
    const m = memOperand(x.label);
    if (!m || !m.index) continue;
    if (m.first && RMW.test(m.mnemonic.replace(/^lock /, ''))) rmw.push(row);
    else if (m.first && STORE_ONLY.test(m.mnemonic)) (stores.get(m.text) ?? stores.set(m.text, []).get(m.text)).push(row);
    else if (!m.first) (loads.get(m.text) ?? loads.set(m.text, []).get(m.text)).push(row);
  }
  for (const [addr, st] of stores) if (loads.has(addr)) rmw.push(...loads.get(addr), ...st);
  if (rmw.length) {
    const r = [...new Set(rmw)].sort((a, b) => a - b);
    out.push({ id: 'rmw-index', text: 'store forwarding', rows: r,
      title: `a read-modify-write to an indexed address (${r.map((k) => rows[k].label).join('; ')}): when iterations hit the same address (repeated data), each waits for the previous store; not modelled` });
  }
  // an exit before the loop's branch
  if (response?.mode === 'loop' && instrs.length > 1) {
    const early = instrs.slice(0, -1).filter(({ x }) => COND_BRANCH.test(String(x.label).trim().split(' ')[0].toLowerCase()));
    if (early.length) {
      out.push({ id: 'exit', text: 'exit mispredict', rows: early.map(({ row }) => row),
        title: 'the loop has an exit before its branch: its mispredict when the loop ends (once per call) is not modelled; with short trip counts it can cost more than the loop' });
    }
  }
  // loads that may split a cache line
  const split = [];
  for (const { x, row } of instrs) {
    const m = memOperand(x.label);
    if (!m || !m.size || m.size < 2 || m.size > 64) continue;
    const isLoad = !m.first || !STORE_ONLY.test(m.mnemonic);
    if (isLoad && ((m.disp % m.size) + m.size) % m.size !== 0) split.push(row);
  }
  if (split.length) {
    out.push({ id: 'split', text: `split loads? (${split.length})`, rows: split,
      title: `${split.length} load${split.length === 1 ? '' : 's'} at an offset that is not a multiple of the width (${split.map((k) => rows[k].label).slice(0, 4).join('; ')}${split.length > 4 ? '; …' : ''}): some cross a 64-byte line, which costs extra; not modelled` });
  }
  return out;
}
