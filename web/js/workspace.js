// The workspace: loaded synchronously in <head>, like theme.js. The page is dense (index.html sets class "dense" on
// <html>; css/dense.css), and the result pane is a tabbed workspace: the summary (CPUs, throughput, limits, chain)
// stays on top; under it a row of tabs, the first one the result's own ("table": the uop table; in A–B mode "diff":
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
      var row = more.children[i];
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

  // Wide screens: the panes are the window's height (dense.css); the scroller of the shown tab (the table, the
  // trace, the dependency graph, the bytes) grows to the bottom of the result pane, so nothing below it is empty.
  // (A–B's diff and its two traces: the pane scrolls.)
  var wide = window.matchMedia ? window.matchMedia('(min-width: 1200px)') : null;
  var SCROLLERS = '.trace-scroll, .dp-wrap, .ly-wrap, .mca-out';
  var fitted = [], fitFrame = 0;
  function fitSoon() { if (!fitFrame) fitFrame = requestAnimationFrame(function () { fitFrame = 0; fit(); }); }
  function fit() {
    var top = document.querySelector('.top');
    if (top) root.style.setProperty('--top-h', top.offsetHeight + 'px');
    fitted.forEach(function (e) { e.style.removeProperty('max-height'); });
    fitted = [];
    var pane = document.getElementById('results');
    if (!pane || !wide || !wide.matches) return;
    var view = opened[0] ? opened[0] : main();
    if (!view) return;
    if (!opened[0] && view.classList.contains('ws-main')) return;
    var all = opened[0] ? view.querySelectorAll(SCROLLERS) : view.querySelectorAll('.table-wrap');
    if (all.length !== 1) return;
    var scroller = all[0];
    var p = pane.getBoundingClientRect(), r = scroller.getBoundingClientRect(), v = view.getBoundingClientRect();
    var below = Math.max(0, v.bottom - r.bottom);         // the view's own lines under its scroller (legends)
    if (!opened[0]) {                                      // the table: the lines after it in the result too
      var last = document.querySelector('#result-body > :last-child');
      if (last) below = Math.max(below, last.getBoundingClientRect().bottom - r.bottom);
    }
    var pad = parseFloat(getComputedStyle(pane).paddingBottom) || 0;
    var room = pane.clientHeight - (r.top - p.top + pane.scrollTop) - below - pad - 2;
    scroller.style.maxHeight = Math.max(160, Math.floor(room)) + 'px';
    fitted.push(scroller);
  }
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
      var tr = document.querySelector('#result-body table.uops tbody tr.tl-sel');
      if (tr && tr.getClientRects().length) tr.scrollIntoView({ block: 'nearest' });
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
        if (b.getAttribute('data-tab') === focusName) b.focus({ preventScroll: true });
      });
      strip.appendChild(g);
    }
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
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      fold(!folded);
    });
  }

  function bind() {
    place();
    bindFold();
    // a view points at a row of the table (rowjump.js): the table tab
    document.addEventListener('wuica:show-table', function () { if (opened[0]) choose(null); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
