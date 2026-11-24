// Copying as text: one control per view, the same place in every tab (the right end of the tab row: workspace.js draws
// it and sends "wuica:copy"), and one for the whole result next to the headline. A click copies Markdown; Shift+click
// CSV and Alt+click JSON where the view has them (the control's title says which). The key c copies the shown view
// (keys.js). The text comes from each view's model through the provider it registers here, not from the page, so it
// does not depend on what is scrolled into view; the result says what was copied in the status line.

const providers = new Map(); // tab name ('table', 'diff', 'bound', ..., 'all': the whole result) -> {what, md, csv?, json?}

// A view says how it is copied: what (a few words for the status line), md (), and csv (), json () if it has them.
// null: nothing to copy.
export function setCopy(tab, provider) { if (provider) providers.set(tab, provider); else providers.delete(tab); }
export const getCopy = (tab) => providers.get(tab) ?? null;
export const FORMATS = (p) => ['md', 'csv', 'json'].filter((f) => typeof p?.[f] === 'function');
export const formatOf = (e) => (e?.shiftKey ? 'csv' : e?.altKey ? 'json' : 'md');
export function titleOf(p, base = 'copy this view') {
  const f = FORMATS(p);
  return `${base} as Markdown${f.includes('csv') ? '; Shift+click: CSV' : ''}${f.includes('json') ? '; Alt+click: JSON' : ''} (c)`;
}

// env: {copyText(text) -> promise of ok, flash(text, {error}), current() -> the shown tab's name}
export function createCopy(env) {
  async function copy(tab, format = 'md') {
    const p = getCopy(tab);
    const f = p && typeof p[format] === 'function' ? format : 'md';
    const text = p ? p[f]?.() : '';
    if (!text) { env.flash('nothing to copy here'); return false; }
    const ok = await env.copyText(text);
    env.flash(ok ? `copied: ${p.what}${f === 'md' ? '' : ` (${f})`}` : 'copy failed: the clipboard is not available here', { error: !ok });
    return ok;
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('wuica:copy', (e) => { copy(e.detail?.tab ?? env.current(), e.detail?.format ?? 'md'); });
  }
  return { copy, copyShown: (format = 'md') => copy(env.current(), format) };
}
