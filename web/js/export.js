// Export: the result as Markdown (for an issue or a review), the uop table as CSV, the response as JSON; copied to the
// clipboard by three small buttons next to the uop table (the row of tools above it). Text is made only on a click.
//
// The text comes from markdown.js (no DOM; shared with the npm package); this module is the page's glue.

import { h, copyText } from './render.js';
import { report, toCSV, toJSON } from './markdown.js';

export { toCSV, toJSON };

// Markdown of the whole result (markdown.js report): the headline, limits, caveats, chain, uop table, a link back.
//   meta: {archKey, archTitle, link, config (the CPU's configuration, for the caveats), shown (the branch labels shown)}
export function toMarkdown(r, meta = {}) {
  return report(r, { arch: meta.archKey, archTitle: meta.archTitle, link: meta.link, config: meta.config ?? null, shown: meta.shown ?? null });
}

// ---- the view ----------------------------------------------------------------------------------------------------

export function createExport() {
  return {
    decorate(root, view) {
      const r = view?.response;
      const tools = root?.querySelector('.table-tools');
      if (!tools || !r || r.error || !Array.isArray(r.rows)) return;
      tools.querySelector('.ex-tools')?.remove();
      const make = {
        md: () => toMarkdown(r, { archKey: view.archKey, archTitle: view.archTitle, link: location.href, shown: view.shown }),
        csv: () => toCSV(r),
        json: () => toJSON(r, view.request),
      };
      const titles = { md: 'copy the result as a Markdown table', csv: 'copy the uop table as CSV', json: 'copy the request and the response as JSON' };
      const buttons = Object.keys(make).map((k) => {
        const b = h('button', { type: 'button', class: 'plain ex-btn', 'data-format': k, title: titles[k], text: k });
        b.addEventListener('click', async () => {
          const ok = await copyText(make[k]());
          b.textContent = ok ? 'copied' : 'failed';
          setTimeout(() => { b.textContent = k; }, 1500);
        });
        return b;
      });
      tools.append(h('span', { class: 'ex-tools', role: 'group', 'aria-label': 'copy the result' }, h('span', { class: 'ex-k', text: 'copy' }), ...buttons));
    },
    setOpen() {},
  };
}
