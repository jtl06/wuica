// The workspace: loaded synchronously in <head>, like theme.js. The result pane is a tabbed workspace (style.css): the
// summary (CPUs, throughput, limits, chain) stays on top; under it a row of tabs, the first one the result's own ("table": the uop table; in A–B mode "diff":
// the uop tables of A and B and their difference, ab.js) and the views (bound, try, bytes, deps, mca, sweep, trace, and
// source after an import: always in this order, source last); one tab's content shows at a time. A view tab opens that
// view's own <details> and closes the others, so the views, their keys and the address behave as before. A picked view
// loads even past its size limit (the button marked data-gate), since picking the tab already asks for it. The keys
// 1–9 pick the tabs in their order (keys.js). In A–B mode the views are of one side; a switch at the end of the tab row
// picks it (the event "wuica:ab-side"; app.js). On wide screens the panes are the window's height, the shown tab's
// scroller fills the result pane, and the input pane folds away (a button, or "\").
(function () {
  var root = document.documentElement;

  var strip = null, moreObs = null, bodyObs = null, lastKey = '', opened = [], busy = false;
  var abOn = function () { return document.body.classList.contains('ab-on'); };
  // the views of one side in A–B mode (not the trace: it shows both)
  var BOTH = { trace: true };

  // the views: rows of #more with a label and a details
  function views() {
    var more = document.getElementById('more');
    var out = [];
    if (!more) return out;
    for (var i = 0; i < more.children.length; i++) {
      var row = /** @type {HTMLElement} */ (more.children[i]);
      if (row.hidden) continue;
      var label = row.querySelector(':scope > .label');
      var details = row.querySelector(':scope > .field > details');
      if (label && details) out.push({ name: label.textContent.trim(), details: details });
    }
    return out;
  }
  function setOpen(details, open) {
    if (details.open === open) return;
    var summary = details.querySelector(':scope > summary');
    if (summary) summary.click(); else details.open = open;
  }
  // one view at a time: the one opened last wins (a tab, a key, a link)
  function exclusive() {
    if (busy) return;
    var list = views();
    var now = list.filter(function (v) { return v.details.open; }).map(function (v) { return v.details; });
    var fresh = now.filter(function (d) { return opened.indexOf(d) < 0; });
    var keep = fresh.length ? fresh[fresh.length - 1] : now[0];
    busy = true;
    try { now.forEach(function (d) { if (d !== keep) setOpen(d, false); }); } finally { busy = false; }
    opened = keep ? [keep] : [];
    var results = document.getElementById('results');
    if (results) results.classList.toggle('view-on', !!keep);
    paintStrip(false);
    // the tab was picked: a view past its size limit (a large trace, a large dependency graph) loads anyway
    var gate = keep && keep.querySelector('[data-gate]');
    if (gate) setTimeout(function () { if (gate.isConnected && keep.open) gate.click(); }, 0);
    fitSoon();
  }

  // the result's own first section: the uop table (render.js), or A–B's diff (ab.js)
  function main() {
    var body = document.getElementById('result-body');
    return body && (body.querySelector(':scope > .ws-main') || body.querySelector(':scope > .row.lead:has(> .field > .table-wrap)'));
  }

  // Wide screens: the panes are the window's height (style.css). The shown tab's scrollers (the uop tables, A–B's two
  // tables and its open folds, the report under the table, the trace, the dependency graph, the bytes, mca's text)
  // share what the result pane has left: each as tall as its content up to an equal share, scrollers side by side
  // count once; so the pane itself does not scroll. From 1200 × 700 the page does not either (style.css); in shorter
  // windows the scrollers keep a floor and the pane scrolls.
  var wide = window.matchMedia ? window.matchMedia('(min-width: 1200px)') : null;
  var still = window.matchMedia ? window.matchMedia('(min-width: 1200px) and (min-height: 700px)') : null;
  var SCROLLERS = '.trace-scroll, .dp-wrap, .ly-wrap, .mca-out, .table-wrap, details[open] > pre, .ab-pair pre';
  var MIN_H = 120, MIN_STILL = 48; // (the floor of a scroller's height; where the page does not scroll, a lower one)
  var fitted = [], fitFrame = 0;
  function fitSoon() { if (!fitFrame) fitFrame = requestAnimationFrame(function () { fitFrame = 0; fit(); }); }
  function shownParts() {
    if (opened[0]) return [opened[0]];
    var body = document.getElementById('result-body');
    var tabs = body && body.querySelector(':scope > .view-tabs');
    var out = [];
    for (var e = tabs ? tabs.nextElementSibling : null; e; e = e.nextElementSibling) out.push(e);
    return out;
  }
  function scrollers(parts) {
    var all = [];
    parts.forEach(function (p) { p.querySelectorAll(SCROLLERS).forEach(function (e) { if (e.getClientRects().length && !e.closest('details:not([open])')) all.push(e); }); });
    // (not one inside another)
    return all.filter(function (e) { return !all.some(function (o) { return o !== e && o.contains(e); }); });
  }
  // A–B's two tables side by side when each half has room for its columns and the instruction column at the narrowest
  // the port fit cuts it to (render.js fitInstr: 120 px of text, and the cell's padding)
  var MIN_INSTR = 140;
  function sideBySide() {
    var stack = document.querySelector('#ab-main .ab-stack');
    if (!stack) return;
    var need = 0;
    /** @type {NodeListOf<HTMLTableElement>} */ (stack.querySelectorAll(':scope > .ab-col table.uops')).forEach(function (t) {
      var first = t.querySelector('thead th.first');
      if (!first) return;
      // (the columns at their own width, not stretched to the table's)
      var w0 = t.style.width;
      t.style.width = 'max-content';
      need = Math.max(need, t.getBoundingClientRect().width - first.getBoundingClientRect().width);
      t.style.width = w0;
    });
    var gap = parseFloat(getComputedStyle(stack).columnGap) || 0;
    var on = need > 0 && (stack.clientWidth - gap) / 2 >= need + MIN_INSTR;
    stack.classList.toggle('ab-side', on);
  }
  function fit() {
    var top = /** @type {HTMLElement | null} */ (document.querySelector('.top'));
    if (top) root.style.setProperty('--top-h', top.offsetHeight + 'px');
    var pane = document.getElementById('results');
    if (!pane || !wide || !wide.matches) { fitted.forEach(function (e) { e.style.removeProperty('max-height'); }); fitted = []; return; }
    sideBySide();
    if (boxed) { boxed.style.removeProperty('max-height'); boxed.style.removeProperty('overflow-y'); boxed = null; }
    var parts = shownParts();
    var list = scrollers(parts);
    fitted.forEach(function (e) { if (list.indexOf(e) < 0) e.style.removeProperty('max-height'); });
    fitted = list;
    var padB = parseFloat(getComputedStyle(pane).paddingBottom) || 0;
    // what the pane's content needs now against what it has (negative: too much)
    var room = function () {
      var pr = pane.getBoundingClientRect(), bottom = pr.top;
      for (var c = pane.firstElementChild; c; c = c.nextElementSibling) {
        if (!c.getClientRects().length || getComputedStyle(c).position === 'absolute' || getComputedStyle(c).position === 'fixed') continue;
        bottom = Math.max(bottom, c.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(c).marginBottom) || 0));
      }
      return pane.clientHeight - (bottom - pr.top + pane.scrollTop + padB) - 1;
    };
    for (var pass = 0; list.length && pass < 3; pass++) {
      var delta = room();
      // the scrollers in rows (side by side: one row), each row as tall as its tallest
      var rows = [];
      list.forEach(function (e) {
        var r = e.getBoundingClientRect();
        var nat = e.scrollHeight + (e.offsetHeight - e.clientHeight);
        var row = rows.filter(function (x) { return Math.abs(x.top - r.top) < 4; })[0];
        if (!row) { row = { top: r.top, h: 0, nat: 0, els: [] }; rows.push(row); }
        row.h = Math.max(row.h, r.height); row.nat = Math.max(row.nat, nat); row.els.push([e, nat]);
      });
      var target = rows.reduce(function (a, x) { return a + x.h; }, 0) + delta;
      // the share: rows shorter than it keep their content's height
      var cap = Infinity, sumNat = rows.reduce(function (a, x) { return a + x.nat; }, 0);
      if (sumNat > target) {
        var sorted = rows.map(function (x) { return x.nat; }).sort(function (a, b) { return a - b; });
        var rest = target, n = sorted.length;
        cap = rest / n;
        for (var k = 0; k < sorted.length; k++) {
          if (sorted[k] > cap) break;
          rest -= sorted[k]; n--; cap = n ? rest / n : Infinity;
        }
        cap = Math.max(still && still.matches ? MIN_STILL : MIN_H, Math.floor(cap));
      }
      var changed = false;
      rows.forEach(function (x) {
        x.els.forEach(function (en) {
          var want = en[1] > cap ? cap + 'px' : '';
          if (en[0].style.maxHeight !== want) { en[0].style.maxHeight = want; changed = true; }
        });
      });
      if (!changed) break;
    }
    // still too much where the page does not scroll (the scrollers at their floor): the tab's largest part scrolls, not
    // the pane, so the headline and the tabs stay
    var over = room();
    if (over < -1 && still && still.matches && parts.length) {
      var big = parts.reduce(function (a, p) { return p.getBoundingClientRect().height > a.getBoundingClientRect().height ? p : a; });
      big.style.maxHeight = Math.max(MIN_STILL, Math.floor(big.getBoundingClientRect().height + over)) + 'px';
      big.style.overflowY = 'auto';
      boxed = big;
    }
  }
  var boxed = null; // the part of the shown tab that scrolls as a whole (see the end of fit)
  window.addEventListener('resize', fitSoon);
  function choose(name) {
    var list = views();
    busy = true;
    try {
      list.forEach(function (v) { if (v.name !== name) setOpen(v.details, false); });
      list.forEach(function (v) { if (v.name === name) setOpen(v.details, true); });
    } finally { busy = false; }
    exclusive();
  }
  // the table tab picked: the selected row in view (picked in the trace while the table was hidden), once it is fitted
  function revealSel() {
    requestAnimationFrame(function () {
      var t = /** @type {(HTMLTableElement & {vr?: import('./vrows.js').VRows}) | null} */ (document.querySelector('#result-body table.uops'));
      var sel = t && t.vr ? t.vr.data.sel : -1; // (vrows.js: drawn on the way)
      if (sel >= 0 && t.getClientRects().length) t.vr.reveal(sel);
    });
  }
  function side() { return document.body.dataset.abSide === 'b' ? 'b' : 'a'; }
  function pickSide(s) {
    if (s === side()) return;
    try { document.dispatchEvent(new CustomEvent('wuica:ab-side', { detail: s })); } catch (e) { /* old browsers */ }
    paintStrip(true);
  }

  function paintStrip(force) {
    if (!strip) return;
    var list = views();
    var active = opened[0] || null;
    var ab = abOn();
    var activeName = null;
    list.forEach(function (v) { if (v.details === active) activeName = v.name; });
    var perSide = ab && !!active && !BOTH[activeName];
    var results = document.getElementById('results');
    if (results) results.dataset.sideView = perSide ? '1' : '';
    var key = (ab ? 'ab:' + side() + ':' : '') + list.map(function (v) { return v.name + (v.details === active ? '+' : '-'); }).join(' ');
    if (key === lastKey && !force) return;
    lastKey = key;
    // (drawn anew: the focus stays on the tab it was on, e.g. one picked by Enter or Space)
    var a = document.activeElement;
    var focusName = a && a.parentNode && (a.parentNode === strip || a.parentNode.parentNode === strip) ? a.getAttribute('data-tab') : null;
    strip.textContent = '';
    var first = ab ? { name: 'diff', title: 'the uop tables of A and B, their difference, limits and slots' } : { name: 'table', title: 'uops per instruction' };
    var tabs = [{ name: first.name, title: first.title, on: !active, pick: function () { choose(null); revealSel(); } }];
    list.forEach(function (v) {
      var summary = v.details.querySelector(':scope > summary');
      tabs.push({ name: v.name, title: (summary ? summary.textContent.replace(/\s+/g, ' ').trim() : v.name) + (ab && !BOTH[v.name] ? ' (of A or B)' : ''),
        on: v.details === active, pick: function () { choose(v.name); } });
    });
    tabs.forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'view-tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t.on ? 'true' : 'false');
      b.setAttribute('data-tab', t.name);
      if (i < 9) b.setAttribute('aria-keyshortcuts', String(i + 1));
      b.title = t.title + (i < 9 ? ' (' + (i + 1) + ')' : '');
      b.textContent = t.name;
      b.addEventListener('click', t.pick);
      strip.appendChild(b);
      if (t.name === focusName) b.focus({ preventScroll: true });
    });
    // A–B: the side the views show
    if (perSide) {
      var g = document.createElement('span');
      g.className = 'ws-side';
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', 'the side the view shows');
      ['a', 'b'].forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ws-side-btn ab-tag' + (s === 'b' ? ' b' : '') + (s === side() ? ' on' : '');
        b.setAttribute('aria-pressed', s === side() ? 'true' : 'false');
        b.setAttribute('data-tab', 'side-' + s);
        b.title = 'show ' + s.toUpperCase();
        b.textContent = s.toUpperCase();
        b.addEventListener('click', function () { pickSide(s); });
        g.appendChild(b);
      });
      strip.appendChild(g);
      // (focused once it is in the page: a button outside it takes no focus)
      var f = /** @type {HTMLElement | null} */ (g.querySelector('[data-tab="' + focusName + '"]'));
      if (f) f.focus({ preventScroll: true });
    }
    // the copy control of the shown tab, at the end of the row (copy-view.js does the copying)
    var c = document.createElement('button');
    c.type = 'button';
    c.className = 'plain ws-copy';
    c.setAttribute('data-tab', 'copy');
    c.setAttribute('aria-keyshortcuts', 'c');
    c.title = 'copy this view as text: Markdown; Shift+click: CSV, Alt+click: JSON, where the view has them (c)';
    c.textContent = 'copy';
    c.addEventListener('click', function (e) {
      var shown = (strip.querySelector('.view-tab[aria-selected="true"]') || strip.querySelector('.view-tab'));
      try {
        document.dispatchEvent(new CustomEvent('wuica:copy', { detail: { tab: shown ? shown.getAttribute('data-tab') : null, format: e.shiftKey ? 'csv' : e.altKey ? 'json' : 'md' } }));
      } catch (err) { /* old browsers */ }
    });
    strip.appendChild(c);
    if (focusName === 'copy') c.focus({ preventScroll: true });
  }

  // the strip sits in the result, right above its first section (the result is drawn anew on every run)
  function seat() {
    var body = document.getElementById('result-body');
    if (!body || !strip) return;
    var first = main();
    if (first) { if (strip.nextSibling !== first || strip.parentNode !== body) body.insertBefore(strip, first); }
    else if (strip.parentNode) strip.parentNode.removeChild(strip);
    paintStrip(false);
  }

  function place() {
    var more = document.getElementById('more');
    var results = document.getElementById('results');
    var body = document.getElementById('result-body');
    if (!more || !results || !body) return;
    strip = document.createElement('div');
    strip.className = 'view-tabs';
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', 'Result views');
    if (more.parentNode !== results) results.appendChild(more);
    if (window.MutationObserver) {
      // views are added (bound) or filled (the trace slot) later, and open from tabs, keys and links
      moreObs = new MutationObserver(exclusive);
      moreObs.observe(more, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden'] });
      bodyObs = new MutationObserver(function () { seat(); fitSoon(); });
      bodyObs.observe(body, { childList: true });
      // (deeper: a fold or the report opened, a view's content drawn; and any change of size)
      new MutationObserver(fitSoon).observe(results, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden'] });
      if (window.ResizeObserver) { var ro = new ResizeObserver(fitSoon); ro.observe(results); ro.observe(body); ro.observe(more); }
      // single <-> A–B: the first tab's name, the side switch
      new MutationObserver(function () { paintStrip(false); }).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-ab-side'] });
    }
    seat();
    exclusive();
    paintStrip(true);
  }
  // Wide screens: the input pane folds to a strip at the left edge with its name, so the result gets the width (a click,
  // or "\\" outside a field)
  var INPUT_KEY = 'wuica-input-folded';
  var folded = false;
  try { folded = localStorage.getItem(INPUT_KEY) === '1'; } catch (e) { /* storage unavailable */ }
  root.classList.toggle('input-folded', folded);
  function fold(on) {
    folded = on;
    root.classList.toggle('input-folded', folded);
    try { localStorage.setItem(INPUT_KEY, folded ? '1' : '0'); } catch (e) { /* not remembered */ }
    paintFold();
    // the trace and the graphs measure their width on resize
    try { window.dispatchEvent(new Event('resize')); } catch (e) { /* old browsers */ }
    fitSoon();
  }
  function paintFold() {
    var b = document.getElementById('input-fold');
    if (!b) return;
    b.textContent = folded ? 'input ▸' : '◂';
    b.setAttribute('aria-expanded', folded ? 'false' : 'true');
    b.title = (folded ? 'show the input' : 'hide the input') + ' (\\)';
  }
  function bindFold() {
    var pane = document.getElementById('input');
    if (!pane || document.getElementById('input-fold')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'input-fold';
    b.className = 'input-fold';
    b.setAttribute('aria-controls', 'input');
    b.setAttribute('aria-keyshortcuts', 'Backslash');
    b.addEventListener('click', function () { fold(!folded); });
    pane.insertBefore(b, pane.firstChild);
    paintFold();
    document.addEventListener('keydown', function (e) {
      if (e.key !== '\\' || e.ctrlKey || e.metaKey || e.altKey) return;
      var t = /** @type {HTMLElement} */ (e.target);
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      fold(!folded);
    });
  }

  // From 1200 × 700 the page does not scroll (style.css): the limitations ("limitations" in the top bar) are a popover
  function bindAbout() {
    var about = document.getElementById('about');
    var link = /** @type {HTMLElement | null} */ (document.querySelector('.top nav a[href="#about"]'));
    if (!about || !link) return;
    link.setAttribute('aria-controls', 'about');
    link.setAttribute('aria-expanded', 'false');
    var show = function (on) {
      root.classList.toggle('about-open', on);
      link.setAttribute('aria-expanded', on ? 'true' : 'false');
    };
    link.addEventListener('click', function (e) {
      if (!still || !still.matches) return; // (the page scrolls: the link goes there)
      e.preventDefault();
      show(!root.classList.contains('about-open'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && root.classList.contains('about-open')) { show(false); link.focus(); }
    });
    document.addEventListener('pointerdown', function (e) {
      if (root.classList.contains('about-open') && !about.contains(/** @type {Node} */ (e.target)) && e.target !== link) show(false);
    }, true);
  }

  function bind() {
    place();
    bindFold();
    bindAbout();
    // a view points at a row of the table (rowjump.js): the table tab
    // (a jump to a row: the table shown and fitted now, so the row it scrolls to stays in view: rowjump.js)
    document.addEventListener('wuica:show-table', function () { if (opened[0]) choose(null); fit(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
