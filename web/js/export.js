// Export: what the result's first tab ("table") copies through the tab row's control (copy-view.js): the uop table as
// Markdown (with its headline), CSV or JSON. The text comes from markdown.js (no DOM; shared with the npm package);
// this module is the page's glue.

import { setCopy } from './copy-view.js';
import { report, headline, uopTable, toCSV, toJSON } from './markdown.js';

export { toCSV, toJSON };

// Markdown of the whole result (markdown.js report): the headline, limits, caveats, chain, uop table, a link back.
//   meta: {archKey, archTitle, link, config (the CPU's configuration, for the caveats), shown (the branch labels shown)}
export function toMarkdown(r, meta = {}) {
  return report(r, { arch: meta.archKey, archTitle: meta.archTitle, link: meta.link, config: meta.config ?? null, shown: meta.shown ?? null });
}

export function createExport() {
  return {
    decorate(root, view) {
      const r = view?.response;
      if (!r || r.error || !Array.isArray(r.rows)) { setCopy('table', null); return; }
      setCopy('table', {
        what: 'the uop table',
        md: () => `${headline(r, { arch: view.archKey, archTitle: view.archTitle })}\n\n${uopTable(r, { shown: view.shown })}\n`,
        csv: () => toCSV(r),
        json: () => toJSON(r, view.request),
      });
    },
    setOpen() {},
  };
}
