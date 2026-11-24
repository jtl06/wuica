// The code boxes in colour (web/js/asm-hl.js) in headless Chrome (--headless, --remote-debugging-port: tests-js/cdp.mjs):
// - the layer is where the box has its text, to the pixel: the box's own text (layer hidden) and the layer's text (box
//   transparent), both in one colour, give identical screenshots of the box: at the top and deep in the SHA-256
//   showcase, on long lines scrolled sideways, with tabs, with 15 px scroll bars, at zoom 110/125/150/200 %, on a phone,
//   in A–B's box B;
// - it follows text the page sets (an example, a mode switch: no input event), typing, scrolling;
// - the assembler's messages underline their line and token, and the list stays as it was;
// - hex stays plain (objdump text in colour); an IME's composition shows the box's own text; a layer that fails leaves
//   the plain box; the layer holds no findable text; the token colours are AA on the box in both themes;
// - the uop table's instructions are tokens with the same text.
//   node tests-js/web_asm_hl_browser.mjs [--chrome PATH]
import fs from 'node:fs';
import path from 'node:path';
import { findChrome, launch, serve, copyDist, Page, HELPERS, checker, ROOT, decodePng } from './cdp.mjs';

const chrome = findChrome();
const check = checker('asm colour browser');
if (!fs.existsSync(path.join(ROOT, 'web/dist/manifest.json'))) { console.log('web/dist is missing: run web/build.sh first'); process.exit(1); }
if (!chrome) { console.log('Chrome not found (use --chrome PATH): skipped'); process.exit(check.summary() ? 1 : 0); }

const PRE = `${HELPERS}
  const frames = (n = 2) => new Promise((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const idle = () => $('status-wrap').classList.contains('idle') && !$('results').hasAttribute('aria-busy');
  const settle = async () => { await wait(100); await until(idle, 120000); await frames(3); };
  const example = async (id) => { $('examples').value = id; $('examples').dispatchEvent(new Event('change', { bubbles: true })); await wait(200); await settle(); };
  const sheet = (css) => { window.__hlSheet ??= new CSSStyleSheet(); if (!document.adoptedStyleSheets.includes(window.__hlSheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, window.__hlSheet]; window.__hlSheet.replaceSync(css); };
  // the layer's text as drawn (the generated content of its tokens, its line breaks), by line
  const layerText = (ta) => { const l = ta.parentElement.querySelector('.ed-text'); let s = ''; const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) s += c.data; else if (c.dataset?.t !== undefined) s += c.dataset.t; else walk(c); } }; walk(l); return s.split('\\n'); };
  // the lines in view agree with the box (and every drawn line is the box's line at that index)
  const follows = (ta) => { const L = layerText(ta), V = ta.value.split('\\n'); const cs = getComputedStyle(ta); const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const lh = ta.scrollHeight > ta.clientHeight + 1 ? (ta.scrollHeight - pad) / V.length : parseFloat(cs.lineHeight); // (the box's own pitch)
    const a = Math.floor(ta.scrollTop / lh), b = Math.min(V.length - 1, Math.ceil((ta.scrollTop + ta.clientHeight) / lh));
    const bad = []; for (let k = a; k <= b; k++) if (L[k] !== V[k]) bad.push([k, L[k], V[k]]);
    L.forEach((l, k) => { if (l !== '' && l !== V[k]) bad.push([k, l, V[k]]); });
    return { on: ta.parentElement.classList.contains('ed-on'), bad: bad.slice(0, 3), lines: V.length }; };`;

const srv = await serve(copyDist());
const { browser, close } = await launch(chrome);
const ONE = '#ffffff';
const SHEETS = {
  box: `.ed > textarea { color: ${ONE} !important; caret-color: transparent !important; } .ed > .ed-hl { visibility: hidden !important; }`,
  layer: `.ed > textarea { color: transparent !important; caret-color: transparent !important; } .ed > .ed-hl, .ed > .ed-hl * { color: ${ONE} !important; text-decoration: none !important; }`,
};
const BARS = '::-webkit-scrollbar { width: 15px; height: 15px; background: #808080; }';

// the box's two pictures: its own text and the layer's; the pixels that differ (WUICA_HL_DEBUG=DIR: both saved there)
let shots = 0;
async function alignment(p, sel, extra = '') {
  const shot = async (which) => {
    const clip = await p.eval(`${PRE} sheet(${JSON.stringify(SHEETS[which] + extra)}); document.activeElement?.blur?.(); await frames(3);
      const r = $(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };`);
    const { data } = await p.cmd('Page.captureScreenshot', { format: 'png', clip });
    return { ...(await decodePng(Buffer.from(data, 'base64'))), png: Buffer.from(data, 'base64') };
  };
  const a = await shot('box'), b = await shot('layer');
  if (process.env.WUICA_HL_DEBUG) { const n = ++shots; fs.writeFileSync(path.join(process.env.WUICA_HL_DEBUG, `${n}-box.png`), a.png); fs.writeFileSync(path.join(process.env.WUICA_HL_DEBUG, `${n}-layer.png`), b.png); }
  await p.eval(`${PRE} sheet(${JSON.stringify(extra)}); return 1;`);
  let differ = 0, ink = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    if (a.rgba[i] !== b.rgba[i] || a.rgba[i + 1] !== b.rgba[i + 1] || a.rgba[i + 2] !== b.rgba[i + 2]) differ++;
    if (a.rgba[i] > 128) ink++;
  }
  // the offset of the layer's picture against the box's, to a fraction of a device pixel: the sums of squared differences
  // at the picture shifted by -1, 0 and +1 pixel, a parabola through them (glyphs drawn at positions 1/64 px apart are
  // rasterized a little differently, so the pictures are rarely identical: 0.00 to 0.07 px measured; one pixel off is 1)
  const ssd = (dx, dy) => {
    let s = 0;
    for (let y = 3; y < a.height - 3; y++) for (let x = 3; x < a.width - 3; x++) {
      const i = 4 * (y * a.width + x), j = 4 * ((y + dy) * a.width + x + dx);
      for (let c = 0; c < 3; c++) { const d = a.rgba[i + c] - b.rgba[j + c]; s += d * d; }
    }
    return s;
  };
  const z = ssd(0, 0);
  const sub = (m, q) => (m - 2 * z + q > 0 ? (m - q) / (2 * (m - 2 * z + q)) : z === 0 ? 0 : 9);
  const dx = sub(ssd(-1, 0), ssd(1, 0)), dy = sub(ssd(0, -1), ssd(0, 1));
  return { dx: Math.round(dx * 1000) / 1000, dy: Math.round(dy * 1000) / 1000, differ, ink, size: `${a.width}x${a.height}` };
}
const aligned = async (p, what, sel = 'code', extra = '') => {
  const r = await alignment(p, sel, extra);
  check(r.ink > 200 && Math.abs(r.dx) < 0.25 && Math.abs(r.dy) < 0.25, `${what}: the layer's text is where the box's is (within a quarter of a device pixel)`, JSON.stringify(r));
  return r;
};

// long lines with tabs (scrolled sideways), a block comment over lines, labels, directives
const LONG = ['.text', '/* a block', '   comment */ loop:', ...Array.from({ length: 60 }, (_, i) => `\tvaddps ymm${i % 16}, ymm1, ymmword ptr [rdi + 8*rcx + ${i * 32}]\t# ${'x'.repeat(i * 5)} end`), '\tdec rcx', '\tjnz loop'].join('\n');

try {
  const p = await Page.open(browser, { width: 1440, height: 900 });
  await p.goto(`${srv.origin}/?nosw=1`);
  await p.ready();
  await p.eval(`${PRE} await settle(); return 1;`);

  // ---- the default example: in colour, the tokens' kinds, the text not findable in the layer
  let r = await p.eval(`${PRE} const ta = $('code'); const hl = ta.parentElement.querySelector('.ed-hl');
    const kinds = [...hl.querySelectorAll('[data-t]')].map((s) => s.className + ':' + s.dataset.t.trim()).filter((s) => !s.startsWith(':'));
    return { f: follows(ta), kinds, layerText: hl.textContent.trim(), color: getComputedStyle(ta).color, inert: hl.inert, hidden: hl.getAttribute('aria-hidden'), field: ta.closest('.code-field') !== null };`);
  check(r.f.on && r.f.bad.length === 0, 'the default example is drawn in colour, line for line', JSON.stringify(r.f));
  check(['tok-label:loop', 'tok-mnemonic:add', 'tok-register:rax', 'tok-number:1', 'tok-punct:,', 'tok-symbol:loop'].every((k) => r.kinds.includes(k)), 'its tokens: label, mnemonic, register, number, punctuation, branch target', JSON.stringify(r.kinds));
  check(r.layerText === '' && r.inert && r.hidden === 'true', 'the layer holds no text of its own (generated content: a find-in-page finds the box\'s text once) and is hidden from assistive technology', JSON.stringify([r.layerText.slice(0, 40), r.inert, r.hidden]));
  check(r.color === 'rgba(0, 0, 0, 0)' && r.field, 'the box\'s own text is transparent while the layer is on', r.color);
  await aligned(p, 'default example, 1440×900');

  // ---- the token colours: AA (4.5:1) on the box, in both themes
  for (const scheme of ['dark', 'light']) {
    await p.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    r = await p.eval(`${PRE} await frames(2);
      const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
      const lum = (c) => { const [R, G, B] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      const bg = getComputedStyle($('code')).backgroundColor, pageBg = getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.documentElement).backgroundColor : getComputedStyle(document.body).backgroundColor;
      const out = {}; const probe = document.createElement('span'); $('code').parentElement.querySelector('.ed-hl').append(probe);
      for (const k of ['mnemonic', 'prefix', 'register', 'number', 'punct', 'label', 'symbol', 'directive', 'comment', 'size', 'address', 'bytes', 'error']) { probe.className = 'tok-' + k; const c = getComputedStyle(probe).color; out[k] = [c, Math.round(ratio(c, bg) * 100) / 100, Math.round(ratio(c, pageBg) * 100) / 100]; }
      probe.remove(); return out;`);
    const low = Object.entries(r).filter(([, [, a, b]]) => a < 4.5 || b < 4.5);
    check(low.length === 0, `${scheme}: every token colour is AA on the box and the page`, JSON.stringify(low.length ? low : r));
    check(new Set(Object.values(r).map(([c]) => c)).size >= 6, `${scheme}: the tokens have several colours`, JSON.stringify(r));
  }
  await p.cmd('Emulation.setEmulatedMedia', { features: [] });

  // ---- text set by the page (no input event): an example; typing; the SHA-256 showcase deep down
  r = await p.eval(`${PRE} await example('sha256'); await until(() => (document.querySelector('#result-body .meta')?.title ?? '').startsWith('2949 instructions'), 120000); await frames(2); return follows($('code'));`);
  check(r.on && r.bad.length === 0 && r.lines > 2900, 'an example set by the page (no input event) is drawn', JSON.stringify(r));
  r = await p.eval(`${PRE} const ta = $('code'); return { n: ta.parentElement.querySelectorAll('.ed-text [data-t]').length };`);
  check(r.n > 50 && r.n < 3000, 'only the lines near the view are drawn (not 2,949)', JSON.stringify(r));
  await aligned(p, 'SHA-256, top');
  r = await p.eval(`${PRE} const ta = $('code'); ta.scrollTop = 40000; await frames(3); return { ...follows(ta), top: ta.scrollTop };`);
  check(r.on && r.bad.length === 0 && r.top > 30000, 'scrolled deep into SHA-256: the lines in view are drawn', JSON.stringify(r));
  await aligned(p, 'SHA-256, scrolled to line 2,100');
  r = await p.eval(`${PRE} const ta = $('code'); ta.scrollTop = ta.scrollHeight; await frames(3); return { ...follows(ta), top: ta.scrollTop };`);
  check(r.on && r.bad.length === 0, 'scrolled to the end: the last lines are drawn', JSON.stringify(r));
  await aligned(p, 'SHA-256, scrolled to the end');
  // typing deep down (the real input pipeline)
  r = await p.eval(`${PRE} const ta = $('code'); const at = ta.value.split('\\n').slice(0, 2400).join('\\n').length; ta.focus(); ta.setSelectionRange(at, at); ta.scrollTop = 2380 * parseFloat(getComputedStyle(ta).lineHeight); await frames(2); return at;`);
  await p.key('Enter', { keyCode: 13, text: '\r' });
  await p.type('  inc r9');
  r = await p.eval(`${PRE} await frames(3); const ta = $('code'); return { ...follows(ta), line: ta.value.split('\\n')[2400] };`);
  check(r.on && r.bad.length === 0 && r.line === '  inc r9', 'typed deep down: the layer follows', JSON.stringify(r));
  await aligned(p, 'SHA-256 after typing at line 2,400');
  // a character typed: only its line is drawn again (the others keep their elements)
  r = await p.eval(`${PRE} const ta = $('code'); const hl = ta.parentElement.querySelector('.ed-text'); const before = [...hl.children]; ta.focus();
    document.execCommand('insertText', false, 'x'); await frames(2); const after = [...hl.children];
    return { kept: after.filter((e) => before.includes(e)).length, n: after.length, f: follows(ta) };`);
  check(r.f.bad.length === 0 && r.n > 20 && r.kept === r.n - 1, 'a character typed: one line drawn again, the others kept', JSON.stringify(r));
  await p.key('Backspace', { keyCode: 8 });
  // undo (the box's own history)
  await p.key('z', { code: 'KeyZ', keyCode: 90, modifiers: process.platform === 'darwin' ? 4 : 2 });
  r = await p.eval(`${PRE} await frames(3); return follows($('code'));`);
  check(r.on && r.bad.length === 0, 'after undo the layer follows', JSON.stringify(r));

  // ---- long lines, tabs, a block comment; scrolled sideways; with 15 px scroll bars
  r = await p.eval(`${PRE} set($('code'), ${JSON.stringify(LONG)}); await settle(); const ta = $('code'); ta.scrollTop = 300; ta.scrollLeft = 900; await frames(3);
    const hl = ta.parentElement.querySelector('.ed-hl'); return { ...follows(ta), left: ta.scrollLeft, comment: [...hl.querySelectorAll('.tok-comment')].map((s) => s.dataset.t.trim()).slice(0, 2), directive: hl.querySelector('.tok-directive')?.dataset.t.trim() };`);
  check(r.on && r.bad.length === 0 && r.left === 900, 'long lines scrolled sideways are drawn', JSON.stringify(r));
  await p.eval(`${PRE} const ta = $('code'); ta.scrollTop = 0; await frames(2); return 1;`);
  r = await p.eval(`${PRE} const hl = $('code').parentElement.querySelector('.ed-hl'); return [...[...hl.querySelectorAll('.tok-comment')].map((s) => s.dataset.t.trimEnd()).slice(0, 2), hl.querySelector('.tok-directive')?.dataset.t.trim()];`);
  check(r[0] === '/* a block' && r[1] === '   comment */', 'a block comment over two lines is a comment on both', JSON.stringify(r));
  check(r[2] === '.text', 'a directive is a token of its own', JSON.stringify(r));
  // the block comment's start removed: the next line is code again
  r = await p.eval(`${PRE} const ta = $('code'); ta.value = ta.value.replace('/* a block', '# a block'); await frames(3);
    const second = ta.parentElement.querySelectorAll('.ed-text > div')[2]; const out = { kinds: [...second.querySelectorAll('[data-t]')].map((s) => s.className + ':' + s.dataset.t.trim()).filter((x) => !x.startsWith(':')), f: follows(ta) };
    ta.value = ta.value.replace('# a block', '/* a block'); await frames(3); return out;`);
  check(r.f.bad.length === 0 && !r.kinds.some((k) => k.startsWith('tok-comment')) && r.kinds.includes('tok-mnemonic:comment'), 'a block comment\'s start removed: the lines after it are code again', JSON.stringify(r));
  await p.eval(`${PRE} const ta = $('code'); ta.scrollTop = 300; ta.scrollLeft = 900; await frames(2); return 1;`);
  await aligned(p, 'long lines with tabs, scrolled sideways');
  await aligned(p, 'long lines, 15 px scroll bars', 'code', BARS);
  r = await p.eval(`${PRE} sheet(${JSON.stringify(BARS)}); await frames(2); const ta = $('code'); ta.scrollTop = ta.scrollHeight; ta.scrollLeft = ta.scrollWidth; await frames(3); return { ...follows(ta), top: ta.scrollTop, left: ta.scrollLeft, hlTop: ta.parentElement.querySelector('.ed-hl').scrollTop, hlLeft: ta.parentElement.querySelector('.ed-hl').scrollLeft };`);
  check(r.bad.length === 0 && r.top === r.hlTop && r.left === r.hlLeft && r.left > 0, '15 px scroll bars, scrolled to the far corner: the layer scrolls as far as the box', JSON.stringify(r));
  await aligned(p, 'long lines, 15 px scroll bars, the far corner', 'code', BARS);
  await p.eval(`${PRE} sheet(''); return 1;`);

  // ---- a long text (the line pitch is the box's, 18.84 px, not the style's 18.85: a line in 3,000) and a long line
  r = await p.eval(`${PRE} if ($('live').checked) $('live').click(); const ta = $('code');
    ta.value = Array.from({ length: 60000 }, (_, i) => \`  add r\${8 + i % 8}, \${i}\`).join('\\n'); await frames(3);
    ta.scrollTop = ta.scrollHeight; await frames(3); const t0 = performance.now(); ta.scrollTop -= 400; await frames(1); const ms = performance.now() - t0; await frames(2);
    return { ...follows(ta), ms: Math.round(ms) };`);
  check(r.on && r.bad.length === 0 && r.lines === 60000, '60,000 lines scrolled to the end: the lines in view are drawn', JSON.stringify(r));
  console.log(`  a scroll near the end of 60,000 lines: ${r.ms} ms to the next frame`);
  await aligned(p, '60,000 lines, scrolled to the end');
  r = await p.eval(`${PRE} const ta = $('code'); ta.value = ['loop:', '  add rax, 1 # ' + 'x'.repeat(3000), '  jnz loop'].join('\\n'); ta.scrollTop = 0; ta.scrollLeft = 0; await frames(3);
    const line = ta.parentElement.querySelectorAll('.ed-text > div')[1]; const out = { ...follows(ta), pieces: [...line.querySelectorAll('[data-t]')].map((x) => x.className) };
    $('live').click(); return out;`);
  check(r.on && r.bad.length === 0 && r.pieces.length === 1 && r.pieces[0] === '', 'a line of 3,000 characters: drawn without colours (one piece)', JSON.stringify(r));
  await aligned(p, 'a line of 3,000 characters');

  // ---- characters of other fonts above the view (drawn as empty lines there: their lines are no taller)
  r = await p.eval(`${PRE} set($('code'), Array.from({ length: 400 }, (_, i) => i % 7 ? \`  add r\${8 + i % 8}, \${i}\` : \`  nop # 注释 → \${i}\`).join('\\n')); await settle();
    const ta = $('code'); ta.scrollTop = 5000; await frames(3); return follows(ta);`);
  check(r.on && r.bad.length === 0, 'characters of other fonts above the view: the lines in view are drawn', JSON.stringify(r));
  await aligned(p, 'characters of other fonts above the view, scrolled');
  // ---- forced colours: the box's own text, no layer
  await p.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  r = await p.eval(`${PRE} await frames(2); return getComputedStyle($('code').parentElement.querySelector('.ed-hl')).display;`);
  check(r === 'none', 'forced colours: the layer is not shown (the system colours the box\'s text)', r);
  await p.cmd('Emulation.setEmulatedMedia', { features: [] });

  // ---- zoom (device pixels per CSS pixel), and a short window
  r = await p.eval(`${PRE} await example('sha256'); const ta = $('code'); ta.scrollTop = 20000; await frames(3); return 1;`);
  for (const z of [1.1, 1.25, 1.5, 2]) {
    await p.cmd('Emulation.setDeviceMetricsOverride', { width: Math.round(1440 / z), height: Math.round(900 / z), deviceScaleFactor: z, mobile: false });
    await p.eval(`${PRE} await frames(4); $('code').scrollTop = 20000; await frames(3); return 1;`);
    await aligned(p, `SHA-256 deep, zoom ${Math.round(z * 100)} %`);
  }
  await p.size(1200, 700);
  await p.eval(`${PRE} await frames(4); return 1;`);
  await aligned(p, 'SHA-256 deep, 1200×700');

  // ---- AT&T
  r = await p.eval(`${PRE} $('syntax').value = 'att'; $('syntax').dispatchEvent(new Event('change', { bubbles: true })); set($('code'), 'loop:\\n\\taddq $1, %rax\\n\\tvmovups 32(%rdi,%rcx,8), %ymm0\\n\\tdecq %r15\\n\\tjnz loop'); await settle();
    const hl = $('code').parentElement.querySelector('.ed-hl'); return { ...follows($('code')), kinds: [...hl.querySelectorAll('[data-t]')].map((s) => s.className + ':' + s.dataset.t.trim()).filter((s) => !s.startsWith(':')) };`);
  check(r.on && r.bad.length === 0 && ['tok-mnemonic:addq', 'tok-number:$1', 'tok-punct:%', 'tok-register:rax', 'tok-number:32'].every((k) => r.kinds.includes(k)), 'AT&T: its tokens', JSON.stringify(r));
  await aligned(p, 'AT&T, 1200×700');

  // ---- a message: its line underlined, its token marked; the list as it was
  r = await p.eval(`${PRE} $('syntax').value = 'intel'; $('syntax').dispatchEvent(new Event('change', { bubbles: true })); set($('code'), 'loop:\\n  add rax, 1\\n  bogus rbx, 2\\n  jnz loop'); await settle(); await until(() => msgs().length > 0); await frames(2);
    const hl = $('code').parentElement.querySelector('.ed-hl');
    return { msgs: msgs(), line: [...hl.querySelectorAll('.ed-err [data-t]')].map((s) => s.dataset.t).join(''), err: [...hl.querySelectorAll('.tok-error')].map((s) => s.dataset.t.trim()), others: hl.querySelectorAll('.ed-err').length, f: follows($('code')) };`);
  check(r.msgs.length === 1 && /^line 3:3: invalid instruction mnemonic 'bogus'/.test(r.msgs[0]), 'the message list is the assembler\'s (one message, line and column)', JSON.stringify(r.msgs));
  check(r.line === 'bogus rbx, 2' && r.others === 1, 'the message\'s line is underlined (its words), no other line', JSON.stringify(r));
  check(r.err.length === 1 && r.err[0] === 'bogus', 'the token at the message\'s column is marked as the error', JSON.stringify(r.err));
  await p.size(1440, 900);
  await p.eval(`${PRE} await frames(3); return 1;`);
  await aligned(p, 'a message shown (underlines hidden for the comparison)');
  // the line edited: its mark goes (the message stays until the next result)
  r = await p.eval(`${PRE} $('live').checked && $('live').click(); const ta = $('code'); ta.value = ta.value.replace('bogus rbx, 2', 'bogus rbx, 3'); await frames(3);
    const hl = ta.parentElement.querySelector('.ed-hl'); const out = { marks: hl.querySelectorAll('.ed-err, .tok-error').length, msgs: msgs().length }; $('live').click(); return out;`);
  check(r.marks === 0 && r.msgs === 1, 'a line edited after its message: no mark on it (the list stays until the next result)', JSON.stringify(r));
  r = await p.eval(`${PRE} set($('code'), 'loop:\\n  add rax, 1\\n  jnz loop'); await done(() => $('run').click()); await settle(); return { msgs: msgs().length, marks: $('code').parentElement.querySelectorAll('.ed-err, .tok-error').length };`);
  check(r.msgs === 0 && r.marks === 0, 'the message gone: no mark', JSON.stringify(r));

  // ---- hex: plain; objdump text in colour
  r = await p.eval(`${PRE} $('mode-hex').click(); await settle(); set($('code'), '48 83 c0 01 49 ff cf 75 f7'); await settle(); const ed = $('code').parentElement;
    const plain = { on: ed.classList.contains('ed-on'), color: getComputedStyle($('code')).color };
    set($('code'), '0000000000401120 <f>:\\n  401120:\\t48 83 c0 01          \\tadd    $0x1,%rax\\n  401124:\\t49 ff cf             \\tdec    %r15\\n  401127:\\t75 f7                \\tjne    401120 <f>'); await settle(); await frames(2);
    const hl = ed.querySelector('.ed-hl'); return { plain, od: { ...follows($('code')), addr: hl.querySelectorAll('.tok-address')[2]?.dataset.t.trim(), bytes: hl.querySelector('.tok-bytes')?.dataset.t.trim(), mn: hl.querySelector('.tok-mnemonic')?.dataset.t.trim() } };`);
  check(!r.plain.on && r.plain.color !== 'rgba(0, 0, 0, 0)', 'hex: plain (the box shows its own text)', JSON.stringify(r.plain));
  check(r.od.on && r.od.bad.length === 0 && r.od.addr === '401124:' && r.od.bytes === '48 83 c0 01' && r.od.mn === 'add', 'objdump text in the hex box: in colour (address, bytes, mnemonic)', JSON.stringify(r.od));
  await aligned(p, 'objdump text in the hex box');
  r = await p.eval(`${PRE} $('mode-asm').click(); await settle(); await frames(2); return follows($('code'));`);
  check(r.on && r.bad.length === 0, 'back to asm (the text set by the page): in colour', JSON.stringify(r));

  // ---- an IME composition: the box's own text meanwhile
  r = await p.eval(`${PRE} const ta = $('code'); ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' })); await frames(2);
    const during = [ta.parentElement.classList.contains('ed-on'), getComputedStyle(ta).color];
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '' })); await frames(2); return { during, after: ta.parentElement.classList.contains('ed-on') };`);
  check(!r.during[0] && r.during[1] !== 'rgba(0, 0, 0, 0)' && r.after, 'an IME composition: the box shows its own text, the layer comes back after it', JSON.stringify(r));

  // ---- A–B: box B in colour
  r = await p.eval(`${PRE} $('cmp-ab').click(); await settle(); await frames(2); const b = $('code-b'); return { ...follows(b), field: b.closest('.ab-b') !== null };`);
  check(r.on && r.bad.length === 0 && r.field, 'A–B: box B in colour', JSON.stringify(r));
  await aligned(p, 'A–B, box B', 'code-b');
  await aligned(p, 'A–B, box A', 'code');
  await p.eval(`${PRE} $('cmp-single').click(); await settle(); return 1;`);

  // ---- the uop table: the instructions as tokens, the same text
  r = await p.eval(`${PRE} set($('code'), 'loop:\\n  add rax, 1\\n  dec r15\\n  jnz loop'); await done(() => $('run').click()); await settle();
    const cells = [...document.querySelectorAll('#result-body table.uops tbody th.first > :first-child')];
    return { n: cells.length, tokens: cells.filter((c) => c.querySelector('.tok-mnemonic')).length, texts: cells.map((c) => c.textContent), titles: cells.map((c) => c.title) };`);
  check(r.n > 0 && r.tokens === r.n, 'the uop table: each instruction\'s mnemonic is a token', JSON.stringify(r));
  check(JSON.stringify(r.texts) === JSON.stringify(['add rax, 0x1', 'dec r15', 'jnz loop']), 'the uop table: the cells\' text is the instruction\'s (the branch target as its label)', JSON.stringify(r));

  // ---- a layer that fails: the plain box, still a text field
  r = await p.eval(`${PRE} const ta = $('code'); Object.defineProperty(ta, 'scrollTop', { configurable: true, get() { throw new Error('test'); } });
    set(ta, 'loop:\\n  add rax, 2\\n  jnz loop'); await frames(3); delete ta.scrollTop; const out = { on: ta.parentElement.classList.contains('ed-on'), color: getComputedStyle(ta).color, value: ta.value.split('\\n')[1] };
    set(ta, 'loop:\\n  add rax, 3\\n  jnz loop'); await frames(3); out.later = ta.parentElement.classList.contains('ed-on'); return out;`);
  check(!r.on && !r.later && r.color !== 'rgba(0, 0, 0, 0)' && r.value === '  add rax, 2', 'a layer that throws: off for good, the box shows its own text', JSON.stringify(r));
  check(p.take().filter((x) => !/test/.test(x)).length === 0, 'no console errors or failed requests');
  await p.close();

  // ---- a phone (16 px in the box)
  const m = await Page.open(browser, { width: 375, height: 812, mobile: true });
  await m.goto(`${srv.origin}/?nosw=1`);
  await m.ready();
  await m.eval(`${PRE} await settle(); return 1;`);
  r = await m.eval(`${PRE} return [getComputedStyle($('code')).fontSize, getComputedStyle($('code').parentElement.querySelector('.ed-hl')).fontSize];`);
  check(r[0] === '16px' && r[1] === '16px', 'a phone: the layer has the box\'s 16 px', JSON.stringify(r));
  await aligned(m, 'a phone (375 px)');
  check(m.take().length === 0, 'phone: no console errors');
  await m.close();
} finally {
  await close();
  await srv.stop();
}
process.exit(check.summary() ? 1 : 0);
