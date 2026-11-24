// The bugs of the GUI dogfood of 0.1.10, in the built site with the real analyzer (headless Chrome, started with
// --headless and --remote-debugging-port through tests-js/cdp.mjs). Inputs: tests-js/fixtures/dogfood/ (clang -O2
// output of the report's kernels, and its test files). Each part is one bug of the report:
// - B3: no "[object HTMLSpanElement]" in A–B's headline (a list in a list of the caveat line), nor anywhere on the page
// No network: requests to godbolt.org are answered here. Skipped (exit 0) without Chrome.
//
//   node tests-js/web_dogfood_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT } from './cdp.mjs';

const chrome = findChrome();
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(0); }
const check = checker('dogfood browser');
const fx = (name) => fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/dogfood', name), 'utf8');
const js = JSON.stringify;

// in the page: a paste into a box (the input event of a paste), a select's value, waiting for the result
const W = `${HELPERS}
  const pasteInto = (el, text) => { el.focus(); el.value = text; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })); };
  const pick = (id, v) => { const s = $(id); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); };
  const optionOf = (id, re) => [...$(id).options].find((o) => re.test(o.textContent))?.value;
  const settle = async () => { await wait(300); await until(() => !$('results').hasAttribute('aria-busy') && !$('result-body').classList.contains('stale')); await wait(300); };
  const headline = () => document.querySelector('#result-body > .row.lead')?.innerText ?? '';
  const tabs = () => [...document.querySelectorAll('#result-body > .view-tabs > .view-tab')];
`;

// requests to godbolt.org: a short link that does not exist (404)
const intercept = (params, p) => {
  const status = params.request.method === 'OPTIONS' ? 204 : 404;
  p.cmd('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: status,
    responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }, { name: 'access-control-allow-origin', value: '*' },
      { name: 'access-control-allow-methods', value: 'POST, GET, OPTIONS' }, { name: 'access-control-allow-headers', value: 'Content-Type, Accept' }],
    body: Buffer.from(status === 404 ? '{}' : '').toString('base64') }).catch(() => {});
};

const srv = await serve(copyDist());
const { browser, close } = await launch(chrome);
const fresh = async (opts = {}) => {
  const page = await Page.open(browser, { width: 1440, height: 900, intercept, ...opts });
  page.ignore.push(/godbolt\.org/);
  await page.goto(`${srv.origin}/?nosw=1`);
  await page.ready();
  await page.waitFor(`document.getElementById('results').dataset.run`, 'the first result', 60000);
  return page;
};
try {
  // ---- B3: A–B's caveat line with a caveat of one side only -------------------------------------------------------------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      pasteInto($('code'), ${js(fx('scan_v2.s'))}); await settle();
      $('cmp-ab').click(); await settle();
      pasteInto($('code-b'), ${js(fx('saxpy.s'))}); await settle();
      pick('loop-chip-b', optionOf('loop-chip-b', /\\.LBB0_8\\b/)); await settle();
      set($('a-work'), '8'); set($('b-work'), '32'); pick('b-arch', 'ICL'); await settle();
      const head = headline();
      // every tab of the result, A's and B's views
      const seen = [document.body.innerText];
      for (const side of ['a', 'b']) {
        for (const t of tabs()) { t.click(); await wait(400); seen.push(document.body.innerText); }
        document.dispatchEvent(new CustomEvent('wuica:ab-side', { detail: 'b' })); await wait(300);
      }
      $('cmp-single').click(); await settle();
      for (const t of tabs()) { t.click(); await wait(400); seen.push(document.body.innerText); }
      return { head, single: !document.body.classList.contains('ab-on'), object: seen.filter((t) => /\\[object /.test(t)).map((t) => /.{0,80}\\[object .{0,40}/.exec(t)?.[0]) };`);
    check(/not modelled exit mispredict/.test(r.head), 'B3: the A–B headline has its caveat line', r.head);
    check(!/\[object /.test(r.head) && /exit mispredict\s*A\b/.test(r.head), 'B3: the caveat of one side is tagged with the side, no "[object …]"', r.head);
    check(r.single, 'B3: back in single mode', '');
    check(r.object.length === 0, 'B3: no "[object …]" anywhere on the page, in every tab of A–B and single mode', js(r.object));
    check(page.take().length === 0, 'B3: no errors', '');
    await page.close();
  }

  // ---- B1: code a CPU cannot run is not shown as a result (the headline, the table of CPUs, A–B) ----------------------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      const row = (k) => document.querySelector('table.cmp-cpus tr[data-arch="' + k + '"]');
      const cell = (k, c) => row(k)?.querySelector(c)?.textContent ?? '';
      const lead = () => document.querySelector('#result-body > .row.lead');
      const out = {};
      pasteInto($('code'), ${js(fx('avx512.s'))}); await settle();
      out.skl = { head: headline(), struck: lead().querySelector('.tp .value').classList.contains('invalid'), title: lead().querySelector('.tp .value').title };
      $('cpu-all').click(); await until(() => $('cmp-cpus').dataset.state === 'done', 90000); await wait(300);
      out.table = Object.fromEntries(['SKL', 'ZEN3', 'ICL', 'ADL-P'].map((k) => [k, { tp: cell(k, '.cmp-tp'), bn: cell(k, '.cmp-bn'), invalid: row(k).classList.contains('invalid'),
        fastest: row(k).classList.contains('fastest'), bar: row(k).querySelector('.gauge > span').style.width }]));
      out.fastest = [...document.querySelectorAll('table.cmp-cpus tr.fastest')].map((t) => t.dataset.arch).join();
      row('ZEN3').click(); await settle();
      out.zen3 = { head: headline(), struck: lead().querySelector('.tp .value').classList.contains('invalid'), status: $('status').textContent };
      // A–B: A on ZEN3, B the same code on ICL
      $('cpu-clear').click(); await wait(200);
      $('cmp-ab').click(); await settle(); $('ab-copy').click(); await settle(); pick('b-arch', 'ICL'); await settle();
      out.ab = { head: headline(), struckA: !!lead().querySelector('.ab-tp .value.invalid'), verdict: lead().querySelector('.ab-delta')?.dataset.verdict };
      return out;`, { timeout: 200000 });
    check(r.skl.struck && /not a result for SKL: needs AVX-512 · 12 undecodable positions skipped/.test(r.skl.head) && /38\.00 cycles\/iteration as computed/.test(r.skl.title),
      'B1: SKL headline: the number struck (in the tooltip), "needs AVX-512"', js(r.skl));
    check(/3\.00 cycles\/iteration · ZEN3 \(not a result: needs AVX-512\)/.test(r.zen3.status), 'B1: the status line says so too', r.zen3.status);
    const t = r.table;
    check(t.SKL.tp === '38.00' && t.SKL.invalid && /needs AVX-512 · 12 undecodable skipped/.test(t.SKL.bn), 'B1: table: SKL marked, its number kept', js(t.SKL));
    check(t.ZEN3.tp === '3.00' && t.ZEN3.invalid && !t.ZEN3.fastest && /needs AVX-512 · 12 not supported/.test(t.ZEN3.bn), 'B1: table: ZEN3 marked as the Intel rows, not the fastest', js(t.ZEN3));
    check(t['ADL-P'].invalid && t['ADL-P'].bar === '0%' && t.ICL.bar === '66.7%' && !t.ICL.invalid, 'B1: table: no bar for ADL-P\'s 11725, which does not set the scale', js([t['ADL-P'], t.ICL]));
    check(r.fastest === 'ICL,TGL,RKL,ICX', 'B1: table: the fastest are CPUs that run the code', r.fastest);
    check(r.zen3.struck && /not a result for ZEN3: needs AVX-512 · 12 instructions not supported/.test(r.zen3.head), 'B1: ZEN3 headline: struck, why', js(r.zen3));
    check(r.ab.struckA && r.ab.verdict === 'invalid' && /not comparable: A needs AVX-512 on ZEN3/.test(r.ab.head) && !/faster|better/.test(r.ab.head), 'B1: A–B: no verdict, "not comparable"', js(r.ab));
    check(page.take().length === 0, 'B1: no errors', '');
    await page.close();
  }

  // ---- a gap in the tables (the note X on an instruction the CPU's decoder accepts) is a result with a note -------------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      const row = (k) => document.querySelector('table.cmp-cpus tr[data-arch="' + k + '"]');
      pasteInto($('code'), ${js(fx('ldouble.s'))}); await settle();
      const lead = document.querySelector('#result-body > .row.lead');
      const single = { struck: !!lead.querySelector('.value.invalid'), alert: !!lead.querySelector('.cannot-run'), note: lead.querySelector('.no-data')?.textContent ?? '', title: lead.querySelector('.no-data')?.title ?? '' };
      $('cpu-all').click(); await until(() => $('cmp-cpus').dataset.state === 'done', 90000); await wait(300);
      const rows = [...document.querySelectorAll('table.cmp-cpus tbody tr')].map((t) => ({ k: t.dataset.arch, invalid: t.classList.contains('invalid'), fastest: t.classList.contains('fastest'), bar: t.querySelector('.gauge > span').style.width, bn: t.querySelector('.cmp-bn').textContent }));
      return { single, rows };`, { timeout: 200000 });
    check(!r.single.struck && !r.single.alert && r.single.note === '2 instructions without data' && /cost out/.test(r.single.title), 'gap: the headline stands, with "2 instructions without data"', js(r.single));
    check(r.rows.length === 15 && r.rows.every((x) => !x.invalid && x.bar !== '0%' && /without data/.test(x.bn)) && r.rows.some((x) => x.fastest), 'gap: all 15 CPUs keep their numbers, bars and a fastest, with the note', js(r.rows));
    check(page.take().length === 0, 'gap: no errors', '');
    await page.close();
  }

  // ---- B2: the status line (aria-live) never keeps the result of code that is no longer there ---------------------------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      const status = () => ($('status-wrap').classList.contains('idle') ? '' : $('status').textContent);
      const ex = (id) => { const s = $('examples'); s.value = id; s.dispatchEvent(new Event('change', { bubbles: true })); };
      const out = {};
      // an example: its result is told (for a few seconds)
      ex('dot1'); await settle(); out.example = [status(), tp()];
      // then, within those seconds, a paste and a live result: not the example's number any more
      pasteInto($('code'), ${js(fx('fnv.s'))}); out.atPaste = status(); await settle(); out.pasted = [status(), tp()];
      // a CPU picked: told; then typing
      ex('dot1'); await settle();
      const box = [...document.querySelectorAll('#cpu-grid input')].find((b) => b.value === 'HSW'); box.click(); await settle(); out.cpu = [status(), tp()];
      $('code').focus(); $('code').setSelectionRange(0, 0); document.execCommand('insertText', false, '  nop\\n'); out.atTyping = status(); await settle(); out.typed = [status(), tp()];
      return out;`);
    check(/cycles\/iteration · SKL/.test(r.example[0]) && r.example[0].startsWith(r.example[1]), 'B2: an example tells its result', js(r.example));
    check(r.atPaste === '' && (r.pasted[0] === '' || r.pasted[0].startsWith(r.pasted[1])) && r.pasted[1] !== r.example[1], 'B2: after a paste, the status line has no old result', js(r));
    check(/· HSW/.test(r.cpu[0]) && r.cpu[0].startsWith(r.cpu[1]), 'B2: a CPU picked tells its result', js(r.cpu));
    check(r.atTyping === '' && (r.typed[0] === '' || r.typed[0].startsWith(r.typed[1])), 'B2: after typing, the status line has no old result', js(r));
    await page.close();
  }

  // ---- B7: A → B copies the loop picked; other loops of one text, or other sizes at the same elems, are said ---------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      const odd = () => document.querySelector('#result-body .ab-odd')?.textContent ?? '';
      const speed = () => /([\\d.]+)× (faster|slower)/.exec(headline())?.slice(1).join(' ') ?? headline();
      const out = {};
      pasteInto($('code'), ${js(fx('saxpy.s'))}); await settle();
      pick('loop-chip', optionOf('loop-chip', /\\.LBB0_8\\b/)); await settle();
      set($('a-work'), '32'); await settle();
      $('cmp-ab').click(); await settle();
      // B, another text first (so that A → B replaces it), then A → B
      pasteInto($('code-b'), ${js(fx('fnv.s'))}); await settle();
      $('ab-copy').click(); await settle(); pick('b-arch', 'ICL'); await settle();
      out.copy = { bLoop: $('loop-chip-b')?.selectedOptions[0]?.textContent, bWork: $('b-work').value, speed: speed(), odd: odd() };
      // B's loop picked other than A's: said in the headline (the same text)
      pick('loop-chip-b', optionOf('loop-chip-b', /\\.LBB0_16\\b/)); await settle();
      out.other = { odd: odd(), title: document.querySelector('#result-body .ab-odd')?.title ?? '', speed: speed() };
      return out;`, { timeout: 200000 });
    await page.size(1200, 700);
    r.narrow = await page.eval(`${W} await wait(500); const d = document.querySelector('#result-body .ab-delta'), o = document.querySelector('#result-body .ab-odd');
      return { second: !!o?.closest('.ab-meta'), first: !!document.querySelector('#result-body .ab-tp .ab-odd, #result-body .ab-tp .align-tag'), text: d.textContent };`);
    await page.size(1440, 900);
    Object.assign(r, await page.eval(`${W}
      const odd = () => document.querySelector('#result-body .ab-odd')?.textContent ?? '';
      const out = {};
      pick('loop-chip-b', optionOf('loop-chip-b', /\\.LBB0_8\\b/)); await settle();
      // an edit of B keeps its loop (A → B's text is B's own)
      $('code-b').focus(); $('code-b').setSelectionRange(0, 0); document.execCommand('insertText', false, '# edited\\n'); await settle();
      out.edited = $('loop-chip-b')?.selectedOptions[0]?.textContent;
      // the link keeps B's loop
      $('copy-link').click(); await wait(200); out.hash = location.hash;
      // both sides as machine code of one text: no loops to tell apart (no pick left from B's assembly)
      $('mode-hex').click(); await until(() => !$('code').readOnly && $('code').getAttribute('aria-label') === 'Machine code (hex)'); await settle();
      $('ab-copy').click(); await settle();
      out.hex = { odd: odd(), bHex: $('b-mode-hex').checked };
      return out;`, { timeout: 200000 }));
    check(/\.LBB0_8\b/.test(r.copy.bLoop) && r.copy.bWork === '32', 'B7: A → B copies the loop picked and the elems', js(r.copy));
    check(r.narrow.second && !r.narrow.first, 'B7: at 1200 × 700 the tag is on the second line (the verdict keeps its room on the first)', js(r.narrow));
    check(r.hex.bHex && r.hex.odd === '', 'B7: both sides machine code of one text: no "other loops"', js(r.hex));
    check(r.copy.speed === '1.50 faster' && r.copy.odd === '', 'B7: B on ICL: 1.50× faster (not 4.51×), nothing odd', js(r.copy));
    check(/\.LBB0_8\b/.test(r.edited), 'B7: an edit of B keeps its loop', r.edited);
    check(/[&#]blp=\d/.test(r.hash), 'B7: the link has B\'s loop (blp)', r.hash);
    check(r.other.odd === 'other loops' && /A \.LBB0_8, B \.LBB0_16/.test(r.other.title), 'B7: other loops of the same text: said in the headline', js(r.other));
    // a fresh tab with the link: B analyzes the loop the link names
    const p2 = await Page.open(browser, { width: 1440, height: 900, intercept });
    await p2.goto(`${srv.origin}/?nosw=1${r.hash.replace(/blp=\d+/, (m) => m)}`);
    await p2.waitFor(`document.getElementById('results').dataset.run && document.querySelector('#result-body .ab-tp')`, 'the A–B result', 60000);
    const back = await p2.eval(`${W} await settle(); return { bLoop: $('loop-chip-b')?.selectedOptions[0]?.textContent, speed: /([\\d.]+)× (faster|slower)/.exec(headline())?.slice(1).join(' ') };`);
    check(/\.LBB0_8\b/.test(back.bLoop) && back.speed === '1.50 faster', 'B7: the link in a fresh tab: B\'s loop and the 1.50×', js(back));
    check(page.take().length === 0 && p2.take().length === 0, 'B7: no errors', '');
    await p2.close();
    await page.close();
  }

  // ---- B8: a try variant opened with ↗ keeps its unit: elems = the original's × the unroll -----------------------------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      pasteInto($('code'), ${js(fx('fnv.s'))}); await settle();
      const base = [tp(), document.querySelector('#result-body .tp .unit').textContent];
      document.querySelector('.view-tab[data-tab="try"]').click();
      await until(() => /★/.test($('whatif')?.innerText ?? ''), 60000);
      const tr = document.querySelector('#whatif tr[data-id="acc4"]');
      const a = tr.querySelector('a.wi-open'); a.dispatchEvent(new Event('focus'));
      return { base, shown: tr.querySelector('.wi-tp').textContent, href: a.getAttribute('href'), title: a.title };`, { timeout: 120000 });
    check(r.base[0] === '32.00' && /^#v=1&/.test(r.href.replace(/^[^#]*/, '')) && /elems 4: unrolled ×4/.test(r.title), 'B8: the link of "4 accumulators" says its elems', js(r));
    const p2 = await Page.open(browser, { width: 1440, height: 900 });
    await p2.goto(`${srv.origin}/?nosw=1${r.href.replace(/^[^#]*/, '')}`);
    await p2.waitFor(`document.getElementById('results').dataset.run && document.querySelector('#result-body .tp .value')`, 'the variant', 60000);
    const v = await p2.eval(`${W} return { tp: tp(), unit: document.querySelector('#result-body .tp .unit').textContent, elems: $('a-work').value, mode: $('mode-hex').checked };`);
    check(v.mode && v.elems === '4' && v.unit === 'cycles/element' && Math.abs(Number(v.tp) - Number(r.shown.replace(/[≈~]/, ''))) < 0.06, 'B8: the variant\'s tab: elems 4, its cycles per element as try showed (not 32.00 per iteration)', js([v, r.shown]));
    check(page.take().length === 0 && p2.take().length === 0, 'B8: no errors', '');
    await p2.close();
    await page.close();
  }

  // ---- elems: back to 1 for other code (a paste); an edit marks it; the same value typed again clears the mark ---------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      const unit = () => document.querySelector('#result-body .tp .unit')?.textContent;
      const field = () => ({ value: $('a-work').value, flag: $('a-work').closest('label').classList.contains('flag'), title: $('a-work').closest('label').title });
      const out = {};
      set($('a-work'), '8'); await settle(); out.set = [field(), unit()];
      pasteInto($('code'), ${js(fx('fnv.s'))}); await settle(); out.pasted = [field(), unit()];
      set($('a-work'), '8'); await settle();
      $('code').focus(); $('code').setSelectionRange(0, 0); document.execCommand('insertText', false, '# a comment\\n'); await settle();
      out.edited = [field(), unit(), document.querySelector('#result-body .tp .unit').title];
      // the same number typed again (no focus event first: as typed into the focused field)
      $('a-work').value = '8'; $('a-work').dispatchEvent(new Event('input', { bubbles: true })); await wait(100);
      out.confirmed = [field(), unit()];
      $('copy-link').click(); await wait(200); out.hash = location.hash;
      // asm -> hex (the same machine code): kept; other hex pasted: 1
      $('mode-hex').click(); await until(() => /^[0-9a-f ]+/i.test($('code').value.trim()) && !$('code').readOnly); await settle();
      out.hex = field().value;
      pasteInto($('code'), '48 83 c0 01 49 ff cf 75 f7'); await settle(); out.hexPasted = field().value;
      // B: a format switch (the same machine code) is not other code: a keystroke after it keeps the count, marked
      $('cmp-ab').click(); await settle();
      pasteInto($('code-b'), ${js(fx('fnv.s'))}); await settle(); pick('b-syntax', 'att'); await settle();
      set($('b-work'), '8'); await settle();
      $('b-mode-hex').click(); await until(() => !$('code-b').readOnly && /machine code/.test($('code-b').getAttribute('aria-label'))); await settle();
      $('code-b').focus(); $('code-b').setSelectionRange(0, 0); document.execCommand('insertText', false, ' '); await settle();
      out.bSwitch = [$('b-work').value, $('b-work').closest('label').classList.contains('flag')];
      // A: an untouched example in the other syntax is the same code
      $('cmp-single').click(); await settle();
      const s = $('examples'); s.value = 'dot1'; s.dispatchEvent(new Event('change', { bubbles: true })); await settle();
      set($('a-work'), '8'); await settle();
      pick('syntax', 'att'); await settle();
      $('code').focus(); $('code').setSelectionRange(0, 0); document.execCommand('insertText', false, ' '); await settle();
      out.aSyntax = [field().value, field().flag];
      return out;`, { timeout: 200000 });
    check(r.bSwitch[0] === '8' && r.bSwitch[1], 'elems: B: after asm → hex, a keystroke keeps the count (marked)', js(r.bSwitch));
    check(r.aSyntax[0] === '8' && r.aSyntax[1], 'elems: A: after an example\'s syntax switch, a keystroke keeps the count (marked)', js(r.aSyntax));
    check(r.set[0].value === '8' && r.set[1] === 'cycles/element', 'elems: set', js(r.set));
    check(r.pasted[0].value === '1' && !r.pasted[0].flag && r.pasted[1] === 'cycles/iteration', 'elems: other code pasted: back to 1, no mark', js(r.pasted));
    check(r.edited[0].value === '8' && r.edited[0].flag && r.edited[1] === 'cycles/element?' && /The code changed/.test(r.edited[0].title) && !/A's/.test(r.edited[0].title), 'elems: an edit keeps it, marked (single mode: not "A\'s code")', js(r.edited));
    check(!r.confirmed[0].flag && r.confirmed[1] === 'cycles/element', 'elems: the same value typed again clears the mark (field and headline)', js(r.confirmed));
    check(/[&#]aw=8(&|$)/.test(r.hash) && r.hex === '8' && r.hexPasted === '1', 'elems: in the link; kept through asm → hex; other hex pasted: 1', js([r.hash.slice(0, 40), r.hex, r.hexPasted]));
    const p2 = await Page.open(browser, { width: 1440, height: 900 });
    await p2.goto(`${srv.origin}/?nosw=1${r.hash}`);
    await p2.waitFor(`document.getElementById('results').dataset.run && document.querySelector('#result-body .tp .value')`, 'the result', 60000);
    const back = await p2.eval(`${W} await settle(); return [$('a-work').value, document.querySelector('#result-body .tp .unit').textContent, $('a-work').closest('label').classList.contains('flag')];`);
    check(back[0] === '8' && back[1] === 'cycles/element' && !back[2], 'elems: a shared link opens with its elems, unmarked', js(back));
    check(page.take().length === 0 && p2.take().length === 0, 'elems: no errors', '');
    await p2.close();
    await page.close();
  }

  // ---- the loop picker: label · function · size (· depth), the loop picked by default unchanged --------------------------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      // (the option's own text: every browser shows it, closed and open; no label attribute)
      const opts = () => [...$('loop-chip').options].map((o) => ({ label: o.text, attr: o.hasAttribute('label'), value: o.value, on: o.selected }));
      pasteInto($('code'), ${js(fx('multi.s'))}); await settle();
      const multi = opts();
      pasteInto($('code'), ${js(fs.readFileSync(path.join(ROOT, 'tests-js/fixtures/cli/count_u8.hsw.s'), 'utf8'))}); await settle();
      return { multi, nested: opts(), width: $('loop-chip').getBoundingClientRect().width };`);
    const m = r.multi;
    check(m.length === 10 && m[0].label === '.LBB0_9 · sum · 11 instr' && m[5].label === '.LBB2_8 · popc · 43 instr' && m[9].label === 'whole', 'picker: label, function and size of each loop (4 functions)', js(m.map((o) => o.label)));
    check(m[0].on && m[0].value === '0' && !m.some((o) => o.attr) && m.every((o, k) => o.value === (k < 9 ? String(k) : 'whole')), 'picker: the order, the values and the default as before', js(m.map((o) => [o.value, o.on])));
    check(r.nested[0].label === '.LBB0_12 · 11 instr · depth 2' && r.nested[3].label === '.LBB0_4 · 79 instr' && r.nested[0].on, 'picker: one function: no name; nested loops: their depth', js(r.nested.map((o) => o.label)));
    check(r.width < 200, 'picker: the closed menu stays narrow (the toolbar keeps its height)', String(r.width));
    await page.close();
  }

  // ---- keyboard: the uop table is one tab stop (the focused row, then its link); j/k and the arrows inside -----------------
  {
    const page = await fresh();
    await page.eval(`${W} const s = $('examples'); s.value = 'sha256'; s.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => Number(tp()) > 100, 90000); await settle(); document.activeElement?.blur(); return 1;`, { timeout: 120000 });
    const where = () => page.eval(`${W} const a = document.activeElement, t = document.querySelector('table.uops');
      return { tag: a?.tagName, inTable: !!t?.contains(a), row: a?.closest?.('tbody tr') ? t.vr.index(a.closest('tbody tr')) : -1, link: a?.tagName === 'A',
        stops: [...document.querySelectorAll('#result-body .table-wrap, #result-body table.uops a, #result-body table.uops tr')].filter((e) => e.tabIndex >= 0 && e.closest('.table-wrap') === t.closest('.table-wrap')).length };`);
    await page.key('j'); await page.key('j'); await page.key('j');
    const j3 = await where();
    await page.key('ArrowDown', { keyCode: 40 });
    const down = await where();
    await page.key('Tab', { keyCode: 9 });
    const tab1 = await where();
    await page.key('Tab', { keyCode: 9 });
    const tab2 = await where();
    await page.key('Tab', { keyCode: 9, modifiers: 8 }); // Shift+Tab: back to the row's link
    const back = await where();
    // the table scrolled far from its row (not drawn: a long table draws the rows near the view), Tab from before it
    await page.eval(`${W} const w = document.querySelector('#result-body .table-wrap'); w.scrollTop = w.scrollHeight; await wait(300);
      [...document.querySelectorAll('#result-body .table-tools input[type="checkbox"]')].at(-1).focus(); return 1;`);
    await page.key('Tab', { keyCode: 9 });
    const into = await where();
    await page.key('Tab', { keyCode: 9, modifiers: 8 });
    const outOf = await where();
    check(j3.inTable && j3.row === 2 && down.row === 3, 'keys: j/k and ↓ move the focused row', js([j3, down]));
    check(down.stops === 2, 'keys: the table has two stops in the tab order (the focused row and its link), not one per instruction', js(down));
    check(tab1.link && tab1.row === 3, 'keys: Tab from the row: its uops.info link', js(tab1));
    check(!tab2.inTable, 'keys: Tab again leaves the table', js(tab2));
    check(back.link && back.row === 3, 'keys: Shift+Tab comes back to the row\'s link', js(back));
    check(into.inTable && into.row === 3 && !into.link, 'keys: Tab into the table scrolled away: its row (drawn again), not nothing', js(into));
    check(!outOf.inTable && outOf.tag === 'INPUT', 'keys: Shift+Tab from the row leaves the table (the scroller is no stop then)', js(outOf));
    check(page.take().length === 0, 'keys: no errors', '');
    await page.close();
  }

  // ---- a what-if number under its limit is shown at the limit everywhere on the page (whatif-core.js shownOutcome) -------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      const s = $('examples'); s.value = 'dot1'; s.dispatchEvent(new Event('change', { bubbles: true })); await settle();
      document.querySelector('.view-tab[data-tab="try"]').click();
      await until(() => /★/.test($('whatif')?.innerText ?? ''), 60000); await wait(300);
      const sim = /simulated ([\\d.]+)/.exec(document.querySelector('#whatif tr[data-id="acc8"] .wi-tp').title)?.[1];
      const copied = []; navigator.clipboard.writeText = async (t) => { copied.push(t); };
      document.querySelector('#result-body .view-tabs .ws-copy').click(); await wait(200);
      document.dispatchEvent(new CustomEvent('wuica:copy', { detail: { tab: 'all', format: 'md' } })); await wait(200);
      const texts = [document.body.innerText, ...copied];
      for (const t of ['bound', 'table']) { document.querySelector('.view-tab[data-tab="' + t + '"]').click(); await wait(600); texts.push(document.body.innerText); }
      const raw = texts.flatMap((t) => t.split('\\n')).filter((l) => sim && l.includes(sim) && !l.includes('(simulated ' + sim + ')'));
      return { sim, shown: document.querySelector('#whatif tr[data-id="acc8"] .wi-tp')?.textContent, raw, copies: copied.length };`, { timeout: 120000 });
    check(r.sim === '3.98' && r.copies === 2, 'what-if: dot1\'s 8 accumulators simulate 3.98 (under the Ports limit)', js(r));
    check(r.raw.length === 0, 'what-if: the page, the try Markdown and "copy all" show 3.98 only as "(simulated 3.98)"', js(r.raw));
    await page.close();
  }

  // ---- a sweep click: the offset next to the headline (a tag that sets it back); the toolbar does not move --------------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      const top = () => Math.round($('code').getBoundingClientRect().top), tbh = () => Math.round(document.querySelector('#input .toolbar').getBoundingClientRect().height);
      const tag = () => document.querySelector('#result-body .row.lead .align-tag');
      pasteInto($('code'), ${js(fx('scan_v2.s'))}); await settle();
      const before = { top: top(), tb: tbh(), tag: !!tag(), tp: tp() };
      document.querySelector('.view-tab[data-tab="sweep"]').click();
      await until(() => document.querySelectorAll('#cmp-sweep rect.hit').length === 64 && $('cmp-sweep').dataset.state === 'done', 90000);
      document.querySelector('#cmp-sweep rect.hit[data-offset="30"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      const after = { top: top(), tb: tbh(), tag: tag()?.textContent ?? null, tp: tp(), align: $('opt-align').value, summary: $('advanced-summary').textContent };
      $('cmp-ab').click(); await settle();
      const ab = document.querySelector('#result-body .ab-meta .align-tag')?.textContent ?? null;
      $('cmp-single').click(); await settle();
      tag().click(); await settle();
      await until(() => $('cmp-sweep').dataset.state === 'done', 60000).catch(() => {});
      const reset = { tag: !!tag(), align: $('opt-align').value, tp: tp(), summary: $('advanced-summary').textContent, cursor: document.querySelector('#cmp-sweep .at')?.textContent ?? '' };
      return { before, after, ab, reset };`, { timeout: 200000 });
    check(!r.before.tag && r.after.tag === 'offset 30 ×' && r.after.align === '30' && r.after.tp !== r.before.tp, 'sweep click: the headline says "offset 30" (its number changed)', js(r));
    check(r.after.top === r.before.top && r.after.tb === r.before.tb && r.after.summary === ' · 1 changed', 'sweep click: the toolbar keeps its height, the editor does not move (the options\' count for screen readers)', js([r.before, r.after]));
    check(r.ab === 'offset 30 ×', 'sweep click: A–B shows the offset too', String(r.ab));
    check(!r.reset.tag && r.reset.align === '0' && r.reset.tp === r.before.tp && r.reset.summary === '' && /^offset 0:/.test(r.reset.cursor), 'the tag sets the offset back to 0 (the sweep\'s cursor too)', js(r.reset));
    check(page.take().length === 0, 'sweep: no errors', '');
    await page.close();
  }

  // ---- phones (390 × 844): a code box of about 12 lines, every tab in view, the CPU table's notes not cut --------------
  {
    const page = await fresh({ width: 390, height: 844, mobile: true });
    const r = await page.eval(`${W}
      const c = $('code'), lines = c.clientHeight / parseFloat(getComputedStyle(c).lineHeight);
      const strip = document.querySelector('#result-body > .view-tabs');
      const tabsIn = [...strip.querySelectorAll('.view-tab')].every((t) => { const b = t.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; });
      const out = { lines: Math.round(lines * 10) / 10, tabsIn, strip: [strip.scrollWidth, strip.clientWidth], top: Math.round($('results').getBoundingClientRect().top + scrollY), h: innerHeight };
      pasteInto(c, ${js(fx('avx512.s'))}); await settle();
      $('cpu-all').click(); await until(() => $('cmp-cpus').dataset.state === 'done', 90000); await wait(300);
      const wrap = document.querySelector('#cmp-cpus .table-wrap'), bn = document.querySelector('table.cmp-cpus tr[data-arch="SKL"] .cmp-bn');
      out.table = { wrap: [wrap.scrollWidth, wrap.clientWidth], bn: bn.textContent, bnRight: Math.round(bn.getBoundingClientRect().right), w: innerWidth, page: document.documentElement.scrollWidth - innerWidth };
      return out;`, { timeout: 200000 });
    check(r.lines >= 11, 'phone: the code box shows about 12 lines (was about 5)', js(r));
    check(r.tabsIn && r.strip[0] <= r.strip[1], 'phone: every tab of the result is in view (no strip scrolled sideways)', js(r));
    check(r.top < r.h, 'phone: the result still starts in the first screen', js([r.top, r.h]));
    check(r.table.wrap[0] <= r.table.wrap[1] && r.table.bnRight <= r.table.w && /needs AVX-512 · 12 undecodable skipped/.test(r.table.bn) && r.table.page <= 0, 'phone: the CPU table fits; its notes wrap instead of being cut', js(r.table));
    check(page.take().length === 0, 'phone: no errors', '');
    await page.close();
  }

  // ---- B6: an assembler error of the old code goes when a Compiler Explorer link replaces it (A, and B) ----------------
  {
    const page = await fresh();
    const r = await page.eval(`${W}
      const clip = (el, text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); el.focus(); el.select(); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); };
      const line = (id) => document.querySelector('.ce-line[data-for="' + id + '"]')?.textContent ?? '';
      const out = {};
      for (const [code, box] of [['code', 'input-messages'], ['code-b', 'b-messages']]) {
        // (A's box holds the link: code again, or nothing is analyzed; B's syntax does not follow a paste)
        if (code === 'code-b') { pasteInto($('code'), ${js(fx('fnv.s'))}); await settle(); $('cmp-ab').click(); await settle(); pick('b-syntax', 'att'); }
        pasteInto($(code), ${js(fx('tricky.s'))});
        await until(() => /LCPI0_0/.test($(box).textContent));
        const before = [$(box).textContent, $(code).getAttribute('aria-invalid')];
        clip($(code), 'https://godbolt.org/z/notareallink1');
        await until(() => /not found/i.test(line(code)));
        await wait(500);
        out[code] = { before, after: $(box).textContent, invalid: $(code).getAttribute('aria-invalid'), ce: line(code), stale: $('input-stale')?.textContent ?? '' };
      }
      return out;`);
    for (const [side, x] of [['A', r.code], ['B', r['code-b']]]) {
      check(/LCPI0_0/.test(x.before[0]) && x.before[1] === 'true', `B6 ${side}: tricky.s gives its assembler error`, js(x));
      check(/not found/i.test(x.ce) && x.after === '' && x.invalid !== 'true', `B6 ${side}: after the link, only Compiler Explorer's message (the old error is gone)`, js(x));
    }
    check(r.code.stale === '', 'B6: no "stale: the input has an error" for a link', js(r.code));
    await page.close();
  }
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
