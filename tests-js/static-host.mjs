// A static file server for the browser tests that behaves like the site's host (Cloudflare static assets with a 404.html):
//   /index.html, /dir/index.html  -> 307 to /, /dir/          /name.html -> 307 to /name (also /404.html -> /404)
//   /, /dir/                      -> index.html (200)        /name      -> name.html if it exists
//   /dir (a directory)            -> 307 to /dir/
//   /404, anything missing        -> the content of 404.html with status 404
//   _headers                      -> its rules are applied to the responses; _headers and _redirects are not served
// The query string is kept in redirects. Content types as the host sends them (application/wasm for .wasm,
// application/gzip for .gz, application/octet-stream for what it does not know). The responses are not compressed here;
// transferSize() says what the host would send: it compresses only the content types of COMPRESSED_TYPES.
// A redirect is what broke the service worker once (a cached redirected response for the page made every later visit
// fail): the tests must see the same redirects as the real site.
//
//   import { hostHandler } from './static-host.mjs';
//   const server = http.createServer(hostHandler(() => dist));      // a function: the root may change between requests
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.br': 'application/octet-stream', '.gz': 'application/gzip',
  '.xml': 'application/xml',
};

// The content types the host compresses (gzip or brotli, as the browser accepts): Cloudflare's list,
// https://developers.cloudflare.com/speed/optimization/content/compression/ (as of 2026-04-17). Everything else
// (application/octet-stream, application/gzip, font/woff2, image/png) goes as it is: a large file of another type must be
// compressed already (0.1.9 shipped its tables as .bin, application/octet-stream: 6.4 MB instead of 0.8).
export const COMPRESSED_TYPES = new Set(['text/html', 'text/richtext', 'text/plain', 'text/css', 'text/x-script', 'text/x-component',
  'text/x-java-source', 'text/x-markdown', 'application/javascript', 'application/x-javascript', 'text/javascript', 'text/js',
  'image/x-icon', 'image/vnd.microsoft.icon', 'application/x-perl', 'application/x-httpd-cgi', 'text/xml', 'application/xml',
  'application/rss+xml', 'application/vnd.api+json', 'application/x-protobuf', 'application/json', 'multipart/bag',
  'multipart/mixed', 'application/xhtml+xml', 'font/ttf', 'font/otf', 'font/x-woff', 'image/svg+xml',
  'application/vnd.ms-fontobject', 'application/ttf', 'application/x-ttf', 'application/otf', 'application/x-otf',
  'application/truetype', 'application/opentype', 'application/x-opentype', 'application/font-woff', 'application/eot',
  'application/font', 'application/font-sfnt', 'application/wasm', 'application/javascript-binast',
  'application/manifest+json', 'application/ld+json', 'application/graphql+json', 'application/geo+json']);

export const contentType = (file) => TYPES[path.extname(file)] ?? 'application/octet-stream';
export const compressedByHost = (file) => COMPRESSED_TYPES.has(contentType(file).split(';')[0].trim());

// The bytes the host sends for a file: compressed (estimated as gzip at level 6, what it uses at least) if its content
// type is on the list, else the file as it is.
export function transferSize(file) {
  const bytes = fs.readFileSync(file);
  return compressedByHost(file) ? zlib.gzipSync(bytes, { level: 6 }).length : bytes.length;
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** the rules of a Cloudflare `_headers` file: [{ pattern: RegExp, headers: [[name, value]] }] */
function readHeaders(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, '_headers'), 'utf8'); } catch { return []; }
  const rules = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const re = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      rules.push({ pattern: new RegExp(`^${re}$`), headers: [] });
    } else if (rules.length) {
      const i = line.indexOf(':');
      if (i > 0) rules.at(-1).headers.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

/** A request handler serving `getRoot()` like the host. `onRequest(pathnameWithSearch)` is called for every request. */
export function hostHandler(getRoot, { onRequest } = {}) {
  return (req, res) => {
    const root = path.resolve(typeof getRoot === 'function' ? getRoot() : getRoot);
    const url = new URL(req.url, 'http://x');
    onRequest?.(url.pathname + url.search);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
    const p = path.normalize(path.join(root, pathname));
    if (p !== root && !p.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const headers = { 'cache-control': 'public, max-age=0, must-revalidate' };
    for (const rule of readHeaders(root)) if (rule.pattern.test(url.pathname)) for (const [k, v] of rule.headers) headers[k] = v;
    const redirect = (to) => res.writeHead(307, { ...headers, location: to + url.search }).end();
    const send = (status, file) => {
      res.writeHead(status, { ...headers, 'content-type': contentType(file) });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    };
    const notFound = () => {
      const page = path.join(root, '404.html');
      if (isFile(page)) send(404, page); else res.writeHead(404, headers).end();
    };
    const base = path.basename(pathname);
    if (base === '_headers' || base === '_redirects') { notFound(); return; }
    if (pathname.endsWith('/index.html')) { redirect(pathname.slice(0, -'index.html'.length)); return; }
    if (pathname.endsWith('.html')) { redirect(pathname.slice(0, -'.html'.length)); return; }
    if (pathname.endsWith('/')) { const index = path.join(p, 'index.html'); if (isFile(index)) send(200, index); else notFound(); return; }
    if (isFile(p)) { send(200, p); return; }
    if (isDir(p) && isFile(path.join(p, 'index.html'))) { redirect(`${pathname}/`); return; }
    if (pathname === '/404') { notFound(); return; }
    if (isFile(`${p}.html`)) { send(200, `${p}.html`); return; }
    notFound();
  };
}
