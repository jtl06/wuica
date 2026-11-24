// The public API as the README shows it, compiled against index.d.ts (tsc --noEmit, scripts/typecheck.mjs; never run: outside test/, so node --test does not pick it up):
// the declarations are what a TypeScript user of `wuica-cli` sees. The end of the file checks that the implementation
// (lib/index.js, typed by tsc from its JavaScript and JSDoc) has every declared export with a compatible type.
import { createWuica, markdown, whatIf, diffResult, WHAT_IF_VARIANTS, listLoops, examples, findExample, normalizeHex, detectSyntax, insights,
  OPTION_DEFAULTS, ARCH_FIELDS, DEFAULT_ARCH, ARCH_ORDER, ARCH_INFO, objectKind } from 'wuica-cli';
import type { AnalyzeResult, CompareResult, Failure, Wuica, WhatIfResult, LoopListing, Insights, CliAnalyzeJson } from 'wuica-cli';
import * as impl from '../lib/index.js';
import * as decl from 'wuica-cli';

async function readme(): Promise<void> {
  const w: Wuica = await createWuica();
  const r = await w.analyze('SKL', { source: 'loop:\n add rax, [rsi]\n add rsi, 8\n dec rcx\n jnz loop\n' });
  if (r.code === 0) {
    const ok: AnalyzeResult = r;
    const tp: number = ok.tp;
    const mode: 'loop' | 'unroll' = ok.mode;
    const bn: string[] = ok.bottlenecks;
    const text: string = ok.text;
    const hex: string | undefined = ok.hex;
    void [tp, mode, bn, text, hex];
    const md: string = markdown.report(ok, { insights: w.insights(ok), source: 'loop: ...' });
    const table: string = markdown.uopTable(ok);
    void [md, table];
  } else {
    const f: Failure = r;
    const e: string = f.error;
    void e;
  }
  await w.analyze('ZEN3', { hex: '4801d84801c349ffcf75f5', options: { noMacroFusion: true } });
  await w.analyze({ arch: 'ADL-P', source: 'addq %rbx, %rax', syntax: 'att' });
  const c = await w.compare({ source: 'imul rax, rbx' });
  if (c.code === 0) {
    const cc: CompareResult = c;
    const md: string = markdown.cpuTable(cc);
    for (const x of cc.results) if (x.code === 0) void x.tp;
    void md;
  }
  const archs = w.archs();
  void archs[0].id;
  const a = await w.assemble('vaddps zmm0, zmm1, zmm2');
  if (a.code === 0) void a.hex.length;
  if (r.code === 0) {
    const s = w.summarize(r);
    const ins: Insights | null = w.insights(r);
    void [s, ins];
  }
  const many = await w.analyzeMany('SKL', [{ hex: '4801d8' }, { source: 'add rax, rbx' }]);
  void many;
  const cm = await w.compareMany([{ hex: '4801d8' }], { archs: ['SKL', 'ZEN3'] });
  void cm;
  const df = await w.diff('SKL', { a: { source: 'add rax, 1' }, b: { hex: '4801d8' }, per: [1, 2] });
  if (df.code === 0) void [df.speedup, df.perElement?.b, df.ports[0]?.delta, df.instructions.changes[0]?.status];
  if (r.code === 0) {
    const dr = diffResult(r, r);
    // @ts-expect-error a failure (analyses of two modes) has no speedup: diffResult returns DiffResult | Failure
    void dr.speedup;
    if (dr.code === 0) void dr.speedup;
  }
  const wi = await w.whatIf('SKL', { source: 'add rax, 1', variants: ['acc4'], per: 8 });
  if (wi.code === 0) void wi.perElement;
  const x = await whatIf((arch, req) => w.analyze(arch, req), 'SKL', { source: 'add rax, 1' }, WHAT_IF_VARIANTS, { assemble: (t) => w.assemble(t) });
  if (x.code === 0) {
    const y: WhatIfResult = x;
    const md: string = markdown.whatIf(y);
    void md;
  }
  const loops = listLoops('f:\n.L1:\n dec rcx\n jnz .L1\n');
  if (Array.isArray(loops)) {
    const l: LoopListing[] = loops;
    void markdown.loops(l);
  }
  const e = findExample('saxpy');
  if (e) void e.hex;
  void [examples().length, normalizeHex('48 01 d8'), detectSyntax('add %rbx, %rax'), OPTION_DEFAULTS.minCycles, ARCH_FIELDS, DEFAULT_ARCH, ARCH_ORDER, ARCH_INFO, objectKind(new Uint8Array(4))];
  const j = {} as CliAnalyzeJson;
  void insights(j);
  await w.close();
}
void readme;

// Every declared export exists in the implementation, and every declared function (and Wuica method) accepts the
// declared arguments there: a missing export or method, or one that needs more arguments than the declaration passes,
// fails here. (The return types of the JavaScript are inferred loosely; the README's uses above check those through
// index.d.ts.)
type Declared = typeof decl;
type Accepts<T> = { [K in keyof T]: T[K] extends (...args: infer P) => unknown ? (...args: P) => unknown : unknown };
const implemented: Accepts<Declared> = impl;
type ImplWuica = Awaited<ReturnType<typeof impl.createWuica>>;
const methods: Accepts<Wuica> = {} as ImplWuica;
void [implemented, methods];
