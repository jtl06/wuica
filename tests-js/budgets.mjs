// The transfer budgets of the site (bytes on the wire, as the host compresses them): tests-js/web_host_browser.mjs checks
// the build against them with the host's rule, scripts/smoke-live.mjs the deployed site with what Chrome receives. A growth
// of more than 10% fails. First visit: the files requested until the first result, by the page's mark
// "wuica-first-result" (the page, its modules, the analyzer, uarch.json, the tables of the CPUs shown; the service
// worker's precache runs meanwhile; not the assembler, which the default example does not wait for: app.js fetches it
// after the first result). Tables: all 15, which the idle prefetch fetches (those of the first visit included). Measured
// on the build of 0.1.9's hotfix with tables made by zlib at level 9 (web/build.sh without zopfli: the tables 939 kB;
// with zopfli 797 kB); the first visit without the assembler (0.1.10): 1,195,335 bytes at most in three runs (2,383,630
// with it before).
export const BUDGET = Object.freeze({ firstVisit: 1_200_000, tables: 940_000 });
export const SLACK = 1.1;
