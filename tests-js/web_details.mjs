// Tests of the details of a result on the page's side (web/js/details.js, icard.js, portset.js, slots.js; the accuracy
// numbers of archs.js): the notation of allowed ports, the throughput from the ports, the latencies shown, the card's
// model, the front-end badges, the port-set blame and the issue slots; on hand-written data, and (if the analyzer has been
// built) on the built-in examples on every CPU with "details": true.
// Usage: node tests-js/web_details.mjs
import fs from 'node:fs';
import { detailsFit, portString, portThroughput, latencyPairs, createDetails } from '../web/js/details.js';
import { layout, hazards, cardModel, frontTags, bottleneckShare } from '../web/js/icard.js';
import { portSetBlame, setName } from '../web/js/portset.js';
import { slotParts } from '../web/js/slots.js';
import { issueLog, issueAt, issueShare, issueText } from '../web/js/trace-issue.js';
import { loadTrace } from '../web/js/trace.js';
import { ACCURACY, accuracyNote } from '../web/js/archs.js';
import { WasmEngine, makeRequest } from '../web/js/engine.js';
import { EXAMPLES, CLASSIC_EXAMPLES } from '../web/js/examples.js';
import { SHA256_BLOCK_HEX } from '../web/js/showcase.js';
import * as pkg from '../packages/wuica/lib/details.js';

let failed = 0, count = 0;
function check(cond, what, detail = '') { count++; if (!cond) { failed++; console.log(`FAIL ${what}${detail ? ': ' + detail : ''}`); } }
const root = new URL('../', import.meta.url);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// --- hand-written ----------------------------------------------------------------------------------------------------
{
  const ALU = ['Port 0', 'Port 1', 'Port 5', 'Port 6'], LOAD = ['Port 2', 'Port 3'];
  check(portString([{ ports: ALU, uops: 1 }, { ports: LOAD, uops: 1 }]) === '1*p0156+1*p23', 'ports: uops.info notation');
  check(portString([{ ports: ['ALU0', 'ALU1'], uops: 2 }]) === '2*[ALU0 ALU1]' && portString([]) === '', 'ports: other names');
  check(portThroughput({ portData: [{ ports: ALU, uops: 1 }, { ports: LOAD, uops: 1 }] }) === 0.5, 'tp: a load on two ports');
  check(portThroughput({ portData: [{ ports: ['Port 0'], uops: 3 }, { ports: ['Port 0', 'Port 1'], uops: 1 }] }) === 3, 'tp: three uops on one port');
  check(portThroughput({ portData: [{ ports: ['Port 0'], uops: 1 }, { ports: ['Port 0', 'Port 1'], uops: 3 }] }) === 2, 'tp: a union of two sets');
  check(portThroughput({ portData: [{ ports: ['Port 0'], uops: 1 }], tpTable: 4 }) === 4 && portThroughput(null) === 0, 'tp: the table limit');
  const lat = latencyPairs({ latencies: [{ from: 'RAX', to: 'RAX', cycles: 1 }, { from: 'RAX', to: 'flags (C)', cycles: 1 }, { from: 'RAX', to: 'RAX', cycles: 1 }] });
  check(lat.length === 1 && lat[0].to === 'RAX', 'latencies: flags left out next to a register output, pairs once', JSON.stringify(lat));
  check(latencyPairs({ latencies: [{ from: 'RAX', to: 'flags (SPAZO)', cycles: 1 }] }).length === 1, 'latencies: a compare keeps its flags');
  check(detailsFit({ tp: 1, rows: [{}, {}] }, { tp: 1, details: { rows: [null, null] } }) && !detailsFit({ tp: 1, rows: [{}] }, { tp: 2, details: { rows: [null] } })
    && !detailsFit({ tp: 1, rows: [{}] }, { tp: 1 }), 'details fit the response');

  const COLS = ['MITE', 'MS', 'DSB', 'LSD', 'Issued', 'Exec.', 'Port 0'];
  const r = {
    tp: 1, mode: 'loop', columns: COLS,
    rows: [
      { kind: 'instr', label: 'a', opcode: '00'.repeat(14), notes: '', values: [0, 0, 1, 0, 1, 1, 1] },
      { kind: 'regMerge', label: '<Register Merge Uop>', notes: '', values: [0, 0, 0, 0, 1, 1, 1] },
      { kind: 'instr', label: 'b', opcode: '00'.repeat(6), notes: '', values: [0, 4, 0, 0, 4, 4, 1] },
      { kind: 'instr', label: 'c', opcode: '7500', notes: 'M', values: [0, 0, 0, 0, 0, 0, 0] },
    ],
  };
  const lay = layout(r, 52);
  check(lay.get(0).offset === 52 && lay.get(2).offset === 66 && lay.get(3).offset === 72 && !lay.has(1), 'layout: offsets of the instruction rows');
  const hz = hazards(r, 52);
  check(hz.length === 2 && hz[0].row === 0 && hz[0].hz === '64' && hz[1].row === 2 && hz[1].hz === 'µ', 'badges: a line split, a microcoded instruction', JSON.stringify(hz));
  check(hazards(r, 0).map((x) => x.hz).join() === 'µ', 'badges: no split at offset 0');
  check(hazards({ ...r, mode: 'unroll' }, 52).map((x) => x.hz).join() === 'µ', 'badges: no line split for an unrolled block (its copies sit elsewhere)');
  check(hazards(r, 52, { rows: [null, null, { lcp: true }, null] }).map((x) => x.hz).join() === '64,µ L', 'badges: LCP once the details are there');
  check(cardModel(r, 1, null) === null && cardModel(r, 9, null) === null, 'card: none for the extra uops');
  const basic = cardModel(r, 0, null, 52);
  check(basic.length === 14 && basic.crosses.join() === '16,32,64' && !basic.details && basic.issued === 1, 'card: without details, from the response', JSON.stringify(basic));
  const det = { offset: 52, length: 14, crosses: [16, 64], portData: [{ ports: ['Port 0'], uops: 1 }], latencies: [], uops: 1, retireSlots: 1, uopsMITE: 1, uopsMS: 0, lcp: true, microcoded: false, complexDecoder: true, macroFusedWithNext: false, macroFusedWithPrev: false, uopList: [{ load: true }] };
  const full = cardModel(r, 0, det, 52);
  check(full.details && full.ports === '1*p0' && full.tp === 1 && full.lcp && full.loads === 1 && full.tpBound === 1 && full.tpBy === 'ports', 'card: with details');
  // div: the card's tp is the divider's cycles (the loop's Divider limit), not its ports' (2.00 for div ecx on ZEN3)
  const dv = cardModel(r, 0, { ...det, portData: [{ ports: ['Port 0'], uops: 2 }], divCycles: 6 }, 52);
  check(dv.tp === 2 && dv.div === 6 && dv.tpBound === 6 && dv.tpBy === 'divider', 'card: a div, tp from the divider', JSON.stringify([dv.tp, dv.div, dv.tpBound]));
  const tags = frontTags(full).map((t) => t.text);
  check(tags.join(' ') === '14 B @52 ✂16 ✂64 LCP complex', 'card: front-end tags', tags.join(' '));
  check(cardModel(r, 3, null).fused && frontTags(cardModel(r, 3, null)).some((t) => t.text === '←fused'), 'card: macro-fused');

  const ps = { ports: ['Port 0', 'Port 1', 'Port 5', 'Port 6'], uops: 5, tp: 1.25, rows: [4, 0, 1, 0] };
  const b = portSetBlame(r, ps);
  check(b && b.total === 5 && b.max === 4 && b.set.name === 'p0156' && b.ports.join() === 'p0,p1,p5,p6' && b.unit === 'uops', 'port set: blame', JSON.stringify(b));
  check(portSetBlame(r, { ...ps, rows: [1] }) === null && portSetBlame(r, null) === null && portSetBlame(r, { ...ps, rows: [0, 0, 0, 0] }) === null, 'port set: wrong or empty');
  check(setName(['ALU0', 'ALU1']) === 'ALU0 ALU1', 'port set: other names');
  // the divider: the share of the Div column, named as the loop's bottleneck
  const rdiv = { tp: 6, mode: 'loop', bottlenecks: ['Divider'], limits: [{ name: 'Ports', tp: 2 }], columns: ['Div', 'Port 0'], rows: [{ kind: 'instr', label: 'div ecx', opcode: 'f7f1', values: [6, 2] }, { kind: 'instr', label: 'jnz 0x0', opcode: '75fc', values: [0, 1] }] };
  const sd = bottleneckShare(rdiv, 0, null);
  check(sd?.resource === 'Divider' && sd.share === 1 && sd.unit === 'cycles', 'card: share of the Divider bottleneck', JSON.stringify(sd));
  // the card's share of the bottleneck: Ports by the port set when the details have it, else the busiest ports
  const rp = { ...r, tp: 2, bottlenecks: ['Ports'], limits: [{ name: 'Ports', tp: 2 }] };
  const s0 = bottleneckShare(rp, 0, null), s1 = bottleneckShare(rp, 0, { ports: ps });
  check(s0?.resource === 'Ports' && near(s0.share, 1 / 3) && near(s1.share, 0.8) && bottleneckShare(rp, 3, { ports: ps }).share === 0, 'card: share of the bottleneck', JSON.stringify([s0, s1]));

  const sp = slotParts({ width: 4, cycles: 10, iterations: 10, slots: { issued: 2, frontEnd: 1, rob: 0.5, rs: 0, other: 0.5 } });
  check(sp.map((p) => p.key).join() === 'issued,frontEnd,rob,rs,other' && near(sp[0].share, 0.5) && near(sp[2].share, 0.125), 'slots: shares');
  check(slotParts({ width: 4, slots: { issued: 0, frontEnd: 0, rob: 0, rs: 0, other: 0 } }) === null && slotParts(null) === null, 'slots: none');

  // the trace's issue strip
  const log = issueLog({ issue: { width: 4, first: 10, issued: [4, 2, 0], cause: '.FR', slots: {} } });
  check(log && issueAt(log, 9) === null && issueAt(log, 11).cause === 'F' && issueAt(log, 13) === null, 'issue strip: cycles of the window');
  check(near(issueShare(log, 0, 100), 0.5) && near(issueShare(log, 11, 11), 0.5) && issueShare(log, 20, 30) === null, 'issue strip: share of the slots');
  check(issueText(log, 10) === 'issued 4/4' && /^issued 0\/4 · reorder buffer full$/.test(issueText(log, 12)) && issueText(log, 50) === null, 'issue strip: text', issueText(log, 12));
  check(issueLog({ issue: { width: 4, first: 0, issued: [1], cause: '' } }) === null && issueLog(null) === null, 'issue strip: unusable logs');

  // the fetcher: one analysis per view, null without the details, a cancelled call tried again
  let calls = 0, mode = 'ok';
  const fake = {
    async analyze(req) {
      calls++;
      if (mode === 'cancel') { const e = new Error('cancelled'); e.name = 'CancelledError'; throw e; }
      return { tp: 1, details: mode === 'ok' && req.details ? { rows: [null, null, null, null] } : undefined };
    },
  };
  const d = createDetails({ engine: () => fake });
  const v = { response: r, request: { hex: '00', arch: 'SKL' } };
  const [x, y] = await Promise.all([d.get(v), d.get(v)]);
  check(x && x === y && calls === 1 && d.peek(v) === x, 'fetcher: one analysis for a view');
  mode = 'cancel';
  const v2 = { response: r, request: { hex: '00', arch: 'SKL' } };
  check(await d.get(v2) === null && d.peek(v2) === undefined, 'fetcher: a cancelled call is not remembered');
  mode = 'none';
  check(await d.get(v2) === null && d.peek(v2) === null && calls === 3, 'fetcher: no details (an old module)');
  const v3 = { response: { ...r, mock: { arch: 'SKL' } }, request: {} };
  check(await d.get(v3) === null && calls === 3, 'fetcher: mock responses are not analyzed');
}

// --- the accuracy numbers: the "after" rows of docs/ACCURACY.md ---------------------------------------------------------
{
  const doc = fs.readFileSync(new URL('docs/ACCURACY.md', root), 'utf8');
  const after = new Map(); // "ZEN3" -> [random, real]
  let set = null;
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 8) continue;
    if (/random/.test(cells[1])) set = 'random'; else if (/real/.test(cells[1])) set = 'real';
    const m = /^uiCA (\S+), after$/.exec(cells[3]);
    if (m && set) { const e = after.get(m[1]) ?? {}; e[set] ??= parseFloat(cells[5]); after.set(m[1], e); } // the first: the current round
  }
  for (const [k, a] of Object.entries(ACCURACY)) {
    check(after.get(k)?.random === a.random && after.get(k)?.real === a.real, `accuracy ${k} as in docs/ACCURACY.md`, JSON.stringify([a, after.get(k)]));
  }
  check(after.size === Object.keys(ACCURACY).length, 'accuracy: every model of the document', [...after.keys()].join());
  check(accuracyNote('ZEN3') === `within 10%: ${Math.round(ACCURACY.ZEN3.random)}% random · ${Math.round(ACCURACY.ZEN3.real)}% real code` && accuracyNote('SKL') === '', 'accuracy note');
}

// --- the examples on every CPU, with the details of the analyzer -----------------------------------------------------------
const wasm = new URL('target/wasm32-unknown-unknown/release/wuica_wasm.wasm', root);
if (!fs.existsSync(wasm) || !fs.existsSync(new URL('data/uarch.json', root))) {
  console.log('(analyzer or data/ missing: only the hand-written cases)');
} else {
  const e = await WasmEngine.create(fs.readFileSync(wasm));
  const uarchBytes = fs.readFileSync(new URL('data/uarch.json', root));
  await e.loadUarch(uarchBytes);
  const uarch = JSON.parse(uarchBytes);
  const archs = Object.keys(uarch.configs).filter((k) => !k.includes('_'));
  for (const t of new Set(archs.map((a) => uarch.configs[a].name))) await e.loadArch(t, fs.readFileSync(new URL(`data/arch/${t}.json`, root)));
  let cases = 0;
  const blocks = [...EXAMPLES, ...CLASSIC_EXAMPLES].map((x) => ({ id: x.id, hex: x.hex }));
  for (const b of blocks) {
    for (const arch of archs) {
      for (const align of [0, 61]) {
        const request = makeRequest(b.hex, arch, { alignmentOffset: align });
        const r = await e.analyze(request);
        if (r.error) continue;
        const res = await e.analyze({ ...request, details: true });
        const what = `${b.id} ${arch} @${align}`;
        cases++;
        check(detailsFit(r, res), `${what}: details fit`);
        const { details: d, ...rest } = res;
        check(JSON.stringify(rest) === JSON.stringify(r), `${what}: the response is the same with details`);
        const lay = layout(r, align);
        r.rows.forEach((x, row) => {
          const det = d.rows[row];
          if (x.kind !== 'instr') { check(det === null, `${what}: no details for row ${row}`); return; }
          check(det && det.offset === lay.get(row).offset && det.length === lay.get(row).length, `${what}: row ${row} where the page puts it`, JSON.stringify([det?.offset, lay.get(row)]));
          const m = cardModel(r, row, det, align);
          check(m.crosses.join() === cardModel(r, row, null, align).crosses.join(), `${what}: row ${row} crossings agree`);
          // the microcode badge: the MS column has uops only for instructions with uops from the MS
          const ms = r.rows[row].values[r.columns.indexOf('MS')] || 0;
          if (ms > 0) check(det.uopsMS > 0, `${what}: row ${row} µ badge only for microcoded instructions`);
          if (x.notes !== 'X') check(det.portData.length === 0 || portString(det.portData).length > 0, `${what}: row ${row} ports`);
          // the MCP summary (packages/wuica/lib/details.js) says what the card says
          check(pkg.portString(det.portData) === portString(det.portData) && JSON.stringify(pkg.latencyPairs(det)) === JSON.stringify(latencyPairs(det)), `${what}: row ${row}: the package's ports and latencies are the page's`);
        });
        if (d.ports) {
          const pb = portSetBlame(r, d.ports);
          const limit = r.limits.find((l) => l.name === 'Ports')?.tp;
          check(pb && near(pb.total, d.ports.uops, 1e-6) && Math.abs(d.ports.tp - limit) <= 0.005 + 1e-9, `${what}: the port set gives the Ports limit`, JSON.stringify([d.ports, limit]));
        }
        if (d.issue) check(slotParts(d.issue) !== null, `${what}: issue slots`);
        const di = pkg.detailInsights(res);
        if (d.ports) check(di.portSet.ports.join() === d.ports.ports.join() && di.portSet.instructions.every((x) => d.ports.rows[x.index] > 0), `${what}: the package's port set`);
      }
    }
  }
  check(cases > 150, 'examples analyzed', String(cases));
  // the trace gets the issue log of the same simulation
  {
    const request = makeRequest(EXAMPLES[0].hex, 'SKL');
    const base = await e.analyze(request);
    const { model } = await loadTrace({ response: base, request }, { analyze: (q) => e.analyze(q) });
    const d = (await e.analyze({ ...request, details: true })).details;
    check(model.issue && model.issue.first === d.issue.first && model.issue.cause === d.issue.cause && model.issue.first < model.nCycles, 'trace: the issue log of its simulation', JSON.stringify(model.issue?.first));
    // the issued uops per cycle are the trace's own (addedToRB, fused uops)
    let ok = model.issue.issued.slice(0, 50).some((n) => n > 0);
    for (let k = 0; k < model.issue.issued.length && k < 50; k++) {
      const c = model.issue.first + k;
      const n = new Set(model.uops.filter((u) => u.issued === c && u.fUopID !== undefined).map((u) => `${u.rnd}/${u.instrID}/${u.lamUopID}/${u.fUopID}`)).size;
      if (n !== model.issue.issued[k]) { ok = false; break; }
    }
    check(ok, 'trace: the issue log counts the fused uops the trace issues');
  }
  // the showcase: details for every row
  const sha = String(Array.isArray(SHA256_BLOCK_HEX) ? SHA256_BLOCK_HEX.join('') : SHA256_BLOCK_HEX).replace(/[^0-9a-f]/gi, '');
  const r = await e.analyze({ ...makeRequest(sha, 'SKL'), details: true });
  check(!r.error && r.details.rows.filter(Boolean).length === r.rows.filter((x) => x.kind === 'instr').length && r.details.issue, 'showcase: details', r.error);
}

console.log(`${count} details checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
