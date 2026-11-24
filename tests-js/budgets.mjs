// The transfer budgets of the site (bytes on the wire, as the host compresses them): tests-js/web_host_browser.mjs checks
// the build against them with the host's rule, scripts/smoke-live.mjs the deployed site with what Chrome receives. A growth
// of more than 10% fails. First visit: the files requested until the first result (the page, its modules, the analyzer,
// the assembler, uarch.json, the tables of the CPUs shown; the service worker's precache runs meanwhile). Tables: all 15,
// which the idle prefetch fetches (those of the first visit included). Measured on the build of 0.1.9's hotfix with
// tables made by zlib at level 9 (web/build.sh without zopfli: first visit 2,383,630 bytes at most, the tables 939 kB;
// with zopfli 797 kB).
export const BUDGET = Object.freeze({ firstVisit: 2_400_000, tables: 940_000 });
export const SLACK = 1.1;
