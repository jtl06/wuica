// The workspace: loaded synchronously in <head>, like theme.js. The page is dense (index.html sets class "dense" on
// <html>; css/dense.css), and the result pane is a tabbed workspace: the summary (CPUs, throughput, limits, chain)
// stays on top; under it a row of tabs, "table" (the uop table, the default) and the views (bound, try, bytes, deps,
// mca, source, sweep, trace); one tab's content shows at a time. A view tab opens that view's own <details> and closes
// the others, so the views, their keys and the address behave as before. A picked view loads even past its size limit
// (the button marked data-gate), since picking the tab already asks for it. On wide screens the panes are the
// window's height, the shown tab's scroller fills the result pane, and the input pane folds away (a button, or "\").
(function () {
  var root = document.documentElement;

  var strip = null, moreObs = null, bodyObs = null, lastKey = '', opened = [], busy = false;

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

  // Wide screens: the panes are the window's height (dense.css); the scroller of the shown tab (the table, the
  // trace, the dependency graph, the bytes) grows to the bottom of the result pane, so nothing below it is empty.
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
    if (!pane || !wide || !wide.matches || document.body.classList.contains('ab-on')) return;
    var view = opened[0] ? opened[0] : document.querySelector('#result-body > .row.lead:has(> .field > .table-wrap)');
    if (!view) return;
    var scroller = opened[0] ? view.querySelector(SCROLLERS) : view.querySelector('.table-wrap');
    if (!scroller) return;
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

  function paintStrip(force) {
    if (!strip) return;
    var list = views();
    var active = opened[0] || null;
    var key = list.map(function (v) { return v.name + (v.details === active ? '+' : '-'); }).join(' ');
    if (key === lastKey && !force) return;
    lastKey = key;
    // (drawn anew: the focus stays on the tab it was on, e.g. one picked by Enter or Space)
    var a = document.activeElement;
    var focusName = a && a.parentNode === strip ? a.textContent : null;
    strip.textContent = '';
    var tabs = [{ name: 'table', title: 'uops per instruction', on: !active, pick: function () { choose(null); revealSel(); } }];
    list.forEach(function (v) {
      var summary = v.details.querySelector(':scope > summary');
      tabs.push({ name: v.name, title: summary ? summary.textContent.replace(/\s+/g, ' ').trim() : v.name,
        on: v.details === active, pick: function () { choose(v.name); } });
    });
    tabs.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'view-tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t.on ? 'true' : 'false');
      b.title = t.title;
      b.textContent = t.name;
      b.addEventListener('click', t.pick);
      strip.appendChild(b);
      if (t.name === focusName) b.focus({ preventScroll: true });
    });
  }

  // the strip sits in the result, right above the uop table (the result is drawn anew on every run)
  function seat() {
    var body = document.getElementById('result-body');
    if (!body || !strip) return;
    var table = body.querySelector(':scope > .row.lead:has(> .field > .table-wrap)');
    if (table) { if (strip.nextSibling !== table || strip.parentNode !== body) body.insertBefore(strip, table); }
    else if (strip.parentNode) strip.parentNode.removeChild(strip);
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
    }
    seat();
    exclusive();
    paintStrip(true);
  }
  // Wide screens: the input pane folds to a narrow strip, so the result gets the width (a click, or "\\" outside a field)
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
    b.textContent = folded ? '▸' : '◂';
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
