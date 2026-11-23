// Color theme: loaded synchronously in <head> (a classic script: the CSP allows no inline script), so the stored
// choice applies before the first paint. Without a stored choice the page follows prefers-color-scheme (in CSS);
// the toggle in the top bar stores "light" or "dark". Works without storage (the choice then lasts for the page).
(function () {
  var KEY = 'wuica-theme';
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { /* storage unavailable */ }
  if (stored === 'light' || stored === 'dark') root.setAttribute('data-theme', stored);

  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function current() {
    var t = root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return media && media.matches ? 'light' : 'dark';
  }
  function paint() {
    var b = document.getElementById('theme-toggle');
    if (!b) return;
    var t = current(), other = t === 'light' ? 'dark' : 'light';
    b.textContent = t;
    b.setAttribute('aria-label', 'Color theme: ' + t);
    b.title = 'switch to ' + other;
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    var color = getComputedStyle(root).getPropertyValue('--background').trim();
    if (color) for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', color);
  }
  function bind() {
    var b = document.getElementById('theme-toggle');
    if (!b) return;
    b.addEventListener('click', function () {
      var next = current() === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* not remembered */ }
      paint();
    });
    if (media && media.addEventListener) media.addEventListener('change', paint);
    paint();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
