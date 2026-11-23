// Finds the Chrome for the browser suites (tests-js/web_*browser*.mjs) and scripts/check.mjs: the given path (--chrome PATH),
// $CHROME, or the usual install locations on macOS and Linux (Google Chrome's .deb installs /usr/bin/google-chrome and
// google-chrome-stable, both links to /opt/google/chrome/chrome). Returns null if none exists.
import fs from 'node:fs';

export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

export function findChrome(explicit = null) {
  return explicit || process.env.CHROME || CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}
